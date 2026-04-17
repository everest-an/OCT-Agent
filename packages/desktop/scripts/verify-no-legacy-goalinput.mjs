#!/usr/bin/env node
/**
 * L1 Anti-Regression Guard: prevent the legacy goal-input textarea from
 * reappearing in TaskCenter.tsx.
 *
 * Background: The UI originally had TWO goal-input boxes on Team Tasks
 * (legacy `goalInput` textarea + new `MissionFlowShell` Composer) which
 * confused users. The legacy textarea was removed in F-Team-Tasks Phase 4.
 *
 * This guard fails CI if:
 *   1. A `goalInput` useState hook is reintroduced in TaskCenter.tsx
 *   2. A textarea `placeholder="taskCenter.goalPlaceholder"` comes back
 *   3. `MissionCard` renders in TaskCenter's render tree again
 *
 * Rationale: single source of truth for team-task composing is
 * `MissionComposer` inside `MissionFlowShell`. Do not split user intent
 * across two inputs.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TASK_CENTER = resolve(ROOT, 'src/pages/TaskCenter.tsx');

if (!existsSync(TASK_CENTER)) {
  console.error(`[L1 FAIL] ${TASK_CENTER} not found`);
  process.exit(1);
}

const src = readFileSync(TASK_CENTER, 'utf-8');

// Strip single-line comments so we don't trip on legitimate documentation references.
const body = src
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

let errors = 0;

// Check 1 — no `goalInput` state
if (/useState[^)]*\bgoalInput\b/.test(body)) {
  errors++;
  console.error('[L1 FAIL] Legacy `useState goalInput` reintroduced in TaskCenter.tsx');
}

// Check 2 — no placeholder referencing taskCenter.goalPlaceholder
if (/taskCenter\.goalPlaceholder/.test(body)) {
  errors++;
  console.error('[L1 FAIL] Legacy placeholder taskCenter.goalPlaceholder back in TaskCenter.tsx');
}

// Check 3 — no MissionCard imports or JSX usage
if (/import\s+MissionCard\b/.test(body) || /<MissionCard\b/.test(body)) {
  errors++;
  console.error('[L1 FAIL] MissionCard has returned to TaskCenter.tsx; use MissionHistoryList from mission-flow/ instead');
}

// Check 4 — MissionFlowShell must still be present
if (!/<MissionFlowShell\b/.test(body)) {
  errors++;
  console.error('[L1 FAIL] MissionFlowShell is missing from TaskCenter.tsx render tree');
}

if (errors > 0) {
  console.error(`\n[L1 FAIL] ${errors} legacy-UI regression(s) detected in TaskCenter.tsx.`);
  process.exit(1);
}

console.log('[L1 PASS] TaskCenter.tsx is legacy-goalinput-free and MissionFlowShell is present.');
