/**
 * Performance + stability guards for MissionRunner.
 *
 * Covers:
 *   - L3.7  · step idle timeout fires when Gateway goes quiet (hang detection)
 *   - L3.12 · high-frequency deltas do not stall the event loop
 *   - 02-FILE-LAYOUT · MEMORY.md read is capped when file is huge
 *   - 02-FILE-LAYOUT · previous-artifact read is capped per file
 *   - capTail / capMiddle unit tests
 *
 * These tests are the defense against "mission works for 10 min then app
 * freezes" regressions the user explicitly flagged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  MissionRunner,
  capMiddle,
  capTail,
  type GatewayAdapter,
  type GatewayChatEvent,
  type MissionEvent,
} from '../../electron/mission/mission-runner';
import { appendMemory } from '../../electron/mission/file-layout';

const AGENTS = [
  { id: 'main', name: 'Claw', role: 'Generalist' },
  { id: 'coder', name: 'Dev', role: 'Developer' },
];

function validPlanJson() {
  return JSON.stringify({
    summary: 'x',
    subtasks: [
      { id: 'T1', agentId: 'coder', role: 'Developer', title: 'Scaffold', deliverable: 'md', depends_on: [] },
      { id: 'T2', agentId: 'coder', role: 'Developer', title: 'Build', deliverable: 'md', depends_on: ['T1'] },
      { id: 'T3', agentId: 'coder', role: 'Developer', title: 'Review', deliverable: 'md', depends_on: ['T2'] },
    ],
  });
}

function makeFakeGateway() {
  const subscriptions = new Map<string, (e: GatewayChatEvent) => void>();
  const spawns: any[] = [];
  const aborts: { sessionKey: string; runId?: string }[] = [];
  let counter = 1;

  const adapter: GatewayAdapter = {
    async sendChat({ agentId, prompt, sessionKey, model, thinking }) {
      const key = sessionKey || `agent:${agentId}:subagent:uuid-${counter}`;
      const runId = `run-${counter++}`;
      spawns.push({ sessionKey: key, runId, agentId, prompt, model, thinking });
      return { sessionKey: key, runId };
    },
    async abort(sessionKey, runId) {
      aborts.push({ sessionKey, runId });
    },
    subscribe(sessionKey, handler) {
      subscriptions.set(sessionKey, handler);
      return () => subscriptions.delete(sessionKey);
    },
  };

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const fire = async (sessionKey: string, ev: GatewayChatEvent) => {
    const h = subscriptions.get(sessionKey);
    if (!h) throw new Error(`no subscriber for ${sessionKey}`);
    h(ev);
    await flush();
  };
  const fireLatest = async (ev: GatewayChatEvent) => {
    const last = spawns[spawns.length - 1];
    await fire(last.sessionKey, ev);
  };
  /** Synchronously fire (no microtask flush) — for high-frequency delta perf tests. */
  const fireSync = (sessionKey: string, ev: GatewayChatEvent) => {
    const h = subscriptions.get(sessionKey);
    if (!h) throw new Error(`no subscriber for ${sessionKey}`);
    h(ev);
  };

  return { adapter, spawns, subscriptions, aborts, fire, fireLatest, fireSync };
}

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awclaw-runner-perf-'));
});
afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// capTail / capMiddle — pure helpers
// ---------------------------------------------------------------------------

describe('capTail', () => {
  it('returns input unchanged when under cap', () => {
    expect(capTail('hello', 1000)).toBe('hello');
  });

  it('keeps the tail when over cap', () => {
    const input = 'A'.repeat(100) + 'TAIL';
    const result = capTail(input, 50);
    expect(result).toContain('TAIL');
    expect(result.length).toBeLessThan(input.length);
    expect(result).toMatch(/truncated \d+ chars from head/);
  });

  it('is no-op when maxBytes is <=0 or non-finite', () => {
    expect(capTail('abc', 0)).toBe('abc');
    expect(capTail('abc', Number.POSITIVE_INFINITY)).toBe('abc');
    expect(capTail('abc', Number.NaN)).toBe('abc');
  });
});

describe('capMiddle', () => {
  it('returns input unchanged when under cap', () => {
    expect(capMiddle('hello', 1000)).toBe('hello');
  });

  it('keeps head (first 25%) and tail (last 75%) with marker', () => {
    const head = 'HEAD'.repeat(20);  // 80 chars
    const middle = 'M'.repeat(1000);
    const tail = 'TAIL'.repeat(20);  // 80 chars
    const input = head + middle + tail;
    const result = capMiddle(input, 200);
    expect(result).toContain('HEAD');
    expect(result).toContain('TAIL');
    expect(result).toMatch(/truncated \d+ chars from middle/);
    // Head preserved from the very beginning
    expect(result.startsWith('HEAD')).toBe(true);
    // Tail preserved at the very end
    expect(result.endsWith('TAIL')).toBe(true);
  });

  it('returns input unchanged for invalid cap', () => {
    expect(capMiddle('abc', 0)).toBe('abc');
    expect(capMiddle('abc', -1)).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// MEMORY.md read cap — prevents main-thread stall on huge memory file
// ---------------------------------------------------------------------------

describe('MissionRunner · MEMORY.md read cap', () => {
  it('truncates huge MEMORY.md before injecting into worker prompt', async () => {
    const gw = makeFakeGateway();
    const events: MissionEvent[] = [];
    const runner = new MissionRunner(gw.adapter, (e) => events.push(e), {
      root: tmpRoot,
      idGen: () => 'mission-big-mem',
      clock: () => new Date('2026-04-17T10:00:00Z'),
      memoryReadCapBytes: 500, // tiny cap for test
    });

    // Start mission + finish Planner
    await runner.createMission({ goal: 'x', agents: AGENTS });
    await gw.fireLatest({ state: 'final', text: validPlanJson() });

    // Finish T1 with a huge markdown body — this will balloon MEMORY.md via
    // appendMemory() in the runner's happy-path. We also pre-pollute MEMORY.md
    // directly to make the cap trigger on T2's prompt build.
    appendMemory('mission-big-mem', 'PRE'.repeat(1000), tmpRoot);
    await gw.fireLatest({ state: 'final', text: 'step 1 output' });

    // T2 spawn now has a capped sharedMemory
    const t2Spawn = gw.spawns[gw.spawns.length - 1];
    expect(t2Spawn.prompt).toContain('<SharedMemory>');
    expect(t2Spawn.prompt).toMatch(/truncated \d+ chars from middle/);
    // Prompt length is much smaller than raw memory would have been
    const sharedBlockMatch = t2Spawn.prompt.match(/<SharedMemory>\n([\s\S]*?)\n<\/SharedMemory>/);
    expect(sharedBlockMatch).toBeTruthy();
    expect(sharedBlockMatch![1].length).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Artifact read cap — prevents a single outlier step from blowing context
// ---------------------------------------------------------------------------

describe('MissionRunner · artifact read cap', () => {
  it('truncates huge previous-artifact before injecting into next step', async () => {
    const gw = makeFakeGateway();
    const events: MissionEvent[] = [];
    const runner = new MissionRunner(gw.adapter, (e) => events.push(e), {
      root: tmpRoot,
      idGen: () => 'mission-big-artifact',
      clock: () => new Date('2026-04-17T10:00:00Z'),
      artifactReadCapBytes: 200,   // tiny cap
    });

    await runner.createMission({ goal: 'x', agents: AGENTS });
    await gw.fireLatest({ state: 'final', text: validPlanJson() });

    // T1 emits a huge body
    const huge = 'X'.repeat(10_000) + '\n## Handoff to next agent\n- tail content';
    await gw.fireLatest({ state: 'final', text: huge });

    // T2's prompt sees only a cap-length tail with "truncated from head" marker
    const t2Spawn = gw.spawns[gw.spawns.length - 1];
    expect(t2Spawn.prompt).toContain('<PreviousArtifacts>');
    expect(t2Spawn.prompt).toMatch(/truncated \d+ chars from head/);
    expect(t2Spawn.prompt).toContain('tail content');  // tail survived
    // X-run should be mostly trimmed — we expect well under 10_000 Xs to slip through
    const xCount = (t2Spawn.prompt.match(/X/g) || []).length;
    expect(xCount).toBeLessThan(500);  // cap 200 + a small prompt-frame window
  });
});

// ---------------------------------------------------------------------------
// Step idle timeout — L3.7 hang detection
// ---------------------------------------------------------------------------

describe('MissionRunner · step idle timeout', () => {
  // Use fake timers only for timeouts; keep setImmediate real for microtask flushes.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts step + fails mission when Gateway goes quiet for longer than stepIdleTimeoutMs', async () => {
    const gw = makeFakeGateway();
    const events: MissionEvent[] = [];
    const runner = new MissionRunner(gw.adapter, (e) => events.push(e), {
      root: tmpRoot,
      idGen: () => 'mission-hang',
      clock: () => new Date('2026-04-17T10:00:00Z'),
      stepIdleTimeoutMs: 1000,   // 1 s for the test
    });

    await runner.createMission({ goal: 'x', agents: AGENTS });
    await gw.fireLatest({ state: 'final', text: validPlanJson() });

    // T1 is running. Fire one delta then go silent.
    await gw.fireLatest({ state: 'delta', chunk: 'starting...' });

    // No further events for 1.5 s → idle timer should fire
    await vi.advanceTimersByTimeAsync(1500);

    // Let microtasks flush the abort + failStep cascade
    await new Promise((resolve) => setImmediate(resolve));

    const stepFailed = events.find((e) => e.type === 'step-failed') as Extract<MissionEvent, { type: 'step-failed' }>;
    expect(stepFailed).toBeDefined();
    expect(stepFailed.errorCode).toBe('timeout');
    expect(stepFailed.message).toMatch(/idle for \d+s/);

    const missionFailed = events.find((e) => e.type === 'mission:failed');
    expect(missionFailed).toBeDefined();

    // Gateway.abort was invoked for the stuck session
    expect(gw.aborts).toHaveLength(1);
  });

  it('does NOT fire timeout when deltas arrive within the window (reset behavior)', async () => {
    const gw = makeFakeGateway();
    const events: MissionEvent[] = [];
    const runner = new MissionRunner(gw.adapter, (e) => events.push(e), {
      root: tmpRoot,
      idGen: () => 'mission-active',
      clock: () => new Date('2026-04-17T10:00:00Z'),
      stepIdleTimeoutMs: 1000,
    });

    await runner.createMission({ goal: 'x', agents: AGENTS });
    await gw.fireLatest({ state: 'final', text: validPlanJson() });

    // Fire a delta every 500 ms × 5 — never idle for 1s
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(500);
      await gw.fireLatest({ state: 'delta', chunk: `chunk ${i} ` });
    }

    // Confirm no timeout fired yet
    expect(events.some((e) => e.type === 'step-failed')).toBe(false);

    // Finalize T1 normally. T2 is now running and has its own fresh idle timer,
    // but the timer for T1's original session is gone (final cleared it).
    await gw.fireLatest({ state: 'final', text: 'ok' });

    // Not enough silent time for T2's idle timer to fire yet (its budget is
    // still 1 s and we have not advanced that far).
    await vi.advanceTimersByTimeAsync(500);
    expect(events.some((e) => e.type === 'step-failed')).toBe(false);
    // T1 completed cleanly with step-ended
    expect(events.some((e) => e.type === 'step-ended')).toBe(true);
  });

  it('is disabled when stepIdleTimeoutMs = 0', async () => {
    const gw = makeFakeGateway();
    const events: MissionEvent[] = [];
    const runner = new MissionRunner(gw.adapter, (e) => events.push(e), {
      root: tmpRoot,
      idGen: () => 'mission-no-idle',
      clock: () => new Date('2026-04-17T10:00:00Z'),
      stepIdleTimeoutMs: 0,
    });

    await runner.createMission({ goal: 'x', agents: AGENTS });
    await gw.fireLatest({ state: 'final', text: validPlanJson() });

    await vi.advanceTimersByTimeAsync(60_000);  // 1 min of silence
    expect(events.some((e) => e.type === 'step-failed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// High-frequency delta — does not stall
// ---------------------------------------------------------------------------

describe('MissionRunner · high-frequency delta burst', () => {
  it('handles 2000 delta events in a single step without blocking', async () => {
    const gw = makeFakeGateway();
    const events: MissionEvent[] = [];
    const runner = new MissionRunner(gw.adapter, (e) => events.push(e), {
      root: tmpRoot,
      idGen: () => 'mission-burst',
      clock: () => new Date('2026-04-17T10:00:00Z'),
      stepIdleTimeoutMs: 60_000,
    });

    await runner.createMission({ goal: 'x', agents: AGENTS });
    await gw.fireLatest({ state: 'final', text: validPlanJson() });

    // T1 is running; the session key is the subagent that just got spawned.
    const t1Key = gw.spawns[gw.spawns.length - 1].sessionKey;

    const start = Date.now();
    for (let i = 0; i < 2000; i++) {
      gw.fireSync(t1Key, { state: 'delta', chunk: 'x' });
    }
    const elapsed = Date.now() - start;

    // Generous budget to avoid CI flakiness — 2000 deltas should be well under
    // a second of pure JS + emit. On a slow CI shouldn't exceed ~800ms.
    expect(elapsed).toBeLessThan(2000);

    const deltaEventCount = events.filter((e) => e.type === 'step-delta').length;
    expect(deltaEventCount).toBe(2000);

    // Finalize cleanly
    await gw.fire(t1Key, { state: 'final', text: 'done' });
    // Final emits step-ended
    expect(events.some((e) => e.type === 'step-ended')).toBe(true);
  });
});
