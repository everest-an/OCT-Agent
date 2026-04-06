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
    const workspaceDir = path.join(home, '.openclaw', `workspace-${agentId}`);
    const workspaceIdentity = path.join(workspaceDir, 'IDENTITY.md');
    const agentIdentity = path.join(home, '.openclaw', 'agents', agentId, 'agent', 'IDENTITY.md');
    const legacyIdentity = '# Identity\n\n- **name**: Research\n- **emoji**: default\n- **role**: AI Assistant\n';

    existsSyncMock.mockImplementation((target: string) => (
      target === workspaceDir
      || target === workspaceIdentity
      || target === agentIdentity
    ));

    readFileSyncMock.mockImplementation((target: string) => {
      if (target === workspaceIdentity || target === agentIdentity) {
        return legacyIdentity;
      }
      throw new Error(`Unexpected read: ${target}`);
    });

    registerAgentHandlers({
      home,
      safeShellExecAsync: vi.fn().mockResolvedValue(null),
      readShellOutputAsync: vi.fn().mockResolvedValue(JSON.stringify([
        { id: agentId, identityName: 'Research', identityEmoji: 'default', isDefault: false, bindings: 0 },
      ])),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      runAsync: vi.fn().mockResolvedValue(''),
      runSpawnAsync: vi.fn().mockResolvedValue(''),
    });

    const handlers = getHandlers();
    const result = await handlers['agents:list']({} as any);

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
});