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
    expect(ensureGatewayRunning).not.toHaveBeenCalled();
    expect(runSpawnAsync).toHaveBeenCalledWith(
      'openclaw',
      ['agents', 'add', 'research-agent', '--non-interactive', '--workspace', path.join(home, '.openclaw', 'workspace-research-agent')],
      120000,
    );
  });

  it('falls back to openclaw.json creation when agents:add times out', async () => {
    const home = '/mock/home';
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    let configRaw = JSON.stringify({ agents: { list: [{ id: 'main' }] } });

    existsSyncMock.mockImplementation((target: string) => target === configPath);
    readFileSyncMock.mockImplementation((target: string) => {
      if (target === configPath) return configRaw;
      throw new Error(`Unexpected read: ${target}`);
    });
    writeFileSyncMock.mockImplementation((target: string, content: string) => {
      if (target === configPath) configRaw = String(content);
    });

    registerAgentHandlers({
      home,
      safeShellExecAsync: vi.fn().mockResolvedValue(null),
      readShellOutputAsync: vi.fn().mockResolvedValue(null),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      runAsync: vi.fn().mockResolvedValue(''),
      runSpawnAsync: vi.fn().mockRejectedValue(new Error('Command timed out')),
      runDoctorFix: vi.fn().mockResolvedValue({ success: true }),
    });

    const handlers = getHandlers();
    const result = await handlers['agents:add']({} as any, 'Research Agent');
    const finalConfig = JSON.parse(configRaw);

    expect(result).toMatchObject({ success: true, agentId: 'research-agent' });
    expect(finalConfig.agents.list.map((a: any) => a.id)).toEqual(['main', 'research-agent']);
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

  it('rejects invalid agent names before invoking openclaw', async () => {
    const home = '/mock/home';
    const runSpawnAsync = vi.fn().mockResolvedValue('ok');

    registerAgentHandlers({
      home,
      safeShellExecAsync: vi.fn().mockResolvedValue(null),
      readShellOutputAsync: vi.fn().mockResolvedValue(null),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      runAsync: vi.fn().mockResolvedValue(''),
      runSpawnAsync,
      runDoctorFix: vi.fn().mockResolvedValue({ success: true }),
    });

    const handlers = getHandlers();
    const onlyEmoji = await handlers['agents:add']({} as any, '🤖🤖');
    const onlyPunctuation = await handlers['agents:add']({} as any, '---___');
    const ocNumeric = await handlers['agents:add']({} as any, 'oc-1775820266907');
    const reservedMain = await handlers['agents:add']({} as any, 'main');

    expect(onlyEmoji.success).toBe(false);
    expect(onlyEmoji.error).toContain('Invalid agent name');
    expect(onlyPunctuation.success).toBe(false);
    expect(onlyPunctuation.error).toContain('Invalid agent name');
    expect(ocNumeric.success).toBe(false);
    expect(ocNumeric.error).toContain('Invalid agent name');
    expect(reservedMain.success).toBe(false);
    expect(reservedMain.error).toContain('Invalid agent name');
    expect(runSpawnAsync).not.toHaveBeenCalled();
  });

  it('rejects overly long agent names before invoking openclaw', async () => {
    const home = '/mock/home';
    const runSpawnAsync = vi.fn().mockResolvedValue('ok');

    registerAgentHandlers({
      home,
      safeShellExecAsync: vi.fn().mockResolvedValue(null),
      readShellOutputAsync: vi.fn().mockResolvedValue(null),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      runAsync: vi.fn().mockResolvedValue(''),
      runSpawnAsync,
      runDoctorFix: vi.fn().mockResolvedValue({ success: true }),
    });

    const handlers = getHandlers();
    const tooLongName = 'a'.repeat(65);
    const result = await handlers['agents:add']({} as any, tooLongName);

    expect(result.success).toBe(false);
    expect(result.error).toContain('maximum length is 64');
    expect(runSpawnAsync).not.toHaveBeenCalled();
  });

  it('cleans openclaw.json and redirects orphan bindings when CLI delete reports not found', async () => {
    const home = '/mock/home';
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    const deletedAgent = 'research-agent';
    let configRaw = JSON.stringify({
      agents: {
        list: [
          { id: 'main' },
          { id: deletedAgent },
        ],
      },
      bindings: [
        { type: 'route', agentId: deletedAgent, match: { channel: 'openclaw-weixin' } },
      ],
    });

    existsSyncMock.mockImplementation((target: string) => target.includes('/mock/home/.openclaw/'));
    readFileSyncMock.mockImplementation((target: string) => {
      if (target === configPath) return configRaw;
      throw new Error(`Unexpected read: ${target}`);
    });
    writeFileSyncMock.mockImplementation((target: string, content: string) => {
      if (target === configPath) {
        configRaw = String(content);
      }
    });

    registerAgentHandlers({
      home,
      safeShellExecAsync: vi.fn().mockResolvedValue(null),
      readShellOutputAsync: vi.fn().mockResolvedValue(null),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      runAsync: vi.fn().mockResolvedValue(''),
      runSpawnAsync: vi.fn().mockRejectedValue(new Error('agent not found')),
      runDoctorFix: vi.fn().mockResolvedValue({ success: true }),
    });

    const handlers = getHandlers();
    const result = await handlers['agents:delete']({} as any, deletedAgent);
    const finalConfig = JSON.parse(configRaw);

    expect(result).toMatchObject({ success: true, removedFromConfig: true, redirectedBindings: 1 });
    expect(finalConfig.agents.list.map((a: any) => a.id)).toEqual(['main']);
    expect(finalConfig.bindings[0].agentId).toBe('main');
  });

  it('rejects invalid display name in set-identity before invoking openclaw', async () => {
    const home = '/mock/home';
    const runSpawnAsync = vi.fn().mockResolvedValue('ok');

    registerAgentHandlers({
      home,
      safeShellExecAsync: vi.fn().mockResolvedValue(null),
      readShellOutputAsync: vi.fn().mockResolvedValue(null),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      runAsync: vi.fn().mockResolvedValue(''),
      runSpawnAsync,
      runDoctorFix: vi.fn().mockResolvedValue({ success: true }),
    });

    const handlers = getHandlers();
    const result = await handlers['agents:set-identity']({} as any, 'main', '🤖🤖', '', '', '');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid agent name');
    expect(runSpawnAsync).not.toHaveBeenCalled();
  });

  it('ignores non-emoji emoji input and still updates display name', async () => {
    const home = '/mock/home';
    const runSpawnAsync = vi.fn().mockResolvedValue('ok');

    registerAgentHandlers({
      home,
      safeShellExecAsync: vi.fn().mockResolvedValue(null),
      readShellOutputAsync: vi.fn().mockResolvedValue(null),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      runAsync: vi.fn().mockResolvedValue(''),
      runSpawnAsync,
      runDoctorFix: vi.fn().mockResolvedValue({ success: true }),
    });

    const handlers = getHandlers();
    const result = await handlers['agents:set-identity']({} as any, 'main', 'Optic', 'Opti', '', '');

    expect(result).toMatchObject({ success: true });
    expect(runSpawnAsync).toHaveBeenCalledWith(
      'openclaw',
      ['agents', 'set-identity', '--agent', 'main', '--name', 'Optic'],
      60000,
    );
  });

  it('falls back to openclaw.json identity update when set-identity times out', async () => {
    const home = '/mock/home';
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    let configRaw = JSON.stringify({
      agents: {
        list: [
          { id: 'main', identity: { name: 'Main Agent' } },
        ],
      },
    });

    existsSyncMock.mockImplementation((target: string) => target === configPath);
    readFileSyncMock.mockImplementation((target: string) => {
      if (target === configPath) return configRaw;
      throw new Error(`Unexpected read: ${target}`);
    });
    writeFileSyncMock.mockImplementation((target: string, content: string) => {
      if (target === configPath) configRaw = String(content);
    });

    registerAgentHandlers({
      home,
      safeShellExecAsync: vi.fn().mockResolvedValue(null),
      readShellOutputAsync: vi.fn().mockResolvedValue(null),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      runAsync: vi.fn().mockResolvedValue(''),
      runSpawnAsync: vi.fn().mockRejectedValue(new Error('Command timed out')),
      runDoctorFix: vi.fn().mockResolvedValue({ success: true }),
    });

    const handlers = getHandlers();
    const result = await handlers['agents:set-identity']({} as any, 'main', 'Optic', '🧠', '', '');
    const finalConfig = JSON.parse(configRaw);

    expect(result).toMatchObject({ success: true });
    expect(finalConfig.agents.list[0].identity.name).toBe('Optic');
    expect(finalConfig.agents.list[0].identity.emoji).toBe('🧠');
  });

  // agents:delete happy path — CLI 成功，清理 config 和目录
  it('agents:delete happy path removes agent from config', async () => {
    const home = '/mock/home';
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    let configRaw = JSON.stringify({
      agents: {
        list: [
          { id: 'main' },
          { id: 'research-agent' },
        ],
      },
    });

    existsSyncMock.mockImplementation((target: string) => {
      if (target === configPath) return true;
      // Workspace/agent directories don't exist (already cleaned by CLI)
      return false;
    });
    readFileSyncMock.mockImplementation((target: string) => {
      if (target === configPath) return configRaw;
      throw new Error(`Unexpected read: ${target}`);
    });
    writeFileSyncMock.mockImplementation((target: string, content: string) => {
      if (target === configPath) configRaw = String(content);
    });

    registerAgentHandlers({
      home,
      safeShellExecAsync: vi.fn().mockResolvedValue(null),
      readShellOutputAsync: vi.fn().mockResolvedValue(null),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      runAsync: vi.fn().mockResolvedValue(''),
      runSpawnAsync: vi.fn().mockResolvedValue('ok'),
      runDoctorFix: vi.fn().mockResolvedValue({ success: true }),
    });

    const handlers = getHandlers();
    const result = await handlers['agents:delete']({} as any, 'research-agent');
    const finalConfig = JSON.parse(configRaw);

    expect(result).toMatchObject({ success: true });
    expect(finalConfig.agents.list.map((a: any) => a.id)).toEqual(['main']);
  });

  // agents:add happy path — CLI 成功返回 agentId
  it('agents:add happy path creates agent via CLI', async () => {
    const home = '/mock/home';
    const configPath = path.join(home, '.openclaw', 'openclaw.json');

    existsSyncMock.mockImplementation((target: string) => target === configPath);
    readFileSyncMock.mockImplementation((target: string) => {
      if (target === configPath) return JSON.stringify({ agents: { list: [{ id: 'main' }] } });
      throw new Error(`Unexpected read: ${target}`);
    });

    const runSpawnAsync = vi.fn().mockResolvedValue('ok');

    registerAgentHandlers({
      home,
      safeShellExecAsync: vi.fn().mockResolvedValue(null),
      readShellOutputAsync: vi.fn().mockResolvedValue(null),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      runAsync: vi.fn().mockResolvedValue(''),
      runSpawnAsync,
      runDoctorFix: vi.fn().mockResolvedValue({ success: true }),
    });

    const handlers = getHandlers();
    const result = await handlers['agents:add']({} as any, 'My Research Bot');

    expect(result).toMatchObject({ success: true, agentId: 'my-research-bot' });
    expect(runSpawnAsync).toHaveBeenCalledWith(
      'openclaw',
      expect.arrayContaining(['agents', 'add', 'my-research-bot']),
      expect.any(Number),
    );
  });

  // agents:read-file — 读取存在的文件返回内容
  it('agents:read-file returns file content when file exists', async () => {
    const home = '/mock/home';
    const agentId = 'research';
    const workspaceDir = path.join(home, '.openclaw', `workspace-${agentId}`);
    const filePath = path.join(workspaceDir, 'SOUL.md');

    existsSyncMock.mockImplementation((target: string) => target === filePath || target === workspaceDir);
    readFileSyncMock.mockImplementation((target: string) => {
      if (target === filePath) return '# Soul\nYou are a research assistant.';
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
    const result = await handlers['agents:read-file']({} as any, agentId, 'SOUL.md');

    expect(result).toMatchObject({ success: true });
    expect(result.content).toContain('research assistant');
  });

  // agents:write-file — 写入文件并成功返回
  it('agents:write-file writes content to workspace directories', async () => {
    const home = '/mock/home';
    const agentId = 'research';

    existsSyncMock.mockReturnValue(false);

    registerAgentHandlers({
      home,
      safeShellExecAsync: vi.fn().mockResolvedValue(null),
      readShellOutputAsync: vi.fn().mockResolvedValue(null),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      runAsync: vi.fn().mockResolvedValue(''),
      runSpawnAsync: vi.fn().mockResolvedValue(''),
    });

    const handlers = getHandlers();
    const result = await handlers['agents:write-file']({} as any, agentId, 'SOUL.md', '# New Soul');

    expect(result).toMatchObject({ success: true });
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('SOUL.md'),
      '# New Soul',
      'utf-8',
    );
  });
});