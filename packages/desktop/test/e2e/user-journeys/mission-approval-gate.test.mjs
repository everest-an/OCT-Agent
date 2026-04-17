/**
 * L4 User Journey E2E — Plan Preview Gate (Zero Mock)
 *
 * Proves the `awaitApproval: true` path: after the Planner produces a plan,
 * the MissionRunner pauses until approveAndRun() is called explicitly.
 *
 * Prerequisites: OpenClaw Gateway running + one model configured.
 * SKIPs when env is not ready.
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

let ready = false;
let skipReason = '';
before(async () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const distMission = path.resolve(here, '../../../dist-electron/mission/mission-runner.js');
  if (!fs.existsSync(distMission)) { skipReason = 'dist-electron/mission not built — run `npm run build` first'; return; }
  if (!fs.existsSync(path.join(HOME, '.openclaw', 'openclaw.json'))) { skipReason = 'openclaw.json missing'; return; }
  if (!fs.existsSync(path.join(HOME, '.openclaw', 'identity', 'device.json'))) { skipReason = 'device identity missing'; return; }
  const gw = await pingGateway();
  if (!gw) { skipReason = 'Gateway not running'; return; }
  ready = true;
});

describe('Mission Flow · approval gate', () => {
  it('pauses after plan-ready and resumes on approveAndRun', async (t) => {
    if (!ready) return t.skip(skipReason);

    const { GatewayClient } = await import('../../../dist-electron/gateway-ws.js');
    const { MissionRunner } = await import('../../../dist-electron/mission/mission-runner.js');
    const { createGatewayAdapter } = await import('../../../dist-electron/mission/streaming-bridge.js');

    const gw = new GatewayClient();
    await gw.connect();

    const events = [];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-approval-e2e-'));
    const runner = new MissionRunner(
      createGatewayAdapter(gw),
      (e) => events.push(e),
      {
        root,
        awaitApproval: true,
        stepIdleTimeoutMs: 60_000,
        maxPlannerRetries: 1,
      },
    );

    try {
      const mission = await runner.createMission({
        goal: 'Describe three short tips for writing unit tests.',
        agents: [
          { id: 'main', name: 'Main' },
          { id: 'coder', name: 'Coder' },
          { id: 'tester', name: 'Tester' },
        ],
      });

      // Wait for plan-ready (up to 90s)
      const planReady = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 90_000);
        const poll = setInterval(() => {
          const ev = events.find((e) => e.type === 'plan-ready');
          if (ev) { clearTimeout(t); clearInterval(poll); resolve(ev); }
        }, 250);
      });
      assert.ok(planReady, 'plan-ready did not fire within 90s');

      // After plan-ready: mission status must be paused_awaiting_human
      const paused = runner.getMission(mission.id);
      assert.equal(paused.status, 'paused_awaiting_human',
        `expected paused_awaiting_human, got ${paused.status}`);
      assert.ok(
        !events.some((e) => e.type === 'step-started'),
        'step-started must not fire before approval',
      );

      // Approve
      await runner.approveAndRun(mission.id);

      // Wait for step-started within 30s
      const started = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 30_000);
        const poll = setInterval(() => {
          if (events.some((e) => e.type === 'step-started')) {
            clearTimeout(t); clearInterval(poll); resolve(true);
          }
        }, 250);
      });
      assert.ok(started, 'step-started did not fire within 30s of approveAndRun');

      // Cancel the rest — we've proved the gate works
      await runner.cancel(mission.id, 'E2E done');
    } finally {
      try { gw.destroy(); } catch { /* ignore */ }
    }
  });
});
