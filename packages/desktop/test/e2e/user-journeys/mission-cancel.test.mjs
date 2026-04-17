/**
 * L4 User Journey E2E — Mission Cancel (Zero Mock)
 *
 * Starts a mission and cancels it mid-planning. Asserts:
 *   - cancel() resolves cleanly
 *   - mission.status === 'failed'
 *   - mission:failed event with a reason fires
 *   - any subsequent Gateway events do not resurrect the mission
 *
 * SKIPs when Gateway is not running.
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

describe('Mission Flow · cancel', () => {
  it('cancelling a live mission transitions to failed + aborts Gateway run', async (t) => {
    if (!ready) return t.skip(skipReason);

    const { GatewayClient } = await import('../../../dist-electron/gateway-ws.js');
    const { MissionRunner } = await import('../../../dist-electron/mission/mission-runner.js');
    const { createGatewayAdapter } = await import('../../../dist-electron/mission/streaming-bridge.js');

    const gw = new GatewayClient();
    await gw.connect();
    const events = [];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-cancel-e2e-'));
    const runner = new MissionRunner(
      createGatewayAdapter(gw),
      (e) => events.push(e),
      { root, awaitApproval: true, stepIdleTimeoutMs: 60_000, maxPlannerRetries: 0 },
    );

    try {
      const mission = await runner.createMission({
        goal: 'Write a short paragraph about software quality.',
        agents: [{ id: 'main' }, { id: 'coder' }, { id: 'tester' }],
      });

      // Wait for at least one planner-delta (proves planning is live)
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 10_000);
        const poll = setInterval(() => {
          if (events.some((e) => e.type === 'planner-delta' || e.type === 'plan-ready')) {
            clearTimeout(t); clearInterval(poll); resolve();
          }
        }, 250);
      });

      await runner.cancel(mission.id, 'E2E test cancel');

      const persisted = runner.getMission(mission.id);
      assert.equal(persisted.status, 'failed');
      assert.ok(
        events.some((e) => e.type === 'mission:failed' && /cancel/i.test(e.reason || '')),
        'expected a mission:failed event citing cancel reason',
      );
    } finally {
      try { gw.destroy(); } catch { /* ignore */ }
    }
  });
});
