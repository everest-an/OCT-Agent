import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handleMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
  },
}));

import { registerChannelSetupHandlers } from '../../electron/ipc/register-channel-setup-handlers';

function getRegisteredSetupHandler() {
  const match = handleMock.mock.calls.find(([channel]) => channel === 'channel:setup');
  if (!match) throw new Error('channel:setup handler not registered');
  return match[1] as (event: unknown, channelId: string) => Promise<any>;
}

describe('registerChannelSetupHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset();
    vi.restoreAllMocks();
  });

  it('waits for the channel to appear before confirming success', async () => {
    const send = vi.fn();
    const runAsync = vi.fn(async () => 'ok');
    const safeShellExecAsync = vi.fn(async () => 'ok');
    const readShellOutputAsync = vi
      .fn()
      .mockResolvedValueOnce('[warn] loading plugins')
      .mockResolvedValueOnce('[plugins] Registered\n[{"id":"signal","status":"linked"}]');
    const channelLoginWithQR = vi.fn(async () => ({ success: true }));

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } } as any),
      getChannel: () => ({ label: 'Signal', openclawId: 'signal', pluginPackage: '@openclaw/signal', setupFlow: 'add-then-login' }),
      runAsync,
      safeShellExecAsync,
      readShellOutputAsync,
      channelLoginWithQR,
    });

    const handler = getRegisteredSetupHandler();
    const result = await handler({}, 'signal');

    expect(result).toMatchObject({ success: true });
    expect(result.pendingConfirmation).toBeUndefined();
    expect(readShellOutputAsync).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith('channel:status', 'channels.status.confirming::Signal');
  });

  it('returns pending confirmation instead of failing when OpenClaw is still syncing', async () => {
    const send = vi.fn();

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } } as any),
      getChannel: () => ({ label: 'WhatsApp', openclawId: 'whatsapp', pluginPackage: '@openclaw/whatsapp', setupFlow: 'qr-login' }),
      runAsync: vi.fn(async () => 'ok'),
      safeShellExecAsync: vi.fn(async () => 'ok'),
      readShellOutputAsync: vi.fn(async () => '[warn] still loading plugins'),
      channelLoginWithQR: vi.fn(async () => ({ success: true })),
    });

    const handler = getRegisteredSetupHandler();
    const result = await handler({}, 'whatsapp');

    expect(result).toMatchObject({
      success: true,
      pendingConfirmation: true,
    });
    expect(send).toHaveBeenCalledWith('channel:status', 'channels.status.awaitingConfirmation::WhatsApp');
  });

  it('prepares local daemon on Windows before QR login', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const send = vi.fn();
    const runAsync = vi.fn(async () => 'ok');
    const ensureLocalDaemonReadyForRuntime = vi.fn(async () => true);
    const channelLoginWithQR = vi.fn(async () => ({ success: true }));

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } } as any),
      getChannel: () => ({ label: 'WeChat', openclawId: 'openclaw-weixin', pluginPackage: '@tencent-weixin/openclaw-weixin', setupFlow: 'qr-login' }),
      runAsync,
      safeShellExecAsync: vi.fn(async () => 'ok'),
      readShellOutputAsync: vi.fn(async () => '[{"id":"openclaw-weixin","status":"linked"}]'),
      channelLoginWithQR,
      ensureLocalDaemonReadyForRuntime,
    });

    const handler = getRegisteredSetupHandler();
    const result = await handler({}, 'wechat');

    expect(result).toMatchObject({ success: true });
    expect(ensureLocalDaemonReadyForRuntime).toHaveBeenCalledTimes(1);
    expect(channelLoginWithQR).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('channel:status', 'channels.status.startingMemory');
    expect(ensureLocalDaemonReadyForRuntime.mock.invocationCallOrder[0]).toBeLessThan(channelLoginWithQR.mock.invocationCallOrder[0]);
  });

  it('retries local daemon preflight once on Windows before failing', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const ensureLocalDaemonReadyForRuntime = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    const channelLoginWithQR = vi.fn(async () => ({ success: true }));

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } } as any),
      getChannel: () => ({ label: 'WeChat', openclawId: 'openclaw-weixin', pluginPackage: '@tencent-weixin/openclaw-weixin', setupFlow: 'qr-login' }),
      runAsync: vi.fn(async () => 'ok'),
      safeShellExecAsync: vi.fn(async () => 'ok'),
      readShellOutputAsync: vi.fn(async () => null),
      channelLoginWithQR,
      ensureLocalDaemonReadyForRuntime,
    });

    const handler = getRegisteredSetupHandler();
    const result = await handler({}, 'wechat');

    expect(result.success).toBe(false);
    expect(String(result.error || '')).toContain('Local memory service is still starting');
    expect(ensureLocalDaemonReadyForRuntime).toHaveBeenCalledTimes(2);
    expect(channelLoginWithQR).not.toHaveBeenCalled();
  });
});