import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ipcHandleMock } = vi.hoisted(() => ({
  ipcHandleMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: ipcHandleMock,
  },
}));

import { registerRuntimeHealthHandlers } from '../../electron/ipc/register-runtime-health-handlers';

function getRegisteredHandlers() {
  return Object.fromEntries(
    ipcHandleMock.mock.calls.map(([channel, handler]) => [channel, handler]),
  ) as Record<string, (...args: any[]) => Promise<any>>;
}

describe('registerRuntimeHealthHandlers', () => {
  beforeEach(() => {
    ipcHandleMock.mockReset();
  });

  it('repairs the local daemon during startup (gateway auto-fix is intentionally skipped — handled by startGatewayRepairInBackground)', async () => {
    // The refactored startup handler calls runChecks 3 times:
    //   1. fastChecks (node-installed, openclaw-installed, openclaw-command-health, plugin-installed)
    //   2. slowChecks (daemon-running, gateway-running, channel-bindings)
    //   3. recheck of only repaired items (daemon-running only — gateway is excluded from autoFixChecks)
    //
    // NOTE: gateway-running is intentionally excluded from autoFixChecks in the production handler.
    // Gateway repair is done separately by startGatewayRepairInBackground() to avoid the 20s CLI freeze
    // at startup. The UI loads regardless of gateway state.
    const runChecks = vi.fn()
      // Call 1: fastChecks — all pass
      .mockResolvedValueOnce({
        checks: [
          { id: 'node-installed', label: 'Node.js', status: 'pass', fixable: 'none', message: 'Installed' },
          { id: 'openclaw-installed', label: 'OpenClaw', status: 'pass', fixable: 'none', message: 'Installed' },
          { id: 'openclaw-command-health', label: 'OpenClaw health', status: 'pass', fixable: 'none', message: 'OK' },
          { id: 'plugin-installed', label: 'Awareness plugin', status: 'pass', fixable: 'none', message: 'Installed' },
        ],
      })
      // Call 2: slowChecks — daemon failing, gateway also failing (but gateway won't be auto-fixed)
      .mockResolvedValueOnce({
        checks: [
          { id: 'daemon-running', label: 'Local Daemon', status: 'fail', fixable: 'auto', message: 'Local Daemon is not running' },
          { id: 'gateway-running', label: 'Gateway', status: 'fail', fixable: 'auto', message: 'Gateway is not running' },
          { id: 'channel-bindings', label: 'Channel bindings', status: 'pass', fixable: 'none', message: 'OK' },
        ],
      })
      // Call 3: recheck daemon-running only (gateway is not in autoFixChecks, not rechecked here)
      .mockResolvedValueOnce({
        checks: [
          { id: 'daemon-running', label: 'Local Daemon', status: 'pass', fixable: 'none', message: 'Running' },
        ],
      });
    const runFix = vi.fn(async (checkId: string) => ({ id: checkId, success: true, message: `${checkId} fixed` }));
    const send = vi.fn();

    registerRuntimeHealthHandlers({
      home: 'C:/Users/test',
      app: {},
      dirname: 'C:/test',
      safeShellExec: vi.fn(() => null),
      safeShellExecAsync: vi.fn(async () => null),
      doctor: { runChecks, runFix },
      computeSha256: vi.fn(() => 'hash'),
      checkDaemonHealth: vi.fn(async () => false),
      waitForLocalDaemonReady: vi.fn(async () => true),
      sendSetupDaemonStatus: vi.fn(),
      sleep: vi.fn(async () => undefined),
      recentDaemonStartup: () => false,
      ensureGatewayAccess: vi.fn(async () => ({ ok: true })),
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }),
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['app:startup-ensure-runtime']();

    expect(result).toMatchObject({ ok: true, needsSetup: false });
    // Only daemon-running is auto-fixed; gateway-running is intentionally skipped (handled by background repair)
    expect(runFix.mock.calls.map(([checkId]) => checkId)).toEqual(['daemon-running']);
  });

  it('prepares gateway access during startup when the gateway is already healthy', async () => {
    // All checks pass → no repairs needed → only 2 runChecks calls (fast + slow, no recheck)
    const runChecks = vi.fn()
      // Call 1: fastChecks — all pass
      .mockResolvedValueOnce({
        checks: [
          { id: 'node-installed', label: 'Node.js', status: 'pass', fixable: 'none', message: 'Installed' },
          { id: 'openclaw-installed', label: 'OpenClaw', status: 'pass', fixable: 'none', message: 'Installed' },
          { id: 'openclaw-command-health', label: 'OpenClaw health', status: 'pass', fixable: 'none', message: 'OK' },
          { id: 'plugin-installed', label: 'Awareness plugin', status: 'pass', fixable: 'none', message: 'Installed' },
        ],
      })
      // Call 2: slowChecks — all pass
      .mockResolvedValueOnce({
        checks: [
          { id: 'daemon-running', label: 'Local Daemon', status: 'pass', fixable: 'none', message: 'Running' },
          { id: 'gateway-running', label: 'Gateway', status: 'pass', fixable: 'none', message: 'Running' },
          { id: 'channel-bindings', label: 'Channel bindings', status: 'pass', fixable: 'none', message: 'OK' },
        ],
      });
    const ensureGatewayAccess = vi.fn(async () => ({ ok: true, repaired: true, message: 'Local Gateway access was approved automatically.' }));

    registerRuntimeHealthHandlers({
      home: 'C:/Users/test',
      app: {},
      dirname: 'C:/test',
      safeShellExec: vi.fn(() => null),
      safeShellExecAsync: vi.fn(async () => null),
      doctor: { runChecks, runFix: vi.fn() },
      computeSha256: vi.fn(() => 'hash'),
      checkDaemonHealth: vi.fn(async () => true),
      waitForLocalDaemonReady: vi.fn(async () => true),
      sendSetupDaemonStatus: vi.fn(),
      sleep: vi.fn(async () => undefined),
      recentDaemonStartup: () => false,
      ensureGatewayAccess,
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } }),
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['app:startup-ensure-runtime']();

    expect(ensureGatewayAccess).toHaveBeenCalledTimes(1);
    expect(result.fixed).toContain('Local Gateway access was approved automatically.');
    expect(result).toMatchObject({ ok: true, needsSetup: false });
  });

  it('does not mark needsSetup when only daemon-running is still failing', async () => {
    // Daemon fails → repair attempted but fails → recheck still shows daemon failing.
    // Expected: ok=false, needsSetup=false (daemon is not a setup-blocker), blockingId='daemon-running'
    const runChecks = vi.fn()
      // Call 1: fastChecks — all pass (plugin-installed pass = not a setup blocker)
      .mockResolvedValueOnce({
        checks: [
          { id: 'node-installed', label: 'Node.js', status: 'pass', fixable: 'none', message: 'Installed' },
          { id: 'openclaw-installed', label: 'OpenClaw', status: 'pass', fixable: 'none', message: 'Installed' },
          { id: 'openclaw-command-health', label: 'OpenClaw health', status: 'pass', fixable: 'none', message: 'OK' },
          { id: 'plugin-installed', label: 'Awareness plugin', status: 'pass', fixable: 'none', message: 'Installed' },
        ],
      })
      // Call 2: slowChecks — daemon failing, gateway and bindings pass
      .mockResolvedValueOnce({
        checks: [
          { id: 'daemon-running', label: 'Local Daemon', status: 'fail', fixable: 'auto', message: 'Local Daemon is not running' },
          { id: 'gateway-running', label: 'Gateway', status: 'pass', fixable: 'none', message: 'Running' },
          { id: 'channel-bindings', label: 'Channel bindings', status: 'pass', fixable: 'none', message: 'OK' },
        ],
      })
      // Call 3: recheck daemon-running after failed repair — still failing
      .mockResolvedValueOnce({
        checks: [
          { id: 'daemon-running', label: 'Local Daemon', status: 'fail', fixable: 'auto', message: 'Local Daemon is not running' },
        ],
      });

    registerRuntimeHealthHandlers({
      home: 'C:/Users/test',
      app: {},
      dirname: 'C:/test',
      safeShellExec: vi.fn(() => null),
      safeShellExecAsync: vi.fn(async () => null),
      doctor: { runChecks, runFix: vi.fn(async () => ({ success: false, message: 'daemon retry failed' })) },
      computeSha256: vi.fn(() => 'hash'),
      checkDaemonHealth: vi.fn(async () => false),
      waitForLocalDaemonReady: vi.fn(async () => false),
      sendSetupDaemonStatus: vi.fn(),
      sleep: vi.fn(async () => undefined),
      recentDaemonStartup: () => false,
      ensureGatewayAccess: vi.fn(async () => ({ ok: true })),
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } }),
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['app:startup-ensure-runtime']();

    expect(result.ok).toBe(false);
    expect(result.needsSetup).toBe(false);
    expect(result.blockingId).toBe('daemon-running');
    expect(result.warnings.join('\n')).toContain('Local Daemon is not running');
  });
});