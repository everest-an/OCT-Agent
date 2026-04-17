/**
 * L3 Failure-mode / chaos tests for the mission pipeline.
 *
 * Focus: every external boundary (Gateway WS, Awareness daemon, LLM output)
 * has at least three scenarios covered — happy / hard-fail / edge-shape.
 * Corresponds to 03-ACCEPTANCE.md L3.x + the streaming failure bullets.
 *
 * These tests complement the L2 integration tests by deliberately
 * exercising broken / adversarial inputs.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MissionRunner, type MissionEvent } from '../../electron/mission/mission-runner';
import { createGatewayAdapter, normalizeChatPayload, extractDeltaText } from '../../electron/mission/streaming-bridge';
import { AwarenessBridge } from '../../electron/mission/awareness-bridge';

type Listener = (payload: any) => void;

function makeWs() {
  const listeners = new Set<Listener>();
  const ws: any = {
    chatSend: vi.fn(async () => ({ runId: 'r1' })),
    chatAbort: vi.fn(async () => undefined),
    on: vi.fn((ev: string, cb: Listener) => { if (ev === 'event:chat') listeners.add(cb); }),
    off: vi.fn((ev: string, cb: Listener) => { if (ev === 'event:chat') listeners.delete(cb); }),
  };
  return {
    ws,
    emit: (payload: any) => { for (const cb of [...listeners]) cb(payload); },
  };
}

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'l3-chaos-')); }
async function flush(n = 3) {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setImmediate(r));
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Gateway payload chaos
// ---------------------------------------------------------------------------
describe('L3 chaos — Gateway payload normalization', () => {
  it('drops malformed payloads silently (no throw)', () => {
    const badInputs = [null, undefined, 42, 'string', {}, { state: 'weird' }];
    for (const b of badInputs) {
      expect(normalizeChatPayload(b as any)).toBeNull();
    }
  });

  it('normalizes delta payloads with varied shapes', () => {
    expect(extractDeltaText({ delta: 'plain' })).toBe('plain');
    expect(extractDeltaText({ delta: { content: 'from-content' } })).toBe('from-content');
    expect(extractDeltaText({ delta: { text: 'from-text' } })).toBe('from-text');
    expect(
      extractDeltaText({ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }),
    ).toBe('ab');
    expect(extractDeltaText({ message: { content: 'plain' } })).toBe('plain');
    expect(extractDeltaText({})).toBe('');
    expect(extractDeltaText(null)).toBe('');
  });

  it('session-key mismatch means handler is never called', async () => {
    const { ws, emit } = makeWs();
    const adapter = createGatewayAdapter(ws);
    const handler = vi.fn();
    adapter.subscribe('sk-target', handler);
    emit({ state: 'delta', sessionKey: 'sk-other', delta: 'noise' });
    expect(handler).not.toHaveBeenCalled();
    emit({ state: 'delta', sessionKey: 'sk-target', delta: 'signal' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Gateway failure modes
// ---------------------------------------------------------------------------
describe('L3 chaos — Gateway failure modes during planner', () => {
  it('planner error event fails mission (no retry after maxPlannerRetries=0)', async () => {
    const { ws, emit } = makeWs();
    const adapter = createGatewayAdapter(ws);
    const events: MissionEvent[] = [];
    const runner = new MissionRunner(adapter, (e) => events.push(e), {
      root: tmpRoot(), stepIdleTimeoutMs: 0, maxPlannerRetries: 0,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'chaos1',
    });
    const mission = await runner.createMission({
      goal: 'x',
      agents: [{ id: 'main' }, { id: 'coder' }, { id: 'tester' }],
    });
    const plannerKey = `agent:main:main`;
    emit({ state: 'error', sessionKey: plannerKey, errorMessage: 'provider down' });
    await flush();
    const m = runner.getMission(mission.id)!;
    expect(m.status).toBe('failed');
    expect(events.map((e) => e.type)).toContain('mission:failed');
  });

  it('planner aborted is treated as failure', async () => {
    const { ws, emit } = makeWs();
    const adapter = createGatewayAdapter(ws);
    const events: MissionEvent[] = [];
    const runner = new MissionRunner(adapter, (e) => events.push(e), {
      root: tmpRoot(), stepIdleTimeoutMs: 0, maxPlannerRetries: 0,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'chaos2',
    });
    const mission = await runner.createMission({
      goal: 'x',
      agents: [{ id: 'main' }, { id: 'coder' }, { id: 'tester' }],
    });
    emit({ state: 'aborted', sessionKey: `agent:main:main`, errorMessage: 'user aborted' });
    await flush();
    expect(runner.getMission(mission.id)!.status).toBe('failed');
  });

  it('planner JSON with forbidden fields fails validation and retries once', async () => {
    const { ws, emit } = makeWs();
    const adapter = createGatewayAdapter(ws);
    const events: MissionEvent[] = [];
    const runner = new MissionRunner(adapter, (e) => events.push(e), {
      root: tmpRoot(), stepIdleTimeoutMs: 0, maxPlannerRetries: 1,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'chaos3',
    });
    await runner.createMission({
      goal: 'x',
      agents: [{ id: 'main' }, { id: 'coder' }, { id: 'tester' }],
    });
    emit({
      state: 'final',
      sessionKey: `agent:main:main`,
      text: JSON.stringify({
        summary: 'bad',
        subtasks: [
          { id: 'T1', agentId: 'main', role: 'L', title: 'A', deliverable: 'd', depends_on: [], command: 'rm -rf /' },
          { id: 'T2', agentId: 'coder', role: 'D', title: 'B', deliverable: 'd', depends_on: ['T1'] },
          { id: 'T3', agentId: 'tester', role: 'Q', title: 'C', deliverable: 'd', depends_on: ['T2'] },
        ],
      }),
    });
    await flush();
    // Planner retry should fire → chatSend called twice
    expect((ws.chatSend as any).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('planner JSON with only 1 subtask fails (< MIN_SUBTASKS)', async () => {
    const { ws, emit } = makeWs();
    const adapter = createGatewayAdapter(ws);
    const events: MissionEvent[] = [];
    const runner = new MissionRunner(adapter, (e) => events.push(e), {
      root: tmpRoot(), stepIdleTimeoutMs: 0, maxPlannerRetries: 0,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'chaos4',
    });
    const mission = await runner.createMission({
      goal: 'x',
      agents: [{ id: 'main' }, { id: 'coder' }, { id: 'tester' }],
    });
    emit({
      state: 'final',
      sessionKey: `agent:main:main`,
      text: JSON.stringify({ summary: 'x', subtasks: [
        { id: 'T1', agentId: 'main', role: 'L', title: 'only', deliverable: 'd', depends_on: [] },
      ] }),
    });
    await flush();
    expect(runner.getMission(mission.id)!.status).toBe('failed');
  });

  it('planner JSON with cycle fails', async () => {
    const { ws, emit } = makeWs();
    const adapter = createGatewayAdapter(ws);
    const runner = new MissionRunner(adapter, () => {}, {
      root: tmpRoot(), stepIdleTimeoutMs: 0, maxPlannerRetries: 0,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'chaos5',
    });
    const mission = await runner.createMission({
      goal: 'x',
      agents: [{ id: 'main' }, { id: 'coder' }, { id: 'tester' }],
    });
    emit({
      state: 'final',
      sessionKey: `agent:main:main`,
      text: JSON.stringify({ summary: 'cycle', subtasks: [
        { id: 'T1', agentId: 'main',   role: 'L', title: 'a', deliverable: 'd', depends_on: ['T3'] },
        { id: 'T2', agentId: 'coder',  role: 'D', title: 'b', deliverable: 'd', depends_on: ['T1'] },
        { id: 'T3', agentId: 'tester', role: 'Q', title: 'c', deliverable: 'd', depends_on: ['T2'] },
      ] }),
    });
    await flush();
    expect(runner.getMission(mission.id)!.status).toBe('failed');
  });

  it('planner JSON that is not JSON at all fails', async () => {
    const { ws, emit } = makeWs();
    const adapter = createGatewayAdapter(ws);
    const runner = new MissionRunner(adapter, () => {}, {
      root: tmpRoot(), stepIdleTimeoutMs: 0, maxPlannerRetries: 0,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'chaos6',
    });
    const mission = await runner.createMission({
      goal: 'x',
      agents: [{ id: 'main' }, { id: 'coder' }, { id: 'tester' }],
    });
    emit({ state: 'final', sessionKey: `agent:main:main`, text: 'I am not JSON' });
    await flush();
    expect(runner.getMission(mission.id)!.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Worker step failure modes
// ---------------------------------------------------------------------------
describe('L3 chaos — worker failure modes', () => {
  async function seed(runner: MissionRunner, emit: (p: any) => void) {
    await runner.createMission({
      goal: 'x',
      agents: [{ id: 'main' }, { id: 'coder' }, { id: 'tester' }],
    });
    emit({
      state: 'final',
      sessionKey: `agent:main:main`,
      text: JSON.stringify({ summary: 's', subtasks: [
        { id: 'T1', agentId: 'main', role: 'L', title: 'a', deliverable: 'd', depends_on: [] },
        { id: 'T2', agentId: 'coder', role: 'D', title: 'b', deliverable: 'd', depends_on: ['T1'] },
        { id: 'T3', agentId: 'tester', role: 'Q', title: 'c', deliverable: 'd', depends_on: ['T2'] },
      ] }),
    });
    await flush();
  }

  it('worker error event fails the step + mission', async () => {
    const { ws, emit } = makeWs();
    const adapter = createGatewayAdapter(ws);
    const runner = new MissionRunner(adapter, () => {}, {
      root: tmpRoot(), stepIdleTimeoutMs: 0,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'chaosW1',
    });
    await seed(runner, emit);
    const workerKey = (ws.chatSend as any).mock.calls[1][0];
    emit({ state: 'error', sessionKey: workerKey, errorMessage: 'provider down' });
    await flush();
    expect(runner.getMission('chaosW1')!.status).toBe('failed');
    expect(runner.getMission('chaosW1')!.steps[0].status).toBe('failed');
  });

  it('worker aborted propagates errorCode=timeout', async () => {
    const { ws, emit } = makeWs();
    const adapter = createGatewayAdapter(ws);
    const runner = new MissionRunner(adapter, () => {}, {
      root: tmpRoot(), stepIdleTimeoutMs: 0,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'chaosW2',
    });
    await seed(runner, emit);
    const workerKey = (ws.chatSend as any).mock.calls[1][0];
    emit({ state: 'aborted', sessionKey: workerKey, errorMessage: 'user aborted' });
    await flush();
    const step = runner.getMission('chaosW2')!.steps[0];
    expect(step.status).toBe('failed');
    expect(step.errorCode).toBe('timeout');
  });

  it('gateway.sendChat throwing for a worker marks step as agent_crash', async () => {
    const { ws, emit } = makeWs();
    // First send (planner) OK, second (T1 worker) throws
    let call = 0;
    (ws.chatSend as any).mockImplementation(async () => {
      call++;
      if (call === 2) throw new Error('ECONN');
      return { runId: `r${call}` };
    });
    const adapter = createGatewayAdapter(ws);
    const runner = new MissionRunner(adapter, () => {}, {
      root: tmpRoot(), stepIdleTimeoutMs: 0,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'chaosW3',
    });
    await seed(runner, emit);
    await flush();
    const step = runner.getMission('chaosW3')!.steps[0];
    expect(step.status).toBe('failed');
    expect(step.errorCode).toBe('agent_crash');
  });

  it('step idle timeout forces failure + abort', async () => {
    const { ws, emit } = makeWs();
    const adapter = createGatewayAdapter(ws);
    const runner = new MissionRunner(adapter, () => {}, {
      root: tmpRoot(), stepIdleTimeoutMs: 50,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'chaosW4',
    });
    await seed(runner, emit);
    // Wait for real timer to fire (50ms idle + buffer).
    await new Promise((r) => setTimeout(r, 120));
    const step = runner.getMission('chaosW4')!.steps[0];
    expect(step.status).toBe('failed');
    expect(step.errorCode).toBe('timeout');
    expect(ws.chatAbort).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Streaming burst / ordering
// ---------------------------------------------------------------------------
describe('L3 chaos — streaming stress', () => {
  it('2000 delta burst is processed without loss + in under 2s', async () => {
    const { ws, emit } = makeWs();
    const adapter = createGatewayAdapter(ws);
    const events: MissionEvent[] = [];
    const runner = new MissionRunner(adapter, (e) => events.push(e), {
      root: tmpRoot(), stepIdleTimeoutMs: 0,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'burst',
    });
    await runner.createMission({
      goal: 'x',
      agents: [{ id: 'main' }, { id: 'coder' }, { id: 'tester' }],
    });
    const key = (ws.chatSend as any).mock.calls[0][0];
    const t0 = Date.now();
    for (let i = 0; i < 2000; i++) {
      emit({ state: 'delta', sessionKey: key, delta: `x` });
    }
    await flush();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(events.filter((e) => e.type === 'planner-delta').length).toBe(2000);
  });

  it('empty delta chunks are ignored (no spam events)', async () => {
    const { ws, emit } = makeWs();
    const adapter = createGatewayAdapter(ws);
    const events: MissionEvent[] = [];
    const runner = new MissionRunner(adapter, (e) => events.push(e), {
      root: tmpRoot(), stepIdleTimeoutMs: 0,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'emptyd',
    });
    await runner.createMission({
      goal: 'x',
      agents: [{ id: 'main' }, { id: 'coder' }, { id: 'tester' }],
    });
    const key = (ws.chatSend as any).mock.calls[0][0];
    emit({ state: 'delta', sessionKey: key, delta: '' });
    emit({ state: 'delta', sessionKey: key, delta: null });
    emit({ state: 'delta', sessionKey: key });
    await flush();
    expect(events.some((e) => e.type === 'planner-delta')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AwarenessBridge failure paths
// ---------------------------------------------------------------------------
describe('L3 chaos — AwarenessBridge fail-safe', () => {
  it('daemon throws → empty string returned (not exception)', async () => {
    const bridge = new AwarenessBridge({
      callTool: async () => { throw new Error('daemon offline'); },
    });
    const out = await bridge.recallForPlanner({ goal: 'x', agents: [{ id: 'main' }] });
    expect(out).toBe('');
  });

  it('daemon returns {error:...} → empty string returned', async () => {
    const bridge = new AwarenessBridge({
      callTool: async () => ({ error: 'not connected' }),
    });
    const out = await bridge.recallForStep({ missionGoal: 'g', stepTitle: 't' });
    expect(out).toBe('');
  });

  it('daemon returns malformed (null, non-object) → empty string', async () => {
    const bridge = new AwarenessBridge({
      callTool: async () => null as any,
    });
    const out = await bridge.recallForPlanner({ goal: 'x' });
    expect(out).toBe('');
  });

  it('failSilent:false rethrows daemon errors', async () => {
    const bridge = new AwarenessBridge(
      { callTool: async () => { throw new Error('boom'); } },
      { failSilent: false },
    );
    await expect(bridge.recallForPlanner({ goal: 'x' })).rejects.toThrow(/boom/);
  });

  it('truncates huge recall results', async () => {
    const bridge = new AwarenessBridge(
      {
        callTool: async () => ({
          content: [{ type: 'text', text: 'A'.repeat(10_000) }],
        }),
      },
      { maxFormattedChars: 500 },
    );
    const out = await bridge.recallForPlanner({ goal: 'x' });
    expect(out.length).toBeLessThan(700);
    expect(out).toContain('truncated');
  });
});

// ---------------------------------------------------------------------------
// Cancel-flow chaos
// ---------------------------------------------------------------------------
describe('L3 chaos — cancellation', () => {
  it('cancelling after plan-ready still emits mission:failed and aborts any run', async () => {
    const { ws, emit } = makeWs();
    const adapter = createGatewayAdapter(ws);
    const events: MissionEvent[] = [];
    const runner = new MissionRunner(adapter, (e) => events.push(e), {
      root: tmpRoot(), stepIdleTimeoutMs: 0,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'cancelA',
    });
    await runner.createMission({
      goal: 'x', agents: [{ id: 'main' }, { id: 'coder' }, { id: 'tester' }],
    });
    emit({
      state: 'final', sessionKey: `agent:main:main`,
      text: JSON.stringify({ summary: 's', subtasks: [
        { id: 'T1', agentId: 'main', role: 'L', title: 'a', deliverable: 'd', depends_on: [] },
        { id: 'T2', agentId: 'coder', role: 'D', title: 'b', deliverable: 'd', depends_on: ['T1'] },
        { id: 'T3', agentId: 'tester', role: 'Q', title: 'c', deliverable: 'd', depends_on: ['T2'] },
      ] }),
    });
    await flush();

    await runner.cancel('cancelA', 'user pressed Esc');
    expect(events.some((e) => e.type === 'mission:failed')).toBe(true);
    expect(ws.chatAbort).toHaveBeenCalled();
  });

  it('cancelling unknown mission is a no-op', async () => {
    const { ws } = makeWs();
    const adapter = createGatewayAdapter(ws);
    const runner = new MissionRunner(adapter, () => {}, {
      root: tmpRoot(), stepIdleTimeoutMs: 0,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'unkn',
    });
    await expect(runner.cancel('does-not-exist')).resolves.toBeUndefined();
  });
});
