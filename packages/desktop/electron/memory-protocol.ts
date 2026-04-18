export const DESKTOP_MEMORY_SOURCE = 'desktop-memory-panel';
export const MEMORY_SEARCH_RESULT_LIMIT = 15;
// Keep in sync with the MCP server default (mcp-server.mjs max_cards default = 5).
// Sending 50 cards caused 30 KB+ payloads that triggered upstream LLM timeouts.
export const MEMORY_CONTEXT_CARD_LIMIT = 5;
export const MEMORY_CONTEXT_TASK_LIMIT = 5;

// F-053 single-parameter surface: pass ONE `query` and let the daemon auto-route.
// The daemon handles CJK detection, keyword extraction, and bucket shaping itself
// — client-side splitting (the pre-F-053 behaviour below, preserved in comments
// for reference) is both redundant and, for CJK, actively harmful (character-level
// split forces BM25-only and loses semantic routing).
//
// Legacy multi-parameter form (semantic_query/keyword_query/scope/...) still
// works against pre-F-053 daemons via the deprecation path — but the desktop
// ships pinned to @awareness-sdk/local 0.8.0+, so we always use single-param.
export function buildMemorySearchArgs(query: string, opts?: { limit?: number; tokenBudget?: number }) {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return { query: '' };
  }
  const args: { query: string; limit?: number; token_budget?: number } = {
    query: trimmedQuery,
  };
  if (opts?.limit !== undefined) args.limit = opts.limit;
  if (opts?.tokenBudget !== undefined) args.token_budget = opts.tokenBudget;
  return args;
}

// Build arguments for awareness_init tool call
export function buildMemoryInitArgs(source: string, query?: string) {
  return {
    source,
    query: query || '',
  };
}

// Keep in sync with mcp-tools/server.mjs RECALL_MODES
export type RecallMode = 'hybrid' | 'keyword' | 'semantic';
export interface MemorySearchParams {
  semantic_query?: string;
  keyword_query?: string;
  scope?: 'all' | 'timeline' | 'knowledge' | 'insights';
  recall_mode?: RecallMode;
  limit?: number;
  agent_role?: string;
  detail?: 'summary' | 'full';
  ids?: string[];
  source_exclude?: string[];
  multi_level?: boolean;
  cluster_expand?: boolean;
  include_installed?: boolean;
  current_source?: string;
}