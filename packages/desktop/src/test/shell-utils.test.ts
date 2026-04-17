import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  execSyncMock,
  existsSyncMock,
  readdirSyncMock,
  readFileSyncMock,
  realpathSyncMock,
  spawnMock,
} = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  readdirSyncMock: vi.fn().mockReturnValue([]),
  readFileSyncMock: vi.fn(),
  realpathSyncMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  default: {
    execSync: execSyncMock,
    spawn: spawnMock,
  },
  execSync: execSyncMock,
  spawn: spawnMock,
}));

vi.mock('fs', () => ({
  default: {
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
    readdirSync: readdirSyncMock,
    realpathSync: realpathSyncMock,
  },
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  readdirSync: readdirSyncMock,
  realpathSync: realpathSyncMock,
}));

import { createShellUtils } from '../../electron/shell-utils';

function createBufferedChild(stdoutText = '', stderrText = '') {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };

  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  queueMicrotask(() => {
    if (stdoutText) child.stdout.emit('data', Buffer.from(stdoutText));
    if (stderrText) child.stderr.emit('data', Buffer.from(stderrText));
    child.emit('close', 0);
  });

  return child;
}

describe('createShellUtils', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    existsSyncMock.mockReset();
    readdirSyncMock.mockReset();
    readdirSyncMock.mockReturnValue([]);
    readFileSyncMock.mockReset();
    realpathSyncMock.mockReset();
    spawnMock.mockReset();
    execSyncMock.mockReturnValue('');
    readFileSyncMock.mockReturnValue('{}');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses direct spawn for simple openclaw commands', async () => {
    existsSyncMock.mockImplementation((target: string) => (
      /openclaw[\\/]package\.json$/i.test(target)
      || /openclaw[\\/]openclaw\.mjs$/i.test(target)
      || /node(\.exe)?$/i.test(target)
    ));

    spawnMock.mockImplementation((cmd: string) => {
      if (/[\\/]?node(\.exe)?$/i.test(cmd)) {
        return createBufferedChild('OpenClaw 2026.4.14');
      }
      return createBufferedChild('unexpected');
    });

    const utils = createShellUtils({
      home: 'C:/Users/tester',
      app: {
        getPath: () => 'C:/Program Files/AwarenessClaw/AwarenessClaw.exe',
        getAppPath: () => 'E:/AwarenessClaw/packages/desktop',
      },
    });

    const output = await utils.readShellOutputAsync('openclaw gateway status 2>&1', 2000);

    expect(output).toContain('OpenClaw 2026.4.14');
    expect(spawnMock).toHaveBeenCalled();
    const [command, args, opts] = spawnMock.mock.calls[0];
    if (process.platform === 'win32') {
      expect(String(command)).toMatch(/[\\/]?node(\.exe)?$/i);
      expect(args).toEqual(expect.arrayContaining(['gateway', 'status']));
      expect(opts?.shell).toBeUndefined();
      return;
    }
    expect(command).toBe('openclaw');
    expect(args).toEqual(['gateway', 'status']);
    expect(opts?.shell).toBeUndefined();
  });

  it('keeps shell execution for complex openclaw commands with operators', async () => {
    spawnMock.mockImplementation((cmd: string, _args: string[], opts?: Record<string, unknown>) => {
      if (opts?.shell === 'cmd.exe' || cmd === '/bin/bash') {
        return createBufferedChild('from-shell');
      }
      return createBufferedChild('unexpected-direct');
    });

    const utils = createShellUtils({
      home: 'C:/Users/tester',
      app: {
        getPath: () => 'C:/Program Files/AwarenessClaw/AwarenessClaw.exe',
        getAppPath: () => 'E:/AwarenessClaw/packages/desktop',
      },
    });

    const output = await utils.readShellOutputAsync('openclaw gateway status | findstr Running', 2000);

    expect(output).toContain('from-shell');
    const [command, _args, opts] = spawnMock.mock.calls[0];
    if (process.platform === 'win32') {
      expect(opts?.shell).toBe('cmd.exe');
      return;
    }
    expect(command).toBe('/bin/bash');
  });
});