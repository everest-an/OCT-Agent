/**
 * Tests for electron/mission/awareness-bridge.ts
 *
 * Coverage:
 *   - recallForPlanner composes a query that includes goal + roles and invokes
 *     the client with the F-053 single-param `query` signature
 *   - recallForStep composes step-level query
 *   - Response parsing: MCP content[] / plain text / cards[] / results[] / empty
 *   - Defensive fallbacks: daemon error / thrown client / malformed result
 *     all return '' (never throw)
 *   - Truncation to maxFormattedChars
 *   - `failSilent: false` surfaces errors for debugging
 *   - `createAwarenessClientFromCallMcp` delegates correctly
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AwarenessBridge,
  createAwarenessClientFromCallMcp,
  extractRecallText,
  type AwarenessClient,
} from '../../electron/mission/awareness-bridge';

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------

function makeClient(resp: any): { client: AwarenessClient; calls: any[] } {
  const calls: any[] = [];
  const client: AwarenessClient = {
    async callTool(toolName, args) {
      calls.push({ toolName, args });
      return typeof resp === 'function' ? resp(args) : resp;
    },
  };
  return { client, calls };
}

function makeThrowingClient(err: any): AwarenessClient {
  return {
    async callTool() { throw err; },
  };
}

// ---------------------------------------------------------------------------
// recallForPlanner
// ---------------------------------------------------------------------------

describe('AwarenessBridge.recallForPlanner', () => {
  it('calls awareness_recall with F-053 single-param `query`, limit, token_budget', async () => {
    const { client, calls } = makeClient({
      content: [{ type: 'text', text: 'past experience text' }],
    });
    const bridge = new AwarenessBridge(client);
    const result = await bridge.recallForPlanner({
      goal: 'Build a TODO app',
      agents: [{ id: 'coder', role: 'Developer' }, { id: 'tester', role: 'Tester' }],
    });

    expect(result).toBe('past experience text');
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe('awareness_recall');
    expect(calls[0].args.query).toContain('Build a TODO app');
    expect(calls[0].args.query).toContain('Developer');
    expect(calls[0].args.query).toContain('Tester');
    expect(typeof calls[0].args.limit).toBe('number');
    expect(typeof calls[0].args.token_budget).toBe('number');
  });

  it('builds a minimal query when no agents provided', async () => {
    const { client, calls } = makeClient({ content: [{ type: 'text', text: 'x' }] });
    const bridge = new AwarenessBridge(client);
    await bridge.recallForPlanner({ goal: 'Make blog' });
    expect(calls[0].args.query).toBe('planning a mission: Make blog');
  });

  it('caps agents role list at 5 (defense against huge agent roster)', async () => {
    const { client, calls } = makeClient({ content: [{ type: 'text', text: '' }] });
    const bridge = new AwarenessBridge(client);
    const manyAgents = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, role: `R${i}` }));
    await bridge.recallForPlanner({ goal: 'g', agents: manyAgents });
    const query = calls[0].args.query;
    // R0..R4 present, R5+ absent
    expect(query).toContain('R0');
    expect(query).toContain('R4');
    expect(query).not.toContain('R10');
  });

  it('honors caller overrides for limit / tokenBudget', async () => {
    const { client, calls } = makeClient({ content: [{ type: 'text', text: '' }] });
    const bridge = new AwarenessBridge(client);
    await bridge.recallForPlanner({ goal: 'g', limit: 42, tokenBudget: 9999 });
    expect(calls[0].args.limit).toBe(42);
    expect(calls[0].args.token_budget).toBe(9999);
  });
});

// ---------------------------------------------------------------------------
// recallForStep
// ---------------------------------------------------------------------------

describe('AwarenessBridge.recallForStep', () => {
  it('includes step title + role + mission goal in the query', async () => {
    const { client, calls } = makeClient({ content: [{ type: 'text', text: 'recalled' }] });
    const bridge = new AwarenessBridge(client);
    await bridge.recallForStep({
      missionGoal: 'Build blog',
      stepTitle: 'Implement login',
      role: 'Developer',
    });
    const q = calls[0].args.query;
    expect(q).toContain('Implement login');
    expect(q).toContain('Developer');
    expect(q).toContain('Build blog');
  });

  it('omits role wrapper when role is absent', async () => {
    const { client, calls } = makeClient({ content: [{ type: 'text', text: 'x' }] });
    const bridge = new AwarenessBridge(client);
    await bridge.recallForStep({ missionGoal: 'g', stepTitle: 'T' });
    expect(calls[0].args.query).toBe('T — context: g');
  });
});

// ---------------------------------------------------------------------------
// Fail-safe behavior
// ---------------------------------------------------------------------------

describe('AwarenessBridge · fail-safe fallbacks', () => {
  it('returns "" when client throws (daemon unavailable)', async () => {
    const bridge = new AwarenessBridge(makeThrowingClient(new Error('ECONNREFUSED')));
    const warn = vi.fn();
    const bridge2 = new AwarenessBridge(makeThrowingClient(new Error('ECONNREFUSED')), { logWarn: warn });
    const result = await bridge.recallForPlanner({ goal: 'g' });
    const result2 = await bridge2.recallForPlanner({ goal: 'g' });
    expect(result).toBe('');
    expect(result2).toBe('');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/recall threw/));
  });

  it('returns "" when daemon returns { error }', async () => {
    const { client } = makeClient({ error: 'daemon is starting' });
    const bridge = new AwarenessBridge(client);
    expect(await bridge.recallForPlanner({ goal: 'g' })).toBe('');
  });

  it('returns "" when daemon returns non-object', async () => {
    const { client } = makeClient(null);
    const bridge = new AwarenessBridge(client);
    expect(await bridge.recallForPlanner({ goal: 'g' })).toBe('');
  });

  it('returns "" when recall result is empty', async () => {
    const { client } = makeClient({ content: [] });
    const bridge = new AwarenessBridge(client);
    expect(await bridge.recallForStep({ missionGoal: 'g', stepTitle: 't' })).toBe('');
  });

  it('failSilent:false re-throws (for debugging)', async () => {
    const bridge = new AwarenessBridge(makeThrowingClient(new Error('bad')), { failSilent: false });
    await expect(bridge.recallForPlanner({ goal: 'g' })).rejects.toThrow(/recall threw/);
  });
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe('AwarenessBridge · truncation', () => {
  it('truncates formatted output to maxFormattedChars with marker', async () => {
    const big = 'X'.repeat(10_000);
    const { client } = makeClient({ content: [{ type: 'text', text: big }] });
    const bridge = new AwarenessBridge(client, { maxFormattedChars: 100 });
    const result = await bridge.recallForPlanner({ goal: 'g' });
    expect(result.length).toBeLessThan(big.length);
    expect(result).toMatch(/truncated \d+ chars/);
  });

  it('does not truncate when under cap', async () => {
    const { client } = makeClient({ content: [{ type: 'text', text: 'short' }] });
    const bridge = new AwarenessBridge(client);
    const result = await bridge.recallForPlanner({ goal: 'g' });
    expect(result).toBe('short');
  });
});

// ---------------------------------------------------------------------------
// extractRecallText — response shape matrix
// ---------------------------------------------------------------------------

describe('extractRecallText', () => {
  it('extracts from MCP content array', () => {
    expect(extractRecallText({
      content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }],
    })).toBe('hello\n\nworld');
  });

  it('extracts from nested result.content', () => {
    expect(extractRecallText({
      result: { content: [{ type: 'text', text: 'nested' }] },
    })).toBe('nested');
  });

  it('ignores non-text content entries', () => {
    expect(extractRecallText({
      content: [
        { type: 'image', text: 'ignored' },
        { type: 'text', text: 'kept' },
      ],
    })).toBe('kept');
  });

  it('falls back to plain text field', () => {
    expect(extractRecallText({ text: 'plain' })).toBe('plain');
  });

  it('formats cards array into bullet list', () => {
    const result = extractRecallText({
      cards: [
        { title: 'Use pnpm', summary: 'Faster than npm in this project' },
        { title: 'Lock Node 20', summary: 'Avoid sharp compile issues' },
      ],
    });
    expect(result).toContain('- **Use pnpm**: Faster');
    expect(result).toContain('- **Lock Node 20**: Avoid');
  });

  it('handles cards with only summary (no title)', () => {
    expect(extractRecallText({ cards: [{ summary: 'only summary' }] })).toBe('- only summary');
  });

  it('falls back to results array when cards missing', () => {
    expect(extractRecallText({
      results: [{ title: 'A', summary: 'a-text' }, { title: 'B' }],
    })).toContain('- **A**: a-text');
  });

  it('returns "" for unparseable shapes', () => {
    expect(extractRecallText(null)).toBe('');
    expect(extractRecallText({})).toBe('');
    expect(extractRecallText({ other: 'field' })).toBe('');
    expect(extractRecallText({ cards: [] })).toBe('');
  });

  it('skips invalid cards (null / missing both fields)', () => {
    expect(extractRecallText({ cards: [null, {}, { title: 'keep' }] })).toBe('- keep');
  });
});

// ---------------------------------------------------------------------------
// createAwarenessClientFromCallMcp
// ---------------------------------------------------------------------------

describe('createAwarenessClientFromCallMcp', () => {
  it('forwards tool+args to the underlying callMcp', async () => {
    const callMcp = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const client = createAwarenessClientFromCallMcp(callMcp);
    const res = await client.callTool('awareness_recall', { query: 'x' });
    expect(callMcp).toHaveBeenCalledWith('awareness_recall', { query: 'x' });
    expect(res).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });
});
