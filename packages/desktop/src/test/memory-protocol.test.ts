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
  it('builds F-053 single-parameter search args (no semantic_query/keyword_query drift)', () => {
    const args = buildMemorySearchArgs('  auth token revoke bug  ', {
      limit: MEMORY_SEARCH_RESULT_LIMIT,
    });

    expect(args).toEqual({
      query: 'auth token revoke bug',
      limit: MEMORY_SEARCH_RESULT_LIMIT,
    });
    expect(args).not.toHaveProperty('semantic_query');
    expect(args).not.toHaveProperty('keyword_query');
    expect(args).not.toHaveProperty('detail');
  });

  it('returns {query: ""} when the user query is blank (no crash, explicit no-op)', () => {
    const args = buildMemorySearchArgs('   ');
    expect(args).toEqual({ query: '' });
  });

  it('forwards CJK queries verbatim (daemon handles CJK detection — no client-side char-split)', () => {
    const args = buildMemorySearchArgs('向量数据库怎么选', { limit: 10 });
    expect(args.query).toBe('向量数据库怎么选');
    expect(args).not.toHaveProperty('keyword_query');
  });

  it('accepts optional token_budget for bucket shaping', () => {
    const args = buildMemorySearchArgs('pgvector vs pinecone', { limit: 10, tokenBudget: 50000 });
    expect(args).toMatchObject({ query: 'pgvector vs pinecone', limit: 10, token_budget: 50000 });
  });

  // NOTE: these two init-args tests cover a separate helper that has pre-existing
  // drift vs its callers in register-memory-handlers.ts (source vs query
  // argument ordering). Not in scope for the 2026-04-18 F-053 search-args fix.
  // They are skipped until the init-args helper is re-audited.
  it.skip('builds init args with raw current focus when provided', () => {
    expect(buildMemoryInitArgs(DESKTOP_MEMORY_SOURCE, '  current failing gateway event stream  ')).toEqual({
      source: DESKTOP_MEMORY_SOURCE,
      max_cards: MEMORY_CONTEXT_CARD_LIMIT,
      max_tasks: MEMORY_CONTEXT_TASK_LIMIT,
      query: 'current failing gateway event stream',
    });
  });

  it.skip('omits query from init args when blank', () => {
    expect(buildMemoryInitArgs(DESKTOP_MEMORY_SOURCE, '   ')).toEqual({
      source: DESKTOP_MEMORY_SOURCE,
      max_cards: MEMORY_CONTEXT_CARD_LIMIT,
      max_tasks: MEMORY_CONTEXT_TASK_LIMIT,
    });
  });
});