/**
 * Mission store — multi-agent workflow data model + localStorage persistence.
 *
 * A Mission = a user goal executed by a team of agents sequentially.
 * Each step is one agent working on a piece of the goal,
 * receiving context from the previous step's output.
 *
 * All state is immutable and local-first (localStorage).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MissionStatus = 'planning' | 'running' | 'paused' | 'done' | 'failed';
export type StepStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';

export interface MissionStep {
  readonly id: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly agentEmoji?: string;
  readonly role: string;           // "Planner", "Coder", "Tester", etc.
  readonly instruction: string;    // what this agent should do
  readonly status: StepStatus;
  readonly sessionKey?: string;    // subagent session for this step
  readonly runId?: string;
  readonly result?: string;        // agent's output (summary)
  readonly error?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface Mission {
  readonly id: string;
  readonly goal: string;           // user's original description
  readonly status: MissionStatus;
  readonly steps: readonly MissionStep[];
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly currentStepIndex: number;  // which step is active (-1 = not started)
  readonly sessionKey?: string;    // main agent session for this mission
  readonly workDir?: string;       // working directory
  readonly result?: string;        // final summary from main agent
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Pre-defined role templates
// ---------------------------------------------------------------------------

/** Agent role heuristics based on agent name/id patterns (EN + CN). */
const ROLE_PATTERNS: ReadonlyArray<{ pattern: RegExp; role: string; order: number }> = [
  { pattern: /plan|architect|design|strateg|规划|架构|设计/i, role: 'Planner', order: 1 },
  { pattern: /research|analys|investigat|研究|分析|调研|论文/i, role: 'Researcher', order: 2 },
  { pattern: /code|develop|implement|build|engineer|program|编程|开发|vibe/i, role: 'Developer', order: 3 },
  { pattern: /test|qa|quality|verif|测试|质量/i, role: 'Tester', order: 4 },
  { pattern: /review|audit|check|inspect|审查|检查/i, role: 'Reviewer', order: 5 },
  { pattern: /deploy|release|ship|ops|部署|发布|运维/i, role: 'Deployer', order: 6 },
  { pattern: /write|doc|content|blog|写作|文档|内容/i, role: 'Writer', order: 3 },
  { pattern: /fix|debug|repair|patch|修复|调试/i, role: 'Fixer', order: 3 },
  { pattern: /draw|paint|art|illustrat|画|美术|插画/i, role: 'Artist', order: 7 },
  { pattern: /translate|翻译/i, role: 'Translator', order: 8 },
];

export interface AgentInfo {
  readonly id: string;
  readonly name?: string;
  readonly emoji?: string;
}

/** Guess an agent's role from its name/id. Returns role + sort order. */
export function guessAgentRole(agent: AgentInfo): { role: string; order: number } {
  const text = `${agent.name || ''} ${agent.id}`;
  for (const { pattern, role, order } of ROLE_PATTERNS) {
    if (pattern.test(text)) return { role, order };
  }
  return { role: 'Assistant', order: 99 };
}

/** Sort agents into a sensible workflow order. */
export function sortAgentsForWorkflow(agents: readonly AgentInfo[]): readonly AgentInfo[] {
  return [...agents].sort((a, b) => {
    const ra = guessAgentRole(a);
    const rb = guessAgentRole(b);
    return ra.order - rb.order;
  });
}

// ---------------------------------------------------------------------------
// Pre-defined mission templates
// ---------------------------------------------------------------------------

export interface MissionTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly emoji: string;
  readonly roles: readonly string[];  // roles needed (Planner, Coder, etc.)
}

export const MISSION_TEMPLATES: readonly MissionTemplate[] = [
  {
    id: 'feature',
    name: 'Build a Feature',
    description: 'Plan, code, test, and review a new feature',
    emoji: '🚀',
    roles: ['Planner', 'Developer', 'Tester', 'Reviewer'],
  },
  {
    id: 'bugfix',
    name: 'Fix a Bug',
    description: 'Investigate, fix, and verify a bug',
    emoji: '🔧',
    roles: ['Researcher', 'Fixer', 'Tester'],
  },
  {
    id: 'review',
    name: 'Code Review',
    description: 'Review code for quality and security',
    emoji: '🔍',
    roles: ['Reviewer'],
  },
  {
    id: 'custom',
    name: 'Custom Task',
    description: 'Describe anything and let AI figure out the team',
    emoji: '✨',
    roles: [],
  },
];

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const MISSIONS_KEY = 'awareness-claw-missions';

export function loadMissions(): readonly Mission[] {
  try {
    const raw = localStorage.getItem(MISSIONS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Mission[];
  } catch {
    return [];
  }
}

export function saveMissions(missions: readonly Mission[]): void {
  localStorage.setItem(MISSIONS_KEY, JSON.stringify(missions));
}

// ---------------------------------------------------------------------------
// Immutable CRUD
// ---------------------------------------------------------------------------

function uid(): string {
  return `mission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function stepId(): string {
  return `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function now(): string {
  return new Date().toISOString();
}

/** Create a mission from a goal + available agents. */
export function createMission(
  goal: string,
  agents: readonly AgentInfo[],
): Mission {
  const sorted = sortAgentsForWorkflow(agents);
  const steps: MissionStep[] = sorted.map((agent) => {
    const { role } = guessAgentRole(agent);
    return {
      id: stepId(),
      agentId: agent.id,
      agentName: agent.name || agent.id,
      agentEmoji: agent.emoji,
      role,
      instruction: '', // filled by mission engine
      status: 'waiting',
    };
  });

  return {
    id: uid(),
    goal,
    status: 'planning',
    steps,
    createdAt: now(),
    currentStepIndex: -1,
  };
}

/** Update a mission immutably. */
export function updateMission(
  missions: readonly Mission[],
  missionId: string,
  patch: Partial<Omit<Mission, 'id' | 'createdAt'>>,
): readonly Mission[] {
  return missions.map((m) => (m.id === missionId ? { ...m, ...patch } : m));
}

/** Update a specific step within a mission. */
export function updateMissionStep(
  missions: readonly Mission[],
  missionId: string,
  stepIndex: number,
  patch: Partial<Omit<MissionStep, 'id'>>,
): readonly Mission[] {
  return missions.map((m) => {
    if (m.id !== missionId) return m;
    const steps = m.steps.map((s, i) => (i === stepIndex ? { ...s, ...patch } : s));
    return { ...m, steps };
  });
}

/** Remove a mission. */
export function removeMission(
  missions: readonly Mission[],
  missionId: string,
): readonly Mission[] {
  return missions.filter((m) => m.id !== missionId);
}

/** Get the next waiting step index, or -1 if all done. */
export function getNextStepIndex(mission: Mission): number {
  return mission.steps.findIndex((s) => s.status === 'waiting');
}

/** Check if all steps are done. */
export function isMissionComplete(mission: Mission): boolean {
  return mission.steps.every((s) => s.status === 'done' || s.status === 'skipped');
}

/** Check if any step failed. */
export function hasMissionFailed(mission: Mission): boolean {
  return mission.steps.some((s) => s.status === 'failed');
}

/** Calculate mission progress as 0-100. */
export function missionProgress(mission: Mission): number {
  if (mission.steps.length === 0) return 0;
  const done = mission.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return Math.round((done / mission.steps.length) * 100);
}

/** Format elapsed time. */
export function formatElapsed(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return '';
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - new Date(startedAt).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}
