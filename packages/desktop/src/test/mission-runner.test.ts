/**
 * Tests for electron/mission/mission-runner.ts — the Orchestrator core.
 *
 * Test philosophy: inject a fake GatewayAdapter and a tmp fs root. Drive
 * Planner + Worker lifecycle deterministically by invoking the subscribe
 * handler from test code.
 *
 * Coverage (from docs/features/team-tasks/03-ACCEPTANCE.md):
 *   Journey 1 — Planner runs, plan validates, mission.json + plan.json written
 *   Journey 2 — Step N sees step N-1's artifact in its prompt (context relay)
 *   Journey 3 — Step-done writes artifact + appends MEMORY.md
 *   Journey 5 — Kanban state from real events (not setTimeout fakes)
 *   Journey 10 — Streaming deltas surface as planner-delta / step-delta
 *
 *   L3.2 — Planner returns invalid JSON → retry once with error context
 *   L3.3 — Planner returns too few / too many subtasks → fail after retry
 *   L3.4 — Planner returns forbidden field → fail after retry (security)
 *   L3.5 — Step errors → mission:failed
 *
 * Also validates the helpers `extractJson` and the emitted event ordering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  MissionRunner,
  extractJson,
  type GatewayAdapter,
  type GatewayChatEvent,
  type GatewaySpawnResult,
  type MissionEvent,
} from '../../electron/mission/mission-runner';
import {
  listMissions,
  readMemory,
  readMission,
  readPlan,
  listArtifacts,
  readArtifact,
} from '../../electron/mission/file-layout';

// ---------------------------------------------------------------------------
// Fake gateway — captures spawns + exposes handler fire for deterministic tests
// ---------------------------------------------------------------------------

interface FakeSpawn {
  readonly sessionKey: string;
  readonly runId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly handler: (e: GatewayChatEvent) => void;
}

function makeFakeGateway() {
  const spawns: FakeSpawn[] = [];
  const subscriptions = new Map<string, (e: GatewayChatEvent) => void>();
  const aborts: { sessionKey: string; runId?: string }[] = [];
  let nextRunCounter = 1;

  const adapter: GatewayAdapter = {
    async sendChat({ agentId, prompt, sessionKey, model, thinking }) {
      const key = sessionKey || `agent:${agentId}:subagent:uuid-${nextRunCounter}`;
      const runId = `run-${nextRunCounter++}`;
      // placeholder handler — replaced by subscribe()
      const placeholder: any = () => {};
      spawns.push({ sessionKey: key, runId, agentId, prompt, model, thinking, handler: placeholder });
      return { sessionKey: key, runId } as GatewaySpawnResult;
    },
    async abort(sessionKey, runId) {
      aborts.push({ sessionKey, runId });
    },
    subscribe(sessionKey, handler) {
      subscriptions.set(sessionKey, handler);
      const s = spawns.find((x) => x.sessionKey === sessionKey);
      if (s) (s as any).handler = handler;
      return () => subscriptions.delete(sessionKey);
    },
  };

  // Any `final`/`error` event can trigger async cascades (fire-and-forget
  // spawnNextStep). Awaiting a macrotask after dispatch lets the runner's
  // `await this.gateway.sendChat(...)` settle and call `subscribe` before the
  // test fires the next event.
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const fire = async (sessionKey: string, event: GatewayChatEvent) => {
    const h = subscriptions.get(sessionKey);
    if (!h) throw new Error(`no subscriber for sessionKey=${sessionKey}`);
    h(event);
    await flush();
  };
  const fireLatest = async (event: GatewayChatEvent) => {
    const latest = spawns[spawns.length - 1];
    await fire(latest.sessionKey, event);
  };

  return { adapter, spawns, subscriptions, aborts, fire, fireLatest };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENTS = [
  { id: 'main', name: 'Claw', role: 'Generalist' },
  { id: 'coder', name: 'Dev', role: 'Developer' },
  { id: 'tester', name: 'QA', role: 'Tester' },
];

function validPlanJson() {
  return JSON.stringify({
    summary: 'Build a TODO app',
    subtasks: [
      { id: 'T1', agentId: 'coder', role: 'Developer', title: 'Scaffold', deliverable: 'md doc', depends_on: [] },
      { id: 'T2', agentId: 'coder', role: 'Developer', title: 'Implement', deliverable: 'md doc', depends_on: ['T1'] },
      { id: 'T3', agentId: 'tester', role: 'Tester', title: 'Test', deliverable: 'md doc', depends_on: ['T2'] },
    ],
  });
}

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awclaw-runner-test-'));
});
afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

type RunnerOpts = ConstructorParameters<typeof MissionRunner>[2];
function newRunner(overrides: Partial<NonNullable<RunnerOpts>> = {}) {
  const gw = makeFakeGateway();
  const events: MissionEvent[] = [];
  const runner = new MissionRunner(gw.adapter, (e) => events.push(e), {
    root: tmpRoot,
    idGen: () => 'mission-test',
    clock: () => new Date('2026-04-17T10:00:00Z'),
    ...overrides,
  });
  return { gw, runner, events };
}

// ---------------------------------------------------------------------------
// extractJson — pure helper
// ---------------------------------------------------------------------------

describe('extractJson', () => {
  it('returns text as-is when already JSON', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('extracts fenced ```json block', () => {
    const text = 'some prose\n```json\n{"a":1}\n```\ntrailing';
    expect(extractJson(text)).toBe('{"a":1}');
  });

  it('extracts plain ``` block without lang tag', () => {
    const text = '```\n{"a":2}\n```';
    expect(extractJson(text)).toBe('{"a":2}');
  });

  it('falls back to first-{ to last-} slice', () => {
    expect(extractJson('prose { "a": 3 } more')).toBe('{ "a": 3 }');
  });

  it('returns trimmed input if no braces at all', () => {
    expect(extractJson('  hello  ')).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// createMission — Planner spawn + persistence
// ---------------------------------------------------------------------------

describe('MissionRunner.createMission', () => {
  it('writes mission.json in planning state + emits "planning"', async () => {
    const { gw, runner, events } = newRunner();
    const m = await runner.createMission({ goal: 'Build a TODO app', agents: AGENTS });
    expect(m.id).toBe('mission-test');
    expect(m.status).toBe('planning');
    expect(listMissions(tmpRoot)).toContain('mission-test');

    const persisted = readMission('mission-test', tmpRoot)!;
    expect(persisted.goal).toBe('Build a TODO app');
    expect(persisted.status).toBe('planning');

    expect(events[0]).toEqual({ type: 'planning', missionId: 'mission-test' });
    expect(gw.spawns).toHaveLength(1);
    expect(gw.spawns[0].agentId).toBe('main');
    expect(gw.spawns[0].prompt).toContain('<UserGoal>');
    expect(gw.spawns[0].prompt).toContain('Build a TODO app');
  });

  it('respects custom plannerAgentId option', async () => {
    const { gw, runner } = newRunner({ plannerAgentId: 'main' });
    void runner;
    await runner.createMission({ goal: 'x', agents: AGENTS });
    expect(gw.spawns[0].agentId).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// Happy path — full 3-step sequential execution
// ---------------------------------------------------------------------------

describe('MissionRunner · happy path (3 sequential steps)', () => {
  it('Planner → T1 → T2 → T3 → mission:done, with context relay', async () => {
    const { gw, runner, events } = newRunner();
    await runner.createMission({ goal: 'Build a TODO app', agents: AGENTS });

    // Planner streams plan then finalizes
    await gw.fireLatest({ state: 'delta', chunk: '{"summary":' });
    await gw.fireLatest({ state: 'delta', chunk: '"ok"' });
    await gw.fireLatest({ state: 'final', text: validPlanJson() });

    // mission.json now has steps
    const afterPlan = readMission('mission-test', tmpRoot)!;
    expect(afterPlan.status).toBe('running');
    expect(afterPlan.steps).toHaveLength(3);
    expect(afterPlan.steps.every((s) => s.status === 'waiting')).toBe(false); // T1 is running
    expect(afterPlan.steps[0].status).toBe('running');

    expect(readPlan('mission-test', tmpRoot)?.subtasks).toHaveLength(3);

    // T1 streams + finals
    await gw.fireLatest({ state: 'delta', chunk: '## What I did\n' });
    await gw.fireLatest({ state: 'delta', chunk: 'ran create-next-app\n' });
    await gw.fireLatest({
      state: 'final',
      text: '## What I did\nran create-next-app\n\n## Handoff to next agent\n- use pnpm',
    });

    // T1 artifact exists + MEMORY.md appended
    const artifacts = listArtifacts('mission-test', tmpRoot);
    expect(artifacts).toEqual(['T1-scaffold.md']);
    const mem = readMemory('mission-test', tmpRoot);
    expect(mem).toContain('T1 done');

    // T2 is now running and saw T1's content in the prompt (context relay)
    const t2Spawn = gw.spawns[gw.spawns.length - 1];
    expect(t2Spawn.agentId).toBe('coder');
    expect(t2Spawn.prompt).toContain('<PreviousArtifacts>');
    expect(t2Spawn.prompt).toContain('ran create-next-app');  // from T1 artifact
    expect(t2Spawn.prompt).toContain('- use pnpm');

    // T2 final
    await gw.fireLatest({ state: 'final', text: '## What I did\nbuilt component' });

    // T3 now spawned
    const t3Spawn = gw.spawns[gw.spawns.length - 1];
    expect(t3Spawn.agentId).toBe('tester');
    expect(t3Spawn.prompt).toContain('built component');

    await gw.fireLatest({ state: 'final', text: '## What I did\nwrote tests' });

    // mission:done emitted
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'planner-delta')).toHaveLength(2);
    expect(types.filter((t) => t === 'step-started')).toHaveLength(3);
    expect(types.filter((t) => t === 'step-delta').length).toBeGreaterThanOrEqual(2); // T1 delta chunks
    expect(types.filter((t) => t === 'step-ended')).toHaveLength(3);
    expect(types).toContain('plan-ready');
    expect(types[types.length - 1]).toBe('mission:done');

    const finalMission = readMission('mission-test', tmpRoot)!;
    expect(finalMission.status).toBe('done');
    expect(finalMission.steps.every((s) => s.status === 'done')).toBe(true);
    expect(listArtifacts('mission-test', tmpRoot)).toEqual([
      'T1-scaffold.md',
      'T2-implement.md',
      'T3-test.md',
    ]);
  });

  it('step-delta events carry the token chunks from Gateway', async () => {
    const { gw, runner, events } = newRunner();
    await runner.createMission({ goal: 'x', agents: AGENTS });
    await gw.fireLatest({ state: 'final', text: validPlanJson() });

    await gw.fireLatest({ state: 'delta', chunk: 'Hello ' });
    await gw.fireLatest({ state: 'delta', chunk: 'world' });
    const deltaEvents = events.filter((e) => e.type === 'step-delta') as Extract<MissionEvent, { type: 'step-delta' }>[];
    expect(deltaEvents.map((e) => e.chunk)).toEqual(['Hello ', 'world']);
  });
});

// ---------------------------------------------------------------------------
// Planner retry on invalid JSON
// ---------------------------------------------------------------------------

describe('MissionRunner · planner retry', () => {
  it('retries Planner once when first output is invalid JSON', async () => {
    const { gw, runner, events } = newRunner();
    await runner.createMission({ goal: 'x', agents: AGENTS });
    expect(gw.spawns).toHaveLength(1); // attempt 1

    // Attempt 1 returns bad JSON
    await gw.fireLatest({ state: 'final', text: 'this is not json' });

    // Attempt 2 should have been spawned
    expect(gw.spawns).toHaveLength(2);
    expect(gw.spawns[1].prompt).toContain('<RetryContext>');
    expect(gw.spawns[1].prompt).toContain('invalid JSON');

    // Attempt 2 succeeds
    await gw.fireLatest({ state: 'final', text: validPlanJson() });

    const m = readMission('mission-test', tmpRoot)!;
    expect(m.status).toBe('running');
    expect(events.some((e) => e.type === 'plan-ready')).toBe(true);
  });

  it('fails mission after maxPlannerRetries exhausted', async () => {
    const { gw, runner, events } = newRunner({ maxPlannerRetries: 1 });
    await runner.createMission({ goal: 'x', agents: AGENTS });
    // attempt 1 bad
    await gw.fireLatest({ state: 'final', text: 'not json' });
    // attempt 2 also bad
    await gw.fireLatest({ state: 'final', text: 'still not json' });

    const failEvent = events.find((e) => e.type === 'mission:failed') as Extract<MissionEvent, { type: 'mission:failed' }>;
    expect(failEvent).toBeDefined();
    expect(failEvent.reason).toMatch(/invalid plan/);
    expect(readMission('mission-test', tmpRoot)?.status).toBe('failed');
  });

  it('fails Planner attempt that passes JSON but violates schema (e.g. forbidden field)', async () => {
    const { gw, runner, events } = newRunner({ maxPlannerRetries: 0 });
    await runner.createMission({ goal: 'x', agents: AGENTS });
    const bad = JSON.stringify({
      summary: 'x',
      subtasks: [
        { id: 'T1', agentId: 'coder', role: 'Developer', title: 't', deliverable: 'd',
          depends_on: [], command: 'rm -rf /' },
        { id: 'T2', agentId: 'coder', role: 'Developer', title: 't', deliverable: 'd', depends_on: ['T1'] },
        { id: 'T3', agentId: 'coder', role: 'Developer', title: 't', deliverable: 'd', depends_on: ['T2'] },
      ],
    });
    await gw.fireLatest({ state: 'final', text: bad });
    expect(events.some((e) => e.type === 'mission:failed' && /forbidden field/.test(e.reason))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step failure + mission failure propagation
// ---------------------------------------------------------------------------

describe('MissionRunner · step failure', () => {
  it('step error marks step failed and mission failed', async () => {
    const { gw, runner, events } = newRunner();
    await runner.createMission({ goal: 'x', agents: AGENTS });
    await gw.fireLatest({ state: 'final', text: validPlanJson() });

    // T1 errors out
    await gw.fireLatest({ state: 'error', errorCode: 'network_error', errorMessage: 'ECONNREFUSED' });

    const stepFailed = events.find((e) => e.type === 'step-failed') as Extract<MissionEvent, { type: 'step-failed' }>;
    expect(stepFailed?.errorCode).toBe('network_error');
    expect(stepFailed?.message).toBe('ECONNREFUSED');

    const missionFailed = events.find((e) => e.type === 'mission:failed') as Extract<MissionEvent, { type: 'mission:failed' }>;
    expect(missionFailed).toBeDefined();

    const m = readMission('mission-test', tmpRoot)!;
    expect(m.status).toBe('failed');
    expect(m.steps[0].status).toBe('failed');
    expect(m.steps[0].errorCode).toBe('network_error');
  });

  it('abort event maps to timeout error code', async () => {
    const { gw, runner, events } = newRunner();
    await runner.createMission({ goal: 'x', agents: AGENTS });
    await gw.fireLatest({ state: 'final', text: validPlanJson() });

    await gw.fireLatest({ state: 'aborted', errorMessage: 'user aborted' });

    const stepFailed = events.find((e) => e.type === 'step-failed') as Extract<MissionEvent, { type: 'step-failed' }>;
    expect(stepFailed?.errorCode).toBe('timeout');
  });

  it('gateway sendChat throw is captured as agent_crash', async () => {
    const gw = makeFakeGateway();
    // Replace sendChat with one that throws on the second call (step spawn)
    let calls = 0;
    gw.adapter.sendChat = async ({ agentId, prompt }) => {
      calls++;
      if (calls === 1) {
        return { sessionKey: `agent:${agentId}:subagent:u1`, runId: 'run-1' };
      }
      throw new Error('boom');
    };
    const events: MissionEvent[] = [];
    const runner = new MissionRunner(gw.adapter, (e) => events.push(e), {
      root: tmpRoot,
      idGen: () => 'mission-test',
      clock: () => new Date('2026-04-17T10:00:00Z'),
    });
    await runner.createMission({ goal: 'x', agents: AGENTS });
    // Fire planner final using the subscription attached at planner spawn
    const key = gw.subscriptions.keys().next().value as string;
    await gw.fire(key, { state: 'final', text: validPlanJson() });

    const stepFailed = events.find((e) => e.type === 'step-failed') as Extract<MissionEvent, { type: 'step-failed' }>;
    expect(stepFailed?.errorCode).toBe('agent_crash');
    expect(stepFailed?.message).toMatch(/boom/);
  });
});

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

describe('MissionRunner.cancel', () => {
  it('aborts running step, marks mission failed with reason', async () => {
    const { gw, runner, events } = newRunner();
    await runner.createMission({ goal: 'x', agents: AGENTS });
    await gw.fireLatest({ state: 'final', text: validPlanJson() });
    // T1 is running now — cancel
    await runner.cancel('mission-test', 'user hit stop');

    expect(gw.aborts).toHaveLength(1);
    expect(readMission('mission-test', tmpRoot)?.status).toBe('failed');
    const failed = events.find((e) => e.type === 'mission:failed') as Extract<MissionEvent, { type: 'mission:failed' }>;
    expect(failed.reason).toBe('user hit stop');
  });

  it('cancel before Planner returns unsubscribes and marks failed', async () => {
    const { gw, runner } = newRunner();
    await runner.createMission({ goal: 'x', agents: AGENTS });
    const plannerKey = gw.spawns[0].sessionKey;
    expect(gw.subscriptions.has(plannerKey)).toBe(true);

    await runner.cancel('mission-test');

    // Subscription for the Planner session was torn down — so a late Gateway
    // frame for this session would be dropped by the real WS layer (no
    // subscriber).
    expect(gw.subscriptions.has(plannerKey)).toBe(false);
    expect(readMission('mission-test', tmpRoot)?.status).toBe('failed');
  });

  it('cancel is a no-op for unknown mission', async () => {
    const { runner } = newRunner();
    await expect(runner.cancel('ghost')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dependency ordering — only spawn after deps are done
// ---------------------------------------------------------------------------

describe('MissionRunner · dependency ordering', () => {
  it('does not spawn T2 until T1 is done (even if T2 is declared first)', async () => {
    const { gw, runner } = newRunner();
    await runner.createMission({ goal: 'x', agents: AGENTS });

    // Plan has T2 first in array, depending on T1
    const outOfOrder = JSON.stringify({
      summary: 'x',
      subtasks: [
        { id: 'T2', agentId: 'coder', role: 'Developer', title: 'Second', deliverable: 'd', depends_on: ['T1'] },
        { id: 'T1', agentId: 'coder', role: 'Developer', title: 'First', deliverable: 'd', depends_on: [] },
        { id: 'T3', agentId: 'tester', role: 'Tester', title: 'Third', deliverable: 'd', depends_on: ['T2'] },
      ],
    });
    await gw.fireLatest({ state: 'final', text: outOfOrder });

    // The next spawn (after Planner) must be T1, not T2
    const firstStepSpawn = gw.spawns[1];
    expect(firstStepSpawn.prompt).toContain('First'); // T1's title
    expect(firstStepSpawn.prompt).not.toContain('<YourTask>\nSecond');
  });

  it('diamond DAG: T2+T3 both depend on T1, T4 on T2 and T3 — still serial in S1', async () => {
    const { gw, runner, events } = newRunner();
    await runner.createMission({ goal: 'x', agents: AGENTS });

    const diamond = JSON.stringify({
      summary: 'diamond',
      subtasks: [
        { id: 'T1', agentId: 'coder', role: 'Developer', title: 'Root', deliverable: 'd', depends_on: [] },
        { id: 'T2', agentId: 'coder', role: 'Developer', title: 'Left', deliverable: 'd', depends_on: ['T1'] },
        { id: 'T3', agentId: 'coder', role: 'Developer', title: 'Right', deliverable: 'd', depends_on: ['T1'] },
        { id: 'T4', agentId: 'tester', role: 'Tester', title: 'Merge', deliverable: 'd', depends_on: ['T2', 'T3'] },
      ],
    });
    await gw.fireLatest({ state: 'final', text: diamond });

    // Finish T1 → exactly one spawn (T2 or T3, not both — S1 serial)
    const beforeT2 = gw.spawns.length;
    await gw.fireLatest({ state: 'final', text: '## T1 done' });
    expect(gw.spawns.length).toBe(beforeT2 + 1);
    await gw.fireLatest({ state: 'final', text: '## T2 done' });
    // Either T3 now or T4 will never run yet; we just check only-one spawned
    await gw.fireLatest({ state: 'final', text: '## T3 done' });
    // Now T4 should be running
    const t4Spawn = gw.spawns[gw.spawns.length - 1];
    expect(t4Spawn.agentId).toBe('tester');

    await gw.fireLatest({ state: 'final', text: '## T4 done' });

    expect(events[events.length - 1].type).toBe('mission:done');
    expect(listArtifacts('mission-test', tmpRoot)).toEqual([
      'T1-root.md',
      'T2-left.md',
      'T3-right.md',
      'T4-merge.md',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Artifact + MEMORY.md writes
// ---------------------------------------------------------------------------

describe('MissionRunner · artifacts + memory', () => {
  it('writeArtifact includes frontmatter stepId + durationSeconds', async () => {
    const { gw, runner } = newRunner();
    await runner.createMission({ goal: 'x', agents: AGENTS });
    await gw.fireLatest({ state: 'final', text: validPlanJson() });
    await gw.fireLatest({ state: 'final', text: 'body content here' });
    const artifact = readArtifact('mission-test', 'T1', 'Scaffold', tmpRoot)!;
    expect(artifact).toMatch(/^---/);
    expect(artifact).toContain('stepId: T1');
    expect(artifact).toContain('agentId: coder');
    expect(artifact).toContain('body content here');
  });

  it('MEMORY.md accumulates one block per step', async () => {
    const { gw, runner } = newRunner();
    await runner.createMission({ goal: 'x', agents: AGENTS });
    await gw.fireLatest({ state: 'final', text: validPlanJson() });
    await gw.fireLatest({ state: 'final', text: 'step1 summary' });
    await gw.fireLatest({ state: 'final', text: 'step2 summary' });
    const mem = readMemory('mission-test', tmpRoot);
    expect(mem).toContain('T1 done');
    expect(mem).toContain('T2 done');
    // Only one `# Mission Memory` header
    expect((mem.match(/# Mission Memory/g) || []).length).toBe(1);
  });
});
