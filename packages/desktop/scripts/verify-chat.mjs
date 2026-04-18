#!/usr/bin/env node
/**
 * L1 · verify-chat.mjs (preview.6)
 *
 * Static guards for the Chat-First redesign — catches regressions that unit
 * tests might miss because they run in jsdom while these are repo-wide greps.
 *
 * What it checks:
 *   1) `src/App.tsx` + `src/components/Sidebar.tsx` contain NO `taskCenter` /
 *      `TaskCenter` nav reference (Mission Flow was removed).
 *   2) `electron/main.ts` has NO `registerMissionHandlers` / `registerWorkflowHandlers`
 *      import or call (they were removed together).
 *   3) `electron/preload.ts` + `src/types/electron.d.ts` expose NO `mission`
 *      named APIs except the kept types comment (prevents re-introduction).
 *   4) The 3 chat-bug fixes stay wired: main process emits `chat:stream-reset`,
 *      accumulates `liveThinkingBuffer`, dedupes `sawFinalState`.
 *   5) The renderer subscribes to `chat:stream-reset` and uses the memoized
 *      `StreamingMarkdownBlock` for streaming content.
 *
 * Exits non-zero on any violation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, '..');

const failures = [];
const read = (rel) => fs.readFileSync(path.join(PKG, rel), 'utf8');
const assert = (cond, label, hint = '') => {
  if (cond) return;
  failures.push(`✗ ${label}${hint ? ' — ' + hint : ''}`);
};

// ---------------------------------------------------------------------------
// 1. Mission/TaskCenter nav removed
// ---------------------------------------------------------------------------
{
  const sidebar = read('src/components/Sidebar.tsx');
  assert(!sidebar.includes('taskCenter'), 'Sidebar.tsx removed taskCenter nav', 'found `taskCenter` in Sidebar');
  assert(!sidebar.includes('Target'), 'Sidebar.tsx dropped Target icon (mission only)', 'found Target icon import still present');

  const app = read('src/App.tsx');
  assert(!app.includes("from './pages/TaskCenter'"), 'App.tsx dropped TaskCenter import');
  assert(!app.includes("currentPage === 'taskCenter'"), 'App.tsx dropped taskCenter page branch');
}

// ---------------------------------------------------------------------------
// 2. Main process mission/workflow handlers removed
// ---------------------------------------------------------------------------
{
  const main = read('electron/main.ts');
  assert(!main.includes("from './ipc/register-mission-handlers'"), 'main.ts removed registerMissionHandlers import');
  assert(!main.includes("from './ipc/register-workflow-handlers'"), 'main.ts removed registerWorkflowHandlers import');
  assert(!/registerMissionHandlers\s*\(/.test(main), 'main.ts no longer calls registerMissionHandlers()');
  assert(!/registerWorkflowHandlers\s*\(/.test(main), 'main.ts no longer calls registerWorkflowHandlers()');
}

// ---------------------------------------------------------------------------
// 3. Preload + types expose no mission API surface
// ---------------------------------------------------------------------------
{
  const preload = read('electron/preload.ts');
  const missionApiPattern = /\b(missionStart|missionList|missionCancel|missionCreateFromGoal|missionApproveAndRun|missionGet|missionDelete|missionReadArtifact|missionSweepStale|onMission[A-Z])/;
  assert(!missionApiPattern.test(preload), 'preload.ts removed mission* API bindings');

  const dts = read('src/types/electron.d.ts');
  assert(!/MissionSnapshot/.test(dts), 'electron.d.ts removed MissionSnapshot type');
  assert(!missionApiPattern.test(dts), 'electron.d.ts removed mission* type declarations');
}

// ---------------------------------------------------------------------------
// 4. Chat bug fixes wired in main process
// ---------------------------------------------------------------------------
{
  const handlers = read('electron/ipc/register-chat-handlers.ts');
  assert(handlers.includes("send('chat:stream-reset'"), 'chat handlers emit chat:stream-reset on fallback',
    'expected send(\'chat:stream-reset\', { reason }) to stay wired');
  assert(handlers.includes('liveThinkingBuffer'), 'chat handlers accumulate live thinking buffer',
    'liveThinkingBuffer accumulator missing — thinking 散落 will regress');
  assert(/if\s*\(\s*sawFinalState\s*\)\s*\{\s*[^}]*return/.test(handlers),
    'chat handlers dedupe duplicate state:"final" frames',
    'sawFinalState guard missing — duplicate last-turn output will regress');
  assert(handlers.includes('sendStreamChunkThrottled'), 'chat handlers throttle chat:stream IPC sends',
    'sendStreamChunkThrottled missing — streaming perf regressed');
  assert(handlers.includes('flushPendingStream'), 'chat handlers flush pending stream on final/error',
    'flushPendingStream() missing — tail bytes may be swallowed');
}

// ---------------------------------------------------------------------------
// 5. Renderer handles chat:stream-reset + uses memoized streaming block
// ---------------------------------------------------------------------------
{
  const preload = read('electron/preload.ts');
  assert(preload.includes('onChatStreamReset'), 'preload exposes onChatStreamReset');

  const dashboard = read('src/pages/Dashboard.tsx');
  assert(dashboard.includes('onChatStreamReset'), 'Dashboard subscribes to chat:stream-reset');
  assert(dashboard.includes('StreamingMarkdownBlock'), 'Dashboard uses memoized StreamingMarkdownBlock for streaming');

  const types = read('src/types/electron.d.ts');
  assert(types.includes('onChatStreamReset'), 'electron.d.ts declares onChatStreamReset');
}

// ---------------------------------------------------------------------------
// 6. Deleted mission dirs are really gone
// ---------------------------------------------------------------------------
{
  const shouldBeGone = [
    'electron/mission',
    'src/components/mission-flow',
    'src/components/task-center',
    'src/pages/TaskCenter.tsx',
    'src/lib/mission-store.ts',
    'electron/ipc/register-mission-handlers.ts',
    'electron/ipc/register-workflow-handlers.ts',
    'scripts/verify-mission-ipc.mjs',
    'scripts/e2e-mission-smoke.mjs',
  ];
  for (const rel of shouldBeGone) {
    assert(!fs.existsSync(path.join(PKG, rel)),
      `removed: ${rel}`,
      `${rel} still exists — second-round delete incomplete`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.error('[L1 FAIL] verify-chat.mjs caught regressions:');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('[L1 PASS] verify-chat.mjs — chat-first redesign contract intact.');
