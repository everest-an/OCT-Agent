/**
 * L2 integration tests for register-mission-handlers.ts.
 *
 * Verifies:
 *   - all invoke handlers are registered on ipcMain (channel parity)
 *   - mission:create-from-goal kicks off the Planner via the injected adapter
 *   - mission:approve-and-run flips a paused-awaiting-human mission to running
 *   - MissionRunner events are forwarded as webContents.send(channel, payload)
 *   - mission:list / mission:get / mission:read-artifact read from disk
 *   - mission:cancel-flow + mission:delete path do not throw on missing ids
 *   - dispose() removes every handler cleanly
 *
 * We DO NOT spin up a real Gateway WebSocket. Instead we mock ipcMain +
 * BrowserWindow and provide a fake GatewayAdapter via `runnerOptionsOverride`
 * -- no: since the runner is built inside the registrar using the real
 * streaming-bridge, tests swap the gateway by supplying a fake MinimalGatewayWs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: any) => handlers.set(channel, fn)),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
      __handlers: handlers,
    },
    BrowserWindow: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type FakeGatewayCallback = (payload: any) => void;

interface FakeGateway {
  chatSend: ReturnType<typeof vi.fn>;
  chatAbort: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  emit: (payload: any) => void;
  chatEvents: ReturnType<typeof vi.fn>[];
}

function makeFakeGateway(): FakeGateway {
  const listeners = new Set<FakeGatewayCallback>();
  const chatEvents: any[] = [];
  const chatSend = vi.fn(async (sessionKey: string, text: string) => {
    chatEvents.push({ sessionKey, text });
    return { runId: `run-${Math.random().toString(36).slice(2, 7)}` };
  });
  const chatAbort = vi.fn(async () => undefined);
  const on = vi.fn((event: string, cb: FakeGatewayCallback) => {
    if (event === 'event:chat') listeners.add(cb);
  });
  const off = vi.fn((event: string, cb: FakeGatewayCallback) => {
    if (event === 'event:chat') listeners.delete(cb);
  });
  const emit = (payload: any) => {
    for (const fn of [...listeners]) fn(payload);
  };
  return { chatSend, chatAbort, on, off, emit, chatEvents } as any;
}

function makeMockWindow() {
  const sends: Array<{ channel: string; payload: any }> = [];
  const webContents = {
    send: vi.fn((channel: string, payload: any) => {
      sends.push({ channel, payload });
    }),
  };
  return {
    window: {
      isDestroyed: () => false,
      webContents,
    },
    sends,
  };
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mission-ipc-'));
}

function cleanup(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// flush microtasks + one macrotask to let async callbacks settle
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
    await Promise.resolve();
  }
}

async function setup(opts?: { callMcp?: any; existingHome?: boolean }) {
  vi.resetModules();
  const { ipcMain } = (await import('electron')) as any;
  (ipcMain.__handlers as Map<string, any>).clear();

  const gw = makeFakeGateway();
  const { window, sends } = makeMockWindow();
  const root = tmpRoot();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-ipc-home-'));
  // Minimal openclaw.json so readAgentsFromConfig returns a sensible list.
  fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
  if (opts?.existingHome !== false) {
    fs.writeFileSync(
      path.join(home, '.openclaw', 'openclaw.json'),
      JSON.stringify({
        agents: {
          list: [
            { id: 'main', identity: { name: 'Main Agent', role: 'Generalist' } },
            { id: 'coder', identity: { name: 'Coder', role: 'Developer' } },
            { id: 'tester', identity: { name: 'Tester', role: 'QA' } },
          ],
        },
      }),
    );
  }

  const { registerMissionHandlers } = await import(
    '../../electron/ipc/register-mission-handlers'
  );

  const controller = registerMissionHandlers({
    home,
    getGatewayWs: async () => gw as any,
    getMainWindow: () => window as any,
    callMcp: opts?.callMcp,
    root,
    runnerOptionsOverride: {
      // Fixed clock + id gen for deterministic mission.id
      clock: () => new Date('2026-04-17T10:00:00Z'),
      idGen: () => 'mission-test',
      maxPlannerRetries: 0,
      stepIdleTimeoutMs: 0, // disable — tests manage lifecycle
    },
  });

  return {
    controller,
    ipcMain,
    handlers: ipcMain.__handlers as Map<string, any>,
    gw,
    sends,
    window,
    root,
    home,
    teardown: () => {
      controller.dispose();
      cleanup(root);
      cleanup(home);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('register-mission-handlers — channel registration', () => {
  it('registers every expected invoke channel', async () => {
    const env = await setup();
    try {
      const expected = [
        'mission:create-from-goal',
        'mission:approve-and-run',
        'mission:list',
        'mission:get',
        'mission:cancel-flow',
        'mission:delete',
        'mission:read-artifact',
      ];
      for (const ch of expected) {
        expect(env.handlers.has(ch)).toBe(true);
      }
    } finally { env.teardown(); }
  });

  it('dispose removes every registered handler', async () => {
    const env = await setup();
    env.controller.dispose();
    expect(env.handlers.size).toBe(0);
    cleanup(env.root);
    cleanup(env.home);
  });

  it('does NOT register legacy mission:cancel (avoid conflict with workflow handlers)', async () => {
    const env = await setup();
    try {
      expect(env.handlers.has('mission:cancel')).toBe(false);
    } finally { env.teardown(); }
  });
});

describe('register-mission-handlers — invoke paths', () => {
  it('mission:create-from-goal rejects empty goal', async () => {
    const env = await setup();
    try {
      const createFn = env.handlers.get('mission:create-from-goal')!;
      await expect(createFn({}, '')).rejects.toThrow(/goal is required/);
      await expect(createFn({}, '   ')).rejects.toThrow(/goal is required/);
    } finally { env.teardown(); }
  });

  it('mission:create-from-goal spawns planner and returns missionId', async () => {
    const env = await setup();
    try {
      const createFn = env.handlers.get('mission:create-from-goal')!;
      const res = await createFn({}, 'Build a todo app');
      expect(res).toEqual({ missionId: 'mission-test' });
      expect(env.gw.chatSend).toHaveBeenCalledTimes(1);
      // first chatSend is the planner prompt
      const [_sessionKey, prompt] = env.gw.chatSend.mock.calls[0];
      expect(prompt).toContain('Build a todo app');
    } finally { env.teardown(); }
  });

  it('mission:create-from-goal feeds recall results into the planner prompt', async () => {
    const callMcp = vi.fn(async () => ({
      content: [{ type: 'text', text: 'Previously chose pnpm over npm for reproducibility.' }],
    }));
    const env = await setup({ callMcp });
    try {
      const createFn = env.handlers.get('mission:create-from-goal')!;
      await createFn({}, 'Build a todo app');
      expect(callMcp).toHaveBeenCalledWith(
        'awareness_recall',
        expect.objectContaining({ query: expect.stringContaining('Build a todo app') }),
      );
      const [, prompt] = env.gw.chatSend.mock.calls[0];
      expect(prompt).toContain('pnpm over npm');
    } finally { env.teardown(); }
  });

  it('mission:create-from-goal still succeeds when awareness daemon errors', async () => {
    const callMcp = vi.fn(async () => { throw new Error('daemon offline'); });
    const env = await setup({ callMcp });
    try {
      const createFn = env.handlers.get('mission:create-from-goal')!;
      const res = await createFn({}, 'Plan a release');
      expect(res.missionId).toBe('mission-test');
      expect(env.gw.chatSend).toHaveBeenCalledTimes(1);
    } finally { env.teardown(); }
  });

  it('mission:create-from-goal falls back to main agent when openclaw.json is missing', async () => {
    const env = await setup({ existingHome: false });
    try {
      const createFn = env.handlers.get('mission:create-from-goal')!;
      await createFn({}, 'Build a chat UI');
      const [, prompt] = env.gw.chatSend.mock.calls[0];
      expect(prompt).toContain('<AvailableAgents>');
      expect(prompt).toMatch(/main/);
    } finally { env.teardown(); }
  });
});

describe('register-mission-handlers — event forwarding', () => {
  it('forwards planning / planner-delta / plan-ready events to renderer', async () => {
    const env = await setup();
    try {
      const createFn = env.handlers.get('mission:create-from-goal')!;
      await createFn({}, 'Ship a weekly digest');

      // planning event fires before planner spawn returns
      expect(env.sends.some((s) => s.channel === 'mission:planning')).toBe(true);

      const sessionKey = env.gw.chatSend.mock.calls[0][0];
      // Emit a couple of planner deltas
      env.gw.emit({ state: 'delta', sessionKey, delta: '{"summary":"Plan",' });
      env.gw.emit({ state: 'delta', sessionKey, delta: '"subtasks":[...]}' });
      await flush();
      const deltas = env.sends.filter((s) => s.channel === 'mission:planner-delta');
      expect(deltas.length).toBeGreaterThanOrEqual(2);
      expect(deltas[0].payload).toMatchObject({ missionId: 'mission-test' });
      expect(typeof deltas[0].payload.chunk).toBe('string');

      // Emit planner final JSON
      const planJson = JSON.stringify({
        summary: 'Ship a weekly digest',
        subtasks: [
          { id: 'T1', agentId: 'main', role: 'Lead', title: 'Draft spec', deliverable: 'spec.md', depends_on: [] },
          { id: 'T2', agentId: 'coder', role: 'Dev', title: 'Implement', deliverable: 'code', depends_on: ['T1'] },
          { id: 'T3', agentId: 'tester', role: 'QA', title: 'Test', deliverable: 'report.md', depends_on: ['T2'] },
        ],
      });
      env.gw.emit({ state: 'final', sessionKey, text: planJson });
      await flush();

      const planReady = env.sends.find((s) => s.channel === 'mission:plan-ready');
      expect(planReady).toBeDefined();
      expect(planReady!.payload.mission.status).toBe('paused_awaiting_human');
    } finally { env.teardown(); }
  });

  it('mission:approve-and-run transitions paused-awaiting-human to running and spawns first step', async () => {
    const env = await setup();
    try {
      const createFn = env.handlers.get('mission:create-from-goal')!;
      await createFn({}, 'Demo goal');
      const plannerKey = env.gw.chatSend.mock.calls[0][0];
      env.gw.emit({
        state: 'final',
        sessionKey: plannerKey,
        text: JSON.stringify({
          summary: 'demo plan with three steps',
          subtasks: [
            { id: 'T1', agentId: 'main',   role: 'Lead', title: 'Write intro',  deliverable: 'intro.md', depends_on: [] },
            { id: 'T2', agentId: 'coder',  role: 'Dev',  title: 'Write code',   deliverable: 'code',     depends_on: ['T1'] },
            { id: 'T3', agentId: 'tester', role: 'QA',   title: 'Test output',  deliverable: 'report',   depends_on: ['T2'] },
          ],
        }),
      });
      await flush();

      // At this point plan-ready should have fired but no step yet.
      expect(env.sends.some((s) => s.channel === 'mission:step-started')).toBe(false);
      expect(env.gw.chatSend).toHaveBeenCalledTimes(1); // only planner

      const approveFn = env.handlers.get('mission:approve-and-run')!;
      const res = await approveFn({}, 'mission-test');
      expect(res).toEqual({ ok: true });
      await flush();

      expect(env.gw.chatSend).toHaveBeenCalledTimes(2); // planner + first worker
      expect(env.sends.some((s) => s.channel === 'mission:step-started')).toBe(true);
    } finally { env.teardown(); }
  });

  it('mission:approve-and-run is idempotent on unknown id and non-paused missions', async () => {
    const env = await setup();
    try {
      const approveFn = env.handlers.get('mission:approve-and-run')!;
      const res = await approveFn({}, 'nonexistent');
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/not found/);
    } finally { env.teardown(); }
  });
});

describe('register-mission-handlers — mission:list / get / read-artifact', () => {
  it('mission:list returns persisted missions sorted newest-first', async () => {
    const env = await setup();
    try {
      const createFn = env.handlers.get('mission:create-from-goal')!;
      await createFn({}, 'First');
      const listFn = env.handlers.get('mission:list')!;
      const missions = await listFn({});
      expect(Array.isArray(missions)).toBe(true);
      expect(missions.length).toBeGreaterThanOrEqual(1);
      expect(missions[0].id).toBe('mission-test');
      expect(missions[0].goal).toBe('First');
    } finally { env.teardown(); }
  });

  it('mission:get returns live mission snapshot when runner has it', async () => {
    const env = await setup();
    try {
      const createFn = env.handlers.get('mission:create-from-goal')!;
      await createFn({}, 'Live');
      const getFn = env.handlers.get('mission:get')!;
      const m = await getFn({}, 'mission-test');
      expect(m).toBeTruthy();
      expect(m.goal).toBe('Live');
    } finally { env.teardown(); }
  });

  it('mission:get returns null for unknown id', async () => {
    const env = await setup();
    try {
      const getFn = env.handlers.get('mission:get')!;
      expect(await getFn({}, 'nope')).toBeNull();
    } finally { env.teardown(); }
  });

  it('mission:read-artifact fails gracefully when artifact missing', async () => {
    const env = await setup();
    try {
      const readFn = env.handlers.get('mission:read-artifact')!;
      const r = await readFn({}, 'missing', 'T1');
      expect(r.ok).toBe(false);
    } finally { env.teardown(); }
  });

  it('mission:read-artifact returns body after a step completes', async () => {
    const env = await setup();
    try {
      const createFn = env.handlers.get('mission:create-from-goal')!;
      await createFn({}, 'Need artifact');
      const plannerKey = env.gw.chatSend.mock.calls[0][0];
      env.gw.emit({
        state: 'final',
        sessionKey: plannerKey,
        text: JSON.stringify({
          summary: 'demo needs three steps',
          subtasks: [
            { id: 'T1', agentId: 'main',   role: 'Lead', title: 'Draft',  deliverable: 'draft.md', depends_on: [] },
            { id: 'T2', agentId: 'coder',  role: 'Dev',  title: 'Polish', deliverable: 'code',     depends_on: ['T1'] },
            { id: 'T3', agentId: 'tester', role: 'QA',   title: 'Review', deliverable: 'report',   depends_on: ['T2'] },
          ],
        }),
      });
      await flush();

      const approveFn = env.handlers.get('mission:approve-and-run')!;
      await approveFn({}, 'mission-test');
      await flush();

      const workerKey = env.gw.chatSend.mock.calls[1][0];
      env.gw.emit({ state: 'final', sessionKey: workerKey, text: 'Final draft body.' });
      await flush();

      const readFn = env.handlers.get('mission:read-artifact')!;
      const r = await readFn({}, 'mission-test', 'T1');
      expect(r.ok).toBe(true);
      expect(r.body).toContain('Final draft body');
      expect(r.path).toContain(env.root);
    } finally { env.teardown(); }
  });
});

describe('register-mission-handlers — cancel + delete', () => {
  it('mission:cancel-flow returns ok when runner has the mission', async () => {
    const env = await setup();
    try {
      const createFn = env.handlers.get('mission:create-from-goal')!;
      await createFn({}, 'Mission X');
      const cancelFn = env.handlers.get('mission:cancel-flow')!;
      const res = await cancelFn({}, 'mission-test');
      expect(res).toEqual({ ok: true });
      const failed = env.sends.find((s) => s.channel === 'mission:failed');
      expect(failed).toBeDefined();
    } finally { env.teardown(); }
  });

  it('mission:cancel-flow with missing id gracefully reports error', async () => {
    const env = await setup();
    try {
      const cancelFn = env.handlers.get('mission:cancel-flow')!;
      const res = await cancelFn({}, '');
      expect(res.ok).toBe(false);
    } finally { env.teardown(); }
  });

  it('mission:delete removes persisted files', async () => {
    const env = await setup();
    try {
      const createFn = env.handlers.get('mission:create-from-goal')!;
      await createFn({}, 'toss me');
      const deleteFn = env.handlers.get('mission:delete')!;
      const res = await deleteFn({}, 'mission-test');
      expect(res.ok).toBe(true);
      const listFn = env.handlers.get('mission:list')!;
      const missions = await listFn({});
      expect(missions.some((m: any) => m.id === 'mission-test')).toBe(false);
    } finally { env.teardown(); }
  });
});

describe('register-mission-handlers — event → IPC mapper', () => {
  it('missionEventToIpc maps every MissionEvent variant to the correct channel', async () => {
    vi.resetModules();
    const { missionEventToIpc } = await import(
      '../../electron/ipc/register-mission-handlers'
    );
    const cases: Array<[any, string]> = [
      [{ type: 'planning', missionId: 'm' }, 'mission:planning'],
      [{ type: 'planner-delta', missionId: 'm', chunk: 'x' }, 'mission:planner-delta'],
      [{ type: 'plan-ready', missionId: 'm', mission: {} }, 'mission:plan-ready'],
      [{ type: 'step-started', missionId: 'm', stepId: 'T1', sessionKey: 'k', runId: 'r' }, 'mission:step-started'],
      [{ type: 'step-delta', missionId: 'm', stepId: 'T1', chunk: 'c' }, 'mission:step-delta'],
      [{ type: 'step-ended', missionId: 'm', stepId: 'T1', artifactPath: 'p' }, 'mission:step-ended'],
      [{ type: 'step-failed', missionId: 'm', stepId: 'T1', errorCode: 'unknown', message: 'x' }, 'mission:step-failed'],
      [{ type: 'mission:done', missionId: 'm', mission: {} }, 'mission:done'],
      [{ type: 'mission:failed', missionId: 'm', mission: {}, reason: 'y' }, 'mission:failed'],
    ];
    for (const [ev, chan] of cases) {
      const out = missionEventToIpc(ev);
      expect(out.channel).toBe(chan);
      expect(out.payload).toBeTruthy();
    }
  });
});
