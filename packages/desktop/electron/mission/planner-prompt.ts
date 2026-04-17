/**
 * Planner prompt builder.
 *
 * Given a user goal + list of available agents + optional past experience,
 * produce the prompt string that will be sent to the Planner agent. The agent
 * must reply with **strict JSON** that passes plan-schema.validatePlan().
 *
 * Closed-loop requirement: the embedded example MUST itself pass validation
 * against a realistic availableAgentIds list. This is enforced by
 * `mission-planner-prompt.test.ts`.
 *
 * Spec: docs/features/team-tasks/01-DESIGN.md §5.1 (Planner Prompt)
 *       docs/features/team-tasks/03-ACCEPTANCE.md Journey 1-2
 */

import { MAX_SUBTASKS, MIN_SUBTASKS, FORBIDDEN_FIELDS } from './plan-schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlannerAgent {
  readonly id: string;
  readonly name?: string;
  readonly role?: string;
  readonly model?: string;
  readonly description?: string;
}

export interface BuildPlannerPromptInput {
  /** User's high-level goal, verbatim. */
  readonly goal: string;
  /** Agents the Planner may choose from. Must be non-empty. */
  readonly agents: readonly PlannerAgent[];
  /** Optional Awareness recall summary (past decisions / pitfalls). */
  readonly pastExperience?: string;
  /** Optional working directory hint for the eventual worker agents. */
  readonly workDir?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The literal example used in the prompt — exported for testing the closed loop. */
export const EXAMPLE_AGENT_IDS: readonly string[] = ['main', 'coder', 'tester'];

export function buildPlannerPrompt(input: BuildPlannerPromptInput): string {
  if (!input.goal || input.goal.trim().length === 0) {
    throw new Error('buildPlannerPrompt: goal must be a non-empty string');
  }
  if (!input.agents || input.agents.length === 0) {
    throw new Error('buildPlannerPrompt: agents list must be non-empty');
  }

  const availableAgentsBlock = renderAgents(input.agents);
  const past = (input.pastExperience && input.pastExperience.trim().length > 0)
    ? input.pastExperience.trim()
    : '(no prior experience available for this goal)';
  const workDirLine = input.workDir
    ? `\n<WorkingDirectory>\n${input.workDir}\n</WorkingDirectory>\n`
    : '';

  // Build the human-readable forbidden-fields list for the constraints section.
  const forbiddenList = FORBIDDEN_FIELDS.join(', ');

  return [
    '<Role>',
    'You are the Mission Planner. Your job is to break down a user goal into',
    `${MIN_SUBTASKS}–${MAX_SUBTASKS} ordered subtasks that a team of AI agents can execute.`,
    'You MUST output strict valid JSON matching the schema below.',
    '</Role>',
    '',
    '<UserGoal>',
    input.goal.trim(),
    '</UserGoal>',
    '',
    '<AvailableAgents>',
    availableAgentsBlock,
    '</AvailableAgents>',
    '',
    '<PastExperience>',
    past,
    '</PastExperience>',
    workDirLine,
    '<Constraints>',
    `- Produce between ${MIN_SUBTASKS} and ${MAX_SUBTASKS} subtasks. More tasks mean coordination overhead.`,
    '- Each subtask MUST include: id, agentId, role, title, deliverable, depends_on.',
    '- id must match the pattern ^T\\d+$ (T1, T2, ...). Ids must be unique within the plan.',
    '- agentId must be one of the ids listed in <AvailableAgents> above.',
    '- depends_on is an array of earlier step ids (may be empty). No self-references. No cycles.',
    '- Each deliverable is a markdown document that the NEXT agent will read to continue work.',
    '- Every deliverable markdown MUST end with a "## Handoff to next agent" section containing:',
    '    - Decisions made (do not revisit)',
    '    - Files / paths the next agent needs to know about',
    '    - Known issues / gotchas',
    '    - Next recommended action',
    `- FORBIDDEN fields (security — never include shell in a plan): ${forbiddenList}.`,
    '- Prefer cheaper models (Haiku) for simple execution; use stronger models only for design-heavy steps.',
    '- Keep titles imperative and short (≤ 200 chars). Keep deliverable descriptions ≤ 300 chars.',
    '</Constraints>',
    '',
    '<RoutingRules>',
    `- The team has ${input.agents.length} agent(s) available: ${input.agents.map((a) => a.id).join(', ')}.`,
    '- When 2+ agents are available, **distribute subtasks across DIFFERENT agents** to reflect real team work.',
    '- Match each agent to the subtask that fits its role (e.g. a Coder-role agent handles implementation,',
    '  a Designer-role agent handles UI/UX, a Tester-role agent handles QA/review).',
    '- **DO NOT route every subtask to the same agent** (especially not all to "main"). A plan where every',
    '  subtask shares one agentId is a policy violation and will be rejected.',
    '- If only one agent is available, you MAY repeat the same agentId — but you must still vary the roles',
    '  (e.g. T1 role="Designer", T2 role="Developer", T3 role="Tester").',
    '</RoutingRules>',
    '',
    '<OutputSchema>',
    [
      '{',
      '  "summary": "<one-line description of what this mission will produce>",',
      '  "subtasks": [',
      '    {',
      '      "id": "T1",',
      '      "agentId": "<one of AvailableAgents>",',
      '      "role": "<e.g. Developer>",',
      '      "title": "<short imperative title>",',
      '      "deliverable": "<what the deliverable markdown should contain>",',
      '      "expectedDurationMinutes": <optional positive number in (0, 600]>,',
      '      "model": "<optional model id>",',
      '      "depends_on": []',
      '    }',
      '  ]',
      '}',
    ].join('\n'),
    '</OutputSchema>',
    '',
    '<Example>',
    EXAMPLE_JSON,
    '</Example>',
    '',
    '<Instructions>',
    'Output ONLY the JSON. No prose before or after the JSON object.',
    'If the goal is ambiguous, pick the most reasonable interpretation and proceed.',
    `If you cannot produce a valid plan within the ${MIN_SUBTASKS}–${MAX_SUBTASKS} subtask bound, return a plan of ${MIN_SUBTASKS} subtasks with your best effort.`,
    '</Instructions>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function renderAgents(agents: readonly PlannerAgent[]): string {
  return agents
    .map((a) => {
      const bits = [`- id="${a.id}"`];
      if (a.name && a.name !== a.id) bits.push(`name="${a.name}"`);
      if (a.role) bits.push(`role="${a.role}"`);
      if (a.model) bits.push(`model="${a.model}"`);
      if (a.description) bits.push(`description="${a.description}"`);
      return bits.join(' ');
    })
    .join('\n');
}

/**
 * Example plan for a simple goal. Uses agents `main`, `coder`, `tester` (see
 * EXAMPLE_AGENT_IDS). This example MUST pass validatePlan(parsed,
 * {availableAgentIds: EXAMPLE_AGENT_IDS}) — the closed-loop test enforces it.
 */
const EXAMPLE_JSON = `{
  "summary": "Build a minimal React TODO list app with Vite",
  "subtasks": [
    {
      "id": "T1",
      "agentId": "coder",
      "role": "Developer",
      "title": "Scaffold Vite + React project with TypeScript",
      "deliverable": "Markdown doc listing the generated files and key decisions. Must end with a '## Handoff to next agent' block.",
      "expectedDurationMinutes": 5,
      "model": "claude-haiku-4-5-20251001",
      "depends_on": []
    },
    {
      "id": "T2",
      "agentId": "coder",
      "role": "Developer",
      "title": "Implement the TODO list component with add / toggle / delete",
      "deliverable": "Markdown doc documenting the component API, file paths modified, and remaining TODOs. Must end with '## Handoff to next agent'.",
      "expectedDurationMinutes": 10,
      "model": "claude-haiku-4-5-20251001",
      "depends_on": ["T1"]
    },
    {
      "id": "T3",
      "agentId": "tester",
      "role": "Tester",
      "title": "Write Vitest unit tests for the TODO list component",
      "deliverable": "Markdown doc listing test file paths, coverage summary, and any flaky cases. Must end with '## Handoff to next agent'.",
      "expectedDurationMinutes": 8,
      "model": "claude-haiku-4-5-20251001",
      "depends_on": ["T2"]
    }
  ]
}`;

/** Exported so tests can validate the closed loop. */
export function getExamplePlanJson(): string {
  return EXAMPLE_JSON;
}
