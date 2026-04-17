/**
 * MissionRunner — orchestrator main loop.
 *
 * This module is the CORE business logic: given a user goal and a list of
 * available agents, it drives
 *   Planner spawn → plan validation → sequential step spawn → artifact write
 *   → next step → mission done (or failed).
 *
 * Design goals (documented in 01-DESIGN.md §一·补 + §5.1/5.2):
 *   - Zero Electron imports — testable in pure Node
 *   - All side effects injected (gateway / fs via file-layout / clock / ids)
 *   - Emit typed events so the IPC layer can forward them to the renderer
 *     (maps 1:1 to `mission:*` IPC channels in register-mission-handlers.ts)
 *   - Strict ordering: one step at a time in S1 (parallel DAG = S4)
 *
 * Flow:
 *
 *   createMission(goal, agents)
 *      └─ writeMission({status:'planning'})
 *      └─ emit('mission:planning')
 *      └─ gateway.sendChat(planner prompt) + subscribe delta→emit('planner-delta')
 *      └─ on final:
 *           ├─ parsePlan()
 *           │    ├─ ok:    writePlan() + populate steps + emit('plan-ready')
 *           │    │         status='running' → spawnNextStep()
 *           │    └─ !ok:   retry planner once with error context
 *           │               if still !ok → emit('mission:failed', planner_invalid)
 *
 *   spawnNextStep()
 *      ├─ find waiting step whose depends_on are all 'done'
 *      ├─ none waiting + any failed ⇒ emit('mission:failed')
 *      ├─ none waiting + all done  ⇒ emit('mission:done')
 *      └─ pickedStep:
 *           ├─ buildWorkerPrompt(artifacts + MEMORY.md + ...)
 *           ├─ gateway.sendChat → set status='running' + sessionKey + runId
 *           ├─ subscribe delta → emit('step-delta')
 *           └─ on final:   writeArtifact + appendMemory + status='done'
 *                          → spawnNextStep() (recurse)
 *              on error:   status='failed' → emit('mission:failed')
 */

import type {
  Mission,
  MissionStep,
  MissionErrorCode,
  PlanSubtask,
} from './types';
import {
  appendMemory,
  artifactPath,
  listArtifacts,
  readArtifact,
  readMemory,
  writeArtifact,
  writeMission,
  ensureMissionSkeleton,
  writePlan,
} from './file-layout';
import { parsePlan } from './plan-schema';
import { buildPlannerPrompt, type PlannerAgent } from './planner-prompt';
import { buildWorkerPrompt } from './worker-prompt';
import path from 'path';

// ---------------------------------------------------------------------------
// Types — gateway adapter + emitted events
// ---------------------------------------------------------------------------

/** Single chat event from Gateway WS — already defensively normalized. */
export interface GatewayChatEvent {
  readonly state: 'delta' | 'final' | 'error' | 'aborted';
  readonly chunk?: string;          // delta
  readonly text?: string;           // final
  readonly errorCode?: MissionErrorCode;
  readonly errorMessage?: string;
}

export interface GatewaySpawnResult {
  readonly runId: string;
  readonly sessionKey: string;
}

export interface GatewayAdapter {
  /**
   * Spawn a chat turn. Returns the run id + session key it actually ran on.
   * If `sessionKey` is not provided, adapter creates one for a new sub-agent.
   */
  sendChat(params: {
    agentId: string;
    prompt: string;
    sessionKey?: string;
    model?: string;
    thinking?: string;
  }): Promise<GatewaySpawnResult>;

  /** Abort a running run. */
  abort(sessionKey: string, runId?: string): Promise<void>;

  /**
   * Subscribe to chat events for a session. Returns an unsubscribe function.
   * The adapter is responsible for coalescing raw Gateway frames into one
   * normalized GatewayChatEvent per call.
   */
  subscribe(sessionKey: string, handler: (event: GatewayChatEvent) => void): () => void;
}

export type MissionEvent =
  | { type: 'planning'; missionId: string }
  | { type: 'planner-delta'; missionId: string; chunk: string }
  | { type: 'plan-ready'; missionId: string; mission: Mission }
  | { type: 'step-started'; missionId: string; stepId: string; sessionKey: string; runId: string }
  | { type: 'step-delta'; missionId: string; stepId: string; chunk: string }
  | { type: 'step-ended'; missionId: string; stepId: string; artifactPath: string }
  | { type: 'step-failed'; missionId: string; stepId: string; errorCode: MissionErrorCode; message: string }
  | { type: 'mission:done'; missionId: string; mission: Mission }
  | { type: 'mission:failed'; missionId: string; mission: Mission; reason: string };

export type MissionEventHandler = (event: MissionEvent) => void;

export interface MissionRunnerOptions {
  readonly root?: string;                          // file-layout root, default ~/.awarenessclaw
  readonly clock?: () => Date;                     // override for deterministic tests
  readonly idGen?: () => string;                   // override for deterministic tests
  readonly maxPlannerRetries?: number;             // default 1 (total 2 attempts)
  readonly plannerAgentId?: string;                // default 'main'

  /**
   * Idle timeout per step in ms — fail the step if no Gateway event (delta,
   * tool, final, error) arrives for this long. Protects against hung agents
   * blocking the whole mission. Default: 15 min.
   * Corresponds to 03-ACCEPTANCE L3.7 (agent hang detection).
   */
  readonly stepIdleTimeoutMs?: number;

  /**
   * Hard cap on MEMORY.md content injected into a worker prompt. When the
   * shared memory exceeds this, we keep the first 25% (mission decisions
   * header) and the last 75% (most recent context) with a truncation marker
   * between them. Prevents main-thread stalls on huge memory files.
   * Default: 200 KB.
   */
  readonly memoryReadCapBytes?: number;

  /**
   * Hard cap per individual previous-artifact content injected into the
   * worker prompt. Prevents a single outlier step output from blowing the
   * context window. Default: 80 KB.
   */
  readonly artifactReadCapBytes?: number;

  /**
   * When true, pause after `plan-ready` and require an explicit
   * `approveAndRun(missionId)` call before spawning the first worker step.
   * Mission status is set to `paused_awaiting_human` until approved.
   *
   * IPC layer sets this to true so the Preview UI can show the plan and let
   * the user click "Approve & Run". Unit tests default to false so existing
   * runner specs keep their auto-run behaviour.
   */
  readonly awaitApproval?: boolean;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const DEFAULT_STEP_IDLE_TIMEOUT_MS = 15 * 60 * 1000;  // 15 min
const DEFAULT_MEMORY_READ_CAP_BYTES = 200 * 1024;     // 200 KB
const DEFAULT_ARTIFACT_READ_CAP_BYTES = 80 * 1024;    // 80 KB

export class MissionRunner {
  private readonly gateway: GatewayAdapter;
  private readonly emit: MissionEventHandler;
  private readonly opts: Required<Pick<
    MissionRunnerOptions,
    'maxPlannerRetries' | 'plannerAgentId' | 'stepIdleTimeoutMs' | 'memoryReadCapBytes' | 'artifactReadCapBytes' | 'awaitApproval'
  >> & Pick<MissionRunnerOptions, 'root' | 'clock' | 'idGen'>;
  private readonly cancelled = new Set<string>();
  private readonly activeSubs = new Map<string, () => void>();         // missionId → unsubscribe
  private readonly stepIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();  // missionId → idle timer
  /** In-flight mission snapshot — persisted to disk via file-layout on every mutation. */
  private missions = new Map<string, Mission>();

  constructor(gateway: GatewayAdapter, emit: MissionEventHandler, opts: MissionRunnerOptions = {}) {
    this.gateway = gateway;
    this.emit = emit;
    this.opts = {
      root: opts.root,
      clock: opts.clock,
      idGen: opts.idGen,
      maxPlannerRetries: opts.maxPlannerRetries ?? 1,
      plannerAgentId: opts.plannerAgentId ?? 'main',
      stepIdleTimeoutMs: opts.stepIdleTimeoutMs ?? DEFAULT_STEP_IDLE_TIMEOUT_MS,
      memoryReadCapBytes: opts.memoryReadCapBytes ?? DEFAULT_MEMORY_READ_CAP_BYTES,
      artifactReadCapBytes: opts.artifactReadCapBytes ?? DEFAULT_ARTIFACT_READ_CAP_BYTES,
      awaitApproval: opts.awaitApproval ?? false,
    };
  }

  /** Create a new mission and spawn the Planner. Resolves when Planner is spawned. */
  async createMission(input: {
    goal: string;
    agents: readonly PlannerAgent[];
    workDir?: string;
    pastExperience?: string;
  }): Promise<Mission> {
    const id = this.genMissionId();
    ensureMissionSkeleton(id, this.opts.root);
    const now = this.now();
    const mission: Mission = {
      id,
      version: 1,
      goal: input.goal,
      status: 'planning',
      createdAt: now,
      plannerAgentId: this.opts.plannerAgentId,
      rootWorkDir: input.workDir,
      steps: [],
    };
    writeMission(mission, this.opts.root);
    this.missions.set(id, mission);
    this.emit({ type: 'planning', missionId: id });

    // Spawn Planner (attempt 1 of up-to maxPlannerRetries+1)
    await this.spawnPlanner(id, input, 0);
    return mission;
  }

  /** Cancel an active mission. Aborts any current run + stops further spawning. */
  async cancel(missionId: string, reason = 'user cancelled'): Promise<void> {
    const m = this.missions.get(missionId);
    if (!m) return;
    this.cancelled.add(missionId);
    this.clearStepIdleTimer(missionId);
    const unsubscribe = this.activeSubs.get(missionId);
    if (unsubscribe) unsubscribe();
    this.activeSubs.delete(missionId);

    // Abort any running step session
    const running = m.steps.find((s) => s.status === 'running');
    if (running?.sessionKey) {
      try { await this.gateway.abort(running.sessionKey, running.runId); }
      catch { /* best-effort */ }
    }

    const failed: Mission = { ...m, status: 'failed', completedAt: this.now() };
    this.missions.set(missionId, failed);
    writeMission(failed, this.opts.root);
    this.emit({ type: 'mission:failed', missionId, mission: failed, reason });
  }

  /** Public accessor for tests / IPC. */
  getMission(missionId: string): Mission | undefined {
    return this.missions.get(missionId);
  }

  // -------------------------------------------------------------------------
  // Planner
  // -------------------------------------------------------------------------

  private async spawnPlanner(
    missionId: string,
    input: { goal: string; agents: readonly PlannerAgent[]; workDir?: string; pastExperience?: string },
    attempt: number,
    retryContext?: string,
  ): Promise<void> {
    if (this.cancelled.has(missionId)) return;
    const basePrompt = buildPlannerPrompt({
      goal: input.goal,
      agents: input.agents,
      pastExperience: input.pastExperience,
      workDir: input.workDir,
    });
    const prompt = retryContext
      ? `${basePrompt}\n\n<RetryContext>\nYour previous attempt produced invalid JSON:\n${retryContext}\nPlease correct every issue above and return a valid plan.\n</RetryContext>`
      : basePrompt;

    let plannerSpawn: GatewaySpawnResult;
    try {
      plannerSpawn = await this.gateway.sendChat({
        agentId: this.opts.plannerAgentId,
        prompt,
        thinking: 'medium',
      });
    } catch (err: any) {
      await this.failMission(missionId, `planner spawn failed: ${errMessage(err)}`);
      return;
    }

    let streamedText = '';
    const unsubscribe = this.gateway.subscribe(plannerSpawn.sessionKey, (ev) => {
      if (this.cancelled.has(missionId)) return;
      if (ev.state === 'delta' && ev.chunk) {
        streamedText += ev.chunk;
        this.emit({ type: 'planner-delta', missionId, chunk: ev.chunk });
      } else if (ev.state === 'final') {
        unsubscribe();
        const finalText = ev.text && ev.text.length > 0 ? ev.text : streamedText;
        this.handlePlannerFinal(missionId, input, attempt, finalText);
      } else if (ev.state === 'error' || ev.state === 'aborted') {
        unsubscribe();
        void this.failMission(
          missionId,
          `planner ${ev.state}: ${ev.errorMessage || 'no message'}`,
        );
      }
    });
    this.activeSubs.set(missionId, unsubscribe);
  }

  private handlePlannerFinal(
    missionId: string,
    input: { goal: string; agents: readonly PlannerAgent[]; workDir?: string; pastExperience?: string },
    attempt: number,
    rawText: string,
  ): void {
    const jsonText = extractJson(rawText);
    const availableIds = input.agents.map((a) => a.id);
    const parsed = parsePlan(jsonText, { availableAgentIds: availableIds });

    if (parsed.ok === false) {
      const errors = parsed.errors;
      if (attempt < this.opts.maxPlannerRetries && !this.cancelled.has(missionId)) {
        // retry once with the concatenated error list
        const context = errors.join('\n');
        void this.spawnPlanner(missionId, input, attempt + 1, context);
        return;
      }
      void this.failMission(
        missionId,
        `planner returned invalid plan after ${attempt + 1} attempt(s): ${errors.join('; ')}`,
      );
      return;
    }

    const plan = parsed.plan;
    writePlan(missionId, plan, this.opts.root);

    const base = this.missions.get(missionId);
    if (!base) return;
    const agentsById = new Map(input.agents.map((a) => [a.id, a]));

    const steps: MissionStep[] = plan.subtasks.map((st: PlanSubtask) => {
      const agent = agentsById.get(st.agentId);
      return {
        id: st.id,
        agentId: st.agentId,
        agentName: agent?.name,
        role: st.role,
        title: st.title,
        deliverable: st.deliverable,
        depends_on: st.depends_on,
        expectedDurationMinutes: st.expectedDurationMinutes,
        model: st.model,
        status: 'waiting',
        attempts: 0,
      };
    });

    const updated: Mission = {
      ...base,
      status: this.opts.awaitApproval ? 'paused_awaiting_human' : 'running',
      startedAt: this.now(),
      steps,
    };
    this.missions.set(missionId, updated);
    writeMission(updated, this.opts.root);
    this.emit({ type: 'plan-ready', missionId, mission: updated });

    if (!this.opts.awaitApproval) {
      void this.spawnNextStep(missionId);
    }
  }

  /**
   * Approve a plan that is paused awaiting human confirmation and start
   * worker execution. No-op if the mission is not in `paused_awaiting_human`.
   */
  async approveAndRun(missionId: string): Promise<void> {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`mission ${missionId} not found`);
    if (m.status !== 'paused_awaiting_human') {
      // idempotent: already running/done/failed — silently return
      return;
    }
    const running: Mission = { ...m, status: 'running' };
    this.missions.set(missionId, running);
    writeMission(running, this.opts.root);
    await this.spawnNextStep(missionId);
  }

  // -------------------------------------------------------------------------
  // Step loop
  // -------------------------------------------------------------------------

  private async spawnNextStep(missionId: string): Promise<void> {
    if (this.cancelled.has(missionId)) return;
    const m = this.missions.get(missionId);
    if (!m) return;
    if (m.status !== 'running') return;

    // Terminal conditions first.
    const anyFailed = m.steps.some((s) => s.status === 'failed');
    if (anyFailed) {
      await this.failMission(
        missionId,
        `step failed: ${m.steps.find((s) => s.status === 'failed')?.errorMessage || 'unknown error'}`,
      );
      return;
    }
    const allTerminal = m.steps.every((s) => s.status === 'done' || s.status === 'skipped');
    if (allTerminal) {
      const done: Mission = { ...m, status: 'done', completedAt: this.now() };
      this.missions.set(missionId, done);
      writeMission(done, this.opts.root);
      this.emit({ type: 'mission:done', missionId, mission: done });
      return;
    }

    // Pick the next step whose deps are all satisfied.
    const next = m.steps.find((s) =>
      s.status === 'waiting' &&
      s.depends_on.every((d) => m.steps.find((x) => x.id === d)?.status === 'done'),
    );
    if (!next) return; // no step ready — will be re-triggered by step-ended

    // Build prompt from artifacts + memory (capped to protect main thread)
    const previous = await this.collectPreviousArtifacts(missionId, next);
    const sharedMemory = capMiddle(
      readMemory(missionId, this.opts.root),
      this.opts.memoryReadCapBytes,
    );
    const prompt = buildWorkerPrompt({
      mission: { id: m.id, goal: m.goal, rootWorkDir: m.rootWorkDir },
      step: next,
      previousArtifacts: previous,
      sharedMemory,
    });

    let spawn: GatewaySpawnResult;
    try {
      spawn = await this.gateway.sendChat({
        agentId: next.agentId,
        prompt,
        model: next.model,
        thinking: 'off',
      });
    } catch (err: any) {
      await this.failStep(missionId, next.id, 'agent_crash', `spawn failed: ${errMessage(err)}`);
      return;
    }

    this.updateStep(missionId, next.id, {
      status: 'running',
      sessionKey: spawn.sessionKey,
      runId: spawn.runId,
      startedAt: this.now(),
      attempts: next.attempts + 1,
    });
    this.emit({
      type: 'step-started',
      missionId,
      stepId: next.id,
      sessionKey: spawn.sessionKey,
      runId: spawn.runId,
    });

    // Arm step-level idle timeout — any event resets it; final/error/cancel clears.
    this.armStepIdleTimer(missionId, next.id);

    // Subscribe to step events
    let streamed = '';
    const unsub = this.gateway.subscribe(spawn.sessionKey, (ev) => {
      if (this.cancelled.has(missionId)) return;
      if (ev.state === 'delta' && ev.chunk) {
        this.resetStepIdleTimer(missionId, next.id);
        streamed += ev.chunk;
        this.emit({ type: 'step-delta', missionId, stepId: next.id, chunk: ev.chunk });
      } else if (ev.state === 'final') {
        this.clearStepIdleTimer(missionId);
        unsub();
        this.activeSubs.delete(missionId);
        const body = ev.text && ev.text.length > 0 ? ev.text : streamed;
        void this.handleStepFinal(missionId, next.id, body);
      } else if (ev.state === 'error' || ev.state === 'aborted') {
        this.clearStepIdleTimer(missionId);
        unsub();
        this.activeSubs.delete(missionId);
        const code: MissionErrorCode =
          ev.errorCode || (ev.state === 'aborted' ? 'timeout' : 'unknown');
        void this.failStep(missionId, next.id, code, ev.errorMessage || ev.state);
      }
    });
    this.activeSubs.set(missionId, unsub);
  }

  private armStepIdleTimer(missionId: string, stepId: string): void {
    this.clearStepIdleTimer(missionId);
    const timeout = this.opts.stepIdleTimeoutMs;
    if (timeout <= 0 || !Number.isFinite(timeout)) return;
    const t = setTimeout(() => {
      this.stepIdleTimers.delete(missionId);
      // Abort the gateway run best-effort, then fail the step with a friendly
      // timeout message.
      const m = this.missions.get(missionId);
      const step = m?.steps.find((s) => s.id === stepId);
      if (step?.sessionKey) {
        void this.gateway.abort(step.sessionKey, step.runId).catch(() => { /* ignore */ });
      }
      // Tear down subscription (listener in step may still fire)
      const unsub = this.activeSubs.get(missionId);
      if (unsub) { unsub(); this.activeSubs.delete(missionId); }
      void this.failStep(
        missionId,
        stepId,
        'timeout',
        `step idle for ${Math.round(timeout / 1000)}s without any Gateway event`,
      );
    }, timeout);
    // `timer.unref` prevents the idle timer from keeping Node alive in tests /
    // background daemons; skip on environments that don't expose it.
    if (typeof (t as any).unref === 'function') (t as any).unref();
    this.stepIdleTimers.set(missionId, t);
  }

  private resetStepIdleTimer(missionId: string, stepId: string): void {
    if (!this.stepIdleTimers.has(missionId)) return;
    this.armStepIdleTimer(missionId, stepId);
  }

  private clearStepIdleTimer(missionId: string): void {
    const t = this.stepIdleTimers.get(missionId);
    if (t) { clearTimeout(t); this.stepIdleTimers.delete(missionId); }
  }

  private async handleStepFinal(missionId: string, stepId: string, body: string): Promise<void> {
    if (this.cancelled.has(missionId)) return;
    const m = this.missions.get(missionId);
    if (!m) return;
    const step = m.steps.find((s) => s.id === stepId);
    if (!step) return;

    const createdAt = this.now();
    const started = step.startedAt ? new Date(step.startedAt) : new Date(createdAt);
    const durationSeconds = Math.max(0, Math.floor((new Date(createdAt).getTime() - started.getTime()) / 1000));

    const rel = writeArtifact({
      missionId,
      stepId: step.id,
      title: step.title,
      body,
      frontmatter: {
        stepId: step.id,
        agentId: step.agentId,
        createdAt,
        durationSeconds,
      },
      root: this.opts.root,
    });
    const summary = firstNonEmptyLine(body) || `${step.id} completed`;
    appendMemory(
      missionId,
      `## ${step.id} done\n\n${summary}\n\n_(by ${step.agentId})_`,
      this.opts.root,
    );

    this.updateStep(missionId, stepId, {
      status: 'done',
      completedAt: createdAt,
      artifactPath: rel,
    });
    this.emit({ type: 'step-ended', missionId, stepId, artifactPath: rel });

    await this.spawnNextStep(missionId);
  }

  private async failStep(
    missionId: string,
    stepId: string,
    code: MissionErrorCode,
    message: string,
  ): Promise<void> {
    if (this.cancelled.has(missionId)) return;
    this.updateStep(missionId, stepId, {
      status: 'failed',
      completedAt: this.now(),
      errorCode: code,
      errorMessage: message,
    });
    this.emit({
      type: 'step-failed',
      missionId,
      stepId,
      errorCode: code,
      message,
    });
    await this.failMission(missionId, `${stepId}: ${message}`);
  }

  private async failMission(missionId: string, reason: string): Promise<void> {
    const m = this.missions.get(missionId);
    if (!m) return;
    if (m.status === 'failed' || m.status === 'done') return;
    const failed: Mission = { ...m, status: 'failed', completedAt: this.now() };
    this.missions.set(missionId, failed);
    writeMission(failed, this.opts.root);
    this.clearStepIdleTimer(missionId);
    const unsub = this.activeSubs.get(missionId);
    if (unsub) { unsub(); this.activeSubs.delete(missionId); }
    this.emit({ type: 'mission:failed', missionId, mission: failed, reason });
  }

  private updateStep(missionId: string, stepId: string, patch: Partial<MissionStep>): void {
    const m = this.missions.get(missionId);
    if (!m) return;
    const steps = m.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s));
    const updated: Mission = { ...m, steps };
    this.missions.set(missionId, updated);
    writeMission(updated, this.opts.root);
  }

  private async collectPreviousArtifacts(
    missionId: string,
    step: MissionStep,
  ): Promise<{ stepId: string; title: string; content: string }[]> {
    const m = this.missions.get(missionId);
    if (!m) return [];
    const out: { stepId: string; title: string; content: string }[] = [];
    for (const depId of step.depends_on) {
      const depStep = m.steps.find((s) => s.id === depId);
      if (!depStep) continue;
      const raw = readArtifact(missionId, depStep.id, depStep.title, this.opts.root);
      if (raw) {
        out.push({
          stepId: depStep.id,
          title: depStep.title,
          content: capTail(raw, this.opts.artifactReadCapBytes),
        });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private now(): string {
    return (this.opts.clock ? this.opts.clock() : new Date()).toISOString();
  }

  private genMissionId(): string {
    if (this.opts.idGen) return this.opts.idGen();
    const stamp = (this.opts.clock ? this.opts.clock() : new Date())
      .toISOString()
      .replace(/[-:T]/g, '')
      .replace(/\..+$/, '');
    const rand = Math.random().toString(36).slice(2, 8);
    return `mission-${stamp}-${rand}`;
  }
}

// ---------------------------------------------------------------------------
// Utility — exported for testing
// ---------------------------------------------------------------------------

/**
 * Extract a JSON object from a potentially-noisy LLM output. Strategy:
 *   1. If the text parses as JSON, return as-is.
 *   2. Try to find a fenced ```json ... ``` block.
 *   3. Otherwise return the substring from the first '{' to the last '}'.
 * The downstream validator catches any remaining garbage.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (fence && fence[1]) return fence[1].trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\n/)) {
    const t = line.trim();
    if (t.length > 0) return t.length > 200 ? t.slice(0, 200) + '…' : t;
  }
  return '';
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}

/**
 * Cap a string to at most `maxBytes` (UTF-8 approx via String.length as a
 * fast proxy). Keeps the **tail** — for artifacts we want the "Handoff" block
 * which is always at the end.
 *
 * Returns the string unchanged if already within cap.
 */
export function capTail(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return text;
  if (text.length <= maxBytes) return text;
  const keep = text.slice(text.length - maxBytes);
  return `[… truncated ${text.length - maxBytes} chars from head …]\n\n${keep}`;
}

/**
 * Cap a string by keeping the **first 25%** (mission header / early decisions)
 * and the **last 75%** (recent context), with a marker between them. Used for
 * MEMORY.md where early decisions and recent activity both matter.
 */
export function capMiddle(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return text;
  if (text.length <= maxBytes) return text;
  const headSize = Math.floor(maxBytes * 0.25);
  const tailSize = maxBytes - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(text.length - tailSize);
  const dropped = text.length - maxBytes;
  return `${head}\n\n[… truncated ${dropped} chars from middle for context budget …]\n\n${tail}`;
}

// Re-export path for callers that need it
export { path };
