/**
 * L2 Integration tests — file-layout + plan-schema + planner-prompt +
 * mission-runner + streaming-bridge + awareness-bridge wired together with
 * ONLY the Gateway WebSocket mocked.
 *
 * These are the "unit modules compose correctly" tests. L3 chaos adds
 * failure paths (disconnects, out-of-order deltas, etc.), L4 runs a real
 * Electron + real Gateway.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MissionRunner, type MissionEvent } from '../../electron/mission/mission-runner';
import { createGatewayAdapter } from '../../electron/mission/streaming-bridge';
import { AwarenessBridge } from '../../electron/mission/awareness-bridge';
import { readMission, readPlan, readArtifact, readMemory } from '../../electron/mission/file-layout';
import { parsePlan } from '../../electron/mission/plan-schema';
import { buildPlannerPrompt, getExamplePlanJson, EXAMPLE_AGENT_IDS } from '../../electron/mission/planner-prompt';

type Listener = (payload: any) => void;

function makeGatewayWs() {
  const listeners = new Set<Listener>();
  const chatSends: any[] = [];
  const ws = {
    chatSend: vi.fn(async (sessionKey: string, text: string) => {
      chatSends.push({ sessionKey, text });
      return { runId: `r-${chatSends.length}` };
    }),
    chatAbort: vi.fn(async () => undefined),
    on: vi.fn((event: string, cb: Listener) => {
      if (event === 'event:chat') listeners.add(cb);
    }),
    off: vi.fn((event: string, cb: Listener) => {
      if (event === 'event:chat') listeners.delete(cb);
    }),
  };
  const emit = (payload: any) => { for (const cb of [...listeners]) cb(payload); };
  return { ws, emit, chatSends };
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mission-l2-int-'));
}

async function flush(n = 3) {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setImmediate(r));
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Integration 1: Planner prompt → LLM final → plan-schema validation → steps spawn → artifact
// ---------------------------------------------------------------------------
describe('mission-integration — full happy path', () => {
  it('produces artifacts + MEMORY.md from a 3-step plan with real file-layout persistence', async () => {
    const root = tmpRoot();
    const { ws, emit, chatSends } = makeGatewayWs();
    const adapter = createGatewayAdapter(ws as any);

    const events: MissionEvent[] = [];
    const runner = new MissionRunner(adapter, (e) => events.push(e), {
      root,
      stepIdleTimeoutMs: 0,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'missn',
      maxPlannerRetries: 0,
    });

    const mission = await runner.createMission({
      goal: 'Produce a weekly digest',
      agents: [
        { id: 'main', name: 'Main' },
        { id: 'coder', name: 'Coder' },
        { id: 'tester', name: 'Tester' },
      ],
    });

    // Planner final
    const plannerKey = chatSends[0].sessionKey;
    emit({
      state: 'final',
      sessionKey: plannerKey,
      text: JSON.stringify({
        summary: 'digest plan',
        subtasks: [
          { id: 'T1', agentId: 'main',   role: 'Lead', title: 'Draft outline', deliverable: 'outline.md', depends_on: [] },
          { id: 'T2', agentId: 'coder',  role: 'Dev',  title: 'Collect data',  deliverable: 'data.json',  depends_on: ['T1'] },
          { id: 'T3', agentId: 'tester', role: 'QA',   title: 'Review copy',   deliverable: 'report.md',  depends_on: ['T2'] },
        ],
      }),
    });
    await flush();

    // Three worker turns happen synchronously in test (awaitApproval defaults to false)
    for (let i = 1; i <= 3; i++) {
      const workerKey = chatSends[i].sessionKey;
      emit({ state: 'final', sessionKey: workerKey, text: `Final output for step T${i}` });
      await flush();
    }

    // ---- Validate persisted mission state ----
    const reloaded = readMission(mission.id, root)!;
    expect(reloaded).toBeTruthy();
    expect(reloaded.status).toBe('done');
    expect(reloaded.steps.map((s) => s.status)).toEqual(['done', 'done', 'done']);

    // ---- Validate plan.json matches validator ----
    const plan = readPlan(mission.id, root)!;
    expect(plan).toBeTruthy();
    const parsed = parsePlan(JSON.stringify(plan), { availableAgentIds: ['main', 'coder', 'tester'] });
    expect(parsed.ok).toBe(true);

    // ---- Validate artifacts ----
    for (const step of reloaded.steps) {
      const body = readArtifact(mission.id, step.id, step.title, root);
      expect(body).toBeTruthy();
      expect(body).toContain(`Final output for step ${step.id}`);
    }

    // ---- Validate MEMORY.md ----
    const memory = readMemory(mission.id, root);
    expect(memory).toContain('T1 done');
    expect(memory).toContain('T2 done');
    expect(memory).toContain('T3 done');

    // ---- Validate event stream types ----
    const types = events.map((e) => e.type);
    expect(types).toContain('planning');
    expect(types).toContain('plan-ready');
    expect(types).toContain('step-started');
    expect(types).toContain('step-ended');
    expect(types).toContain('mission:done');
  });
});

// ---------------------------------------------------------------------------
// Integration 2: Streaming — planner-delta + step-delta flow end-to-end
// ---------------------------------------------------------------------------
describe('mission-integration — streaming path', () => {
  it('every planner + step delta emits a matching MissionEvent with chunk payload', async () => {
    const root = tmpRoot();
    const { ws, emit, chatSends } = makeGatewayWs();
    const adapter = createGatewayAdapter(ws as any);

    const events: MissionEvent[] = [];
    const runner = new MissionRunner(adapter, (e) => events.push(e), {
      root, stepIdleTimeoutMs: 0,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'missn',
    });
    await runner.createMission({
      goal: 'Streaming test',
      agents: [{ id: 'main', name: 'Main' }, { id: 'coder' }, { id: 'tester' }],
    });

    const plannerKey = chatSends[0].sessionKey;
    // Planner streams 10 tokens then finals
    for (let i = 0; i < 10; i++) {
      emit({ state: 'delta', sessionKey: plannerKey, delta: `p${i}` });
    }
    await flush();
    const plannerDeltas = events.filter((e) => e.type === 'planner-delta');
    expect(plannerDeltas.length).toBe(10);
    expect((plannerDeltas[0] as any).chunk).toBe('p0');

    emit({
      state: 'final',
      sessionKey: plannerKey,
      text: JSON.stringify({
        summary: 's',
        subtasks: [
          { id: 'T1', agentId: 'main', role: 'L', title: 'a', deliverable: 'd', depends_on: [] },
          { id: 'T2', agentId: 'coder', role: 'D', title: 'b', deliverable: 'd', depends_on: ['T1'] },
          { id: 'T3', agentId: 'tester', role: 'Q', title: 'c', deliverable: 'd', depends_on: ['T2'] },
        ],
      }),
    });
    await flush();

    // First step streams a few tokens
    const workerKey = chatSends[1].sessionKey;
    for (let i = 0; i < 5; i++) {
      emit({ state: 'delta', sessionKey: workerKey, delta: `w${i}` });
    }
    await flush();
    const stepDeltas = events.filter((e) => e.type === 'step-delta');
    expect(stepDeltas.length).toBeGreaterThanOrEqual(5);
    expect((stepDeltas[0] as any).chunk).toBe('w0');
    expect((stepDeltas[0] as any).stepId).toBe('T1');
  });

  it('payload {delta:{content}} is normalized to chunk', async () => {
    const { ws, emit, chatSends } = makeGatewayWs();
    const adapter = createGatewayAdapter(ws as any);
    const events: MissionEvent[] = [];
    const runner = new MissionRunner(adapter, (e) => events.push(e), {
      root: tmpRoot(), stepIdleTimeoutMs: 0,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'missn2',
    });
    await runner.createMission({
      goal: 'x',
      agents: [{ id: 'main' }, { id: 'coder' }, { id: 'tester' }],
    });
    emit({
      state: 'delta',
      sessionKey: chatSends[0].sessionKey,
      delta: { content: 'hi!' },
    });
    await flush();
    expect((events.find((e) => e.type === 'planner-delta') as any)?.chunk).toBe('hi!');
  });
});

// ---------------------------------------------------------------------------
// Integration 3: AwarenessBridge injection into planner prompt
// ---------------------------------------------------------------------------
describe('mission-integration — awareness-bridge feeds planner prompt', () => {
  it('recallForPlanner result lands in <PastExperience> section of the prompt', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'Past learning: prefer pnpm over npm for monorepos.' }],
    }));
    const bridge = new AwarenessBridge({ callTool });
    const past = await bridge.recallForPlanner({
      goal: 'Upgrade our monorepo',
      agents: [{ id: 'main' }, { id: 'coder' }],
    });
    expect(past).toContain('pnpm');

    const prompt = buildPlannerPrompt({
      goal: 'Upgrade our monorepo',
      agents: [
        { id: 'main', name: 'Main' },
        { id: 'coder', name: 'Coder' },
        { id: 'tester', name: 'Tester' },
      ],
      pastExperience: past,
    });
    expect(prompt).toContain('<PastExperience>');
    expect(prompt).toContain('pnpm');
    expect(prompt).toContain('<AvailableAgents>');
  });

  it('empty recall yields prompt without PastExperience fluff', async () => {
    const bridge = new AwarenessBridge({ callTool: async () => ({}) });
    const past = await bridge.recallForPlanner({ goal: 'x', agents: [{ id: 'main' }] });
    expect(past).toBe('');
    const prompt = buildPlannerPrompt({
      goal: 'x',
      agents: [{ id: 'main' }, { id: 'coder' }, { id: 'tester' }],
      pastExperience: '',
    });
    expect(prompt).not.toContain('pnpm');
  });
});

// ---------------------------------------------------------------------------
// Integration 4: Planner example JSON passes the runtime validator (closed loop)
// ---------------------------------------------------------------------------
describe('mission-integration — planner/plan-schema closed loop', () => {
  it('getExamplePlanJson is valid under parsePlan with EXAMPLE_AGENT_IDS', () => {
    const res = parsePlan(getExamplePlanJson(), { availableAgentIds: [...EXAMPLE_AGENT_IDS] });
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration 5: DAG ordering honored end-to-end
// ---------------------------------------------------------------------------
describe('mission-integration — DAG ordering', () => {
  it('diamond DAG (T1 → {T2,T3} → T4) fires steps in topo-safe order', async () => {
    const root = tmpRoot();
    const { ws, emit, chatSends } = makeGatewayWs();
    const adapter = createGatewayAdapter(ws as any);
    const events: MissionEvent[] = [];
    const runner = new MissionRunner(adapter, (e) => events.push(e), {
      root, stepIdleTimeoutMs: 0,
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'missn3',
    });

    await runner.createMission({
      goal: 'diamond',
      agents: [{ id: 'main' }, { id: 'coder' }, { id: 'tester' }, { id: 'writer' }],
    });

    emit({
      state: 'final',
      sessionKey: chatSends[0].sessionKey,
      text: JSON.stringify({
        summary: 'diamond',
        subtasks: [
          { id: 'T1', agentId: 'main',   role: 'Lead',  title: 'root',   deliverable: 'r',  depends_on: [] },
          { id: 'T2', agentId: 'coder',  role: 'Dev',   title: 'left',   deliverable: 'l',  depends_on: ['T1'] },
          { id: 'T3', agentId: 'tester', role: 'QA',    title: 'right',  deliverable: 'rt', depends_on: ['T1'] },
          { id: 'T4', agentId: 'writer', role: 'Lead',  title: 'merge',  deliverable: 'm',  depends_on: ['T2', 'T3'] },
        ],
      }),
    });
    await flush();

    // Drive each worker to completion in whatever order the runner spawns it.
    // MissionRunner spawns strictly sequentially (not parallel) — so after T1's
    // final, exactly one of T2/T3 is spawned next.
    for (let i = 1; i <= 4; i++) {
      const key = chatSends[i].sessionKey;
      emit({ state: 'final', sessionKey: key, text: `out T${i}` });
      await flush();
    }

    const stepStarts = events
      .filter((e) => e.type === 'step-started')
      .map((e: any) => e.stepId);
    expect(stepStarts[0]).toBe('T1');
    // T4 must come last
    expect(stepStarts[stepStarts.length - 1]).toBe('T4');
    // T2 and T3 both occurred after T1 and before T4
    const idxT1 = stepStarts.indexOf('T1');
    const idxT2 = stepStarts.indexOf('T2');
    const idxT3 = stepStarts.indexOf('T3');
    const idxT4 = stepStarts.indexOf('T4');
    expect(idxT2).toBeGreaterThan(idxT1);
    expect(idxT3).toBeGreaterThan(idxT1);
    expect(idxT4).toBeGreaterThan(idxT2);
    expect(idxT4).toBeGreaterThan(idxT3);
  });
});
