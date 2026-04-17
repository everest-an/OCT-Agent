#!/usr/bin/env node
/**
 * Real E2E smoke test — connects to the actual OpenClaw Gateway + a real LLM
 * and runs a tiny mission end-to-end. Use this to verify the streaming / IPC
 * path works with real infrastructure (not unit-test mocks).
 *
 * Prereqs:
 *   - `npm run build` has compiled `dist-electron/`
 *   - OpenClaw Gateway running on 127.0.0.1:18789 (`openclaw gateway status`)
 *   - ~/.openclaw/identity/device.json present
 *   - At least one agent in openclaw.json with a configured model
 *
 * Run:
 *   node scripts/e2e-mission-smoke.mjs
 *
 * Exit codes:
 *   0 — mission reached `mission:done` within the budget
 *   1 — any precondition failed, or the mission failed / timed out
 */

import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function pingGateway(port = 18789, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/', timeout: timeoutMs },
      (res) => { res.resume(); resolve(res.statusCode !== undefined); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── Preflight ─────────────────────────────────────────────────────────────
console.log('[smoke] preflight...');
const distMission = resolve(ROOT, 'dist-electron/mission/mission-runner.js');
if (!existsSync(distMission)) {
  console.error(`[smoke] ✗ dist-electron not built. Run: npm run build`);
  process.exit(1);
}
const configExists = existsSync(join(homedir(), '.openclaw', 'openclaw.json'));
if (!configExists) {
  console.error('[smoke] ✗ ~/.openclaw/openclaw.json missing — app not set up');
  process.exit(1);
}
const identityExists = existsSync(join(homedir(), '.openclaw', 'identity', 'device.json'));
if (!identityExists) {
  console.error('[smoke] ✗ ~/.openclaw/identity/device.json missing');
  process.exit(1);
}
const gwUp = await pingGateway();
if (!gwUp) {
  console.error('[smoke] ✗ Gateway not running on 127.0.0.1:18789');
  console.error('[smoke]   Run: openclaw gateway start');
  process.exit(1);
}
console.log('[smoke] ✓ Gateway + identity + config present');

// ── Import compiled runner + adapter ──────────────────────────────────────
const { GatewayClient } = await import('../dist-electron/gateway-ws.js');
const { MissionRunner } = await import('../dist-electron/mission/mission-runner.js');
const { createGatewayAdapter } = await import('../dist-electron/mission/streaming-bridge.js');
const {
  readMission, readArtifact, readMemory,
} = await import('../dist-electron/mission/file-layout.js');

// ── Run a micro mission ───────────────────────────────────────────────────
const gw = new GatewayClient();
console.log('[smoke] connecting to Gateway...');
await gw.connect();
console.log('[smoke] ✓ connected');

const root = mkdtempSync(join(tmpdir(), 'mission-smoke-'));
console.log(`[smoke] tmpRoot = ${root}`);

let plannerDeltaCount = 0;
let stepDeltaCount = 0;
const events = [];

const runner = new MissionRunner(
  createGatewayAdapter(gw),
  (event) => {
    events.push(event);
    if (event.type === 'planner-delta') plannerDeltaCount++;
    else if (event.type === 'step-delta') stepDeltaCount++;
    else if (event.type === 'planning') console.log(`[smoke]   event: planning (missionId=${event.missionId.slice(0, 22)}…)`);
    else if (event.type === 'plan-ready') console.log(`[smoke]   event: plan-ready (${event.mission.steps.length} subtasks)`);
    else if (event.type === 'step-started') console.log(`[smoke]   event: step-started ${event.stepId}`);
    else if (event.type === 'step-ended') console.log(`[smoke]   event: step-ended ${event.stepId} → ${event.artifactPath}`);
    else if (event.type === 'step-failed') console.log(`[smoke]   event: step-FAILED ${event.stepId}: ${event.message}`);
    else if (event.type === 'mission:done') console.log(`[smoke]   event: MISSION DONE ✓`);
    else if (event.type === 'mission:failed') console.log(`[smoke]   event: MISSION FAILED: ${event.reason}`);
  },
  {
    root,
    stepIdleTimeoutMs: 120_000,   // 2 min idle cap per step
    maxPlannerRetries: 0,
    awaitApproval: false,          // auto-run for this smoke
  },
);

const goal = 'Output three concise bullet points about why writing unit tests matters. Keep it under 100 words total.';
console.log(`[smoke] creating mission: "${goal}"`);

try {
  const mission = await runner.createMission({
    goal,
    agents: [
      { id: 'main', name: 'Main', role: 'Generalist' },
    ],
  });
  console.log(`[smoke] ✓ mission created id=${mission.id}`);
} catch (err) {
  console.error(`[smoke] ✗ createMission threw: ${err?.message || err}`);
  gw.destroy();
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
}

// ── Wait up to 3 minutes ──────────────────────────────────────────────────
const BUDGET_MS = 180_000;
const started = Date.now();
console.log(`[smoke] waiting up to ${BUDGET_MS / 1000}s for mission:done/failed...`);

const result = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ timedOut: true }), BUDGET_MS);
  const poll = setInterval(() => {
    const last = events[events.length - 1];
    if (last?.type === 'mission:done' || last?.type === 'mission:failed') {
      clearTimeout(timer);
      clearInterval(poll);
      resolve(last);
    }
  }, 500);
});

const elapsed = Math.round((Date.now() - started) / 1000);
console.log(`\n[smoke] === RESULT after ${elapsed}s ===`);
console.log(`[smoke] planner-delta events: ${plannerDeltaCount}`);
console.log(`[smoke] step-delta events:    ${stepDeltaCount}`);

if (result.timedOut) {
  console.error(`[smoke] ✗ TIMED OUT — mission did not finish in ${BUDGET_MS / 1000}s`);
  console.error(`[smoke]   last event: ${events[events.length - 1]?.type || '(none)'}`);
  gw.destroy();
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
}

if (result.type === 'mission:failed') {
  console.error(`[smoke] ✗ mission FAILED: ${result.reason}`);
  gw.destroy();
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
}

// Verify artifacts on disk
const missionId = result.mission.id;
const persisted = readMission(missionId, root);
console.log(`[smoke] mission.status = ${persisted?.status}`);
console.log(`[smoke] steps:`);
for (const s of persisted?.steps || []) {
  const body = readArtifact(missionId, s.id, s.title, root);
  const preview = (body || '').replace(/\n/g, ' ').slice(0, 80);
  console.log(`[smoke]   ${s.id} status=${s.status} body=${body ? body.length : 0}b "${preview}…"`);
}
const memory = readMemory(missionId, root);
console.log(`[smoke] MEMORY.md = ${memory.length} bytes`);

console.log(`[smoke] ✓ E2E smoke PASSED`);
gw.destroy();
rmSync(root, { recursive: true, force: true });
process.exit(0);
