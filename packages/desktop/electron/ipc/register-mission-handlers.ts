/**
 * IPC handlers for the Mission Flow (F-Team-Tasks Phase 4).
 *
 * Assembles MissionRunner + streaming-bridge + awareness-bridge + file-layout
 * into the Electron main-process surface consumed by TaskCenter /
 * MissionComposer / PlanPreview / KanbanCardStream.
 *
 * Invoke channels (renderer → main):
 *   mission:create-from-goal (goal, opts?) → { missionId }
 *   mission:approve-and-run  (missionId)  → { ok, error? }
 *   mission:list             ()           → [{ id, goal, status, createdAt, ... }]
 *   mission:get              (missionId)  → Mission | null
 *   mission:cancel-flow      (missionId)  → { ok }
 *   mission:delete           (missionId)  → { ok }
 *   mission:read-artifact    (missionId, stepId) → { ok, path, body } | { ok:false }
 *
 * Events (main → renderer, webContents.send):
 *   mission:planning        (missionId)
 *   mission:planner-delta   (missionId, chunk)
 *   mission:plan-ready      (missionId, mission)
 *   mission:step-started    (missionId, stepId, sessionKey, runId)
 *   mission:step-delta      (missionId, stepId, chunk)
 *   mission:step-tool       (missionId, stepId, toolName, status)  — reserved for future
 *   mission:step-ended      (missionId, stepId, artifactPath)
 *   mission:step-failed     (missionId, stepId, errorCode, message)
 *   mission:done            (missionId, mission)
 *   mission:failed          (missionId, mission, reason)
 *
 * Dependency injection keeps the handler testable: tests swap GatewayClient /
 * AwarenessClient for fakes and capture emitted IPC events.
 *
 * NOTE: The channel `mission:cancel-flow` is used instead of `mission:cancel`
 * to avoid conflicting with the legacy orchestrator registered in
 * register-workflow-handlers.ts.
 */

import { ipcMain, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';

import type { Mission, MissionStatus } from '../mission/types';
import {
  MissionRunner,
  type GatewayAdapter,
  type MissionEvent,
  type MissionRunnerOptions,
} from '../mission/mission-runner';
import { createGatewayAdapter, type MinimalGatewayWs } from '../mission/streaming-bridge';
import {
  AwarenessBridge,
  createAwarenessClientFromCallMcp,
  type AwarenessClient,
} from '../mission/awareness-bridge';
import type { PlannerAgent } from '../mission/planner-prompt';
import {
  defaultRoot,
  listMissions as listMissionIds,
  readMission,
  readArtifact as readArtifactFile,
  deleteMission as deleteMissionFiles,
  getMissionDir,
  writeMission,
} from '../mission/file-layout';

// ---------------------------------------------------------------------------
// Public deps + factory
// ---------------------------------------------------------------------------

export interface MissionHandlerDeps {
  /** HOME directory (for reading openclaw.json agent list). */
  readonly home: string;
  /** Returns (or opens) the live Gateway WebSocket client. */
  readonly getGatewayWs: () => Promise<MinimalGatewayWs>;
  /** Active BrowserWindow to target `webContents.send`. */
  readonly getMainWindow: () => BrowserWindow | null;
  /**
   * Thin MCP caller — only used to build the AwarenessBridge. Tests supply a
   * fake. Defaults to the shared `callMcp` helper in memory-client.ts.
   */
  readonly callMcp?: (toolName: string, args: Record<string, any>) => Promise<any>;
  /**
   * File-layout root. Defaults to `~/.awarenessclaw`. Tests point this at a
   * tmp dir so they don't pollute the real mission store.
   */
  readonly root?: string;
  /**
   * Optional MissionRunner-options override. Tests may shrink timers, pin
   * `clock`, or inject custom id generators for deterministic output.
   */
  readonly runnerOptionsOverride?: Partial<MissionRunnerOptions>;
}

export interface MissionHandlerController {
  /** Detach every `ipcMain.handle` registered here — required by tests. */
  dispose(): void;
  /** Handle-level access used by tests. */
  getRunner(): MissionRunner;
  getBridge(): AwarenessBridge;
}

const IPC_INVOKE_CHANNELS = [
  'mission:create-from-goal',
  'mission:approve-and-run',
  'mission:list',
  'mission:get',
  'mission:cancel-flow',
  'mission:delete',
  'mission:read-artifact',
  'mission:sweep-stale',
] as const;

export const MISSION_IPC_INVOKE_CHANNELS = IPC_INVOKE_CHANNELS;
export const MISSION_IPC_EVENT_CHANNELS = [
  'mission:planning',
  'mission:planner-delta',
  'mission:plan-ready',
  'mission:step-started',
  'mission:step-delta',
  'mission:step-tool',
  'mission:step-ended',
  'mission:step-failed',
  'mission:done',
  'mission:failed',
] as const;

// ---------------------------------------------------------------------------
// Main registration
// ---------------------------------------------------------------------------

export function registerMissionHandlers(deps: MissionHandlerDeps): MissionHandlerController {
  const root = deps.root ?? defaultRoot();

  // Awareness bridge — best-effort, silently degrades when daemon is offline.
  const client: AwarenessClient = deps.callMcp
    ? createAwarenessClientFromCallMcp(deps.callMcp)
    : { async callTool() { return { error: 'awareness-bridge: callMcp not provided' }; } };
  const bridge = new AwarenessBridge(client);

  // --- Gateway adapter is created lazily on the first createMission call so
  //     we don't force a Gateway connection at app boot.
  let adapter: GatewayAdapter | null = null;
  async function ensureAdapter(): Promise<GatewayAdapter> {
    if (adapter) return adapter;
    const ws = await deps.getGatewayWs();
    adapter = createGatewayAdapter(ws);
    return adapter;
  }

  // --- Runner is also lazy because its adapter is lazy. But we still need a
  //     stable reference for tests; `getRunner()` forces initialization
  //     synchronously (tests supply a mock adapter inline).
  let runner: MissionRunner | null = null;
  const buildRunner = (adapterArg: GatewayAdapter): MissionRunner => {
    const emit: (event: MissionEvent) => void = (event) => forwardMissionEvent(deps, event);
    const opts: MissionRunnerOptions = {
      root,
      awaitApproval: true,
      ...(deps.runnerOptionsOverride || {}),
    };
    return new MissionRunner(adapterArg, emit, opts);
  };

  async function ensureRunner(): Promise<MissionRunner> {
    if (runner) return runner;
    const ad = await ensureAdapter();
    runner = buildRunner(ad);
    return runner;
  }

  // ---- invoke handlers ----

  ipcMain.handle('mission:create-from-goal', async (
    _e,
    goal: string,
    opts?: {
      workDir?: string;
      agents?: readonly { id: string; name?: string; role?: string; emoji?: string }[];
    },
  ) => {
    if (typeof goal !== 'string' || goal.trim().length === 0) {
      throw new Error('goal is required and must be a non-empty string');
    }

    const activeRunner = await ensureRunner();
    const agents = normalizeAgents(opts?.agents ?? readAgentsFromConfig(deps.home));

    let pastExperience = '';
    try {
      pastExperience = await bridge.recallForPlanner({ goal, agents });
    } catch {
      // awareness-bridge is fail-safe but rethrows when failSilent:false — swallow anyway
      pastExperience = '';
    }

    const mission = await activeRunner.createMission({
      goal: goal.trim(),
      agents,
      workDir: opts?.workDir,
      pastExperience: pastExperience || undefined,
    });
    return { missionId: mission.id };
  });

  ipcMain.handle('mission:approve-and-run', async (_e, missionId: string) => {
    if (!missionId) throw new Error('missionId is required');
    const activeRunner = await ensureRunner();
    try {
      await activeRunner.approveAndRun(missionId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('mission:list', async () => {
    const ids = listMissionIds(root);
    const missions: Mission[] = [];
    for (const id of ids) {
      const m = readMission(id, root);
      if (m) missions.push(m);
    }
    // Sort newest first.
    missions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return missions;
  });

  ipcMain.handle('mission:get', async (_e, missionId: string) => {
    if (!missionId) return null;
    // Prefer the runner's view (which now hydrates from disk on miss, so the
    // in-memory Map stays in sync) and fall back to a direct file read if no
    // runner has been created yet.
    if (runner) {
      const live = runner.getMission(missionId);
      if (live) return live;
    }
    return readMission(missionId, root);
  });

  ipcMain.handle('mission:cancel-flow', async (_e, missionId: string) => {
    if (!missionId) return { ok: false, error: 'missionId is required' };
    try {
      // Ensure a runner exists — user may be cancelling a mission left over
      // from a previous app session, which the runner will hydrate from disk.
      const activeRunner = await ensureRunner();
      await activeRunner.cancel(missionId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('mission:delete', async (_e, missionId: string) => {
    if (!missionId) return { ok: false, error: 'missionId is required' };
    try {
      deleteMissionFiles(missionId, root);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  /**
   * Sweep stuck "running" / "planning" missions from a previous app session.
   *
   * Policy: a mission is "stale" when ALL of:
   *   - its `status` is `running` or `planning` (or `paused`, but NOT
   *     `paused_awaiting_human` — we don't want to kill a plan the user
   *     hasn't yet decided on)
   *   - its `startedAt` timestamp is BEFORE this handler's registration time
   *     (meaning it wasn't started in the current app session)
   *   - `completedAt` is unset (not already terminal)
   *
   * Action: rewrite `mission.json` with status=`failed`, completedAt=now,
   * lastEvent explaining it was interrupted. The UI's history list will then
   * show it as failed instead of "still running".
   *
   * Called by `MissionFlowShell` on mount (once per session).
   */
  const handlerStartedAt = Date.now();
  ipcMain.handle('mission:sweep-stale', async () => {
    try {
      const ids = listMissionIds(root);
      let swept = 0;
      const nowIso = new Date().toISOString();
      for (const id of ids) {
        const m = readMission(id, root);
        if (!m) continue;
        if (m.completedAt) continue;
        if (m.status !== 'running' && m.status !== 'planning' && m.status !== 'paused') continue;
        if (!m.startedAt) continue;
        const startedTs = Date.parse(m.startedAt);
        if (!Number.isFinite(startedTs)) continue;
        // Guard against killing a live mission in the current session: only
        // sweep when startedAt is older than this handler's registration.
        if (startedTs >= handlerStartedAt) continue;

        const swap = {
          ...m,
          status: 'failed' as const,
          completedAt: nowIso,
          lastEvent: {
            at: nowIso,
            type: 'sweep-stale',
            payload: 'Mission was interrupted by an app restart and could not be resumed.',
          },
        };
        try {
          writeMission(swap, root);
          swept++;
        } catch { /* continue with next */ }
      }
      return { ok: true, swept };
    } catch (err) {
      return { ok: false, error: errMsg(err), swept: 0 };
    }
  });

  ipcMain.handle('mission:read-artifact', async (_e, missionId: string, stepId: string) => {
    if (!missionId || !stepId) return { ok: false, error: 'missionId and stepId are required' };
    const mission = readMission(missionId, root);
    if (!mission) return { ok: false, error: 'mission not found' };
    const step = mission.steps.find((s) => s.id === stepId);
    if (!step) return { ok: false, error: `step ${stepId} not found` };
    const body = readArtifactFile(missionId, step.id, step.title, root);
    if (body == null) return { ok: false, error: 'artifact not found' };
    const rel = step.artifactPath || `artifacts/${step.id}.md`;
    return { ok: true, path: path.join(getMissionDir(missionId, root), rel), body };
  });

  return {
    dispose() {
      for (const ch of IPC_INVOKE_CHANNELS) {
        try { ipcMain.removeHandler(ch); } catch { /* ignore */ }
      }
    },
    getRunner() {
      // Tests need a synchronous runner — invent a stub adapter if none is set
      if (!runner) {
        runner = buildRunner({
          async sendChat() { throw new Error('gateway not ready'); },
          async abort() { /* noop */ },
          subscribe() { return () => {}; },
        });
      }
      return runner;
    },
    getBridge() {
      return bridge;
    },
  };
}

// ---------------------------------------------------------------------------
// Event forwarding
// ---------------------------------------------------------------------------

/** Convert MissionEvent → webContents.send payload (idempotent + exported for tests). */
export function missionEventToIpc(event: MissionEvent): { channel: string; payload: any } {
  switch (event.type) {
    case 'planning':
      return { channel: 'mission:planning', payload: { missionId: event.missionId } };
    case 'planner-delta':
      return {
        channel: 'mission:planner-delta',
        payload: { missionId: event.missionId, chunk: event.chunk },
      };
    case 'plan-ready':
      return {
        channel: 'mission:plan-ready',
        payload: { missionId: event.missionId, mission: event.mission },
      };
    case 'step-started':
      return {
        channel: 'mission:step-started',
        payload: {
          missionId: event.missionId,
          stepId: event.stepId,
          sessionKey: event.sessionKey,
          runId: event.runId,
        },
      };
    case 'step-delta':
      return {
        channel: 'mission:step-delta',
        payload: { missionId: event.missionId, stepId: event.stepId, chunk: event.chunk },
      };
    case 'step-ended':
      return {
        channel: 'mission:step-ended',
        payload: {
          missionId: event.missionId,
          stepId: event.stepId,
          artifactPath: event.artifactPath,
        },
      };
    case 'step-failed':
      return {
        channel: 'mission:step-failed',
        payload: {
          missionId: event.missionId,
          stepId: event.stepId,
          errorCode: event.errorCode,
          message: event.message,
        },
      };
    case 'mission:done':
      return {
        channel: 'mission:done',
        payload: { missionId: event.missionId, mission: event.mission },
      };
    case 'mission:failed':
      return {
        channel: 'mission:failed',
        payload: {
          missionId: event.missionId,
          mission: event.mission,
          reason: event.reason,
        },
      };
  }
}

function forwardMissionEvent(deps: MissionHandlerDeps, event: MissionEvent): void {
  const win = deps.getMainWindow();
  if (!win || win.isDestroyed()) return;
  const { channel, payload } = missionEventToIpc(event);
  try {
    win.webContents.send(channel, payload);
  } catch {
    // Renderer may have gone away mid-flight; ignore.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse agents from the user's local openclaw.json and coerce them into the
 * planner-prompt PlannerAgent shape. Falls back to a `main` placeholder so the
 * Planner always has at least one agent id to work with.
 */
export function readAgentsFromConfig(
  home: string,
): readonly PlannerAgent[] {
  try {
    const cfgPath = path.join(home, '.openclaw', 'openclaw.json');
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const cfg = JSON.parse(raw);
    const list: any[] = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
    if (list.length === 0) {
      return [{ id: 'main', name: 'Main Agent', role: 'Generalist' }];
    }
    return list.map((a: any): PlannerAgent => ({
      id: typeof a?.id === 'string' && a.id.length > 0 ? a.id : 'main',
      name: typeof a?.identity?.name === 'string' ? a.identity.name
        : (typeof a?.name === 'string' ? a.name : undefined),
      role: typeof a?.identity?.role === 'string' ? a.identity.role
        : (typeof a?.role === 'string' ? a.role : undefined),
    }));
  } catch {
    return [{ id: 'main', name: 'Main Agent', role: 'Generalist' }];
  }
}

function normalizeAgents(
  input: readonly { id: string; name?: string; role?: string; emoji?: string }[],
): readonly PlannerAgent[] {
  const seen = new Set<string>();
  const out: PlannerAgent[] = [];
  for (const a of input) {
    if (!a || typeof a.id !== 'string' || a.id.length === 0) continue;
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push({ id: a.id, name: a.name, role: a.role });
  }
  if (out.length === 0) {
    out.push({ id: 'main', name: 'Main Agent', role: 'Generalist' });
  }
  return out;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}

// ---------------------------------------------------------------------------
// Re-exports for tests that want to assert on status strings.
// ---------------------------------------------------------------------------

export type { MissionStatus };
