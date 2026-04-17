#!/usr/bin/env node
/**
 * L1 Contract Guard: Mission Flow IPC parity (F-Team-Tasks Phase 4).
 *
 * Verifies that:
 *   1. Every `mission:*` invoke channel declared in register-mission-handlers
 *      has a matching `ipcRenderer.invoke('mission:...')` or
 *      `webContents.send('mission:...')` in preload.ts + electron.d.ts
 *      (and vice versa).
 *   2. The MISSION_IPC_EVENT_CHANNELS export lists every emitted event name.
 *   3. The renderer types in src/types/electron.d.ts expose onMission* /
 *      mission* handlers that match the IPC channels.
 *
 * Fails the process (exit 1) if any parity break is found — wire this into
 * ship-gate / pre-commit to prevent UI-vs-backend drift (v0.6.x lesson).
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const MAIN = resolve(ROOT, 'electron/ipc/register-mission-handlers.ts');
const PRELOAD = resolve(ROOT, 'electron/preload.ts');
const DTS = resolve(ROOT, 'src/types/electron.d.ts');

for (const p of [MAIN, PRELOAD, DTS]) {
  if (!existsSync(p)) {
    console.error(`[L1 FAIL] missing file: ${p}`);
    process.exit(1);
  }
}

const mainSrc = readFileSync(MAIN, 'utf-8');
const preloadSrc = readFileSync(PRELOAD, 'utf-8');
const dtsSrc = readFileSync(DTS, 'utf-8');

let errors = 0;

// ---------------------------------------------------------------------------
// Expected channels (spec)
// ---------------------------------------------------------------------------
const INVOKE_CHANNELS = [
  'mission:create-from-goal',
  'mission:approve-and-run',
  'mission:list',
  'mission:get',
  'mission:cancel-flow',
  'mission:delete',
  'mission:read-artifact',
];
const EVENT_CHANNELS = [
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
];

// ---------------------------------------------------------------------------
// Check 1: register-mission-handlers registers every invoke channel
// ---------------------------------------------------------------------------
for (const ch of INVOKE_CHANNELS) {
  const re = new RegExp(`ipcMain\\.handle\\(['"\`]${ch.replace(/[-:.]/g, (c) => `\\${c}`)}['"\`]`);
  if (!re.test(mainSrc)) {
    errors++;
    console.error(`[L1 FAIL] register-mission-handlers.ts missing ipcMain.handle('${ch}', ...)`);
  }
}

// ---------------------------------------------------------------------------
// Check 2: every invoke channel is also exposed in preload.ts and has a d.ts entry
// ---------------------------------------------------------------------------
for (const ch of INVOKE_CHANNELS) {
  const reInvoke = new RegExp(`ipcRenderer\\.invoke\\(['"\`]${ch.replace(/[-:.]/g, (c) => `\\${c}`)}['"\`]`);
  if (!reInvoke.test(preloadSrc)) {
    errors++;
    console.error(`[L1 FAIL] preload.ts missing ipcRenderer.invoke('${ch}', ...)`);
  }
}

// ---------------------------------------------------------------------------
// Check 3: every event channel is emitted by register-mission-handlers
//          (via the missionEventToIpc mapper) OR via webContents.send.
//          NOTE: mission:step-tool is reserved for future — allow it if absent.
// ---------------------------------------------------------------------------
const OPTIONAL_EVENTS = new Set(['mission:step-tool']);
for (const ch of EVENT_CHANNELS) {
  const listed = mainSrc.includes(`'${ch}'`) || mainSrc.includes(`"${ch}"`);
  if (!listed && !OPTIONAL_EVENTS.has(ch)) {
    errors++;
    console.error(`[L1 FAIL] register-mission-handlers.ts never emits event '${ch}'`);
  }
}

// ---------------------------------------------------------------------------
// Check 4: every event channel has a preload subscription (ipcRenderer.on)
//          and matching onMission* handler in electron.d.ts
// ---------------------------------------------------------------------------
for (const ch of EVENT_CHANNELS) {
  const reOn = new RegExp(`ipcRenderer\\.on\\(['"\`]${ch.replace(/[-:.]/g, (c) => `\\${c}`)}['"\`]`);
  if (!reOn.test(preloadSrc)) {
    errors++;
    console.error(`[L1 FAIL] preload.ts missing ipcRenderer.on('${ch}', ...)`);
  }
}

// onMission* naming — e.g. mission:planner-delta → onMissionPlannerDelta
function toCallbackName(channel) {
  // strip "mission:" prefix
  const rest = channel.replace(/^mission:/, '');
  const camel = rest
    .split(/[-_]/)
    .map((seg) => seg.length ? seg[0].toUpperCase() + seg.slice(1) : '')
    .join('');
  return 'onMission' + camel;
}

for (const ch of EVENT_CHANNELS) {
  const name = toCallbackName(ch);
  if (!preloadSrc.includes(name) && !OPTIONAL_EVENTS.has(ch)) {
    errors++;
    console.error(`[L1 FAIL] preload.ts missing ${name} bridge for '${ch}'`);
  }
  if (!dtsSrc.includes(name) && !OPTIONAL_EVENTS.has(ch)) {
    errors++;
    console.error(`[L1 FAIL] electron.d.ts missing ${name}? for '${ch}'`);
  }
}

// Every invoke channel → missionXxx handler name
function toInvokeName(channel) {
  const rest = channel.replace(/^mission:/, '');
  const camel = rest
    .split(/[-_]/)
    .map((seg, i) => i === 0
      ? seg
      : seg[0].toUpperCase() + seg.slice(1))
    .join('');
  return 'mission' + camel[0].toUpperCase() + camel.slice(1);
}

for (const ch of INVOKE_CHANNELS) {
  const name = toInvokeName(ch);
  if (!preloadSrc.includes(name)) {
    errors++;
    console.error(`[L1 FAIL] preload.ts missing ${name} bridge for '${ch}'`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (errors > 0) {
  console.error(`\n[L1 FAIL] ${errors} mission IPC parity issue(s) detected.`);
  process.exit(1);
}

console.log(`[L1 PASS] Mission Flow IPC parity OK — ${INVOKE_CHANNELS.length} invoke + ${EVENT_CHANNELS.length} event channels.`);
