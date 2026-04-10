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

import { registerChannelConfigHandlers } from '../../electron/ipc/register-channel-config-handlers';

function getRegisteredSaveHandler() {
  const match = handleMock.mock.calls.find(([channel]) => channel === 'channel:save');
  if (!match) throw new Error('channel:save handler not registered');
  return match[1] as (event: unknown, channelId: string, config: Record<string, string>) => Promise<any>;
}

function getRegisteredPairingApproveHandler() {
  const match = handleMock.mock.calls.find(([channel]) => channel === 'channel:pairing-approve');
  if (!match) throw new Error('channel:pairing-approve handler not registered');
  return match[1] as (event: unknown, channelId: string, pairingCode: string) => Promise<any>;
}

function getRegisteredPairingLatestCodeHandler() {
  const match = handleMock.mock.calls.find(([channel]) => channel === 'channel:pairing-latest-code');
  if (!match) throw new Error('channel:pairing-latest-code handler not registered');
  return match[1] as (event: unknown, channelId: string) => Promise<any>;
}

function getRegisteredReadConfigHandler() {
  const match = handleMock.mock.calls.find(([channel]) => channel === 'channel:read-config');
  if (!match) throw new Error('channel:read-config handler not registered');
  return match[1] as (event: unknown, channelId: string) => Promise<any>;
}

function getRegisteredTestHandler() {
  const match = handleMock.mock.calls.find(([channel]) => channel === 'channel:test');
  if (!match) throw new Error('channel:test handler not registered');
  return match[1] as (event: unknown, channelId: string) => Promise<any>;
}

describe('registerChannelConfigHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset();
  });

  it('treats timed-out channel add as recoverable when channel already appears in list', async () => {
    const runAsync = vi
      .fn()
      .mockResolvedValueOnce('plugin installed')
      .mockRejectedValueOnce(new Error('Command timed out'))
      .mockResolvedValueOnce('gateway restarted')
      .mockResolvedValueOnce('bound');

    const readShellOutputAsync = vi
      .fn()
      .mockResolvedValueOnce('telegram configured enabled');

    registerChannelConfigHandlers({
      home: 'C:/Users/test',
      safeShellExecAsync: vi.fn(async () => null),
      readShellOutputAsync,
      runAsync,
      discoverOpenClawChannels: vi.fn(),
      parseCliHelp: vi.fn(() => ({ cliChannels: new Set<string>(), channelFields: new Map() })),
      applyCliHelp: vi.fn(),
      mergeCatalog: vi.fn(),
      mergeChannelOptions: vi.fn(),
      getAllChannels: vi.fn(() => []),
      serializeRegistry: vi.fn(() => []),
      getChannel: vi.fn(() => ({
        id: 'telegram',
        openclawId: 'telegram',
        label: 'Telegram',
        color: '#26A5E4',
        iconType: 'svg',
        connectionType: 'token',
        pluginPackage: '@openclaw/telegram',
        saveStrategy: 'cli',
        configFields: [{ key: 'token' }],
        source: 'openclaw-dynamic',
        order: 1,
      })) as any,
      buildCLIFlags: vi.fn(() => '--token "abc"'),
      toOpenclawId: vi.fn((id: string) => id),
    });

    const handler = getRegisteredSaveHandler();
    const result = await handler({}, 'telegram', { token: 'abc' });

    expect(result).toMatchObject({ success: true });
    expect(readShellOutputAsync).toHaveBeenCalledWith('openclaw channels list 2>&1', 45000);
    expect(runAsync).toHaveBeenCalledWith('openclaw agents bind --agent main --bind telegram 2>&1', 30000);
  });

  it('retries plugin install with command-scoped config on Windows npx ENOENT', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const runAsync = vi
      .fn()
      .mockRejectedValueOnce(new Error('[openclaw] Uncaught exception: Error: spawn npx ENOENT'))
      .mockResolvedValueOnce('plugin installed via scoped config')
      .mockResolvedValueOnce('channel added')
      .mockResolvedValueOnce('gateway restarted')
      .mockResolvedValueOnce('bound');

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
            telegram: {
              enabled: true,
            },
          },
        }) as any;
      }
      throw new Error(`unexpected readFileSync(${String(filePath)})`);
    });

    registerChannelConfigHandlers({
      home: 'C:/Users/test',
      safeShellExecAsync: vi.fn(async () => null),
      readShellOutputAsync: vi.fn(async () => null),
      runAsync,
      discoverOpenClawChannels: vi.fn(),
      parseCliHelp: vi.fn(() => ({ cliChannels: new Set<string>(), channelFields: new Map() })),
      applyCliHelp: vi.fn(),
      mergeCatalog: vi.fn(),
      mergeChannelOptions: vi.fn(),
      getAllChannels: vi.fn(() => []),
      serializeRegistry: vi.fn(() => []),
      getChannel: vi.fn(() => ({
        id: 'telegram',
        openclawId: 'telegram',
        label: 'Telegram',
        color: '#26A5E4',
        iconType: 'svg',
        connectionType: 'token',
        pluginPackage: '@openclaw/telegram',
        saveStrategy: 'cli',
        configFields: [{ key: 'token' }],
        source: 'openclaw-dynamic',
        order: 1,
      })) as any,
      buildCLIFlags: vi.fn(() => '--token "abc"'),
      toOpenclawId: vi.fn((id: string) => id),
    });

    const handler = getRegisteredSaveHandler();
    const result = await handler({}, 'telegram', { token: 'abc' });

    expect(result).toMatchObject({ success: true });
    expect(runAsync).toHaveBeenCalledWith('openclaw plugins install "@openclaw/telegram" 2>&1', 60000);
    expect(runAsync).toHaveBeenCalledWith(expect.stringContaining('OPENCLAW_CONFIG_PATH='), 60000);

    const isolatedWrite = writeSpy.mock.calls.find(([target]) => String(target).includes('awarenessclaw-channel-cmd'));
    expect(isolatedWrite).toBeTruthy();
    const isolatedConfig = JSON.parse(String(isolatedWrite?.[1] || '{}'));
    expect(isolatedConfig.plugins?.entries?.['openclaw-memory']?.enabled).toBe(false);
    expect(isolatedConfig.plugins?.allow || []).not.toContain('openclaw-memory');
    expect(isolatedConfig.plugins?.slots?.memory).toBeUndefined();
    expect(rmSpy).toHaveBeenCalledWith(expect.stringContaining('awarenessclaw-channel-cmd'), expect.objectContaining({ force: true }));
  });

  it('approves pairing code then retries binding and checks connectivity', async () => {
    const runAsync = vi
      .fn()
      .mockResolvedValueOnce('approved')
      .mockRejectedValueOnce(new Error('bind failed'))
      .mockResolvedValueOnce('gateway restarted')
      .mockResolvedValueOnce('bind ok');

    const readShellOutputAsync = vi
      .fn()
      .mockResolvedValueOnce('telegram pending: C4AVKKA9')
      .mockResolvedValueOnce('Runtime: running\nRPC probe: ok')
      .mockResolvedValueOnce('telegram configured enabled');

    registerChannelConfigHandlers({
      home: 'C:/Users/test',
      safeShellExecAsync: vi.fn(async () => null),
      readShellOutputAsync,
      runAsync,
      discoverOpenClawChannels: vi.fn(),
      parseCliHelp: vi.fn(() => ({ cliChannels: new Set<string>(), channelFields: new Map() })),
      applyCliHelp: vi.fn(),
      mergeCatalog: vi.fn(),
      mergeChannelOptions: vi.fn(),
      getAllChannels: vi.fn(() => []),
      serializeRegistry: vi.fn(() => []),
      getChannel: vi.fn(() => ({
        id: 'telegram',
        openclawId: 'telegram',
        label: 'Telegram',
        color: '#26A5E4',
        iconType: 'svg',
        connectionType: 'token',
        configFields: [{ key: 'token' }],
        saveStrategy: 'cli',
        source: 'openclaw-dynamic',
        order: 1,
      })) as any,
      buildCLIFlags: vi.fn(() => ''),
      toOpenclawId: vi.fn((id: string) => id),
    });

    const handler = getRegisteredPairingApproveHandler();
    const result = await handler({}, 'telegram', 'openclaw pairing approve telegram C4AVKKA9');

    expect(result).toMatchObject({ success: true });
    expect(result.connectivity?.ready).toBe(true);
    expect(result.bindRetried).toBe(true);
    expect(runAsync).toHaveBeenCalledWith('openclaw pairing approve --channel telegram C4AVKKA9 2>&1', 30000);
    expect(runAsync).toHaveBeenCalledWith('openclaw gateway restart 2>&1', 30000);
  });

  it('returns a Telegram first-message hint when the channel is healthy but no pairing request exists yet', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any) => {
      if (String(filePath).includes('openclaw.json')) {
        return JSON.stringify({
          channels: {
            telegram: {
              enabled: true,
              botToken: 'redacted-token',
            },
          },
        }) as any;
      }
      throw new Error(`unexpected readFileSync(${String(filePath)})`);
    });

    const readShellOutputAsync = vi
      .fn()
      .mockResolvedValueOnce('Runtime: running\nRPC probe: ok')
      .mockResolvedValueOnce('telegram configured enabled')
      .mockResolvedValueOnce('No pending telegram pairing requests.');

    registerChannelConfigHandlers({
      home: 'C:/Users/test',
      safeShellExecAsync: vi.fn(async () => null),
      readShellOutputAsync,
      runAsync: vi.fn(),
      discoverOpenClawChannels: vi.fn(),
      parseCliHelp: vi.fn(() => ({ cliChannels: new Set<string>(), channelFields: new Map() })),
      applyCliHelp: vi.fn(),
      mergeCatalog: vi.fn(),
      mergeChannelOptions: vi.fn(),
      getAllChannels: vi.fn(() => []),
      serializeRegistry: vi.fn(() => []),
      getChannel: vi.fn(() => ({
        id: 'telegram',
        openclawId: 'telegram',
        label: 'Telegram',
        color: '#26A5E4',
        iconType: 'svg',
        connectionType: 'token',
        configFields: [{ key: 'botToken' }],
        saveStrategy: 'cli',
        source: 'openclaw-dynamic',
        order: 1,
      })) as any,
      buildCLIFlags: vi.fn(() => ''),
      toOpenclawId: vi.fn((id: string) => id),
    });

    const handler = getRegisteredTestHandler();
    const result = await handler({}, 'telegram');

    expect(result).toMatchObject({ success: true });
    expect(result.output).toContain('send your bot a first direct message');
    expect(readShellOutputAsync).toHaveBeenCalledWith('openclaw pairing list telegram 2>&1', 20000);
  });

  it('falls back to gateway status when channels status --probe is temporarily unreachable', async () => {
    const runAsync = vi
      .fn()
      .mockResolvedValueOnce('approved')
      .mockResolvedValueOnce('bind ok');

    const readShellOutputAsync = vi
      .fn()
      .mockResolvedValueOnce('telegram pending: C4AVKKA9')
      .mockResolvedValueOnce('Gateway not reachable: Error: gateway timeout after 10000ms')
      .mockResolvedValueOnce('telegram configured enabled')
      .mockResolvedValueOnce('Runtime: running');

    // Isolate from real ~/.openclaw/openclaw.json — detectChannelConnectivity must
    // follow the full call sequence (channels list → gateway status fallback) so
    // each mock slot is consumed in the right order.
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any) => {
      if (String(filePath).includes('openclaw.json')) return JSON.stringify({ channels: {} }) as any;
      throw new Error(`unexpected readFileSync(${String(filePath)})`);
    });

    registerChannelConfigHandlers({
      home: 'C:/Users/test',
      safeShellExecAsync: vi.fn(async () => null),
      readShellOutputAsync,
      runAsync,
      discoverOpenClawChannels: vi.fn(),
      parseCliHelp: vi.fn(() => ({ cliChannels: new Set<string>(), channelFields: new Map() })),
      applyCliHelp: vi.fn(),
      mergeCatalog: vi.fn(),
      mergeChannelOptions: vi.fn(),
      getAllChannels: vi.fn(() => []),
      serializeRegistry: vi.fn(() => []),
      getChannel: vi.fn(() => ({
        id: 'telegram',
        openclawId: 'telegram',
        label: 'Telegram',
        color: '#26A5E4',
        iconType: 'svg',
        connectionType: 'token',
        configFields: [{ key: 'token' }],
        saveStrategy: 'cli',
        source: 'openclaw-dynamic',
        order: 1,
      })) as any,
      buildCLIFlags: vi.fn(() => ''),
      toOpenclawId: vi.fn((id: string) => id),
    });

    const handler = getRegisteredPairingApproveHandler();
    const result = await handler({}, 'telegram', 'openclaw pairing approve telegram C4AVKKA9');

    expect(result).toMatchObject({ success: true });
    expect(result.connectivity?.ready).toBe(true);
    expect(readShellOutputAsync).toHaveBeenCalledWith('openclaw gateway status 2>&1', 45000);
  });

  it('supports --channel syntax for WhatsApp pairing and keeps WhatsApp DM policy schema-safe', async () => {
    const runAsync = vi
      .fn()
      .mockResolvedValueOnce('approved')
      .mockResolvedValueOnce('bind ok');

    const readShellOutputAsync = vi
      .fn()
      .mockResolvedValueOnce('openclaw pairing approve --channel whatsapp KGHQJ8SK')
      .mockResolvedValueOnce('Runtime: running\nRPC probe: ok')
      .mockResolvedValueOnce('whatsapp configured enabled');

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

    registerChannelConfigHandlers({
      home: 'C:/Users/test',
      safeShellExecAsync: vi.fn(async () => null),
      readShellOutputAsync,
      runAsync,
      discoverOpenClawChannels: vi.fn(),
      parseCliHelp: vi.fn(() => ({ cliChannels: new Set<string>(), channelFields: new Map() })),
      applyCliHelp: vi.fn(),
      mergeCatalog: vi.fn(),
      mergeChannelOptions: vi.fn(),
      getAllChannels: vi.fn(() => []),
      serializeRegistry: vi.fn(() => []),
      getChannel: vi.fn(() => ({
        id: 'whatsapp',
        openclawId: 'whatsapp',
        label: 'WhatsApp',
        color: '#25D366',
        iconType: 'svg',
        connectionType: 'one-click',
        configFields: [],
        saveStrategy: 'cli',
        source: 'openclaw-dynamic',
        order: 3,
      })) as any,
      buildCLIFlags: vi.fn(() => ''),
      toOpenclawId: vi.fn((id: string) => id),
    });

    const handler = getRegisteredPairingApproveHandler();
    const result = await handler({}, 'whatsapp', 'openclaw pairing approve --channel whatsapp KGHQJ8SK');

    expect(result).toMatchObject({ success: true });
    expect(runAsync).toHaveBeenCalledWith('openclaw pairing approve --channel whatsapp KGHQJ8SK --notify 2>&1', 30000);
    expect(writeSpy).toHaveBeenCalled();
    const latestWrite = writeSpy.mock.calls[writeSpy.mock.calls.length - 1];
    const writtenConfig = JSON.parse(String(latestWrite?.[1] || '{}'));
    expect(writtenConfig.channels?.whatsapp?.errorPolicy).toBeUndefined();
    expect(writtenConfig.channels?.whatsapp?.dmPolicy).toBe('pairing');
    expect(writtenConfig.session?.dmScope).toBe('per-channel-peer');
    expect(runAsync).not.toHaveBeenCalledWith('openclaw gateway restart 2>&1', 30000);
  });

  it('repairs invalid non-target channel DM policy before WhatsApp pairing approval', async () => {
    const runAsync = vi
      .fn()
      .mockResolvedValueOnce('approved')
      .mockResolvedValueOnce('bind ok');

    const readShellOutputAsync = vi
      .fn()
      .mockResolvedValueOnce('openclaw pairing approve --channel whatsapp KGHQJ8SK')
      .mockResolvedValueOnce('Runtime: running\nRPC probe: ok')
      .mockResolvedValueOnce('whatsapp configured enabled');

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

    registerChannelConfigHandlers({
      home: 'C:/Users/test',
      safeShellExecAsync: vi.fn(async () => null),
      readShellOutputAsync,
      runAsync,
      discoverOpenClawChannels: vi.fn(),
      parseCliHelp: vi.fn(() => ({ cliChannels: new Set<string>(), channelFields: new Map() })),
      applyCliHelp: vi.fn(),
      mergeCatalog: vi.fn(),
      mergeChannelOptions: vi.fn(),
      getAllChannels: vi.fn(() => []),
      serializeRegistry: vi.fn(() => []),
      getChannel: vi.fn(() => ({
        id: 'whatsapp',
        openclawId: 'whatsapp',
        label: 'WhatsApp',
        color: '#25D366',
        iconType: 'svg',
        connectionType: 'one-click',
        configFields: [],
        saveStrategy: 'cli',
        source: 'openclaw-dynamic',
        order: 3,
      })) as any,
      buildCLIFlags: vi.fn(() => ''),
      toOpenclawId: vi.fn((id: string) => id),
    });

    const handler = getRegisteredPairingApproveHandler();
    const result = await handler({}, 'whatsapp', 'openclaw pairing approve --channel whatsapp KGHQJ8SK');

    expect(result).toMatchObject({ success: true });
    expect(writeSpy).toHaveBeenCalled();
    const latestWrite = writeSpy.mock.calls[writeSpy.mock.calls.length - 1];
    const writtenConfig = JSON.parse(String(latestWrite?.[1] || '{}'));
    expect(writtenConfig.channels?.telegram?.dmPolicy).toBe('pairing');
  });

  it('approves Feishu pairing code without WhatsApp notify flag and reports ready connectivity', async () => {
    const runAsync = vi
      .fn()
      .mockResolvedValueOnce('approved')
      .mockResolvedValueOnce('bind ok');

    const readShellOutputAsync = vi
      .fn()
      .mockResolvedValueOnce('OpenClaw: access not configured.\nPairing code: 5MQFD7PH\nopenclaw pairing approve feishu 5MQFD7PH')
      .mockResolvedValueOnce('Runtime: running\nRPC probe: ok')
      .mockResolvedValueOnce('feishu configured enabled');

    registerChannelConfigHandlers({
      home: 'C:/Users/test',
      safeShellExecAsync: vi.fn(async () => null),
      readShellOutputAsync,
      runAsync,
      discoverOpenClawChannels: vi.fn(),
      parseCliHelp: vi.fn(() => ({ cliChannels: new Set<string>(), channelFields: new Map() })),
      applyCliHelp: vi.fn(),
      mergeCatalog: vi.fn(),
      mergeChannelOptions: vi.fn(),
      getAllChannels: vi.fn(() => []),
      serializeRegistry: vi.fn(() => []),
      getChannel: vi.fn(() => ({
        id: 'feishu',
        openclawId: 'feishu',
        label: 'Feishu',
        color: '#3370FF',
        iconType: 'svg',
        connectionType: 'multi-field',
        configFields: [{ key: 'appId' }, { key: 'appSecret' }],
        saveStrategy: 'json-direct',
        source: 'openclaw-dynamic',
        order: 8,
      })) as any,
      buildCLIFlags: vi.fn(() => ''),
      toOpenclawId: vi.fn((id: string) => id),
    });

    const handler = getRegisteredPairingApproveHandler();
    const result = await handler({}, 'feishu', 'openclaw pairing approve feishu 5MQFD7PH');

    expect(result).toMatchObject({ success: true });
    expect(result.connectivity?.ready).toBe(true);
    expect(runAsync).toHaveBeenCalledWith('openclaw pairing approve --channel feishu 5MQFD7PH 2>&1', 30000);
    expect(runAsync).not.toHaveBeenCalledWith(expect.stringContaining('--notify'), 30000);
    expect(runAsync).toHaveBeenCalledWith('openclaw agents bind --agent main --bind feishu 2>&1', 30000);
  });

  it('returns latest pending pairing code for auto-fill', async () => {
    const readShellOutputAsync = vi
      .fn()
      .mockResolvedValueOnce('telegram pending code: C4AVKKA9\ntelegram pending code: LJK9MNP2');

    registerChannelConfigHandlers({
      home: 'C:/Users/test',
      safeShellExecAsync: vi.fn(async () => null),
      readShellOutputAsync,
      runAsync: vi.fn(async () => 'ok'),
      discoverOpenClawChannels: vi.fn(),
      parseCliHelp: vi.fn(() => ({ cliChannels: new Set<string>(), channelFields: new Map() })),
      applyCliHelp: vi.fn(),
      mergeCatalog: vi.fn(),
      mergeChannelOptions: vi.fn(),
      getAllChannels: vi.fn(() => []),
      serializeRegistry: vi.fn(() => []),
      getChannel: vi.fn(() => ({
        id: 'telegram',
        openclawId: 'telegram',
        label: 'Telegram',
        color: '#26A5E4',
        iconType: 'svg',
        connectionType: 'token',
        configFields: [{ key: 'token' }],
        saveStrategy: 'cli',
        source: 'openclaw-dynamic',
        order: 1,
      })) as any,
      buildCLIFlags: vi.fn(() => ''),
      toOpenclawId: vi.fn((id: string) => id),
    });

    const handler = getRegisteredPairingLatestCodeHandler();
    const result = await handler({}, 'telegram');

    expect(result).toMatchObject({ success: true, code: 'C4AVKKA9' });
    expect(result.codes).toEqual(['C4AVKKA9', 'LJK9MNP2']);
    expect(readShellOutputAsync).toHaveBeenCalledWith('openclaw pairing list telegram 2>&1', 30000);
  });

  it('resolves plugin install spec from plugins inspect output when channel package is absent', async () => {
    const runAsync = vi
      .fn()
      .mockResolvedValueOnce('plugin installed')
      .mockResolvedValueOnce('channel added')
      .mockResolvedValueOnce('gateway restarted')
      .mockResolvedValueOnce('bound');

    const readShellOutputAsync = vi
      .fn()
      .mockResolvedValueOnce('{"install":{"spec":"@openclaw/telegram@beta"}}');

    registerChannelConfigHandlers({
      home: 'C:/Users/test',
      safeShellExecAsync: vi.fn(async () => null),
      readShellOutputAsync,
      runAsync,
      discoverOpenClawChannels: vi.fn(),
      parseCliHelp: vi.fn(() => ({ cliChannels: new Set<string>(), channelFields: new Map() })),
      applyCliHelp: vi.fn(),
      mergeCatalog: vi.fn(),
      mergeChannelOptions: vi.fn(),
      getAllChannels: vi.fn(() => []),
      serializeRegistry: vi.fn(() => []),
      getChannel: vi.fn(() => ({
        id: 'telegram',
        openclawId: 'telegram',
        label: 'Telegram',
        color: '#26A5E4',
        iconType: 'svg',
        connectionType: 'token',
        saveStrategy: 'cli',
        configFields: [{ key: 'token' }],
        source: 'openclaw-dynamic',
        order: 1,
      })) as any,
      buildCLIFlags: vi.fn(() => '--token "abc"'),
      toOpenclawId: vi.fn((id: string) => id),
    });

    const handler = getRegisteredSaveHandler();
    const result = await handler({}, 'telegram', { token: 'abc' });

    expect(result).toMatchObject({ success: true });
    expect(runAsync).toHaveBeenCalledWith('openclaw plugins install "@openclaw/telegram@beta" 2>&1', 60000);
  });

  it('stores account-scoped json-direct channel credentials under accounts.default', async () => {
    let storedConfigText = JSON.stringify({ channels: { feishu: { token: 'legacy-token', enabled: true } } });
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((filePath: any, data: any) => {
      if (String(filePath).includes('.openclaw') && String(filePath).includes('openclaw.json')) {
        storedConfigText = String(data);
      }
      return undefined;
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any) => {
      if (String(filePath).includes('.openclaw') && String(filePath).includes('openclaw.json')) {
        return storedConfigText as any;
      }
      throw new Error(`unexpected readFileSync(${String(filePath)})`);
    });

    registerChannelConfigHandlers({
      home: 'C:/Users/test',
      safeShellExecAsync: vi.fn(async () => null),
      readShellOutputAsync: vi.fn(async () => null),
      runAsync: vi
        .fn()
        .mockResolvedValueOnce('plugin installed')
        .mockResolvedValueOnce('gateway restarted')
        .mockResolvedValueOnce('bound'),
      discoverOpenClawChannels: vi.fn(),
      parseCliHelp: vi.fn(() => ({ cliChannels: new Set<string>(), channelFields: new Map() })),
      applyCliHelp: vi.fn(),
      mergeCatalog: vi.fn(),
      mergeChannelOptions: vi.fn(),
      getAllChannels: vi.fn(() => []),
      serializeRegistry: vi.fn(() => []),
      getChannel: vi.fn(() => ({
        id: 'feishu',
        openclawId: 'feishu',
        label: 'Feishu',
        color: '#3370FF',
        iconType: 'svg',
        connectionType: 'multi-field',
        saveStrategy: 'json-direct',
        pluginPackage: '@openclaw/feishu',
        configFields: [
          { key: 'appId', label: 'appId', cliFlag: '--app-id', configPath: 'accounts.default' },
          { key: 'appSecret', label: 'appSecret', cliFlag: '--app-secret', type: 'password', configPath: 'accounts.default' },
        ],
        source: 'openclaw-dynamic',
        order: 8,
      })) as any,
      buildCLIFlags: vi.fn(() => ''),
      toOpenclawId: vi.fn((id: string) => id),
    });

    const handler = getRegisteredSaveHandler();
    const result = await handler({}, 'feishu', { appId: 'cli_abc', appSecret: 'secret_xyz' });

    expect(result).toMatchObject({ success: true });
    const latestWrite = writeSpy.mock.calls[writeSpy.mock.calls.length - 1];
    const writtenConfig = JSON.parse(String(latestWrite?.[1] || '{}'));
    expect(writtenConfig.channels.feishu.enabled).toBe(true);
    expect(writtenConfig.channels.feishu.token).toBeUndefined();
    expect(writtenConfig.channels.feishu.accounts.default.enabled).toBe(true);
    expect(writtenConfig.channels.feishu.accounts.default.appId).toBe('cli_abc');
    expect(writtenConfig.channels.feishu.accounts.default.appSecret).toBe('secret_xyz');
  });

  it('flattens account-scoped credentials when reading config back to the form', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any) => {
      if (String(filePath).includes('.openclaw') && String(filePath).includes('openclaw.json')) {
        return JSON.stringify({
          channels: {
            feishu: {
              enabled: true,
              accounts: {
                default: {
                  enabled: true,
                  appId: 'cli_abc',
                  appSecret: 'secret_xyz',
                },
              },
            },
          },
        }) as any;
      }
      throw new Error(`unexpected readFileSync(${String(filePath)})`);
    });

    registerChannelConfigHandlers({
      home: 'C:/Users/test',
      safeShellExecAsync: vi.fn(async () => null),
      readShellOutputAsync: vi.fn(async () => null),
      runAsync: vi.fn(async () => 'ok'),
      discoverOpenClawChannels: vi.fn(),
      parseCliHelp: vi.fn(() => ({ cliChannels: new Set<string>(), channelFields: new Map() })),
      applyCliHelp: vi.fn(),
      mergeCatalog: vi.fn(),
      mergeChannelOptions: vi.fn(),
      getAllChannels: vi.fn(() => []),
      serializeRegistry: vi.fn(() => []),
      getChannel: vi.fn(() => ({
        id: 'feishu',
        openclawId: 'feishu',
        label: 'Feishu',
        color: '#3370FF',
        iconType: 'svg',
        connectionType: 'multi-field',
        saveStrategy: 'json-direct',
        configFields: [
          { key: 'appId', label: 'appId', cliFlag: '--app-id', configPath: 'accounts.default' },
          { key: 'appSecret', label: 'appSecret', cliFlag: '--app-secret', type: 'password', configPath: 'accounts.default' },
        ],
        source: 'openclaw-dynamic',
        order: 8,
      })) as any,
      buildCLIFlags: vi.fn(() => ''),
      toOpenclawId: vi.fn((id: string) => id),
    });

    const handler = getRegisteredReadConfigHandler();
    const result = await handler({}, 'feishu');

    expect(result).toEqual({ success: true, config: { appId: 'cli_abc', appSecret: 'secret_xyz' } });
  });

  it('skips redundant Feishu bind when the main agent route already exists in openclaw.json', async () => {
    let storedConfigText = JSON.stringify({
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            default: {
              enabled: true,
              appId: 'cli_existing',
              appSecret: 'secret_existing',
            },
          },
        },
      },
      bindings: [
        {
          type: 'route',
          agentId: 'main',
          match: {
            channel: 'feishu',
          },
        },
      ],
    });

    vi.spyOn(fs, 'writeFileSync').mockImplementation((filePath: any, data: any) => {
      if (String(filePath).includes('.openclaw') && String(filePath).includes('openclaw.json')) {
        storedConfigText = String(data);
      }
      return undefined;
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any) => {
      if (String(filePath).includes('.openclaw') && String(filePath).includes('openclaw.json')) {
        return storedConfigText as any;
      }
      throw new Error(`unexpected readFileSync(${String(filePath)})`);
    });

    const runAsync = vi
      .fn()
      .mockResolvedValueOnce('plugin installed')
      .mockResolvedValueOnce('gateway restarted');

    registerChannelConfigHandlers({
      home: 'C:/Users/test',
      safeShellExecAsync: vi.fn(async () => null),
      readShellOutputAsync: vi.fn(async () => null),
      runAsync,
      discoverOpenClawChannels: vi.fn(),
      parseCliHelp: vi.fn(() => ({ cliChannels: new Set<string>(), channelFields: new Map() })),
      applyCliHelp: vi.fn(),
      mergeCatalog: vi.fn(),
      mergeChannelOptions: vi.fn(),
      getAllChannels: vi.fn(() => []),
      serializeRegistry: vi.fn(() => []),
      getChannel: vi.fn(() => ({
        id: 'feishu',
        openclawId: 'feishu',
        label: 'Feishu',
        color: '#3370FF',
        iconType: 'svg',
        connectionType: 'multi-field',
        saveStrategy: 'json-direct',
        pluginPackage: '@openclaw/feishu',
        configFields: [
          { key: 'appId', label: 'appId', cliFlag: '--app-id', configPath: 'accounts.default' },
          { key: 'appSecret', label: 'appSecret', cliFlag: '--app-secret', type: 'password', configPath: 'accounts.default' },
        ],
        source: 'openclaw-dynamic',
        order: 8,
      })) as any,
      buildCLIFlags: vi.fn(() => ''),
      toOpenclawId: vi.fn((id: string) => id),
    });

    const handler = getRegisteredSaveHandler();
    const result = await handler({}, 'feishu', { appId: 'cli_existing', appSecret: 'secret_existing' });

    expect(result).toMatchObject({ success: true });
    expect(runAsync).toHaveBeenCalledWith('openclaw plugins install "@openclaw/feishu" 2>&1', 60000);
    expect(runAsync).toHaveBeenCalledWith('openclaw gateway restart 2>&1', 30000);
    expect(runAsync).not.toHaveBeenCalledWith('openclaw agents bind --agent main --bind feishu 2>&1', 30000);
  });
});
