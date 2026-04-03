import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    expect(runAsync).toHaveBeenCalledWith('openclaw pairing approve telegram C4AVKKA9 2>&1', 30000);
    expect(runAsync).toHaveBeenCalledWith('openclaw gateway restart 2>&1', 30000);
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
});
