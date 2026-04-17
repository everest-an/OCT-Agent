export const DESKTOP_MEMORY_SOURCE = 'desktop-memory-panel';
export const MEMORY_SEARCH_RESULT_LIMIT = 15;
// Keep in sync with the MCP server default (mcp-server.mjs max_cards default = 5).
// Sending 50 cards caused 30 KB+ payloads that triggered upstream LLM timeouts.
export const MEMORY_CONTEXT_CARD_LIMIT = 5;
export const MEMORY_CONTEXT_TASK_LIMIT = 5;

export function buildMemorySearchArgs(query: string) {
  const trimmedQuery = query.trim();

  // Ensure we return a plain object with valid properties
  if (!trimmedQuery) {
    return { semantic_query: '', keyword_query: '' };
  }

  // Detect CJK vs English queries
  const hasCJK = /[\u4e00-\u9fff]|[\u3040-\u309f]|[\u30a0-\u30ff]/.test(trimmedQuery);
  if (hasCJK) {
    // For CJK: split into characters, remove spaces, treat as keyword query
    const cjkChars = trimmedQuery.replace(/\s/g, '').split('').filter(char => /\S/.test(char));
    return {
      semantic_query: '',
      keyword_query: cjkChars.join(' '),
    };
  }

  // For English: extract keywords and use full query
  const keywords = trimmedQuery
    .split(/\s+/)
    .filter(word => word.length > 2) // Skip short words
    .filter((word, index, arr) => arr.indexOf(word) === index); // Dedupe preserving order

  return {
    semantic_query: trimmedQuery,
    keyword_query: keywords.join(' '),
  };
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