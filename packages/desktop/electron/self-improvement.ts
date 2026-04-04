import fs from 'fs';
import os from 'os';
import path from 'path';

export type SelfImprovementEntryType = 'learning' | 'error' | 'feature';
export type SelfImprovementPriority = 'low' | 'medium' | 'high' | 'critical';
export type SelfImprovementArea = 'frontend' | 'backend' | 'infra' | 'tests' | 'docs' | 'config';
export type SelfImprovementPromotionTarget = 'AGENTS.md' | 'SOUL.md' | 'TOOLS.md';

export type SelfImprovementPromotionBulkApplyResult = {
  requestedCount: number;
  appliedCount: number;
  skippedCount: number;
  applied: Array<{
    proposalId: string;
    target: SelfImprovementPromotionTarget;
    targetFilePath: string;
  }>;
};
export type SelfImprovementLogInput = {
  type: SelfImprovementEntryType;
  summary: string;
  details?: string;
  suggestedAction?: string;
  area?: SelfImprovementArea;
  priority?: SelfImprovementPriority;
  category?: 'correction' | 'insight' | 'knowledge_gap' | 'best_practice';
  commandName?: string;
  source?: string;
  relatedFiles?: string[];
  tags?: string[];
  complexity?: 'simple' | 'medium' | 'complex';
  frequency?: 'first_time' | 'recurring';
  userContext?: string;
  workspacePath?: string;
  homeDir?: string;
  agentId?: string;
};

export type SelfImprovementStatus = {
  rootDir: string;
  learningsDir: string;
  pendingCount: number;
  highPriorityPendingCount: number;
  promotionProposalCount: number;
  readyForPromotionCount: number;
};

export type SelfImprovementPromotionSummary = {
  generatedCount: number;
  proposalFilePath?: string;
  proposalIds: string[];
};

export type SelfImprovementPromotionProposal = {
  id: string;
  status: 'proposed' | 'approved' | 'rejected';
  target: SelfImprovementPromotionTarget;
  patternKey: string;
  summary: string;
  ruleText: string;
  evidenceCount: number;
  evidenceIds: string[];
  createdAt?: string;
  approvedAt?: string;
};

type SelfImprovementPromotionRule = {
  recurrenceThreshold: number;
  windowDays: number;
};

const LEARNINGS_HEADER = '# Learnings\n\nCorrections, insights, and knowledge gaps captured during development.\n\n**Categories**: correction | insight | knowledge_gap | best_practice\n\n---\n';
const ERRORS_HEADER = '# Errors\n\nCommand failures and integration errors.\n\n---\n';
const FEATURE_REQUESTS_HEADER = '# Feature Requests\n\nCapabilities requested by users.\n\n---\n';
const PROMOTION_PROPOSALS_HEADER = '# Promotion Proposals\n\nAuto-generated proposals for promoting recurring patterns into workspace memory files.\n\n**Rule**: recurring pattern >= 3 occurrences within 30 days.\n\n---\n';
const DEFAULT_PROMOTION_RULE: SelfImprovementPromotionRule = {
  recurrenceThreshold: 3,
  windowDays: 30,
};
const TARGET_FILE_HEADER: Record<SelfImprovementPromotionTarget, string> = {
  'AGENTS.md': '# AGENTS\n\nWorkflow rules and coordination guidelines.\n\n',
  'SOUL.md': '# SOUL\n\nBehavior and communication principles.\n\n',
  'TOOLS.md': '# TOOLS\n\nTool usage rules and operational safeguards.\n\n',
};

type EntryFileName = 'LEARNINGS.md' | 'ERRORS.md' | 'FEATURE_REQUESTS.md';

type ParsedLearningEntry = {
  id: string;
  type: SelfImprovementEntryType;
  title: string;
  summary: string;
  area: SelfImprovementArea;
  priority: SelfImprovementPriority;
  status: string;
  loggedAt: Date | null;
  patternKey: string;
};

type ParsedPromotionEntry = SelfImprovementPromotionProposal & {
  rawBlock: string;
};

function toAgentSlug(agentId: string): string {
  return agentId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'main';
}

function resolveWorkspaceRoot(homeDir: string, agentId = 'main'): string {
  const normalizedAgent = (agentId || 'main').trim().toLowerCase();
  if (normalizedAgent === 'main' || normalizedAgent === 'default') {
    return path.join(homeDir, '.openclaw', 'workspace');
  }

  const slug = toAgentSlug(normalizedAgent);
  const candidates = [
    path.join(homeDir, '.openclaw', `workspace-${slug}`),
    path.join(homeDir, '.openclaw', 'workspaces', slug),
    path.join(homeDir, '.openclaw', 'agents', slug, 'agent'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function trimText(input?: string, fallback = 'N/A'): string {
  const text = String(input || '').replace(/\r\n/g, '\n').trim();
  return text || fallback;
}

function listText(values?: string[]): string {
  if (!Array.isArray(values) || values.length === 0) return 'n/a';
  const cleaned = values.map((value) => String(value || '').trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned.join(', ') : 'n/a';
}

function formatSequence(value: number): string {
  return String(Math.max(value, 1)).padStart(3, '0');
}

function getDateStamp(now: Date): string {
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('');
}

function getTypePrefix(type: SelfImprovementEntryType): 'LRN' | 'ERR' | 'FEAT' {
  if (type === 'error') return 'ERR';
  if (type === 'feature') return 'FEAT';
  return 'LRN';
}

function parseTypeFromId(id: string): SelfImprovementEntryType {
  if (id.startsWith('ERR-')) return 'error';
  if (id.startsWith('FEAT-')) return 'feature';
  return 'learning';
}

function normalizePatternText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function buildPatternKey(type: SelfImprovementEntryType, area: string, summary: string): string {
  return `${type}|${area}|${normalizePatternText(summary)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSection(block: string, section: string): string {
  const matcher = new RegExp(`###\\s+${escapeRegExp(section)}\\n([\\s\\S]*?)(?=\\n###\\s+|\\n\\*\\*|\\n---|$)`, 'i');
  const match = matcher.exec(block);
  return match ? match[1].trim() : '';
}

function parseLoggedAt(value?: string): Date | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function parseEntryBlocks(content: string): ParsedLearningEntry[] {
  const entries: ParsedLearningEntry[] = [];
  const matcher = /^## \[([A-Z]+-\d{8}-\d{3})\]\s+([^\n]+)\n([\s\S]*?)(?=^## \[|(?![\s\S]))/gm;

  let match: RegExpExecArray | null = null;
  while (true) {
    match = matcher.exec(content);
    if (!match) break;

    const id = String(match[1] || '').trim();
    const title = String(match[2] || '').trim();
    const block = String(match[3] || '');
    if (!id) continue;

    const type = parseTypeFromId(id);
    const status = (block.match(/\*\*Status\*\*:\s*([^\n]+)/i)?.[1] || 'pending').trim().toLowerCase();
    const priority = (block.match(/\*\*Priority\*\*:\s*([^\n]+)/i)?.[1] || 'medium').trim().toLowerCase() as SelfImprovementPriority;
    const area = (block.match(/\*\*Area\*\*:\s*([^\n]+)/i)?.[1] || 'docs').trim().toLowerCase() as SelfImprovementArea;
    const loggedAt = parseLoggedAt(block.match(/\*\*Logged\*\*:\s*([^\n]+)/i)?.[1]);
    const summary = extractSection(block, 'Summary')
      || extractSection(block, 'Requested Capability')
      || extractSection(block, 'Error')
      || title;
    const patternKey = buildPatternKey(type, area, summary || title);
    if (!patternKey.endsWith('|')) {
      entries.push({
        id,
        type,
        title,
        summary: summary || title,
        area,
        priority,
        status,
        loggedAt,
        patternKey,
      });
    }
  }

  return entries;
}

function pickPromotionTarget(entry: ParsedLearningEntry): SelfImprovementPromotionTarget {
  const summary = `${entry.title} ${entry.summary}`;
  const behaviorPattern = /(tone|style|communication|concise|verbosity|persona|behavior|attitude|language)/i;
  const toolPattern = /(cli|command|shell|flag|argument|args|path|permission|gateway|plugin|tool|npm|openclaw|stderr)/i;

  if (entry.type === 'error' || toolPattern.test(summary)) return 'TOOLS.md';
  if (behaviorPattern.test(summary)) return 'SOUL.md';
  return 'AGENTS.md';
}

function buildPromotionRuleText(entry: ParsedLearningEntry, target: SelfImprovementPromotionTarget): string {
  if (target === 'TOOLS.md') {
    return `Before running workflows related to "${trimText(entry.summary)}", verify command arguments and capture full stderr for failures.`;
  }
  if (target === 'SOUL.md') {
    return `Apply a consistent communication behavior for "${trimText(entry.summary)}" across future responses and avoid reverting to previous style.`;
  }
  return `Standardize a repeatable workflow for "${trimText(entry.summary)}" and keep AGENTS.md aligned when steps evolve.`;
}

function nextPromotionSequence(fileContent: string, dateStamp: string): number {
  const matcher = new RegExp(`\\[PROMO-${dateStamp}-(\\d{3})\\]`, 'g');
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

function readPatternKeysFromProposals(content: string): Set<string> {
  const keys = new Set<string>();
  const matcher = /\*\*Pattern-Key\*\*:\s*([^\n]+)/g;
  let match: RegExpExecArray | null = null;
  while (true) {
    match = matcher.exec(content);
    if (!match) break;
    const key = String(match[1] || '').trim();
    if (key) keys.add(key);
  }
  return keys;
}

function formatPromotionProposalEntry(input: {
  proposalId: string;
  createdAt: string;
  target: SelfImprovementPromotionTarget;
  patternKey: string;
  summary: string;
  ruleText: string;
  evidenceIds: string[];
  evidenceCount: number;
  windowDays: number;
  recurrenceThreshold: number;
}): string {
  return [
    `## [${input.proposalId}] ${input.target}`,
    '',
    `**Created**: ${input.createdAt}`,
    '**Status**: proposed',
    `**Pattern-Key**: ${input.patternKey}`,
    `**Target**: \`${input.target}\``,
    `**Evidence Count**: ${input.evidenceCount}`,
    `**Evidence IDs**: ${input.evidenceIds.join(', ') || 'n/a'}`,
    `**Window**: ${input.windowDays} days`,
    `**Trigger**: recurrence >= ${input.recurrenceThreshold}`,
    '',
    '### Pattern Summary',
    trimText(input.summary),
    '',
    '### Proposed Rule',
    trimText(input.ruleText),
    '',
    '---',
  ].join('\n');
}

function parsePromotionStatus(value: string): 'proposed' | 'approved' | 'rejected' {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'approved') return 'approved';
  if (normalized === 'rejected') return 'rejected';
  return 'proposed';
}

function parseCommaList(value: string): string[] {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePromotionBlocks(content: string): ParsedPromotionEntry[] {
  const entries: ParsedPromotionEntry[] = [];
  const matcher = /^## \[(PROMO-\d{8}-\d{3})\]\s+([^\n]+)\n([\s\S]*?)(?=^## \[PROMO-|(?![\s\S]))/gm;

  let match: RegExpExecArray | null = null;
  while (true) {
    match = matcher.exec(content);
    if (!match) break;

    const id = String(match[1] || '').trim();
    const body = String(match[3] || '');
    const rawBlock = String(match[0] || '').trimEnd();
    if (!id || !rawBlock) continue;

    const status = parsePromotionStatus(body.match(/\*\*Status\*\*:\s*([^\n]+)/i)?.[1] || 'proposed');
    const targetText = (body.match(/\*\*Target\*\*:\s*([^\n]+)/i)?.[1] || match[2] || 'AGENTS.md').replace(/`/g, '').trim();
    const target = (['AGENTS.md', 'SOUL.md', 'TOOLS.md'].includes(targetText) ? targetText : 'AGENTS.md') as SelfImprovementPromotionTarget;
    const patternKey = (body.match(/\*\*Pattern-Key\*\*:\s*([^\n]+)/i)?.[1] || '').trim();
    const evidenceCount = Number.parseInt((body.match(/\*\*Evidence Count\*\*:\s*([^\n]+)/i)?.[1] || '0').trim(), 10) || 0;
    const evidenceIds = parseCommaList(body.match(/\*\*Evidence IDs\*\*:\s*([^\n]+)/i)?.[1] || '');
    const createdAt = (body.match(/\*\*Created\*\*:\s*([^\n]+)/i)?.[1] || '').trim() || undefined;
    const approvedAt = (body.match(/\*\*Approved\*\*:\s*([^\n]+)/i)?.[1] || '').trim() || undefined;

    entries.push({
      id,
      status,
      target,
      patternKey,
      summary: extractSection(body, 'Pattern Summary') || '',
      ruleText: extractSection(body, 'Proposed Rule') || '',
      evidenceCount,
      evidenceIds,
      createdAt,
      approvedAt,
      rawBlock,
    });
  }

  return entries;
}

function updateProposalStatusBlock(block: string, status: 'proposed' | 'approved' | 'rejected', approvedAt?: string): string {
  let next = block.replace(/\*\*Status\*\*:\s*[^\n]+/i, `**Status**: ${status}`);
  if (status === 'approved' && approvedAt) {
    if (/\*\*Approved\*\*:/i.test(next)) {
      next = next.replace(/\*\*Approved\*\*:\s*[^\n]+/i, `**Approved**: ${approvedAt}`);
    } else {
      next = next.replace(/\n---\s*$/, `\n**Approved**: ${approvedAt}\n\n---`);
    }
  }
  return next;
}

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
    proposal.status = params.status;
    if (approvedAt) proposal.approvedAt = approvedAt;
  }

  const { rawBlock: _rawBlock, ...safeProposal } = proposal;
  return safeProposal;
}
async function evaluateRecurringPromotion(learningsDir: string): Promise<SelfImprovementPromotionSummary> {
  const rule = DEFAULT_PROMOTION_RULE;
  const now = Date.now();
  const windowStart = now - (rule.windowDays * 24 * 60 * 60 * 1000);

  const sourceFiles = ['LEARNINGS.md', 'ERRORS.md', 'FEATURE_REQUESTS.md'];
  const allEntries: ParsedLearningEntry[] = [];

  for (const fileName of sourceFiles) {
    const filePath = path.join(learningsDir, fileName);
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      allEntries.push(...parseEntryBlocks(content));
    } catch {
      // ignore missing file
    }
  }

  const grouped = new Map<string, { representative: ParsedLearningEntry; entries: ParsedLearningEntry[] }>();
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
  let nextContent = proposalContent;

  if (!nextContent) {
    nextContent = PROMOTION_PROPOSALS_HEADER;
  }

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

function buildAppliedRuleBlock(proposal: SelfImprovementPromotionProposal, appliedAt: string): string {
  return [
    `<!-- promotion: ${proposal.id} -->`,
    `### [${proposal.id}] Auto-promoted Rule`,
    `- Pattern: ${trimText(proposal.summary)}`,
    `- Rule: ${trimText(proposal.ruleText)}`,
    `- Evidence: ${proposal.evidenceIds.join(', ') || 'n/a'}`,
    `- Applied: ${appliedAt}`,
    '',
  ].join('\n');
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

export async function listSelfImprovementPromotionProposals(params?: {
  homeDir?: string;
  agentId?: string;
  workspacePath?: string;
}): Promise<{
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

export async function applySelfImprovementPromotionProposal(input: {
  proposalId: string;
  homeDir?: string;
  agentId?: string;
  workspacePath?: string;
}): Promise<{
  rootDir: string;
  learningsDir: string;
  proposalFilePath: string;
  targetFilePath: string;
  proposal: SelfImprovementPromotionProposal;
}> {
  const { rootDir, learningsDir } = await ensureSelfImprovementScaffold({
    homeDir: input.homeDir,
    agentId: input.agentId,
    workspacePath: input.workspacePath,
  });
  const proposalFilePath = path.join(learningsDir, 'PROMOTION_PROPOSALS.md');

  const list = await listSelfImprovementPromotionProposals({
    homeDir: input.homeDir,
    agentId: input.agentId,
    workspacePath: input.workspacePath,
  });
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

  return {
    rootDir,
    learningsDir,
    proposalFilePath,
    targetFilePath,
    proposal: safeProposal,
  };
}

export async function rejectSelfImprovementPromotionProposal(input: {
  proposalId: string;
  homeDir?: string;
  agentId?: string;
  workspacePath?: string;
}): Promise<{
  rootDir: string;
  learningsDir: string;
  proposalFilePath: string;
  proposal: SelfImprovementPromotionProposal;
}> {
  const { rootDir, learningsDir } = await ensureSelfImprovementScaffold({
    homeDir: input.homeDir,
    agentId: input.agentId,
    workspacePath: input.workspacePath,
  });
  const proposalFilePath = path.join(learningsDir, 'PROMOTION_PROPOSALS.md');

  const proposal = await setPromotionProposalStatus({
    proposalFilePath,
    proposalId: input.proposalId,
    status: 'rejected',
  });

  return {
    rootDir,
    learningsDir,
    proposalFilePath,
    proposal,
  };
}

export async function applyAllSelfImprovementPromotionProposals(params?: {
  homeDir?: string;
  agentId?: string;
  workspacePath?: string;
}): Promise<{
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
      proposalId: proposal.id,
      homeDir: params?.homeDir,
      agentId: params?.agentId,
      workspacePath: params?.workspacePath,
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

function buildLearningEntry(id: string, nowIso: string, input: SelfImprovementLogInput): string {
  const category = input.category || 'insight';
  const priority = input.priority || 'medium';
  const area = input.area || 'docs';
  const summary = trimText(input.summary);
  const details = trimText(input.details, summary);
  const suggestedAction = trimText(input.suggestedAction, 'Capture this learning in project guidance if it recurs.');
  const source = trimText(input.source, 'desktop');
  const relatedFiles = listText(input.relatedFiles);
  const tags = listText(input.tags);

  return [
    `## [${id}] ${category}`,
    '',
    `**Logged**: ${nowIso}`,
    `**Priority**: ${priority}`,
    '**Status**: pending',
    `**Area**: ${area}`,
    '',
    '### Summary',
    summary,
    '',
    '### Details',
    details,
    '',
    '### Suggested Action',
    suggestedAction,
    '',
    '### Metadata',
    `- Source: ${source}`,
    `- Related Files: ${relatedFiles}`,
    `- Tags: ${tags}`,
    '',
    '---',
  ].join('\n');
}

function buildErrorEntry(id: string, nowIso: string, input: SelfImprovementLogInput): string {
  const priority = input.priority || 'high';
  const area = input.area || 'backend';
  const summary = trimText(input.summary);
  const errorText = trimText(input.details, summary);
  const suggestedFix = trimText(input.suggestedAction, 'Retry with diagnostics and capture the exact failing step.');
  const commandName = trimText(input.commandName, 'desktop_operation');
  const source = trimText(input.source, 'desktop');
  const relatedFiles = listText(input.relatedFiles);

  return [
    `## [${id}] ${commandName}`,
    '',
    `**Logged**: ${nowIso}`,
    `**Priority**: ${priority}`,
    '**Status**: pending',
    `**Area**: ${area}`,
    '',
    '### Summary',
    summary,
    '',
    '### Error',
    errorText,
    '',
    '### Context',
    `- Source: ${source}`,
    '- Repro step: see session timeline in Memory tab',
    '',
    '### Suggested Fix',
    suggestedFix,
    '',
    '### Metadata',
    '- Reproducible: unknown',
    `- Related Files: ${relatedFiles}`,
    '',
    '---',
  ].join('\n');
}

function buildFeatureEntry(id: string, nowIso: string, input: SelfImprovementLogInput): string {
  const priority = input.priority || 'medium';
  const area = input.area || 'frontend';
  const summary = trimText(input.summary);
  const userContext = trimText(input.userContext, trimText(input.details, 'Requested during desktop usage flow.'));
  const complexity = input.complexity || 'medium';
  const suggestedImplementation = trimText(input.suggestedAction, 'Design a minimal UX-first flow and validate it with end-to-end tests.');
  const frequency = input.frequency || 'first_time';

  return [
    `## [${id}] ${summary.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'requested_capability'}`,
    '',
    `**Logged**: ${nowIso}`,
    `**Priority**: ${priority}`,
    '**Status**: pending',
    `**Area**: ${area}`,
    '',
    '### Requested Capability',
    summary,
    '',
    '### User Context',
    userContext,
    '',
    '### Complexity Estimate',
    complexity,
    '',
    '### Suggested Implementation',
    suggestedImplementation,
    '',
    '### Metadata',
    `- Frequency: ${frequency}`,
    '- Related Features: memory',
    '',
    '---',
  ].join('\n');
}

async function ensureFileIfMissing(filePath: string, initialContent: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return false;
  } catch {
    await fs.promises.writeFile(filePath, initialContent, 'utf8');
    return true;
  }
}

export async function ensureSelfImprovementScaffold(params?: {
  homeDir?: string;
  agentId?: string;
  workspacePath?: string;
}): Promise<{
  rootDir: string;
  learningsDir: string;
  createdFiles: string[];
}> {
  const homeDir = params?.homeDir || os.homedir();
  const rootDir = (params?.workspacePath || '').trim() || resolveWorkspaceRoot(homeDir, params?.agentId || 'main');
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

export async function appendSelfImprovementEntry(input: SelfImprovementLogInput): Promise<{
  id: string;
  filePath: string;
  rootDir: string;
  learningsDir: string;
  promotion: SelfImprovementPromotionSummary;
}> {
  const { rootDir, learningsDir } = await ensureSelfImprovementScaffold({
    homeDir: input.homeDir,
    agentId: input.agentId,
    workspacePath: input.workspacePath,
  });

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
}

function countMatches(source: string, pattern: RegExp): number {
  const matches = source.match(pattern);
  return matches ? matches.length : 0;
}

function countHighPriorityPending(source: string): number {
  const blocks = source.split(/\n## \[/g);
  return blocks.reduce((count, block) => {
    if (!/\*\*Status\*\*:\s*pending\b/i.test(block)) return count;
    if (!/\*\*Priority\*\*:\s*(high|critical)\b/i.test(block)) return count;
    return count + 1;
  }, 0);
}

export async function getSelfImprovementStatus(params?: {
  homeDir?: string;
  agentId?: string;
  workspacePath?: string;
}): Promise<SelfImprovementStatus> {
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

  for (const filePath of files) {
    let content = '';
    try {
      content = await fs.promises.readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    pendingCount += countMatches(content, /\*\*Status\*\*:\s*pending\b/gi);
    highPriorityPendingCount += countHighPriorityPending(content);
  }

  const proposalsPath = path.join(learningsDir, 'PROMOTION_PROPOSALS.md');
  try {
    const proposalsContent = await fs.promises.readFile(proposalsPath, 'utf8');
    promotionProposalCount = countMatches(proposalsContent, /^## \[PROMO-\d{8}-\d{3}\]/gm);
    readyForPromotionCount = countMatches(proposalsContent, /^\*\*Status\*\*:\s*proposed\b/gmi);
  } catch {
    promotionProposalCount = 0;
    readyForPromotionCount = 0;
  }

  return {
    rootDir,
    learningsDir,
    pendingCount,
    highPriorityPendingCount,
    promotionProposalCount,
    readyForPromotionCount,
  };
}
