export const DESKTOP_MEMORY_SOURCE = 'desktop-memory-panel';
export const MEMORY_SEARCH_RESULT_LIMIT = 15;
// Keep in sync with the MCP server default (mcp-server.mjs max_cards default = 5).
// Sending 50 cards caused 30 KB+ payloads that triggered upstream LLM timeouts.
export const MEMORY_CONTEXT_CARD_LIMIT = 5;
export const MEMORY_CONTEXT_TASK_LIMIT = 5;

export function buildMemorySearchArgs(query: string) {
  const trimmedQuery = query.trim();
  return {
    semantic_query: trimmedQuery,
    keyword_query: trimmedQuery || undefined,
    detail: 'summary',
    limit: MEMORY_SEARCH_RESULT_LIMIT,
  };
}

export function buildMemoryInitArgs(query?: string) {
  const trimmedQuery = (query || '').trim();
  return {
    source: DESKTOP_MEMORY_SOURCE,
    max_cards: MEMORY_CONTEXT_CARD_LIMIT,
    max_tasks: MEMORY_CONTEXT_TASK_LIMIT,
    ...(trimmedQuery ? { query: trimmedQuery } : {}),
  };
}