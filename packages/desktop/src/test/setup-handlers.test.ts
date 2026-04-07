import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ipcHandleMock, openExternalMock } = vi.hoisted(() => ({
  ipcHandleMock: vi.fn(),
  openExternalMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: ipcHandleMock,
  },
  shell: {
    openExternal: openExternalMock,
  },
}));

import { registerSetupHandlers } from '../../electron/ipc/register-setup-handlers';

function getRegisteredHandlers() {
  return Object.fromEntries(
    ipcHandleMock.mock.calls.map(([channel, handler]) => [channel, handler]),
  ) as Record<string, (...args: any[]) => Promise<any>>;
}

function createSpawnedChild(exitCode = 0) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  setTimeout(() => {
    child.emit('spawn');
    child.emit('close', exitCode);
  }, 0);

  return child;
}

describe('registerSetupHandlers', () => {
  beforeEach(() => {
    ipcHandleMock.mockReset();
    openExternalMock.mockReset();
  });

  it('triggers direct bootstrap fallback early when detached startup does not become healthy', async () => {
    let daemonStartupPromise: Promise<{ success: boolean }> | null = null;
    let lastKickoff = 0;

    const waitForLocalDaemonReady = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const startLocalDaemonDetached = vi.fn(async () => undefined);
    const runSpawn = vi.fn(() => createSpawnedChild(0));
    const forceStopLocalDaemon = vi.fn(async () => undefined);

    registerSetupHandlers({
      home: 'C:/Users/test',
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      getNodeVersion: vi.fn(() => 'v22.0.0'),
      runAsync: vi.fn(async () => ''),
      safeShellExecAsync: vi.fn(async () => null),
      getBundledNpmBin: vi.fn((bin: 'npx' | 'npm') => (bin === 'npx' ? 'C:/bundled/npm/bin/npx-cli.js' : null)),
      resolveBundledCache: vi.fn(() => null),
      downloadFile: vi.fn(async () => undefined),
      sleep: vi.fn(async () => undefined),
      getLocalDaemonHealth: vi.fn(async () => null),
      checkDaemonHealth: vi.fn(async () => false),
      waitForLocalDaemonReady,
      sendSetupDaemonStatus: vi.fn(),
      startLocalDaemonDetached,
      runSpawn,
      forceStopLocalDaemon,
      clearAwarenessLocalNpxCache: vi.fn(),
      formatDaemonSetupError: vi.fn(() => 'pending'),
      persistAwarenessPluginConfig: vi.fn(),
      applyAwarenessPluginConfig: vi.fn(),
      sanitizeAwarenessPluginConfig: vi.fn(),
      mergeOpenClawConfig: vi.fn((existing: Record<string, any>) => existing),
      getDaemonStartupPromise: vi.fn(() => daemonStartupPromise),
      setDaemonStartupPromise: vi.fn((value: Promise<{ success: boolean }> | null) => {
        daemonStartupPromise = value;
      }),
      getDaemonStartupLastKickoff: vi.fn(() => lastKickoff),
      setDaemonStartupLastKickoff: vi.fn((value: number) => {
        lastKickoff = value;
      }),
      sendSetupStatus: vi.fn(),
      setOpenclawInstalling: vi.fn(),
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['setup:start-daemon']();

    expect(result).toMatchObject({ success: true });
    expect(startLocalDaemonDetached).toHaveBeenCalledTimes(1);
    expect(waitForLocalDaemonReady).toHaveBeenCalledTimes(2);
    expect(waitForLocalDaemonReady).toHaveBeenNthCalledWith(
      1,
      45000,
      'setup.install.daemonStatus.preparing',
      expect.any(Object),
    );
    expect(waitForLocalDaemonReady).toHaveBeenNthCalledWith(
      2,
      30000,
      'setup.install.daemonStatus.waiting',
      expect.any(Object),
    );

    // Early direct bootstrap uses process.execPath + bundled npx CLI.
    expect(runSpawn).toHaveBeenCalledTimes(1);
    expect(runSpawn).toHaveBeenCalledWith(process.execPath, expect.any(Array), expect.any(Object));
    expect(forceStopLocalDaemon).not.toHaveBeenCalled();
  });
});
