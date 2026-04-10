import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';

const { ipcHandleMock, existsSyncMock, readFileSyncMock, writeFileSyncMock } = vi.hoisted(() => ({
  ipcHandleMock: vi.fn(),
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: ipcHandleMock,
  },
}));

vi.mock('fs', () => ({
  default: {
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
    writeFileSync: writeFileSyncMock,
    readdirSync: vi.fn().mockReturnValue([]),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
  readdirSync: vi.fn().mockReturnValue([]),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { registerAgentHandlers } from '../../electron/ipc/register-agent-handlers';

function getHandlers() {
  return Object.fromEntries(
    ipcHandleMock.mock.calls.map(([channel, handler]) => [channel, handler]),
  ) as Record<string, (...args: any[]) => Promise<any>>;
}

describe('register-agent-handlers', () => {
  beforeEach(() => {
    ipcHandleMock.mockReset();
    existsSyncMock.mockReset();
    readFileSyncMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  it('migrates legacy default emoji placeholders out of persisted IDENTITY.md files during agents:list', async () => {
    const home = '/mock/home';
    const agentId = 'oc-1';
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    const workspaceDir = path.join(home, '.openclaw', `workspace-${agentId}`);
    const workspaceIdentity = path.join(workspaceDir, 'IDENTITY.md');
    const agentIdentity = path.join(home, '.openclaw', 'agents', agentId, 'agent', 'IDENTITY.md');
    const legacyIdentity = '# Identity\n\n- **name**: Research\n- **emoji**: default\n- **role**: AI Assistant\n';

    existsSyncMock.mockImplementation((target: string) => (
      target === configPath
      || target === workspaceDir
      || target === workspaceIdentity
      || target === agentIdentity
    ));

    readFileSyncMock.mockImplementation((target: string) => {
      if (target === configPath) {
        return JSON.stringify({
          agents: {
            list: [
              {
                id: agentId,
                identity: {
                  name: 'Research',
                  emoji: 'default',
                },
              },
            ],
          },
        });
      }
      if (target === workspaceIdentity || target === agentIdentity) {
        return legacyIdentity;
      }
      throw new Error(`Unexpected read: ${target}`);
    });

    registerAgentHandlers({
      home,
      safeShellExecAsync: vi.fn().mockResolvedValue(null),
      readShellOutputAsync: vi.fn().mockResolvedValue(null),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      runAsync: vi.fn().mockResolvedValue(''),
      runSpawnAsync: vi.fn().mockResolvedValue(''),
    });

    const handlers = getHandlers();
    const result = await handlers['agents:list']({} as any);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toMatchObject({
      success: true,
      agents: [expect.objectContaining({ id: agentId, emoji: '' })],
    });
    expect(writeFileSyncMock).toHaveBeenCalledTimes(2);

    const writes = writeFileSyncMock.mock.calls.map(([target, content]) => ({
      target: String(target),
      content: String(content),
    }));
    expect(writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: workspaceIdentity }),
      expect.objectContaining({ target: agentIdentity }),
    ]));
    for (const write of writes) {
      expect(write.content).not.toContain('default');
      expect(write.content).toContain('- **emoji**:');
    }
  });

  it('does not parse Avatar line text as emoji when Emoji field is blank', async () => {
    const home = '/mock/home';
    const agentId = 'oc-emoji-blank';
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    const workspaceDir = path.join(home, '.openclaw', `workspace-${agentId}`);
    const workspaceIdentity = path.join(workspaceDir, 'IDENTITY.md');

    existsSyncMock.mockImplementation((target: string) => (
      target === configPath
      || target === workspaceDir
      || target === workspaceIdentity
    ));

    readFileSyncMock.mockImplementation((target: string) => {
      if (target === configPath) {
        return JSON.stringify({
          agents: {
            list: [
              {
                id: agentId,
              },
            ],
          },
        });
      }
      if (target === workspaceIdentity) {
        return [
          '# IDENTITY.md - Agent Identity',
          '',
          '- **Name:** Gavis',
          '- **Emoji:**',
          '- **Avatar:** avatars/gavis.png',
          '',
        ].join('\n');
      }
      throw new Error(`Unexpected read: ${target}`);
    });

    registerAgentHandlers({
      home,
      safeShellExecAsync: vi.fn().mockResolvedValue(null),
      readShellOutputAsync: vi.fn().mockResolvedValue(null),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      runAsync: vi.fn().mockResolvedValue(''),
      runSpawnAsync: vi.fn().mockResolvedValue(''),
    });

    const handlers = getHandlers();
    const result = await handlers['agents:list']({} as any);

    expect(result).toMatchObject({
      success: true,
      agents: [
        expect.objectContaining({
          id: agentId,
          name: 'Gavis',
          emoji: '',
        }),
      ],
    });
  });

  it('extracts the leading emoji token from rich emoji identity values', async () => {
    const home = '/mock/home';
    const agentId = 'oc-emoji-rich';
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    const workspaceDir = path.join(home, '.openclaw', `workspace-${agentId}`);
    const workspaceIdentity = path.join(workspaceDir, 'IDENTITY.md');

    existsSyncMock.mockImplementation((target: string) => (
      target === configPath
      || target === workspaceDir
      || target === workspaceIdentity
    ));

    readFileSyncMock.mockImplementation((target: string) => {
      if (target === configPath) {
        return JSON.stringify({
          agents: {
            list: [
              {
                id: agentId,
              },
            ],
          },
        });
      }
      if (target === workspaceIdentity) {
        return [
          '# IDENTITY.md - Agent Identity',
          '',
          '- **Name:** C-3PO',
          '- **Emoji:** 🤖 (or ⚠️ when alarmed)',
          '',
        ].join('\n');
      }
      throw new Error(`Unexpected read: ${target}`);
    });

    registerAgentHandlers({
      home,
      safeShellExecAsync: vi.fn().mockResolvedValue(null),
      readShellOutputAsync: vi.fn().mockResolvedValue(null),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      runAsync: vi.fn().mockResolvedValue(''),
      runSpawnAsync: vi.fn().mockResolvedValue(''),
    });

    const handlers = getHandlers();
    const result = await handlers['agents:list']({} as any);

    expect(result).toMatchObject({
      success: true,
      agents: [expect.objectContaining({ id: agentId, emoji: '🤖' })],
    });
  });

  it('runs Doctor plugin-installed fix before agent operations when awareness plugin is missing', async () => {
    const home = '/mock/home';
    const runDoctorFix = vi.fn().mockResolvedValue({ success: true });
    const ensureGatewayRunning = vi.fn(async () => ({ ok: true }));
    const runSpawnAsync = vi.fn().mockResolvedValue('ok');

    existsSyncMock.mockReturnValue(false);

    registerAgentHandlers({
      home,
      safeShellExecAsync: vi.fn().mockResolvedValue(null),
      readShellOutputAsync: vi.fn().mockResolvedValue(null),
      ensureGatewayRunning,
      runAsync: vi.fn().mockResolvedValue(''),
      runSpawnAsync,
      runDoctorFix,
    });

    const handlers = getHandlers();
    const result = await handlers['agents:add']({} as any, 'Research Agent');

    expect(result).toMatchObject({ success: true });
    expect(runDoctorFix).toHaveBeenCalledTimes(1);
    expect(runDoctorFix).toHaveBeenCalledWith('plugin-installed');
    expect(ensureGatewayRunning).toHaveBeenCalledTimes(1);
    expect(runSpawnAsync).toHaveBeenCalledWith(
      'openclaw',
      ['agents', 'add', 'research-agent', '--non-interactive', '--workspace', path.join(home, '.openclaw', 'workspace-research-agent')],
      45000,
    );
  });

  it('deduplicates awareness plugin auto-heal across concurrent agent operations', async () => {
    const home = '/mock/home';
    const runSpawnAsync = vi.fn().mockResolvedValue('ok');
    let resolveFix: ((value: { success: boolean }) => void) | null = null;
    const runDoctorFix = vi.fn(() => new Promise<{ success: boolean }>((resolve) => {
      resolveFix = resolve;
    }));

    existsSyncMock.mockReturnValue(false);

    registerAgentHandlers({
      home,
      safeShellExecAsync: vi.fn().mockResolvedValue(null),
      readShellOutputAsync: vi.fn().mockResolvedValue(null),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      runAsync: vi.fn().mockResolvedValue(''),
      runSpawnAsync,
      runDoctorFix,
    });

    const handlers = getHandlers();
    const addPromise = handlers['agents:add']({} as any, 'Concurrent Agent');
    const setIdentityPromise = handlers['agents:set-identity']({} as any, 'concurrent-agent', 'Concurrent Agent', '🧪');

    expect(runDoctorFix).toHaveBeenCalledTimes(1);
    resolveFix?.({ success: true });

    const [addResult, setIdentityResult] = await Promise.all([addPromise, setIdentityPromise]);

    expect(addResult).toMatchObject({ success: true });
    expect(setIdentityResult).toMatchObject({ success: true });
    expect(runDoctorFix).toHaveBeenCalledTimes(1);
    expect(runSpawnAsync).toHaveBeenCalledTimes(2);
  });
});