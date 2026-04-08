import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

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
    vi.spyOn(fs, 'existsSync').mockReturnValue(false as any);
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

    // Isolate from real ~/.openclaw/openclaw.json — isChannelLinkedInFile must return
    // false so waitForChannelConfirmation falls through to the CLI slow path.
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any) => {
      if (String(filePath).includes('openclaw.json')) return JSON.stringify({ channels: {} }) as any;
      throw new Error(`unexpected readFileSync(${String(filePath)})`);
    });

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
    const runAsync = vi.fn(async () => 'ok');

    // Isolate from real ~/.openclaw/openclaw.json — isChannelLinkedInFile must return
    // false so all readShellOutputAsync calls return 'no match' and we get pendingConfirmation.
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any) => {
      if (String(filePath).includes('openclaw.json')) return JSON.stringify({ channels: {} }) as any;
      throw new Error(`unexpected readFileSync(${String(filePath)})`);
    });

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } } as any),
      getChannel: () => ({ label: 'WhatsApp', openclawId: 'whatsapp', pluginPackage: '@openclaw/whatsapp', setupFlow: 'qr-login', saveStrategy: 'cli' }),
      runAsync,
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
    expect(runAsync).toHaveBeenCalledWith('openclaw channels add --channel whatsapp 2>&1', 45000);
    expect(send).toHaveBeenCalledWith('channel:status', 'channels.status.awaitingConfirmation::WhatsApp');
  });

  it('keeps WhatsApp DM defaults schema-safe before setup', async () => {
    const runAsync = vi.fn(async () => 'ok');
    const channelLoginWithQR = vi.fn(async () => ({ success: true }));

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any, encoding?: any) => {
      if (String(filePath).includes('.openclaw') && String(filePath).includes('openclaw.json')) {
        return JSON.stringify({
          channels: {
            whatsapp: {
              enabled: true,
              dmPolicy: 'pairing',
              errorPolicy: 'silent',
            },
          },
        }) as any;
      }
      throw new Error(`unexpected readFileSync(${String(filePath)})`);
    });

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } } as any),
      getChannel: () => ({ label: 'WhatsApp', openclawId: 'whatsapp', pluginPackage: '@openclaw/whatsapp', setupFlow: 'qr-login', saveStrategy: 'cli' }),
      runAsync,
      safeShellExecAsync: vi.fn(async () => 'ok'),
      readShellOutputAsync: vi.fn(async () => '[{"id":"whatsapp","status":"linked"}]'),
      channelLoginWithQR,
    });

    const handler = getRegisteredSetupHandler();
    const result = await handler({}, 'whatsapp');

    expect(result).toMatchObject({ success: true });
    expect(writeSpy).toHaveBeenCalled();
    const latestWrite = writeSpy.mock.calls[writeSpy.mock.calls.length - 1];
    const writtenConfig = JSON.parse(String(latestWrite?.[1] || '{}'));
    expect(writtenConfig.channels?.whatsapp?.errorPolicy).toBeUndefined();
    expect(writtenConfig.channels?.whatsapp?.dmPolicy).toBe('pairing');
    expect(writtenConfig.session?.dmScope).toBe('per-channel-peer');
    expect(runAsync).not.toHaveBeenCalledWith('openclaw gateway restart 2>&1', 30000);
  });

  it('sanitizes invalid non-target channel DM policy before setup login', async () => {
    const runAsync = vi.fn(async () => 'ok');
    const channelLoginWithQR = vi.fn(async () => ({ success: true }));

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any, encoding?: any) => {
      if (String(filePath).includes('.openclaw') && String(filePath).includes('openclaw.json')) {
        return JSON.stringify({
          channels: {
            whatsapp: {
              enabled: true,
              dmPolicy: 'pairing',
            },
            telegram: {
              enabled: true,
              botToken: '123456:abc',
              dmPolicy: 'allowlist',
            },
          },
        }) as any;
      }
      throw new Error(`unexpected readFileSync(${String(filePath)})`);
    });

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } } as any),
      getChannel: () => ({ label: 'WhatsApp', openclawId: 'whatsapp', pluginPackage: '@openclaw/whatsapp', setupFlow: 'qr-login', saveStrategy: 'cli' }),
      runAsync,
      safeShellExecAsync: vi.fn(async () => 'ok'),
      readShellOutputAsync: vi.fn(async () => '[{"id":"whatsapp","status":"linked"}]'),
      channelLoginWithQR,
    });

    const handler = getRegisteredSetupHandler();
    const result = await handler({}, 'whatsapp');

    expect(result).toMatchObject({ success: true });
    expect(writeSpy).toHaveBeenCalled();
    const latestWrite = writeSpy.mock.calls[writeSpy.mock.calls.length - 1];
    const writtenConfig = JSON.parse(String(latestWrite?.[1] || '{}'));
    expect(writtenConfig.channels?.telegram?.dmPolicy).toBe('pairing');
  });

  it('prepares local daemon on Windows before QR login', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const send = vi.fn();
    const runAsync = vi.fn(async () => 'ok');
    const ensureLocalDaemonReadyForRuntime = vi.fn(async () => true);
    const channelLoginWithQR = vi.fn(async () => ({ success: true }));

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } } as any),
      getChannel: () => ({ label: 'WeChat', openclawId: 'openclaw-weixin', pluginPackage: '@tencent-weixin/openclaw-weixin', setupFlow: 'qr-login', saveStrategy: 'json-direct' }),
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
      getChannel: () => ({ label: 'WeChat', openclawId: 'openclaw-weixin', pluginPackage: '@tencent-weixin/openclaw-weixin', setupFlow: 'qr-login', saveStrategy: 'json-direct' }),
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

  it('retries WeChat login once when Windows reports spawn npx ENOENT', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const ensureLocalDaemonReadyForRuntime = vi.fn(async () => true);
    const channelLoginWithQR = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: '[openclaw] Uncaught exception: Error: spawn npx ENOENT' })
      .mockResolvedValueOnce({ success: true });

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } } as any),
      getChannel: () => ({ label: 'WeChat', openclawId: 'openclaw-weixin', pluginPackage: '@tencent-weixin/openclaw-weixin', setupFlow: 'qr-login', saveStrategy: 'json-direct' }),
      runAsync: vi.fn(async () => 'ok'),
      safeShellExecAsync: vi.fn(async () => 'ok'),
      readShellOutputAsync: vi.fn(async () => '[{"id":"openclaw-weixin","status":"linked"}]'),
      channelLoginWithQR,
      ensureLocalDaemonReadyForRuntime,
    });

    const handler = getRegisteredSetupHandler();
    const result = await handler({}, 'wechat');

    expect(result).toMatchObject({ success: true });
    expect(ensureLocalDaemonReadyForRuntime).toHaveBeenCalledTimes(2);
    expect(channelLoginWithQR).toHaveBeenCalledTimes(2);
  });

  it('returns friendly npx PATH error when WeChat login still fails with spawn npx ENOENT', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const ensureLocalDaemonReadyForRuntime = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const channelLoginWithQR = vi.fn(async () => ({
      success: false,
      error: '[openclaw] Uncaught exception: Error: spawn npx ENOENT',
    }));

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } } as any),
      getChannel: () => ({ label: 'WeChat', openclawId: 'openclaw-weixin', pluginPackage: '@tencent-weixin/openclaw-weixin', setupFlow: 'qr-login', saveStrategy: 'json-direct' }),
      runAsync: vi.fn(async () => 'ok'),
      safeShellExecAsync: vi.fn(async () => 'ok'),
      readShellOutputAsync: vi.fn(async () => null),
      channelLoginWithQR,
      ensureLocalDaemonReadyForRuntime,
    });

    const handler = getRegisteredSetupHandler();
    const result = await handler({}, 'wechat');

    expect(result.success).toBe(false);
    expect(String(result.error || '')).toContain('npx not found in runtime PATH');
  });

  it('retries WeChat login with higher stack when OpenClaw reports plugin crash on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const channelLoginWithQR = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'OpenClaw crashed while loading plugins. Please retry once.' })
      .mockResolvedValueOnce({ success: true });

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } } as any),
      getChannel: () => ({ label: 'WeChat', openclawId: 'openclaw-weixin', pluginPackage: '@tencent-weixin/openclaw-weixin', setupFlow: 'qr-login', saveStrategy: 'json-direct' }),
      runAsync: vi.fn(async () => 'ok'),
      safeShellExecAsync: vi.fn(async () => 'ok'),
      readShellOutputAsync: vi.fn(async () => '[{"id":"openclaw-weixin","status":"linked"}]'),
      channelLoginWithQR,
      ensureLocalDaemonReadyForRuntime: vi.fn(async () => true),
    });

    const handler = getRegisteredSetupHandler();
    const result = await handler({}, 'wechat');

    expect(result).toMatchObject({ success: true });
    expect(channelLoginWithQR).toHaveBeenCalledTimes(2);
    expect(channelLoginWithQR).toHaveBeenNthCalledWith(
      2,
      'openclaw channels login --channel openclaw-weixin --verbose',
      180000,
      { AWARENESS_OPENCLAW_STACK_SIZE_KB: '12288' },
    );
  });

  it('logs out stale WeChat session and retries once after timeout-like reconnect failure', async () => {
    const runAsync = vi.fn(async () => 'ok');
    const channelLoginWithQR = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'Connection timed out while OpenClaw was still loading. Please retry in 20-60 seconds.' })
      .mockResolvedValueOnce({ success: true });

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } } as any),
      getChannel: () => ({ label: 'WeChat', openclawId: 'openclaw-weixin', pluginPackage: '@tencent-weixin/openclaw-weixin', setupFlow: 'qr-login', saveStrategy: 'json-direct' }),
      runAsync,
      safeShellExecAsync: vi.fn(async () => 'ok'),
      readShellOutputAsync: vi.fn(async () => '[{"id":"openclaw-weixin","status":"linked"}]'),
      channelLoginWithQR,
    });

    const handler = getRegisteredSetupHandler();
    const result = await handler({}, 'wechat');

    expect(result).toMatchObject({ success: true });
    expect(channelLoginWithQR).toHaveBeenCalledTimes(2);
    expect(runAsync).toHaveBeenCalledWith('openclaw channels logout --channel openclaw-weixin 2>&1', 30000);
  });

  it('falls back to scoped plugin isolation when WeChat still crashes after high-stack retry', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const channelLoginWithQR = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'OpenClaw crashed while loading plugins. Please retry once.' })
      .mockResolvedValueOnce({ success: false, error: 'OpenClaw crashed while loading plugins. Please retry once.' })
      .mockResolvedValueOnce({ success: true });

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => undefined as any);
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any) => {
      if (String(filePath).includes('openclaw.json')) {
        return JSON.stringify({
          plugins: {
            allow: ['google', 'minimax', 'openclaw-weixin'],
            entries: {
              google: { enabled: true },
              minimax: { enabled: true },
              'openclaw-weixin': { enabled: true },
            },
          },
          channels: {
            'openclaw-weixin': { enabled: true },
          },
        }) as any;
      }
      throw new Error(`unexpected readFileSync(${String(filePath)})`);
    });

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } } as any),
      getChannel: () => ({ label: 'WeChat', openclawId: 'openclaw-weixin', pluginPackage: '@tencent-weixin/openclaw-weixin', setupFlow: 'qr-login', saveStrategy: 'json-direct' }),
      runAsync: vi.fn(async () => 'ok'),
      safeShellExecAsync: vi.fn(async () => 'ok'),
      readShellOutputAsync: vi.fn(async () => '[{"id":"openclaw-weixin","status":"linked"}]'),
      channelLoginWithQR,
      ensureLocalDaemonReadyForRuntime: vi.fn(async () => true),
    });

    const handler = getRegisteredSetupHandler();
    const result = await handler({}, 'wechat');

    expect(result).toMatchObject({ success: true });
    expect(channelLoginWithQR).toHaveBeenCalledTimes(3);
    const scopedEnv = channelLoginWithQR.mock.calls[2]?.[2] as Record<string, string> | undefined;
    expect(scopedEnv?.OPENCLAW_CONFIG_PATH).toBeTruthy();
    expect(scopedEnv?.AWARENESS_OPENCLAW_STACK_SIZE_KB).toBe('12288');

    const isolatedWrite = writeSpy.mock.calls.find(([target]) => String(target).includes('awarenessclaw-channel-login'));
    expect(isolatedWrite).toBeTruthy();
    const isolatedConfig = JSON.parse(String(isolatedWrite?.[1] || '{}'));
    expect(isolatedConfig.plugins?.allow).toEqual(['openclaw-weixin']);
    expect(isolatedConfig.plugins?.entries?.google?.enabled).toBe(false);
    expect(isolatedConfig.plugins?.entries?.minimax?.enabled).toBe(false);
    expect(isolatedConfig.plugins?.entries?.['openclaw-weixin']?.enabled).toBe(true);
    expect(rmSpy).toHaveBeenCalledWith(expect.stringContaining('awarenessclaw-channel-login'), expect.objectContaining({ force: true }));
  });

  it('retries plugin install with command-scoped config on Windows npx ENOENT', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const runAsync = vi
      .fn()
      .mockRejectedValueOnce(new Error('[openclaw] Uncaught exception: Error: spawn npx ENOENT'))
      .mockResolvedValueOnce('plugin installed via scoped config')
      .mockResolvedValueOnce('bound');
    const channelLoginWithQR = vi.fn(async () => ({ success: true }));

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => undefined as any);
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any, encoding?: any) => {
      if (String(filePath).includes('.openclaw') && String(filePath).includes('openclaw.json')) {
        return JSON.stringify({
          plugins: {
            entries: {
              'openclaw-memory': {
                enabled: true,
              },
            },
            allow: ['openclaw-memory', 'browser'],
            slots: {
              memory: 'openclaw-memory',
            },
          },
          channels: {
            'openclaw-weixin': {
              enabled: true,
            },
          },
        }) as any;
      }
      throw new Error(`unexpected readFileSync(${String(filePath)})`);
    });

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } } as any),
      getChannel: () => ({ label: 'WeChat', openclawId: 'openclaw-weixin', pluginPackage: '@tencent-weixin/openclaw-weixin', setupFlow: 'qr-login', saveStrategy: 'json-direct' }),
      runAsync,
      safeShellExecAsync: vi.fn(async () => 'ok'),
      readShellOutputAsync: vi.fn(async () => '[{"id":"openclaw-weixin","status":"linked"}]'),
      channelLoginWithQR,
      ensureLocalDaemonReadyForRuntime: vi.fn(async () => true),
    });

    const handler = getRegisteredSetupHandler();
    const result = await handler({}, 'wechat');

    expect(result).toMatchObject({ success: true });
    expect(runAsync).toHaveBeenCalledWith('openclaw plugins install "@tencent-weixin/openclaw-weixin" 2>&1', 120000);
    expect(runAsync).toHaveBeenCalledWith(expect.stringContaining('OPENCLAW_CONFIG_PATH='), 120000);
    expect(channelLoginWithQR).toHaveBeenCalledTimes(1);

    const isolatedWrite = writeSpy.mock.calls.find(([target]) => String(target).includes('awarenessclaw-channel-cmd'));
    expect(isolatedWrite).toBeTruthy();
    const isolatedConfig = JSON.parse(String(isolatedWrite?.[1] || '{}'));
    expect(isolatedConfig.plugins?.entries?.['openclaw-memory']?.enabled).toBe(false);
    expect(isolatedConfig.plugins?.allow || []).not.toContain('openclaw-memory');
    expect(isolatedConfig.plugins?.slots?.memory).toBeUndefined();
    expect(rmSpy).toHaveBeenCalledWith(expect.stringContaining('awarenessclaw-channel-cmd'), expect.objectContaining({ force: true }));
  });

  it('retries with command-scoped config when Windows npx ENOENT persists', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const ensureLocalDaemonReadyForRuntime = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const channelLoginWithQR = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: '[openclaw] Uncaught exception: Error: spawn npx ENOENT' })
      .mockResolvedValueOnce({ success: false, error: '[openclaw] Uncaught exception: Error: spawn npx ENOENT' })
      .mockResolvedValueOnce({ success: true });

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => undefined as any);
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any, encoding?: any) => {
      if (String(filePath).includes('.openclaw') && String(filePath).includes('openclaw.json')) {
        return JSON.stringify({
          plugins: {
            entries: {
              'openclaw-memory': {
                enabled: true,
              },
            },
            allow: ['openclaw-memory', 'browser'],
            slots: {
              memory: 'openclaw-memory',
            },
          },
          channels: {
            'openclaw-weixin': {
              enabled: true,
            },
          },
        }) as any;
      }
      throw new Error(`unexpected readFileSync(${String(filePath)})`);
    });

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } } as any),
      getChannel: () => ({ label: 'WeChat', openclawId: 'openclaw-weixin', pluginPackage: '@tencent-weixin/openclaw-weixin', setupFlow: 'qr-login', saveStrategy: 'json-direct' }),
      runAsync: vi.fn(async () => 'ok'),
      safeShellExecAsync: vi.fn(async () => 'ok'),
      readShellOutputAsync: vi.fn(async () => '[{"id":"openclaw-weixin","status":"linked"}]'),
      channelLoginWithQR,
      ensureLocalDaemonReadyForRuntime,
    });

    const handler = getRegisteredSetupHandler();
    const result = await handler({}, 'wechat');

    expect(result).toMatchObject({ success: true });
    expect(channelLoginWithQR).toHaveBeenCalledTimes(3);
    const scopedEnv = channelLoginWithQR.mock.calls[2]?.[2] as Record<string, string> | undefined;
    expect(scopedEnv?.OPENCLAW_CONFIG_PATH).toBeTruthy();

    const isolatedWrite = writeSpy.mock.calls.find(([target]) => String(target).includes('awarenessclaw-channel-login'));
    expect(isolatedWrite).toBeTruthy();
    const isolatedConfig = JSON.parse(String(isolatedWrite?.[1] || '{}'));
    expect(isolatedConfig.plugins?.entries?.['openclaw-memory']?.enabled).toBe(false);
    expect(isolatedConfig.plugins?.allow || []).not.toContain('openclaw-memory');
    expect(isolatedConfig.plugins?.slots?.memory).toBeUndefined();
    expect(rmSpy).toHaveBeenCalledWith(expect.stringContaining('awarenessclaw-channel-login'), expect.objectContaining({ force: true }));
  });

  it('continues setup when plugin install reports already exists', async () => {
    const send = vi.fn();
    const runAsync = vi
      .fn()
      .mockRejectedValueOnce(new Error('plugin already exists: C:/Users/admin/.openclaw/extensions/openclaw-weixin'))
      .mockResolvedValueOnce('ok');
    const channelLoginWithQR = vi.fn(async () => ({ success: true }));

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } } as any),
      getChannel: () => ({ label: 'WeChat', openclawId: 'openclaw-weixin', pluginPackage: '@tencent-weixin/openclaw-weixin', setupFlow: 'qr-login', saveStrategy: 'json-direct' }),
      getChannelByOpenclawId: (openclawId: string) => openclawId === 'telegram'
        ? ({ id: 'telegram', openclawId: 'telegram', pluginPackage: '@openclaw/telegram' } as any)
        : undefined,
      runAsync,
      safeShellExecAsync: vi.fn(async () => 'ok'),
      readShellOutputAsync: vi.fn(async () => '[{"id":"openclaw-weixin","status":"linked"}]'),
      channelLoginWithQR,
    });

    const handler = getRegisteredSetupHandler();
    const result = await handler({}, 'wechat');

    expect(result).toMatchObject({ success: true });
    expect(channelLoginWithQR).toHaveBeenCalledTimes(1);
    expect(runAsync).toHaveBeenCalledWith('openclaw plugins install "@tencent-weixin/openclaw-weixin" 2>&1', 120000);
  });

  it('repairs blocking plugin load failures and retries login once', async () => {
    const send = vi.fn();
    const runAsync = vi.fn(async () => 'ok');
    const channelLoginWithQR = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        error: "[plugins] telegram failed to load from C:/x: Error: Cannot find module 'grammy'",
      })
      .mockResolvedValueOnce({ success: true });

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } } as any),
      getChannel: () => ({ label: 'WeChat', openclawId: 'openclaw-weixin', pluginPackage: '@tencent-weixin/openclaw-weixin', setupFlow: 'qr-login', saveStrategy: 'json-direct' }),
      getChannelByOpenclawId: (openclawId: string) => openclawId === 'telegram'
        ? ({ id: 'telegram', openclawId: 'telegram', pluginPackage: '@openclaw/telegram' } as any)
        : undefined,
      runAsync,
      safeShellExecAsync: vi.fn(async () => 'ok'),
      readShellOutputAsync: vi.fn(async () => '[{"id":"openclaw-weixin","status":"linked"}]'),
      channelLoginWithQR,
    });

    const handler = getRegisteredSetupHandler();
    const result = await handler({}, 'wechat');

    expect(result).toMatchObject({ success: true });
    expect(channelLoginWithQR).toHaveBeenCalledTimes(2);
    expect(runAsync).toHaveBeenCalledWith(expect.stringContaining('openclaw plugins uninstall --force "telegram" 2>&1'), 30000);
    expect(runAsync).toHaveBeenCalledWith(expect.stringContaining('openclaw plugins install "@openclaw/telegram" 2>&1'), 120000);
    expect(send).toHaveBeenCalledWith('channel:status', 'channels.status.repairingPlugin::telegram');
  });

  it('prepares official CLI channels via channels add before login', async () => {
    const runAsync = vi.fn(async () => 'ok');
    const channelLoginWithQR = vi.fn(async () => ({ success: true }));

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } } as any),
      getChannel: () => ({ label: 'WhatsApp', openclawId: 'whatsapp', pluginPackage: '@openclaw/whatsapp', setupFlow: 'qr-login', saveStrategy: 'cli' }),
      runAsync,
      safeShellExecAsync: vi.fn(async () => 'ok'),
      readShellOutputAsync: vi.fn(async () => '[{"id":"whatsapp","status":"linked"}]'),
      channelLoginWithQR,
    });

    const handler = getRegisteredSetupHandler();
    const result = await handler({}, 'whatsapp');

    expect(result).toMatchObject({ success: true });
    expect(runAsync).toHaveBeenCalledWith('openclaw channels add --channel whatsapp 2>&1', 45000);
    expect(channelLoginWithQR).toHaveBeenCalledWith('openclaw channels login --channel whatsapp --verbose', 180000);
  });
  it('resolves repair install spec from openclaw plugins inspect output', async () => {
    const runAsync = vi.fn(async () => 'ok');
    const readShellOutputAsync = vi
      .fn()
      .mockResolvedValueOnce('{"install":{"spec":"@openclaw/telegram@beta"}}')
      .mockResolvedValueOnce('[{"id":"openclaw-weixin","status":"linked"}]');
    const channelLoginWithQR = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: '[plugins] telegram failed to load: cannot start' })
      .mockResolvedValueOnce({ success: true });

    registerChannelSetupHandlers({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } } as any),
      getChannel: () => ({ label: 'WeChat', openclawId: 'openclaw-weixin', pluginPackage: '@tencent-weixin/openclaw-weixin', setupFlow: 'qr-login' }),
      runAsync,
      safeShellExecAsync: vi.fn(async () => 'ok'),
      readShellOutputAsync,
      channelLoginWithQR,
    });

    const handler = getRegisteredSetupHandler();
    const result = await handler({}, 'wechat');

    expect(result).toMatchObject({ success: true });
    expect(runAsync).toHaveBeenCalledWith(expect.stringContaining('openclaw plugins install "@openclaw/telegram@beta" 2>&1'), 120000);
  });
});