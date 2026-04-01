import { describe, expect, it } from 'vitest';
import {
  buildMemoryInitArgs,
  buildMemorySearchArgs,
  DESKTOP_MEMORY_SOURCE,
  MEMORY_CONTEXT_CARD_LIMIT,
  MEMORY_CONTEXT_TASK_LIMIT,
  MEMORY_SEARCH_RESULT_LIMIT,
} from '../../electron/memory-protocol';

describe('desktop memory protocol helpers', () => {
  it('builds summary-first search args without inventing new query terms', () => {
    const args = buildMemorySearchArgs('  auth token revoke bug  ');

    expect(args).toEqual({
      semantic_query: 'auth token revoke bug',
      keyword_query: 'auth token revoke bug',
      detail: 'summary',
      limit: MEMORY_SEARCH_RESULT_LIMIT,
    });
  });

  it('builds init args with raw current focus when provided', () => {
    expect(buildMemoryInitArgs('  current failing gateway event stream  ')).toEqual({
      source: DESKTOP_MEMORY_SOURCE,
      max_cards: MEMORY_CONTEXT_CARD_LIMIT,
      max_tasks: MEMORY_CONTEXT_TASK_LIMIT,
      query: 'current failing gateway event stream',
    });
  });

  it('omits query from init args when blank', () => {
    expect(buildMemoryInitArgs('   ')).toEqual({
      source: DESKTOP_MEMORY_SOURCE,
      max_cards: MEMORY_CONTEXT_CARD_LIMIT,
      max_tasks: MEMORY_CONTEXT_TASK_LIMIT,
    });
  });
});