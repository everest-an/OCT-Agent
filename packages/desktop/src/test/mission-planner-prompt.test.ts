/**
 * Tests for electron/mission/planner-prompt.ts
 *
 * Priorities (from docs/features/team-tasks/03-ACCEPTANCE.md):
 *   - Closed loop: the embedded Example MUST pass plan-schema validation
 *     (otherwise we're giving the LLM an invalid template)
 *   - Prompt contains all required sections (Role / UserGoal / AvailableAgents /
 *     PastExperience / Constraints / OutputSchema / Example / Instructions)
 *   - Constraints reference the actual numeric bounds from plan-schema
 *   - Goal and agents are interpolated verbatim (no escaping/truncation
 *     surprises for the LLM)
 *   - Input validation (empty goal / empty agents)
 *   - Security: FORBIDDEN_FIELDS list is visibly present in the prompt
 */

import { describe, it, expect } from 'vitest';
import {
  buildPlannerPrompt,
  EXAMPLE_AGENT_IDS,
  getExamplePlanJson,
} from '../../electron/mission/planner-prompt';
import {
  parsePlan,
  FORBIDDEN_FIELDS,
  MAX_SUBTASKS,
  MIN_SUBTASKS,
} from '../../electron/mission/plan-schema';

const AGENTS = [
  { id: 'main', name: 'Claw', role: 'Generalist', model: 'claude-sonnet-4-6' },
  { id: 'coder', name: 'Dev', role: 'Developer' },
  { id: 'tester', name: 'QA', role: 'Tester' },
];

// ---------------------------------------------------------------------------
// Closed loop — embedded Example must pass validator
// ---------------------------------------------------------------------------

describe('planner-prompt · closed loop', () => {
  it('EXAMPLE_JSON parses as valid plan against EXAMPLE_AGENT_IDS', () => {
    const res = parsePlan(getExamplePlanJson(), {
      availableAgentIds: [...EXAMPLE_AGENT_IDS],
    });
    if (!res.ok) {
      // Print errors so test failure is actionable
      // eslint-disable-next-line no-console
      console.error('Example plan failed validation:\n' + res.errors.join('\n'));
    }
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.plan.subtasks.length).toBeGreaterThanOrEqual(MIN_SUBTASKS);
      expect(res.plan.subtasks.length).toBeLessThanOrEqual(MAX_SUBTASKS);
    }
  });

  it('every agentId used in the Example is present in EXAMPLE_AGENT_IDS', () => {
    // The closed-loop test above already validates this via parsePlan, but
    // we assert the containment explicitly here for a clearer failure message
    // if someone adds an agentId to the example without updating the set.
    expect(EXAMPLE_AGENT_IDS.length).toBeGreaterThan(0);
    const exampleText = getExamplePlanJson();
    const agentIdMatches = Array.from(exampleText.matchAll(/"agentId":\s*"([^"]+)"/g));
    expect(agentIdMatches.length).toBeGreaterThan(0);
    const usedIds = new Set(agentIdMatches.map((m) => m[1]));
    for (const id of usedIds) {
      expect(EXAMPLE_AGENT_IDS).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// Required sections
// ---------------------------------------------------------------------------

describe('planner-prompt · required sections', () => {
  const prompt = buildPlannerPrompt({
    goal: 'Build a TODO app',
    agents: AGENTS,
  });

  it.each([
    '<Role>',
    '<UserGoal>',
    '<AvailableAgents>',
    '<PastExperience>',
    '<Constraints>',
    '<OutputSchema>',
    '<Example>',
    '<Instructions>',
  ])('contains section tag %s', (tag) => {
    expect(prompt).toContain(tag);
  });

  it('sections appear in the documented order', () => {
    const order = [
      '<Role>',
      '<UserGoal>',
      '<AvailableAgents>',
      '<PastExperience>',
      '<Constraints>',
      '<OutputSchema>',
      '<Example>',
      '<Instructions>',
    ];
    let last = -1;
    for (const tag of order) {
      const idx = prompt.indexOf(tag);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });
});

// ---------------------------------------------------------------------------
// Constraint references match plan-schema
// ---------------------------------------------------------------------------

describe('planner-prompt · constraints reference plan-schema bounds', () => {
  const prompt = buildPlannerPrompt({
    goal: 'x',
    agents: AGENTS,
  });

  it(`mentions MIN_SUBTASKS (${MIN_SUBTASKS}) and MAX_SUBTASKS (${MAX_SUBTASKS})`, () => {
    expect(prompt).toContain(String(MIN_SUBTASKS));
    expect(prompt).toContain(String(MAX_SUBTASKS));
  });

  it('lists every forbidden field by name (security surface)', () => {
    for (const field of FORBIDDEN_FIELDS) {
      expect(prompt).toContain(field);
    }
  });

  it('mandates the "Handoff to next agent" block in every deliverable', () => {
    expect(prompt).toContain('Handoff to next agent');
    expect(prompt).toContain('Decisions made');
    expect(prompt).toContain('Known issues');
  });
});

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

describe('planner-prompt · interpolation', () => {
  it('embeds goal verbatim (trimmed)', () => {
    const prompt = buildPlannerPrompt({
      goal: '  Make a weekly retro email generator  ',
      agents: AGENTS,
    });
    expect(prompt).toContain('Make a weekly retro email generator');
  });

  it('renders all agents with id (+ name / role / model when present)', () => {
    const prompt = buildPlannerPrompt({
      goal: 'x',
      agents: AGENTS,
    });
    expect(prompt).toContain('id="main"');
    expect(prompt).toContain('name="Claw"');
    expect(prompt).toContain('role="Generalist"');
    expect(prompt).toContain('model="claude-sonnet-4-6"');
    expect(prompt).toContain('id="coder"');
    expect(prompt).toContain('id="tester"');
  });

  it('skips name line when name equals id (avoid redundancy)', () => {
    const prompt = buildPlannerPrompt({
      goal: 'x',
      agents: [{ id: 'oc-1', name: 'oc-1' }],
    });
    // id should be shown, but `name="oc-1"` must NOT (equal to id)
    expect(prompt).toContain('id="oc-1"');
    expect(prompt).not.toContain('name="oc-1"');
  });

  it('falls back to "(no prior experience available...)" when pastExperience missing', () => {
    const prompt = buildPlannerPrompt({
      goal: 'x',
      agents: AGENTS,
    });
    expect(prompt).toContain('(no prior experience available');
  });

  it('embeds pastExperience when provided', () => {
    const prompt = buildPlannerPrompt({
      goal: 'x',
      agents: AGENTS,
      pastExperience: 'User always picks pnpm over npm. Prefer Vite for React apps.',
    });
    expect(prompt).toContain('User always picks pnpm over npm');
    expect(prompt).not.toContain('(no prior experience available');
  });

  it('trims and ignores pastExperience that is whitespace only', () => {
    const prompt = buildPlannerPrompt({
      goal: 'x',
      agents: AGENTS,
      pastExperience: '   \n\t  ',
    });
    expect(prompt).toContain('(no prior experience available');
  });

  it('includes workDir section when provided, omits otherwise', () => {
    const withWD = buildPlannerPrompt({
      goal: 'x',
      agents: AGENTS,
      workDir: '/Users/x/projects/blog',
    });
    expect(withWD).toContain('<WorkingDirectory>');
    expect(withWD).toContain('/Users/x/projects/blog');

    const without = buildPlannerPrompt({
      goal: 'x',
      agents: AGENTS,
    });
    expect(without).not.toContain('<WorkingDirectory>');
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('planner-prompt · input validation', () => {
  it('throws on empty goal', () => {
    expect(() => buildPlannerPrompt({ goal: '', agents: AGENTS })).toThrow(/goal/);
    expect(() => buildPlannerPrompt({ goal: '   ', agents: AGENTS })).toThrow(/goal/);
  });

  it('throws on empty agents list', () => {
    expect(() => buildPlannerPrompt({ goal: 'x', agents: [] })).toThrow(/agents/);
  });
});

// ---------------------------------------------------------------------------
// Instruction: JSON only (critical — prevents prose leakage)
// ---------------------------------------------------------------------------

describe('planner-prompt · output instruction', () => {
  it('instructs LLM to output ONLY JSON', () => {
    const prompt = buildPlannerPrompt({ goal: 'x', agents: AGENTS });
    expect(prompt).toMatch(/Output ONLY the JSON/i);
    expect(prompt).toMatch(/No prose before or after/i);
  });
});
