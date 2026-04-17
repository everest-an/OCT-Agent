/**
 * L4 User Journey E2E — Mission Flow Happy Path (Zero Mock)
 *
 * Drives the real MissionRunner + real Gateway WS + real LLM through a
 * minimal 3-step mission and asserts:
 *   - mission reaches status=done
 *   - plan.json has 3+ subtasks
 *   - each step produces a non-empty artifact on disk
 *   - MEMORY.md accumulates per-step summaries
 *   - at least a few planner-delta events and step-delta events fire
 *     (proves streaming is live end-to-end)
 *
 * Prerequisites:
 *   - OpenClaw Gateway running: `openclaw gateway status` → running
 *   - At least one model configured in ~/.openclaw/openclaw.json
 *   - Optional: local Awareness daemon on 37800 (tolerated when offline)
 *
 * Run:
 *   node --test test/e2e/user-journeys/mission-happy-path.test.mjs
 *
 * If the Gateway is not running, the test SKIPs cleanly.
 * Budget: ≤ 5 min (Haiku-class model recommended).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

const GATEWAY_PORT = Number(process.env.OPENCLAW_GATEWAY_PORT) || 18789;
const HOME = os.homedir();

function pingGateway(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port: GATEWAY_PORT, path: '/', timeout: timeoutMs },
      (res) => { res.resume(); resolve(res.statusCode !== undefined); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function identityExists() {
  return fs.existsSync(path.join(HOME, '.openclaw', 'identity', 'device.json'));
}

function configExists() {
  return fs.existsSync(path.join(HOME, '.openclaw', 'openclaw.json'));
}

// ── Setup ────────────────────────────────────────────────────────────────

let ready = false;
let skipReason = '';

before(async () => {
  // Preflight: must have dist-electron built (TS compiled), Gateway running,
  // identity provisioned, and openclaw.json present. Otherwise SKIP.
  const here = path.dirname(new URL(import.meta.url).pathname);
  const distMission = path.resolve(here, '../../../dist-electron/mission/mission-runner.js');
  if (!fs.existsSync(distMission)) {
    skipReason = 'dist-electron/mission not built — run `npm run build` first';
    return;
  }
  if (!configExists()) { skipReason = 'openclaw.json missing'; return; }
  if (!identityExists()) { skipReason = 'device identity missing'; return; }
  const gwUp = await pingGateway();
  if (!gwUp) { skipReason = 'Gateway not running'; return; }
  ready = true;
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('Mission Flow · happy path', () => {
  it('creates a mission, planner plans, workers execute, mission reaches done', async (t) => {
    if (!ready) return t.skip(skipReason);

    // Import from compiled dist-electron (require `npm run build` first).
    const { GatewayClient } = await import('../../../dist-electron/gateway-ws.js');
    const { MissionRunner } = await import('../../../dist-electron/mission/mission-runner.js');
    const { createGatewayAdapter } = await import('../../../dist-electron/mission/streaming-bridge.js');
    const {
      readMission, readPlan, readArtifact, readMemory,
    } = await import('../../../dist-electron/mission/file-layout.js');

    const gw = new GatewayClient();
    await gw.connect();

    const events = [];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-e2e-'));
    const runner = new MissionRunner(
      createGatewayAdapter(gw),
      (e) => events.push(e),
      {
        root,
        stepIdleTimeoutMs: 90_000,
        maxPlannerRetries: 1,
      },
    );

    try {
      const mission = await runner.createMission({
        goal: 'Plan three short bullet points about why tests matter.',
        agents: [
          { id: 'main', name: 'Main' },
          { id: 'coder', name: 'Coder' },
          { id: 'tester', name: 'Tester' },
        ],
      });

      // Wait up to 4 minutes for mission:done or mission:failed
      const outcome = await new Promise((resolve) => {
        const t = setTimeout(() => resolve({ timedOut: true }), 240_000);
        const check = () => {
          const last = events[events.length - 1];
          if (!last) return;
          if (last.type === 'mission:done' || last.type === 'mission:failed') {
            clearTimeout(t);
            clearInterval(poll);
            resolve(last);
          }
        };
        const poll = setInterval(check, 500);
      });

      assert.ok(!outcome.timedOut, 'Mission did not finish within 4 minutes');
      assert.equal(outcome.type, 'mission:done', `Mission failed: ${outcome.reason || 'unknown'}`);

      // On-disk validation
      const persisted = readMission(mission.id, root);
      assert.ok(persisted, 'mission.json not persisted');
      assert.equal(persisted.status, 'done');

      const plan = readPlan(mission.id, root);
      assert.ok(plan, 'plan.json not persisted');
      assert.ok(plan.subtasks.length >= 3, 'plan must have >= 3 subtasks');

      for (const step of persisted.steps) {
        const body = readArtifact(mission.id, step.id, step.title, root);
        assert.ok(body && body.length > 0, `${step.id} artifact missing or empty`);
      }

      const memory = readMemory(mission.id, root);
      assert.ok(memory.includes('T1 done'), 'MEMORY.md must record T1 completion');

      const plannerDeltas = events.filter((e) => e.type === 'planner-delta').length;
      const stepDeltas = events.filter((e) => e.type === 'step-delta').length;
      assert.ok(plannerDeltas >= 1, 'at least 1 planner-delta should fire');
      assert.ok(stepDeltas >= 1, 'at least 1 step-delta should fire');
    } finally {
      try { gw.destroy(); } catch { /* ignore */ }
    }
  });
});
