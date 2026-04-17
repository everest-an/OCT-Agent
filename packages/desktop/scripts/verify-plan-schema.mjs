#!/usr/bin/env node
/**
 * L1 Static Guard: Planner prompt <-> plan-schema parity.
 *
 * Load `getExamplePlanJson()` from planner-prompt.ts at runtime and feed it
 * to `parsePlan()`. If the example the LLM sees is NOT valid against the
 * runtime validator, the Planner will never hit a retry loop we can reason
 * about — the prompt is a lie.
 *
 * This is the equivalent of the in-file closed-loop test that already lives
 * in `src/test/mission-planner-prompt.test.ts`, surfaced at the ship-gate
 * level so a pre-push hook catches drift.
 *
 * We load the TS modules via a light esbuild-free approach: spawn `tsx`
 * if available, otherwise fall back to the vitest runtime (we know the
 * repo already ships vitest).  To keep this script dependency-free, we
 * invoke `npx vitest run --project ephemeral` — but that's heavy.  Instead,
 * we reuse a tiny ad-hoc loader via `node --experimental-strip-types` or
 * a pre-built CJS bundle if any.
 *
 * Simpler approach: use `node --experimental-vm-modules` + ts-node? Too
 * many assumptions.  Instead, we spawn a Node process with the vitest
 * runner scoped to the closed-loop test file; vitest handles TS → JS.
 * This turns the script into "a CI smoke that the specific closed-loop
 * test is present and passes".
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const testFile = resolve(ROOT, 'src/test/mission-planner-prompt.test.ts');
if (!existsSync(testFile)) {
  console.error(`[L1 FAIL] missing closed-loop test: ${testFile}`);
  process.exit(1);
}

// Look for "Example JSON must pass parsePlan" assertion text to make sure the
// closed-loop test case still exists in the file.
import { readFileSync } from 'fs';
const testSrc = readFileSync(testFile, 'utf-8');
if (!/getExamplePlanJson/.test(testSrc) || !/parsePlan/.test(testSrc)) {
  console.error(`[L1 FAIL] mission-planner-prompt.test.ts no longer closes the loop (getExamplePlanJson + parsePlan calls missing).`);
  process.exit(1);
}

// Run the test file with vitest.
const res = spawnSync('npx', ['vitest', 'run', 'src/test/mission-planner-prompt.test.ts'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, CI: '1' },
});

if (res.status !== 0) {
  console.error('[L1 FAIL] planner-prompt closed-loop test failed. Example JSON is no longer valid under plan-schema.');
  process.exit(1);
}

console.log('[L1 PASS] Planner example JSON is valid under plan-schema.');
