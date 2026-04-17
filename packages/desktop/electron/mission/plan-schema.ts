/**
 * Plan JSON runtime validator.
 *
 * LLM Planners may output JSON that *looks* valid but violates invariants
 * (cycles in depends_on, unknown agent ids, too many steps, or even shell
 * command fields from prompt injection). This module is the hard guard that
 * lives between "Planner produced some JSON" and "Orchestrator starts
 * spawning agents".
 *
 * Rationale (see docs/features/team-tasks/01-DESIGN.md §三·D6 and
 * docs/features/team-tasks/03-ACCEPTANCE.md L3.2–L3.4):
 *   - 3–5 subtasks (业界经验, Claude Code / CrewAI 3–5 sweet spot)
 *   - All agent refs must be in the caller-supplied whitelist
 *   - depends_on forms a DAG (no cycles, no self-references, no unknown refs)
 *   - Field whitelist — no `command` / `shell` / `exec` / `cwd` / `script`
 *     escapes prompt injection → shell execution
 *   - Rich error list (not first-error-only) so Planner retry prompt can fix
 *     everything in one shot
 *
 * Zero runtime deps (no zod/ajv) — small hand-rolled checker keeps our bundle
 * lean and audit surface tiny.
 */

import type { Plan, PlanSubtask } from './types';

// ---------------------------------------------------------------------------
// Constants (tunable here; any change requires updating ACCEPTANCE + tests)
// ---------------------------------------------------------------------------

export const MIN_SUBTASKS = 3;
export const MAX_SUBTASKS = 5;

/** Subtask id must match T followed by digits, case-insensitive. */
export const STEP_ID_RE = /^T\d+$/;

/** Fields we refuse to forward from Planner output into any runtime surface. */
export const FORBIDDEN_FIELDS: readonly string[] = [
  'command',
  'shell',
  'exec',
  'cwd',
  'workdir',
  'workDir',
  'script',
  'env',
  'bin',
  'run',
  'stdin',
  'stdout',
];

const ALLOWED_SUBTASK_KEYS: ReadonlySet<string> = new Set([
  'id',
  'agentId',
  'role',
  'title',
  'deliverable',
  'expectedDurationMinutes',
  'model',
  'depends_on',
]);

const ALLOWED_ROOT_KEYS: ReadonlySet<string> = new Set([
  'summary',
  'subtasks',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ValidatePlanOptions {
  /** Allowed agent ids (from the current openclaw.json agents list). */
  readonly availableAgentIds: readonly string[];
  /** Optional allow-list for model ids. If omitted, any non-empty string passes. */
  readonly availableModels?: readonly string[];
}

export type ValidatePlanResult =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validate an arbitrary value as a Plan. Returns either `{ok:true, plan}` or
 * `{ok:false, errors}` with every violation found (not first-error-only), so
 * a retry prompt can surface the full list.
 */
export function validatePlan(
  raw: unknown,
  opts: ValidatePlanOptions,
): ValidatePlanResult {
  const errors: string[] = [];

  if (!isObject(raw)) {
    return { ok: false, errors: ['root value must be a JSON object'] };
  }

  // Unknown root keys
  for (const k of Object.keys(raw)) {
    if (!ALLOWED_ROOT_KEYS.has(k)) {
      errors.push(`root contains unknown key "${k}" (allowed: summary, subtasks)`);
    }
  }

  // summary
  const summary = (raw as any).summary;
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    errors.push('summary must be a non-empty string');
  } else if (summary.length > 500) {
    errors.push(`summary is too long (${summary.length} > 500 chars)`);
  }

  // subtasks — array shape
  const subtasksRaw = (raw as any).subtasks;
  if (!Array.isArray(subtasksRaw)) {
    errors.push('subtasks must be an array');
    return { ok: false, errors };
  }
  if (subtasksRaw.length < MIN_SUBTASKS) {
    errors.push(`subtasks has ${subtasksRaw.length} entries, minimum is ${MIN_SUBTASKS}`);
  }
  if (subtasksRaw.length > MAX_SUBTASKS) {
    errors.push(`subtasks has ${subtasksRaw.length} entries, maximum is ${MAX_SUBTASKS}`);
  }

  // Per-subtask validation
  const seenIds = new Set<string>();
  const validated: PlanSubtask[] = [];
  for (let i = 0; i < subtasksRaw.length; i++) {
    const st = subtasksRaw[i];
    const ctx = `subtasks[${i}]`;
    if (!isObject(st)) {
      errors.push(`${ctx} must be a JSON object`);
      continue;
    }
    const built = validateSubtask(st, ctx, opts, errors);
    if (built) {
      if (seenIds.has(built.id)) {
        errors.push(`${ctx}.id "${built.id}" duplicates an earlier subtask id`);
      } else {
        seenIds.add(built.id);
        validated.push(built);
      }
    }
  }

  // depends_on must only reference declared ids and not self-reference
  for (const st of validated) {
    for (const dep of st.depends_on) {
      if (dep === st.id) {
        errors.push(`subtask ${st.id} depends on itself`);
      } else if (!seenIds.has(dep)) {
        errors.push(`subtask ${st.id} depends_on references unknown step "${dep}"`);
      }
    }
  }

  // Cycle detection (only if all ids resolved — otherwise the cycle message is
  // misleading)
  if (!errors.some((e) => /references unknown step/.test(e))) {
    const cycle = findCycle(validated);
    if (cycle) {
      errors.push(`cyclic dependency detected: ${cycle.join(' → ')}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const plan: Plan = {
    summary: (summary as string).trim(),
    subtasks: validated,
  };
  return { ok: true, plan };
}

/**
 * Parse + validate a JSON string. Convenience wrapper — the Planner returns
 * a string from Gateway, we want a single call site that rejects both bad
 * JSON and bad schema.
 */
export function parsePlan(
  jsonText: string,
  opts: ValidatePlanOptions,
): ValidatePlanResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err: any) {
    return { ok: false, errors: [`invalid JSON: ${err?.message || 'parse error'}`] };
  }
  return validatePlan(parsed, opts);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateSubtask(
  st: Record<string, unknown>,
  ctx: string,
  opts: ValidatePlanOptions,
  errors: string[],
): PlanSubtask | null {
  // Reject forbidden fields first (security) — even if other fields are wrong,
  // we want this error surfaced so retry prompt knows not to include shell.
  for (const f of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(st, f)) {
      errors.push(`${ctx} contains forbidden field "${f}" — shell commands are not allowed in plan`);
    }
  }

  // Warn on unknown (but non-forbidden) keys — permissive but surfaced so
  // future schema additions don't fail silently.
  for (const k of Object.keys(st)) {
    if (!ALLOWED_SUBTASK_KEYS.has(k) && !FORBIDDEN_FIELDS.includes(k)) {
      errors.push(`${ctx} contains unknown field "${k}" (ignored)`);
    }
  }

  // id
  const id = st.id;
  if (typeof id !== 'string' || !STEP_ID_RE.test(id)) {
    errors.push(`${ctx}.id must match ${STEP_ID_RE.toString()} (got ${safeRepr(id)})`);
    return null;
  }

  // agentId
  const agentId = st.agentId;
  if (typeof agentId !== 'string' || agentId.length === 0) {
    errors.push(`${ctx}.agentId must be a non-empty string`);
    return null;
  }
  if (!opts.availableAgentIds.includes(agentId)) {
    errors.push(
      `${ctx}.agentId "${agentId}" is not in the available agents list ` +
      `(allowed: ${opts.availableAgentIds.join(', ') || '(none)'} )`,
    );
  }

  // role
  const role = st.role;
  if (typeof role !== 'string' || role.trim().length === 0) {
    errors.push(`${ctx}.role must be a non-empty string`);
  }

  // title
  const title = st.title;
  if (typeof title !== 'string' || title.trim().length === 0) {
    errors.push(`${ctx}.title must be a non-empty string`);
  } else if (title.length > 200) {
    errors.push(`${ctx}.title is too long (${title.length} > 200 chars)`);
  }

  // deliverable
  const deliverable = st.deliverable;
  if (typeof deliverable !== 'string' || deliverable.trim().length === 0) {
    errors.push(`${ctx}.deliverable must be a non-empty string`);
  }

  // expectedDurationMinutes (optional, but if present must be positive int)
  const dur = st.expectedDurationMinutes;
  if (dur !== undefined) {
    if (typeof dur !== 'number' || !Number.isFinite(dur) || dur <= 0 || dur > 600) {
      errors.push(`${ctx}.expectedDurationMinutes must be a number in (0, 600]`);
    }
  }

  // model (optional)
  const model = st.model;
  if (model !== undefined) {
    if (typeof model !== 'string' || model.length === 0) {
      errors.push(`${ctx}.model must be a non-empty string when provided`);
    } else if (opts.availableModels && !opts.availableModels.includes(model)) {
      errors.push(`${ctx}.model "${model}" is not in the allowed models whitelist`);
    }
  }

  // depends_on (required, but may be empty)
  const deps = st.depends_on;
  if (deps === undefined) {
    errors.push(`${ctx}.depends_on is required (use [] for none)`);
    return null;
  }
  if (!Array.isArray(deps)) {
    errors.push(`${ctx}.depends_on must be an array`);
    return null;
  }
  const depErrors = deps.filter((d) => typeof d !== 'string');
  if (depErrors.length > 0) {
    errors.push(`${ctx}.depends_on contains non-string entries`);
    return null;
  }

  // Build a PlanSubtask. If any of the string-shape checks above failed, we
  // still return the object so later logic (cycle detection) can continue —
  // errors already captured.
  return {
    id,
    agentId: agentId as string,
    role: typeof role === 'string' ? role : '',
    title: typeof title === 'string' ? title : '',
    deliverable: typeof deliverable === 'string' ? deliverable : '',
    depends_on: deps as string[],
    ...(typeof dur === 'number' ? { expectedDurationMinutes: dur } : {}),
    ...(typeof model === 'string' ? { model } : {}),
  };
}

/**
 * Find a cycle in the depends_on DAG via DFS. Returns the first cycle as a
 * path like ["T1", "T2", "T3", "T1"] or null if the graph is acyclic.
 */
function findCycle(subtasks: readonly PlanSubtask[]): string[] | null {
  const byId = new Map<string, PlanSubtask>(subtasks.map((s) => [s.id, s]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const s of subtasks) color.set(s.id, WHITE);

  const stack: string[] = [];
  let cycleFound: string[] | null = null;

  function dfs(id: string): void {
    if (cycleFound) return;
    color.set(id, GRAY);
    stack.push(id);
    const node = byId.get(id);
    if (node) {
      for (const dep of node.depends_on) {
        const c = color.get(dep);
        if (c === WHITE) dfs(dep);
        else if (c === GRAY && !cycleFound) {
          const cycleStart = stack.indexOf(dep);
          cycleFound = stack.slice(cycleStart).concat(dep);
          return;
        }
      }
    }
    color.set(id, BLACK);
    stack.pop();
  }

  for (const s of subtasks) {
    if (cycleFound) break;
    if (color.get(s.id) === WHITE) dfs(s.id);
  }
  return cycleFound;
}

function safeRepr(v: unknown): string {
  if (typeof v === 'string') return `"${v.slice(0, 40)}"`;
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return typeof v;
}
