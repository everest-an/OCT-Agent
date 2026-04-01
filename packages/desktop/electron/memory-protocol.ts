export const DESKTOP_MEMORY_SOURCE = 'desktop-memory-panel';
export const MEMORY_SEARCH_RESULT_LIMIT = 15;
export const MEMORY_CONTEXT_CARD_LIMIT = 50;
export const MEMORY_CONTEXT_TASK_LIMIT = 20;

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