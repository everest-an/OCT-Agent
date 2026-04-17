/**
 * Mission data model types.
 *
 * Mirror of docs/features/team-tasks/02-FILE-LAYOUT.md §3.1 with Plan B adjustments:
 *   - plan is JSON (not YAML) — we do not use Lobster
 *   - runtime defaults to "subagent" (OpenClaw sessions_spawn)
 *
 * Schema version 1. When a breaking change is needed, bump `version` and add a
 * migration in mission/migrations.ts.
 */

export type MissionStatus =
  | 'planning'
  | 'running'
  | 'paused'
  | 'paused_awaiting_human'
  | 'done'
  | 'failed';

export type StepStatus =
  | 'waiting'
  | 'running'
  | 'retrying'
  | 'done'
  | 'failed'
  | 'skipped';

/** Structured error classification — see 01-DESIGN §六 error taxonomy. */
export type MissionErrorCode =
  | 'network_error'
  | 'agent_crash'
  | 'permission_denied'
  | 'tool_rejected'
  | 'timeout'
  | 'context_overflow'
  | 'unknown';

export interface MissionStep {
  readonly id: string;                 // e.g. "T1"
  readonly agentId: string;
  readonly agentName?: string;
  readonly agentEmoji?: string;
  readonly role: string;               // e.g. "Developer"
  readonly title: string;
  readonly deliverable: string;        // what kind of artifact is expected
  readonly depends_on: readonly string[];
  readonly expectedDurationMinutes?: number;
  readonly model?: string;             // e.g. "claude-haiku-4-5-20251001"

  // runtime state — mutated by orchestrator
  readonly status: StepStatus;
  readonly attempts: number;
  readonly sessionKey?: string;        // agent:<id>:subagent:<uuid>
  readonly runId?: string;
  readonly startedAt?: string;         // ISO
  readonly completedAt?: string;       // ISO
  readonly artifactPath?: string;      // relative to mission dir, e.g. "artifacts/T1-foo.md"
  readonly errorCode?: MissionErrorCode;
  readonly errorMessage?: string;
}

export interface Mission {
  readonly id: string;
  readonly version: 1;
  readonly goal: string;
  readonly status: MissionStatus;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly plannerAgentId: string;
  readonly rootWorkDir?: string;
  readonly steps: readonly MissionStep[];
  readonly currentStepId?: string;
  readonly lastEvent?: {
    readonly at: string;
    readonly type: string;
    readonly stepId?: string;
    readonly payload?: string;
  };
}

/** Planner output — after schema validation. */
export interface Plan {
  readonly summary: string;
  readonly subtasks: readonly PlanSubtask[];
}

export interface PlanSubtask {
  readonly id: string;                 // "T1".."Tn"
  readonly agentId: string;
  readonly role: string;
  readonly title: string;
  readonly deliverable: string;
  readonly expectedDurationMinutes?: number;
  readonly model?: string;
  readonly depends_on: readonly string[];
}

/** Artifact markdown frontmatter. */
export interface ArtifactFrontmatter {
  readonly stepId: string;
  readonly agentId: string;
  readonly createdAt: string;
  readonly durationSeconds?: number;
}

export interface Heartbeat {
  readonly runnerPid: number;
  readonly lastBeatAt: string;         // ISO
  readonly currentStepId?: string;
  readonly stepStartedAt?: string;
  readonly lastEvent?: string;
  readonly gatewaySessionKey?: string;
}
