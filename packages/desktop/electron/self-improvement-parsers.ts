import type {
  ParsedLearningEntry,
  ParsedPromotionEntry,
  SelfImprovementArea,
  SelfImprovementEntryType,
  SelfImprovementLogInput,
  SelfImprovementPriority,
  SelfImprovementPromotionProposal,
  SelfImprovementPromotionTarget,
} from './self-improvement-types';

import {
  escapeRegExp,
  trimText,
  listText,
} from './self-improvement-types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

export function buildPatternKey(type: SelfImprovementEntryType, area: string, summary: string): string {
  return `${type}|${area}|${normalizePatternText(summary)}`;
}

export function extractSection(block: string, section: string): string {
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

// ---------------------------------------------------------------------------
// Entry block parsers
// ---------------------------------------------------------------------------

export function parseEntryBlocks(content: string): ParsedLearningEntry[] {
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
        id, type, title,
        summary: summary || title,
        area, priority, status, loggedAt, patternKey,
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Promotion block parsers
// ---------------------------------------------------------------------------

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

export function parsePromotionBlocks(content: string): ParsedPromotionEntry[] {
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
    const rejectedAt = (body.match(/\*\*Rejected\*\*:\s*([^\n]+)/i)?.[1] || '').trim() || undefined;

    entries.push({
      id, status, target, patternKey,
      summary: extractSection(body, 'Pattern Summary') || '',
      ruleText: extractSection(body, 'Proposed Rule') || '',
      evidenceCount, evidenceIds, createdAt, approvedAt, rejectedAt, rawBlock,
    });
  }

  return entries;
}

export function updateProposalStatusBlock(block: string, status: 'proposed' | 'approved' | 'rejected', processedAt?: string): string {
  let next = block.replace(/\*\*Status\*\*:\s*[^\n]+/i, `**Status**: ${status}`);

  if (status === 'approved') {
    next = next.replace(/^\*\*Rejected\*\*:\s*[^\n]+\n?/gim, '');
    if (processedAt) {
      if (/\*\*Approved\*\*:/i.test(next)) {
        next = next.replace(/\*\*Approved\*\*:\s*[^\n]+/i, `**Approved**: ${processedAt}`);
      } else if (/\n---\s*$/m.test(next)) {
        next = next.replace(/\n---\s*$/m, `\n**Approved**: ${processedAt}\n\n---`);
      } else {
        next = `${next.trimEnd()}\n**Approved**: ${processedAt}\n`;
      }
    }
    return next;
  }

  if (status === 'rejected') {
    next = next.replace(/^\*\*Approved\*\*:\s*[^\n]+\n?/gim, '');
    if (processedAt) {
      if (/\*\*Rejected\*\*:/i.test(next)) {
        next = next.replace(/\*\*Rejected\*\*:\s*[^\n]+/i, `**Rejected**: ${processedAt}`);
      } else if (/\n---\s*$/m.test(next)) {
        next = next.replace(/\n---\s*$/m, `\n**Rejected**: ${processedAt}\n\n---`);
      } else {
        next = `${next.trimEnd()}\n**Rejected**: ${processedAt}\n`;
      }
    }
    return next;
  }

  return next;
}

// ---------------------------------------------------------------------------
// Promotion helpers
// ---------------------------------------------------------------------------

export function pickPromotionTarget(entry: ParsedLearningEntry): SelfImprovementPromotionTarget {
  const summary = `${entry.title} ${entry.summary}`;
  const behaviorPattern = /(tone|style|communication|concise|verbosity|persona|behavior|attitude|language)/i;
  const toolPattern = /(cli|command|shell|flag|argument|args|path|permission|gateway|plugin|tool|npm|openclaw|stderr)/i;

  if (entry.type === 'error' || toolPattern.test(summary)) return 'TOOLS.md';
  if (behaviorPattern.test(summary)) return 'SOUL.md';
  return 'AGENTS.md';
}

export function buildPromotionRuleText(entry: ParsedLearningEntry, target: SelfImprovementPromotionTarget): string {
  if (target === 'TOOLS.md') {
    return `Before running workflows related to "${trimText(entry.summary)}", verify command arguments and capture full stderr for failures.`;
  }
  if (target === 'SOUL.md') {
    return `Apply a consistent communication behavior for "${trimText(entry.summary)}" across future responses and avoid reverting to previous style.`;
  }
  return `Standardize a repeatable workflow for "${trimText(entry.summary)}" and keep AGENTS.md aligned when steps evolve.`;
}

export function readPatternKeysFromProposals(content: string): Set<string> {
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

export function nextPromotionSequence(fileContent: string, dateStamp: string): number {
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

export function formatPromotionProposalEntry(input: {
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

// ---------------------------------------------------------------------------
// Entry builders
// ---------------------------------------------------------------------------

export function buildLearningEntry(id: string, nowIso: string, input: SelfImprovementLogInput): string {
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
    '### Summary', summary,
    '',
    '### Details', details,
    '',
    '### Suggested Action', suggestedAction,
    '',
    '### Metadata',
    `- Source: ${source}`,
    `- Related Files: ${relatedFiles}`,
    `- Tags: ${tags}`,
    '',
    '---',
  ].join('\n');
}

export function buildErrorEntry(id: string, nowIso: string, input: SelfImprovementLogInput): string {
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
    '### Summary', summary,
    '',
    '### Error', errorText,
    '',
    '### Context',
    `- Source: ${source}`,
    '- Repro step: see session timeline in Memory tab',
    '',
    '### Suggested Fix', suggestedFix,
    '',
    '### Metadata',
    '- Reproducible: unknown',
    `- Related Files: ${relatedFiles}`,
    '',
    '---',
  ].join('\n');
}

export function buildFeatureEntry(id: string, nowIso: string, input: SelfImprovementLogInput): string {
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
    '### Requested Capability', summary,
    '',
    '### User Context', userContext,
    '',
    '### Complexity Estimate', complexity,
    '',
    '### Suggested Implementation', suggestedImplementation,
    '',
    '### Metadata',
    `- Frequency: ${frequency}`,
    '- Related Features: memory',
    '',
    '---',
  ].join('\n');
}

export function buildAppliedRuleBlock(proposal: SelfImprovementPromotionProposal, appliedAt: string): string {
  return [
    `<!-- promotion: ${proposal.id} -->`,
    `### [${proposal.id}] Auto-promoted Rule`,
    `- Pattern-Key: ${trimText(proposal.patternKey, 'n/a')}`,
    `- Pattern: ${trimText(proposal.summary)}`,
    `- Rule: ${trimText(proposal.ruleText)}`,
    `- Evidence: ${proposal.evidenceIds.join(', ') || 'n/a'}`,
    `- Applied: ${appliedAt}`,
    '',
  ].join('\n');
}
