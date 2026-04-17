/**
 * Tests for electron/mission/streaming-bridge.ts
 *
 * Coverage:
 *   - sendChat forwards to ws.chatSend with the derived session key + thinking
 *   - sendChat preserves caller's explicit sessionKey (for spawned subagents)
 *   - abort transits to ws.chatAbort
 *   - subscribe attaches only to `event:chat`, filters by sessionKey, normalizes
 *   - unsubscribe removes the exact same handler reference
 *   - normalizeChatPayload shapes: delta string / delta {content} / delta {text}
 *     / final string / final {message.content[]} / error / aborted / unknown-null
 *   - Adapter is resilient to foreign / malformed payloads (drops them silently)
 *   - Integration: adapter + real MissionRunner driven by synthetic events
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  createGatewayAdapter,
  extractDeltaText,
  extractFinalText,
  normalizeChatPayload,
  type MinimalGatewayWs,
} from '../../electron/mission/streaming-bridge';
import {
  MissionRunner,
  type GatewayChatEvent,
  type MissionEvent,
} from '../../electron/mission/mission-runner';

// ---------------------------------------------------------------------------
// Mock ws
// ---------------------------------------------------------------------------

interface MockWs extends MinimalGatewayWs {
  emit: (e: string, p: any) => void;
  listenerCount: (e: string) => number;
  chatSend: MinimalGatewayWs['chatSend'] & { mock: any };
}

function makeMockWs(): MockWs {
  const emitter = new EventEmitter();
  const ws: any = {
    chatSend: vi.fn().mockResolvedValue({ runId: 'run-abc' }),
    chatAbort: vi.fn().mockResolvedValue(undefined),
    on: (e: string, h: any) => emitter.on(e, h),
    off: (e: string, h: any) => emitter.off(e, h),
    emit: (e: string, p: any) => emitter.emit(e, p),
    listenerCount: (e: string) => emitter.listenerCount(e),
  };
  return ws as MockWs;
}

// ---------------------------------------------------------------------------
// sendChat / abort
// ---------------------------------------------------------------------------

describe('createGatewayAdapter · sendChat', () => {
  it('derives default session key as agent:<agentId>:main when caller omits', async () => {
    const ws = makeMockWs();
    const adapter = createGatewayAdapter(ws);
    const res = await adapter.sendChat({ agentId: 'coder', prompt: 'hi' });
    expect(res.sessionKey).toBe('agent:coder:main');
    expect(res.runId).toBe('run-abc');
    expect(ws.chatSend).toHaveBeenCalledWith(
      'agent:coder:main',
      'hi',
      expect.objectContaining({ thinking: 'off' }),
    );
  });

  it('uses caller-supplied sessionKey verbatim (subagent path)', async () => {
    const ws = makeMockWs();
    const adapter = createGatewayAdapter(ws);
    const sub = 'agent:coder:subagent:uuid-xx';
    await adapter.sendChat({ agentId: 'coder', prompt: 'hi', sessionKey: sub, thinking: 'medium' });
    expect(ws.chatSend).toHaveBeenCalledWith(sub, 'hi', { thinking: 'medium' });
  });

  it('honors a custom deriveSessionKey option', async () => {
    const ws = makeMockWs();
    const adapter = createGatewayAdapter(ws, {
      deriveSessionKey: (id) => `custom:${id}:mission-42`,
    });
    const res = await adapter.sendChat({ agentId: 'main', prompt: 'x' });
    expect(res.sessionKey).toBe('custom:main:mission-42');
  });

  it('returns empty string runId when ws returns no runId field', async () => {
    const ws = makeMockWs();
    (ws.chatSend as any).mockResolvedValue({});
    const adapter = createGatewayAdapter(ws);
    const res = await adapter.sendChat({ agentId: 'coder', prompt: 'hi' });
    expect(res.runId).toBe('');
  });
});

describe('createGatewayAdapter · abort', () => {
  it('forwards to ws.chatAbort with sessionKey and runId', async () => {
    const ws = makeMockWs();
    const adapter = createGatewayAdapter(ws);
    await adapter.abort('agent:x:subagent:y', 'run-1');
    expect(ws.chatAbort).toHaveBeenCalledWith('agent:x:subagent:y', 'run-1');
  });
});

// ---------------------------------------------------------------------------
// subscribe / filter / unsubscribe
// ---------------------------------------------------------------------------

describe('createGatewayAdapter · subscribe', () => {
  it('only attaches to "event:chat" (ignores event:agent etc)', async () => {
    const ws = makeMockWs();
    const adapter = createGatewayAdapter(ws);
    const handler = vi.fn();
    adapter.subscribe('agent:x:subagent:y', handler);

    expect(ws.listenerCount('event:chat')).toBe(1);
    expect(ws.listenerCount('event:agent')).toBe(0);
  });

  it('filters by sessionKey — drops foreign session events', () => {
    const ws = makeMockWs();
    const adapter = createGatewayAdapter(ws);
    const handler = vi.fn();
    adapter.subscribe('agent:x:subagent:y', handler);

    ws.emit('event:chat', { sessionKey: 'agent:other:main', state: 'delta', delta: 'x' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('delivers delta as GatewayChatEvent with chunk', () => {
    const ws = makeMockWs();
    const adapter = createGatewayAdapter(ws);
    const handler = vi.fn();
    adapter.subscribe('agent:x:subagent:y', handler);

    ws.emit('event:chat', { sessionKey: 'agent:x:subagent:y', state: 'delta', delta: 'Hello' });
    expect(handler).toHaveBeenCalledWith({ state: 'delta', chunk: 'Hello' });
  });

  it('drops malformed / missing payloads silently', () => {
    const ws = makeMockWs();
    const adapter = createGatewayAdapter(ws);
    const handler = vi.fn();
    adapter.subscribe('agent:x:subagent:y', handler);

    ws.emit('event:chat', null);
    ws.emit('event:chat', undefined);
    ws.emit('event:chat', {});
    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribe removes the listener (not just marks inactive)', () => {
    const ws = makeMockWs();
    const adapter = createGatewayAdapter(ws);
    const handler = vi.fn();
    const unsub = adapter.subscribe('agent:x:subagent:y', handler);
    expect(ws.listenerCount('event:chat')).toBe(1);
    unsub();
    expect(ws.listenerCount('event:chat')).toBe(0);

    // Events after unsubscribe are ignored
    ws.emit('event:chat', { sessionKey: 'agent:x:subagent:y', state: 'delta', delta: 'late' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple concurrent subscriptions to different sessions', () => {
    const ws = makeMockWs();
    const adapter = createGatewayAdapter(ws);
    const hA = vi.fn();
    const hB = vi.fn();
    adapter.subscribe('agent:a:subagent:1', hA);
    adapter.subscribe('agent:b:subagent:2', hB);

    ws.emit('event:chat', { sessionKey: 'agent:a:subagent:1', state: 'delta', delta: 'A' });
    ws.emit('event:chat', { sessionKey: 'agent:b:subagent:2', state: 'delta', delta: 'B' });

    expect(hA).toHaveBeenCalledWith({ state: 'delta', chunk: 'A' });
    expect(hB).toHaveBeenCalledWith({ state: 'delta', chunk: 'B' });
    expect(hA).toHaveBeenCalledTimes(1);
    expect(hB).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// normalizeChatPayload shape matrix
// ---------------------------------------------------------------------------

describe('normalizeChatPayload', () => {
  it('returns null for unknown state', () => {
    expect(normalizeChatPayload({ state: 'progress' })).toBeNull();
    expect(normalizeChatPayload({})).toBeNull();
    expect(normalizeChatPayload(null)).toBeNull();
  });

  it('maps delta (string form)', () => {
    expect(normalizeChatPayload({ state: 'delta', delta: 'hi' })).toEqual({ state: 'delta', chunk: 'hi' });
  });

  it('maps delta ({content} form)', () => {
    expect(normalizeChatPayload({ state: 'delta', delta: { content: 'c' } })).toEqual({ state: 'delta', chunk: 'c' });
  });

  it('maps delta ({text} form)', () => {
    expect(normalizeChatPayload({ state: 'delta', delta: { text: 't' } })).toEqual({ state: 'delta', chunk: 't' });
  });

  it('maps delta (message.content array form)', () => {
    const payload = {
      state: 'delta',
      message: { content: [{ type: 'text', text: 'ABC' }, { type: 'thinking', text: 'ignored' }] },
    };
    expect(normalizeChatPayload(payload)).toEqual({ state: 'delta', chunk: 'ABC' });
  });

  it('returns null for empty-chunk delta (prevents useless events)', () => {
    expect(normalizeChatPayload({ state: 'delta', delta: '' })).toBeNull();
    expect(normalizeChatPayload({ state: 'delta' })).toBeNull();
  });

  it('maps final with text field', () => {
    expect(normalizeChatPayload({ state: 'final', text: 'done' })).toEqual({ state: 'final', text: 'done' });
  });

  it('maps final with message.content[]', () => {
    expect(normalizeChatPayload({
      state: 'final',
      message: { content: [{ type: 'text', text: 'OK' }] },
    })).toEqual({ state: 'final', text: 'OK' });
  });

  it('maps error with errorMessage', () => {
    expect(normalizeChatPayload({ state: 'error', errorMessage: 'boom' })).toEqual({
      state: 'error',
      errorMessage: 'boom',
    });
  });

  it('maps aborted (errorMessage optional)', () => {
    expect(normalizeChatPayload({ state: 'aborted' })).toEqual({
      state: 'aborted',
      errorMessage: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// extractDeltaText / extractFinalText — unit
// ---------------------------------------------------------------------------

describe('extractDeltaText / extractFinalText', () => {
  it('extractDeltaText prefers delta string > delta.content > delta.text > message.content', () => {
    expect(extractDeltaText({ delta: 'a' })).toBe('a');
    expect(extractDeltaText({ delta: { content: 'b' } })).toBe('b');
    expect(extractDeltaText({ delta: { text: 'c' } })).toBe('c');
    expect(extractDeltaText({ message: { content: [{ type: 'text', text: 'd' }] } })).toBe('d');
    expect(extractDeltaText({ message: { content: 'e' } })).toBe('e');
    expect(extractDeltaText({})).toBe('');
    expect(extractDeltaText(null as any)).toBe('');
  });

  it('extractFinalText prefers text > message.content array > message.content string', () => {
    expect(extractFinalText({ text: 'a' })).toBe('a');
    expect(extractFinalText({ message: { content: [{ type: 'text', text: 'b' }] } })).toBe('b');
    expect(extractFinalText({ message: { content: 'c' } })).toBe('c');
    expect(extractFinalText({ text: '' })).toBe('');
    expect(extractFinalText({})).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Integration — adapter drives a real MissionRunner through a synthetic flow
// ---------------------------------------------------------------------------

describe('createGatewayAdapter · integration with MissionRunner', () => {
  it('a 2-step mission runs end-to-end through adapter + EventEmitter ws', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awclaw-bridge-int-'));
    try {
      const ws = makeMockWs();
      // Custom chatSend: fabricates a session key + runId based on current counter.
      // For the test we always route to sessionKey passed-in (planner-stage
      // goes to derived key, worker would need a pre-supplied sub-key).
      let runCounter = 1;
      (ws.chatSend as any).mockImplementation(async (_sessionKey: string, _msg: string) => {
        return { runId: `run-${runCounter++}` };
      });

      // For integration we use a single per-step subagent sessionKey supplied
      // via adapter.sendChat({sessionKey}). The MissionRunner always uses the
      // sessionKey it receives back from sendChat for subsequent subscribes.
      const baseAdapter = createGatewayAdapter(ws);
      // Wrap adapter: force a distinct session key per call (simulating
      // real subagent spawn).
      let subCounter = 1;
      const adapter: typeof baseAdapter = {
        sendChat: async (p) => {
          const forced = `agent:${p.agentId}:subagent:uuid-${subCounter++}`;
          return baseAdapter.sendChat({ ...p, sessionKey: forced });
        },
        abort: baseAdapter.abort,
        subscribe: baseAdapter.subscribe,
      };

      const events: MissionEvent[] = [];
      const runner = new MissionRunner(adapter, (e) => events.push(e), {
        root: tmpRoot,
        idGen: () => 'mission-int',
        clock: () => new Date('2026-04-17T10:00:00Z'),
        stepIdleTimeoutMs: 60_000,
      });

      const agents = [
        { id: 'main', name: 'Claw', role: 'Generalist' },
        { id: 'coder', name: 'Dev', role: 'Developer' },
      ];

      const flush = () => new Promise((r) => setImmediate(r));
      await runner.createMission({ goal: 'tiny', agents });

      // Planner final: a 2-step plan
      const planner = ws.chatSend.mock.calls[0]; // eslint-disable-line @typescript-eslint/no-unused-vars
      const plannerKey = `agent:main:subagent:uuid-1`;
      ws.emit('event:chat', {
        sessionKey: plannerKey,
        state: 'final',
        text: JSON.stringify({
          summary: 'tiny',
          subtasks: [
            { id: 'T1', agentId: 'coder', role: 'Developer', title: 'Alpha', deliverable: 'md', depends_on: [] },
            { id: 'T2', agentId: 'coder', role: 'Developer', title: 'Beta', deliverable: 'md', depends_on: ['T1'] },
            { id: 'T3', agentId: 'coder', role: 'Developer', title: 'Gamma', deliverable: 'md', depends_on: ['T2'] },
          ],
        }),
      });
      await flush();

      // T1 gets session uuid-2
      ws.emit('event:chat', { sessionKey: 'agent:coder:subagent:uuid-2', state: 'delta', delta: 'step1 ' });
      ws.emit('event:chat', { sessionKey: 'agent:coder:subagent:uuid-2', state: 'final', text: 'step1 done' });
      await flush();

      // T2 gets session uuid-3
      ws.emit('event:chat', { sessionKey: 'agent:coder:subagent:uuid-3', state: 'final', text: 'step2 done' });
      await flush();

      // T3 gets session uuid-4
      ws.emit('event:chat', { sessionKey: 'agent:coder:subagent:uuid-4', state: 'final', text: 'step3 done' });
      await flush();

      expect(events.some((e) => e.type === 'mission:done')).toBe(true);
      const deltaEvents = events.filter((e) => e.type === 'step-delta');
      expect(deltaEvents).toHaveLength(1);
      expect((deltaEvents[0] as Extract<MissionEvent, { type: 'step-delta' }>).chunk).toBe('step1 ');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
