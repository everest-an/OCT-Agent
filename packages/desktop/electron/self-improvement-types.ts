import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Shared workspace params
// ---------------------------------------------------------------------------

export type WorkspaceParams = {
  homeDir?: string;
  agentId?: string;
  workspacePath?: string;
  /** Override allowed root directories (for testing only). Defaults to ~/.openclaw */
  _allowedRoots?: string[];
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
} & WorkspaceParams;

export type SelfImprovementStatus = {
  rootDir: string;
  learningsDir: string;
  pendingCount: number;
  highPriorityPendingCount: number;
  promotionProposalCount: number;
  readyForPromotionCount: number;
  todayProcessedCount: number;
  todayApprovedCount: number;
  todayRejectedCount: number;
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
  rejectedAt?: string;
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export type SelfImprovementPromotionRule = {
  recurrenceThreshold: number;
  windowDays: number;
};

export type EntryFileName = 'LEARNINGS.md' | 'ERRORS.md' | 'FEATURE_REQUESTS.md';

export type ParsedLearningEntry = {
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

export type ParsedPromotionEntry = SelfImprovementPromotionProposal & {
  rawBlock: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LEARNINGS_HEADER = '# Learnings\n\nCorrections, insights, and knowledge gaps captured during development.\n\n**Categories**: correction | insight | knowledge_gap | best_practice\n\n---\n';
export const ERRORS_HEADER = '# Errors\n\nCommand failures and integration errors.\n\n---\n';
export const FEATURE_REQUESTS_HEADER = '# Feature Requests\n\nCapabilities requested by users.\n\n---\n';
export const PROMOTION_PROPOSALS_HEADER = '# Promotion Proposals\n\nAuto-generated proposals for promoting recurring patterns into workspace memory files.\n\n**Rule**: recurring pattern >= 3 occurrences within 30 days.\n\n---\n';
export const DEFAULT_PROMOTION_RULE: SelfImprovementPromotionRule = {
  recurrenceThreshold: 3,
  windowDays: 30,
};
export const TARGET_FILE_HEADER: Record<SelfImprovementPromotionTarget, string> = {
  'AGENTS.md': '# AGENTS\n\nWorkflow rules and coordination guidelines.\n\n',
  'SOUL.md': '# SOUL\n\nBehavior and communication principles.\n\n',
  'TOOLS.md': '# TOOLS\n\nTool usage rules and operational safeguards.\n\n',
};

// ---------------------------------------------------------------------------
// Utility functions (shared across modules)
// ---------------------------------------------------------------------------

export function toAgentSlug(agentId: string): string {
  return agentId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'main';
}

export function resolveWorkspaceRoot(homeDir: string, agentId = 'main'): string {
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

export function trimText(input?: string, fallback = 'N/A'): string {
  const text = String(input || '').replace(/\r\n/g, '\n').trim();
  return text || fallback;
}

export function listText(values?: string[]): string {
  if (!Array.isArray(values) || values.length === 0) return 'n/a';
  const cleaned = values.map((value) => String(value || '').trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned.join(', ') : 'n/a';
}

export function formatSequence(value: number): string {
  return String(Math.max(value, 1)).padStart(3, '0');
}

export function getDateStamp(now: Date): string {
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('');
}

export function getTypePrefix(type: SelfImprovementEntryType): 'LRN' | 'ERR' | 'FEAT' {
  if (type === 'error') return 'ERR';
  if (type === 'feature') return 'FEAT';
  return 'LRN';
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isPathWithinAllowedRoot(targetPath: string, allowedRoot: string): boolean {
  const resolved = path.resolve(targetPath);
  const normalizedRoot = path.resolve(allowedRoot);
  return resolved === normalizedRoot || resolved.startsWith(normalizedRoot + path.sep);
}
