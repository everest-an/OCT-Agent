import fs from 'fs';
import os from 'os';
import path from 'path';

// Re-export public types for external consumers
export type {
  SelfImprovementEntryType,
  SelfImprovementPriority,
  SelfImprovementArea,
  SelfImprovementPromotionTarget,
  SelfImprovementPromotionBulkApplyResult,
  SelfImprovementLogInput,
  SelfImprovementStatus,
  SelfImprovementPromotionSummary,
  SelfImprovementPromotionProposal,
} from './self-improvement-types';

import type {
  EntryFileName,
  SelfImprovementLogInput,
  SelfImprovementPromotionProposal,
  SelfImprovementPromotionBulkApplyResult,
  SelfImprovementPromotionSummary,
  SelfImprovementStatus,
  SelfImprovementPromotionTarget,
  WorkspaceParams,
} from './self-improvement-types';

import {
  LEARNINGS_HEADER,
  ERRORS_HEADER,
  FEATURE_REQUESTS_HEADER,
  PROMOTION_PROPOSALS_HEADER,
  DEFAULT_PROMOTION_RULE,
  TARGET_FILE_HEADER,
  resolveWorkspaceRoot,
  trimText,
  formatSequence,
  getDateStamp,
  getTypePrefix,
  escapeRegExp,
  isPathWithinAllowedRoot,
} from './self-improvement-types';

import {
  parseEntryBlocks,
  parsePromotionBlocks,
  updateProposalStatusBlock,
  pickPromotionTarget,
  buildPromotionRuleText,
  readPatternKeysFromProposals,
  nextPromotionSequence,
  formatPromotionProposalEntry,
  buildLearningEntry,
  buildErrorEntry,
  buildFeatureEntry,
  buildAppliedRuleBlock,
} from './self-improvement-parsers';

// ---------------------------------------------------------------------------
// Async mutex — prevents race conditions in read-compute-write sequences.
// Electron main process is single-threaded but async, so an in-process mutex
// is sufficient (no cross-process contention).
// ---------------------------------------------------------------------------

class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (this.locked) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.locked = true;
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    } else {
      this.locked = false;
    }
  }
}

const appendMutex = new AsyncMutex();

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function ensureFileIfMissing(filePath: string, initialContent: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return false;
  } catch {
    await fs.promises.writeFile(filePath, initialContent, 'utf8');
    return true;
  }
}

async function ensureTargetFileExists(rootDir: string, target: SelfImprovementPromotionTarget): Promise<string> {
  const targetPath = path.join(rootDir, target);
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    return targetPath;
  } catch {
    await fs.promises.mkdir(rootDir, { recursive: true });
    await fs.promises.writeFile(targetPath, TARGET_FILE_HEADER[target], 'utf8');
    return targetPath;
  }
}

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

export async function ensureSelfImprovementScaffold(params?: WorkspaceParams): Promise<{
  rootDir: string;
  learningsDir: string;
  createdFiles: string[];
}> {
  const homeDir = params?.homeDir || os.homedir();
  const openclawRoot = path.join(homeDir, '.openclaw');
  const allowedRoots = params?._allowedRoots ?? [openclawRoot];
  const rawRoot = (params?.workspacePath || '').trim() || resolveWorkspaceRoot(homeDir, params?.agentId || 'main');
  const rootDir = path.resolve(rawRoot);

  const isAllowed = allowedRoots.some((root) => isPathWithinAllowedRoot(rootDir, root));
  if (!isAllowed) {
    throw new Error(`Workspace path must be within allowed directories, got: ${rootDir}`);
  }

  const learningsDir = path.join(rootDir, '.learnings');

  await fs.promises.mkdir(learningsDir, { recursive: true });

  const createdFiles: string[] = [];
  const targets: Array<[EntryFileName, string]> = [
    ['LEARNINGS.md', LEARNINGS_HEADER],
    ['ERRORS.md', ERRORS_HEADER],
    ['FEATURE_REQUESTS.md', FEATURE_REQUESTS_HEADER],
  ];

  for (const [fileName, header] of targets) {
    const targetPath = path.join(learningsDir, fileName);
    if (await ensureFileIfMissing(targetPath, header)) {
      createdFiles.push(targetPath);
    }
  }

  return { rootDir, learningsDir, createdFiles };
}

// ---------------------------------------------------------------------------
// Proposal status management
// ---------------------------------------------------------------------------

async function setPromotionProposalStatus(params: {
  proposalFilePath: string;
  proposalId: string;
  status: 'approved' | 'rejected';
}): Promise<SelfImprovementPromotionProposal> {
  const content = await fs.promises.readFile(params.proposalFilePath, 'utf8');
  const parsed = parsePromotionBlocks(content);
  const proposal = parsed.find((item) => item.id === params.proposalId);
  if (!proposal) {
    throw new Error(`Promotion proposal not found: ${params.proposalId}`);
  }

  if (proposal.status !== params.status) {
    const approvedAt = params.status === 'approved' ? new Date().toISOString() : undefined;
    const proposalIdPattern = escapeRegExp(proposal.id);
    const statusMatcher = new RegExp(`(## \\[${proposalIdPattern}\\][\\s\\S]*?\\*\\*Status\\*\\*:\\s*)([^\\n]+)`, 'm');
    let updatedContent = content.replace(statusMatcher, `$1${params.status}`);

    const blockMatcher = new RegExp(`(^## \\[${proposalIdPattern}\\][\\s\\S]*?)(?=^## \\[PROMO-|(?![\\s\\S]))`, 'm');
    const blockMatch = blockMatcher.exec(updatedContent);
    if (blockMatch) {
      const updatedBlock = updateProposalStatusBlock(blockMatch[1], params.status, approvedAt);
      updatedContent = updatedContent.replace(blockMatch[1], updatedBlock);
    }

    await fs.promises.writeFile(params.proposalFilePath, updatedContent, 'utf8');
  }

  const { rawBlock: _rawBlock, ...safeProposal } = proposal;
  return {
    ...safeProposal,
    status: params.status,
    ...(params.status === 'approved' ? { approvedAt: new Date().toISOString() } : {}),
  };
}

// ---------------------------------------------------------------------------
// Recurring pattern evaluation
// ---------------------------------------------------------------------------

async function evaluateRecurringPromotion(learningsDir: string): Promise<SelfImprovementPromotionSummary> {
  const rule = DEFAULT_PROMOTION_RULE;
  const now = Date.now();
  const windowStart = now - (rule.windowDays * 24 * 60 * 60 * 1000);

  const sourceFiles = ['LEARNINGS.md', 'ERRORS.md', 'FEATURE_REQUESTS.md'];
  const allEntries = [];

  for (const fileName of sourceFiles) {
    const filePath = path.join(learningsDir, fileName);
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      allEntries.push(...parseEntryBlocks(content));
    } catch {
      // ignore missing file
    }
  }

  const grouped = new Map<string, { representative: (typeof allEntries)[0]; entries: typeof allEntries }>();
  for (const entry of allEntries) {
    if (!entry.patternKey || !entry.loggedAt) continue;
    if (entry.loggedAt.getTime() < windowStart) continue;

    const bucket = grouped.get(entry.patternKey);
    if (!bucket) {
      grouped.set(entry.patternKey, { representative: entry, entries: [entry] });
      continue;
    }
    bucket.entries.push(entry);
  }

  const proposalPath = path.join(learningsDir, 'PROMOTION_PROPOSALS.md');
  let proposalContent = '';
  try {
    proposalContent = await fs.promises.readFile(proposalPath, 'utf8');
  } catch {
    proposalContent = '';
  }

  const existingPatternKeys = readPatternKeysFromProposals(proposalContent);
  const proposalIds: string[] = [];
  let nextContent = proposalContent || PROMOTION_PROPOSALS_HEADER;

  const dateStamp = getDateStamp(new Date());
  for (const { representative, entries } of grouped.values()) {
    const evidenceEntries = entries
      .filter((entry) => entry.status === 'pending')
      .sort((left, right) => (left.loggedAt?.getTime() || 0) - (right.loggedAt?.getTime() || 0));

    if (evidenceEntries.length < rule.recurrenceThreshold) continue;

    const target = pickPromotionTarget(representative);
    const proposalPatternKey = `${target}|${representative.patternKey}`;
    if (existingPatternKeys.has(proposalPatternKey)) continue;

    const seq = formatSequence(nextPromotionSequence(nextContent, dateStamp));
    const proposalId = `PROMO-${dateStamp}-${seq}`;
    const entryText = formatPromotionProposalEntry({
      proposalId,
      createdAt: new Date().toISOString(),
      target,
      patternKey: proposalPatternKey,
      summary: representative.summary,
      ruleText: buildPromotionRuleText(representative, target),
      evidenceIds: evidenceEntries.slice(0, 6).map((entry) => entry.id),
      evidenceCount: evidenceEntries.length,
      windowDays: rule.windowDays,
      recurrenceThreshold: rule.recurrenceThreshold,
    });

    const needsSeparator = nextContent.trim().length > 0 && !nextContent.endsWith('\n\n');
    nextContent = `${nextContent}${needsSeparator ? '\n' : ''}${entryText}\n`;
    existingPatternKeys.add(proposalPatternKey);
    proposalIds.push(proposalId);
  }

  if (proposalIds.length > 0) {
    await fs.promises.writeFile(proposalPath, nextContent, 'utf8');
  }

  return {
    generatedCount: proposalIds.length,
    proposalFilePath: proposalIds.length > 0 ? proposalPath : undefined,
    proposalIds,
  };
}

// ---------------------------------------------------------------------------
// Sequence counter
// ---------------------------------------------------------------------------

function nextSequence(fileContent: string, prefix: 'LRN' | 'ERR' | 'FEAT', dateStamp: string): number {
  const matcher = new RegExp(`\\[${prefix}-${dateStamp}-(\\d{3})\\]`, 'g');
  let maxFound = 0;
  let match: RegExpExecArray | null = null;
  while (true) {
    match = matcher.exec(fileContent);
    if (!match) break;
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > maxFound) {
      maxFound = parsed;
    }
  }
  return maxFound + 1;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function appendSelfImprovementEntry(input: SelfImprovementLogInput): Promise<{
  id: string;
  filePath: string;
  rootDir: string;
  learningsDir: string;
  promotion: SelfImprovementPromotionSummary;
}> {
  const { rootDir, learningsDir } = await ensureSelfImprovementScaffold(input);

  const now = new Date();
  const nowIso = now.toISOString();
  const dateStamp = getDateStamp(now);
  const prefix = getTypePrefix(input.type);

  const targetFileName: EntryFileName = input.type === 'error'
    ? 'ERRORS.md'
    : input.type === 'feature'
      ? 'FEATURE_REQUESTS.md'
      : 'LEARNINGS.md';

  const filePath = path.join(learningsDir, targetFileName);

  await appendMutex.acquire();
  try {
    const existing = await fs.promises.readFile(filePath, 'utf8');
    const sequence = formatSequence(nextSequence(existing, prefix, dateStamp));
    const id = `${prefix}-${dateStamp}-${sequence}`;

    const entry = input.type === 'error'
      ? buildErrorEntry(id, nowIso, input)
      : input.type === 'feature'
        ? buildFeatureEntry(id, nowIso, input)
        : buildLearningEntry(id, nowIso, input);

    const needsSeparator = existing.trim().length > 0 && !existing.endsWith('\n\n');
    await fs.promises.appendFile(filePath, `${needsSeparator ? '\n' : ''}${entry}\n`, 'utf8');

    const promotion = await evaluateRecurringPromotion(learningsDir);

    return { id, filePath, rootDir, learningsDir, promotion };
  } finally {
    appendMutex.release();
  }
}

export async function listSelfImprovementPromotionProposals(params?: WorkspaceParams): Promise<{
  rootDir: string;
  learningsDir: string;
  proposalFilePath: string;
  items: SelfImprovementPromotionProposal[];
}> {
  const { rootDir, learningsDir } = await ensureSelfImprovementScaffold(params);
  const proposalFilePath = path.join(learningsDir, 'PROMOTION_PROPOSALS.md');

  let content = '';
  try {
    content = await fs.promises.readFile(proposalFilePath, 'utf8');
  } catch {
    return { rootDir, learningsDir, proposalFilePath, items: [] };
  }

  const items = parsePromotionBlocks(content)
    .map(({ rawBlock: _rawBlock, ...item }) => item)
    .sort((left, right) => {
      const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
      const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
      return rightTime - leftTime;
    });

  return { rootDir, learningsDir, proposalFilePath, items };
}

export async function applySelfImprovementPromotionProposal(input: WorkspaceParams & {
  proposalId: string;
}): Promise<{
  rootDir: string;
  learningsDir: string;
  proposalFilePath: string;
  targetFilePath: string;
  proposal: SelfImprovementPromotionProposal;
}> {
  const { rootDir, learningsDir } = await ensureSelfImprovementScaffold(input);
  const proposalFilePath = path.join(learningsDir, 'PROMOTION_PROPOSALS.md');

  const list = await listSelfImprovementPromotionProposals(input);
  const proposal = list.items.find((item) => item.id === input.proposalId);
  if (!proposal) {
    throw new Error(`Promotion proposal not found: ${input.proposalId}`);
  }

  const targetFilePath = await ensureTargetFileExists(rootDir, proposal.target);
  const targetContent = await fs.promises.readFile(targetFilePath, 'utf8');
  const marker = `promotion: ${proposal.id}`;
  if (!targetContent.includes(marker)) {
    const appendText = buildAppliedRuleBlock(proposal, new Date().toISOString());
    const separator = targetContent.trim().length > 0 && !targetContent.endsWith('\n\n') ? '\n' : '';
    await fs.promises.writeFile(targetFilePath, `${targetContent}${separator}${appendText}`, 'utf8');
  }

  const safeProposal = await setPromotionProposalStatus({
    proposalFilePath,
    proposalId: proposal.id,
    status: 'approved',
  });

  return { rootDir, learningsDir, proposalFilePath, targetFilePath, proposal: safeProposal };
}

export async function rejectSelfImprovementPromotionProposal(input: WorkspaceParams & {
  proposalId: string;
}): Promise<{
  rootDir: string;
  learningsDir: string;
  proposalFilePath: string;
  proposal: SelfImprovementPromotionProposal;
}> {
  const { rootDir, learningsDir } = await ensureSelfImprovementScaffold(input);
  const proposalFilePath = path.join(learningsDir, 'PROMOTION_PROPOSALS.md');

  const proposal = await setPromotionProposalStatus({
    proposalFilePath,
    proposalId: input.proposalId,
    status: 'rejected',
  });

  return { rootDir, learningsDir, proposalFilePath, proposal };
}

export async function applyAllSelfImprovementPromotionProposals(params?: WorkspaceParams): Promise<{
  rootDir: string;
  learningsDir: string;
  proposalFilePath: string;
  result: SelfImprovementPromotionBulkApplyResult;
}> {
  const listed = await listSelfImprovementPromotionProposals(params);
  const proposed = listed.items.filter((item) => item.status === 'proposed');
  const applied: SelfImprovementPromotionBulkApplyResult['applied'] = [];

  for (const proposal of proposed) {
    const outcome = await applySelfImprovementPromotionProposal({
      ...params,
      proposalId: proposal.id,
    });
    applied.push({
      proposalId: proposal.id,
      target: outcome.proposal.target,
      targetFilePath: outcome.targetFilePath,
    });
  }

  return {
    rootDir: listed.rootDir,
    learningsDir: listed.learningsDir,
    proposalFilePath: listed.proposalFilePath,
    result: {
      requestedCount: proposed.length,
      appliedCount: applied.length,
      skippedCount: listed.items.length - proposed.length,
      applied,
    },
  };
}

// ---------------------------------------------------------------------------
// Status query
// ---------------------------------------------------------------------------

function countMatches(source: string, pattern: RegExp): number {
  const matches = source.match(pattern);
  return matches ? matches.length : 0;
}

function countHighPriorityPending(source: string): number {
  const matcher = /\*\*Priority\*\*:\s*(high|critical)\s*\n[\s\S]*?\*\*Status\*\*:\s*pending/gi;
  return countMatches(source, matcher);
}

export async function getSelfImprovementStatus(params?: WorkspaceParams): Promise<SelfImprovementStatus> {
  const { rootDir, learningsDir } = await ensureSelfImprovementScaffold(params);
  const files = [
    path.join(learningsDir, 'LEARNINGS.md'),
    path.join(learningsDir, 'ERRORS.md'),
    path.join(learningsDir, 'FEATURE_REQUESTS.md'),
  ];

  let pendingCount = 0;
  let highPriorityPendingCount = 0;
  let promotionProposalCount = 0;
  let readyForPromotionCount = 0;

  for (const file of files) {
    try {
      const content = await fs.promises.readFile(file, 'utf8');
      pendingCount += countMatches(content, /\*\*Status\*\*:\s*pending/gi);
      highPriorityPendingCount += countHighPriorityPending(content);
    } catch {
      // missing file
    }
  }

  try {
    const proposalContent = await fs.promises.readFile(path.join(learningsDir, 'PROMOTION_PROPOSALS.md'), 'utf8');
    const proposals = parsePromotionBlocks(proposalContent);
    promotionProposalCount = proposals.length;
    readyForPromotionCount = proposals.filter((item) => item.status === 'proposed').length;
  } catch {
    // no proposals file
  }

  return { rootDir, learningsDir, pendingCount, highPriorityPendingCount, promotionProposalCount, readyForPromotionCount };
}
