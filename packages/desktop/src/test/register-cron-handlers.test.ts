import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ipcHandleMock } = vi.hoisted(() => ({
  ipcHandleMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: ipcHandleMock,
  },
}));

import { registerCronHandlers } from '../../electron/ipc/register-cron-handlers';

function getRegisteredHandlers() {
  return Object.fromEntries(
    ipcHandleMock.mock.calls.map(([channel, handler]) => [channel, handler]),
  ) as Record<string, (...args: any[]) => Promise<any>>;
}

describe('registerCronHandlers', () => {
  beforeEach(() => {
    ipcHandleMock.mockReset();
  });

  it('passes no-deliver for session-bound agent turns so the CLI does not default back to announce', async () => {
    const runSpawnAsync = vi.fn().mockResolvedValue('{"id":"job-1"}');

    registerCronHandlers({
      readShellOutputAsync: vi.fn(),
      runSpawnAsync,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['cron:add']({}, {
      cron: '0 9 * * *',
      message: 'Check todos',
      sessionTarget: 'session:session-existing',
      timeoutSeconds: 120,
      announce: false,
    });

    expect(result).toMatchObject({ success: true });
    expect(runSpawnAsync).toHaveBeenCalledWith(
      'openclaw',
      expect.arrayContaining([
        'cron',
        'add',
        '--session',
        'session:session-existing',
        '--message',
        'Check todos',
        '--no-deliver',
      ]),
      45000,
    );
    expect(runSpawnAsync.mock.calls[0][1]).not.toContain('--announce');
  });

  it('keeps announce for isolated agent turns when requested', async () => {
    const runSpawnAsync = vi.fn().mockResolvedValue('{"id":"job-2"}');

    registerCronHandlers({
      readShellOutputAsync: vi.fn(),
      runSpawnAsync,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['cron:add']({}, {
      cron: '0 9 * * *',
      message: 'Check todos',
      sessionTarget: 'isolated',
      timeoutSeconds: 120,
      announce: true,
    });

    expect(result).toMatchObject({ success: true });
    expect(runSpawnAsync).toHaveBeenCalledWith(
      'openclaw',
      expect.arrayContaining([
        'cron',
        'add',
        '--session',
        'isolated',
        '--message',
        'Check todos',
        '--announce',
      ]),
      45000,
    );
    expect(runSpawnAsync.mock.calls[0][1]).not.toContain('--no-deliver');
  });
});