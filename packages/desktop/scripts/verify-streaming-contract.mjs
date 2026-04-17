#!/usr/bin/env node
/**
 * L1 Static Guard: every `mission:*-delta` event payload must carry a `chunk`
 * string property. This is what the renderer depends on to append tokens
 * live. If somebody renames the field (e.g. to `text`) the stream silently
 * stops updating the UI — exactly the kind of bug that shipped in v0.6.x.
 *
 * Checks:
 *   1. `register-mission-handlers.ts::missionEventToIpc` returns an object
 *      with a `chunk` field for `planner-delta` and `step-delta`.
 *   2. `preload.ts::onMissionPlannerDelta` / `onMissionStepDelta` callback
 *      destructures `chunk`.
 *   3. `useMissionFlow` reads `data.chunk` in its planner-delta and step-delta
 *      handlers.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const files = [
  'electron/ipc/register-mission-handlers.ts',
  'electron/preload.ts',
  'src/components/mission-flow/useMissionFlow.ts',
  'src/types/electron.d.ts',
];
for (const rel of files) {
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) {
    console.error(`[L1 FAIL] missing file: ${rel}`);
    process.exit(1);
  }
}

const mainSrc = readFileSync(resolve(ROOT, files[0]), 'utf-8');
const preloadSrc = readFileSync(resolve(ROOT, files[1]), 'utf-8');
const hookSrc = readFileSync(resolve(ROOT, files[2]), 'utf-8');
const dtsSrc = readFileSync(resolve(ROOT, files[3]), 'utf-8');

let errors = 0;

// Check 1 · register-mission-handlers.ts · planner-delta + step-delta carry chunk
function mapperHasChunkFor(tag) {
  // Accept any of:   channel: 'mission:xxx-delta', payload: { ... chunk: event.chunk ... }
  const re = new RegExp(
    `channel:\\s*['"\`]mission:${tag}-delta['"\`][\\s\\S]{0,200}chunk:\\s*event\\.chunk`,
    'm',
  );
  return re.test(mainSrc);
}
for (const tag of ['planner', 'step']) {
  if (!mapperHasChunkFor(tag)) {
    errors++;
    console.error(`[L1 FAIL] register-mission-handlers.ts::missionEventToIpc — '${tag}-delta' payload missing chunk:event.chunk`);
  }
}

// Check 2 · preload.ts callback signatures include chunk
for (const name of ['onMissionPlannerDelta', 'onMissionStepDelta']) {
  const re = new RegExp(`${name}[\\s\\S]{0,250}chunk`, 'm');
  if (!re.test(preloadSrc)) {
    errors++;
    console.error(`[L1 FAIL] preload.ts::${name} callback missing chunk`);
  }
}

// Check 3 · electron.d.ts types include chunk for the callbacks
for (const name of ['onMissionPlannerDelta', 'onMissionStepDelta']) {
  const re = new RegExp(`${name}[\\s\\S]{0,250}chunk:\\s*string`, 'm');
  if (!re.test(dtsSrc)) {
    errors++;
    console.error(`[L1 FAIL] electron.d.ts::${name} signature missing chunk:string`);
  }
}

// Check 4 · useMissionFlow accumulates chunk in state
if (!/setPlannerStream\([\s\S]{0,80}chunk/.test(hookSrc)) {
  errors++;
  console.error('[L1 FAIL] useMissionFlow does not append data.chunk to plannerStream');
}
if (!/setStepStream\([\s\S]{0,160}chunk/.test(hookSrc)) {
  errors++;
  console.error('[L1 FAIL] useMissionFlow does not append data.chunk to stepStream');
}

if (errors > 0) {
  console.error(`\n[L1 FAIL] ${errors} streaming contract issue(s) detected.`);
  process.exit(1);
}

console.log('[L1 PASS] Streaming contract intact — planner/step delta chunk field wired end-to-end.');
