import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatState } from '../../electron/ipc/chat-types';

const { ipcHandleMock } = vi.hoisted(() => ({
  ipcHandleMock: vi.fn(),
}));

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: {
    handle: ipcHandleMock,
  },
}));

import { registerChatHandlers } from '../../electron/ipc/register-chat-handlers';

class FakeGatewayClient extends EventEmitter {
  isConnected = true;
  sessionPatch = vi.fn(async () => ({ ok: true }));
  chatSend = vi.fn(async () => ({ status: 'started' }));
  chatAbort = vi.fn(async () => undefined);
  chatHistory: ReturnType<typeof vi.fn> = vi.fn(async () => [] as any[]);
}

function getRegisteredHandlers() {
  return Object.fromEntries(
    ipcHandleMock.mock.calls.map(([channel, handler]) => [channel, handler]),
  ) as Record<string, (...args: any[]) => Promise<any>>;
}

function createCliFallbackChild(output: string) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    emitOutput: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  child.emitOutput = () => {
    child.stdout.emit('data', Buffer.from(`${output}\n`));
    child.emit('exit', 0);
  };

  return child;
}

function createCliFallbackErrorChild(stderrLines: string[], exitCode = 1) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    emitOutput: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  child.emitOutput = () => {
    for (const line of stderrLines) {
      child.stderr.emit('data', Buffer.from(`${line}\n`));
    }
    child.emit('exit', exitCode);
  };

  return child;
}

function createAwarenessInitResponse(renderedContext = 'Memory context loaded') {
  return {
    result: {
      content: [{
        text: JSON.stringify({ rendered_context: renderedContext }),
      }],
    },
  };
}

describe('registerChatHandlers', () => {
  beforeEach(() => {
    ipcHandleMock.mockReset();
    spawnMock.mockReset();
    // Reset shared module state between tests
    chatState.activeChatChild = null;
    chatState.awarenessInitCompatibilityMode = false;
    chatState.lastAwarenessInitCompatibilityError = '';
  });

  it('falls back to CLI when gateway preflight fails before websocket connect', async () => {
    const fakeChild = createCliFallbackChild('CLI fallback reply');
    spawnMock.mockReturnValue(fakeChild as any);

    const sendToRenderer = vi.fn();

    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: false, error: 'Gateway failed to start.' })),
      getGatewayWs: vi.fn(),
      getConnectedGatewayWs: vi.fn(() => null),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const pending = handlers['chat:send']({}, 'hello from cli fallback', 'test-session', {});
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    fakeChild.emitOutput();
    const result = await pending;

    expect(result).toMatchObject({ success: true, text: 'CLI fallback reply', sessionId: 'test-session' });
    expect(sendToRenderer).toHaveBeenCalledWith(
      'chat:status',
      expect.objectContaining({
        type: 'gateway',
        message: 'Gateway failed to start.',
      }),
    );
    expect(spawnMock).toHaveBeenCalled();
  });

  it('auto-repairs auth-gated gateway preflight and avoids CLI fallback when reconnect succeeds', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: { role: 'assistant', content: 'gateway recovered reply' },
        });
      }, 0);
      return { status: 'started' };
    });

    const sendToRenderer = vi.fn();
    const getGatewayWs = vi.fn(async () => ws as any);

    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: false, error: 'Local Gateway requires one-time device authorization before desktop chat can use Gateway mode.' })),
      prepareGatewayForChat: vi.fn(async () => ({ ok: false, error: 'Local Gateway requires one-time device authorization before desktop chat can use Gateway mode.' })),
      getGatewayWs,
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', {});

    expect(result).toMatchObject({ success: true, text: 'gateway recovered reply', sessionId: 'test-session' });
    expect(getGatewayWs).toHaveBeenCalled();
    const firstGatewayWsCall = getGatewayWs.mock.calls[0] as unknown[] | undefined;
    expect(firstGatewayWsCall?.[0]).toMatchObject({
      onPairingRepairStart: expect.any(Function),
      onPairingRepair: expect.any(Function),
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(sendToRenderer).toHaveBeenCalledWith(
      'chat:status',
      expect.objectContaining({ message: 'Gateway recovered. Sending this message through fast mode.' }),
    );
  });

  it('patches session model before chatSend so the current session can switch models', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: { role: 'assistant', content: 'switched model in-session' },
        });
      }, 0);
      return { status: 'started' };
    });

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'continue in same session', 'test-session', {
      model: 'openai/gpt-4o',
    });

    expect(result).toMatchObject({ success: true, text: 'switched model in-session', sessionId: 'test-session' });
    expect(ws.sessionPatch).toHaveBeenCalledWith('test-session', { model: 'openai/gpt-4o' });
    expect(ws.chatSend).toHaveBeenCalledWith(
      'test-session',
      expect.any(String),
      expect.not.objectContaining({ model: expect.anything() }),
    );
  });

  it('filters Node internal stack lines and returns a friendly runtime repair hint for npx ENOENT', async () => {
    const fakeChild = createCliFallbackErrorChild([
      '[openclaw] Uncaught exception: Error: spawn npx ENOENT',
      'at ChildProcess._handle.onexit (node:internal/child_process:286:19)',
      'at onErrorNT (node:internal/child_process:484:16)',
      'at process.processTicksAndRejections (node:internal/process/task_queues:89:21)',
    ], 1);
    spawnMock.mockReturnValue(fakeChild as any);

    const sendToRenderer = vi.fn();

    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: false, error: 'Gateway failed to start.' })),
      getGatewayWs: vi.fn(),
      getConnectedGatewayWs: vi.fn(() => null),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const pending = handlers['chat:send']({}, 'hello from cli fallback', 'test-session', {});
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    fakeChild.emitOutput();
    const result = await pending;

    expect(result).toMatchObject({
      success: false,
      sessionId: 'test-session',
    });
    expect(String(result.error || '')).toContain('Please rerun Setup to repair your runtime');

    const streamedText = sendToRenderer.mock.calls
      .filter(([channel]) => channel === 'chat:stream')
      .map(([, payload]) => String(payload || ''))
      .join('\n');

    expect(streamedText).not.toContain('ChildProcess._handle.onexit');
    expect(streamedText).not.toContain('processTicksAndRejections');
  });

  it('silently repairs local runtime and retries once when CLI fallback hits spawn npx ENOENT', async () => {
    const first = createCliFallbackErrorChild([
      '[openclaw] Uncaught exception: Error: spawn npx ENOENT',
      'at ChildProcess._handle.onexit (node:internal/child_process:286:19)',
    ], 1);
    const second = createCliFallbackChild('CLI retry after repair reply');
    spawnMock
      .mockReturnValueOnce(first as any)
      .mockReturnValueOnce(second as any);

    const sendToRenderer = vi.fn();
    const prepareCliFallback = vi.fn(async () => undefined);

    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: false, error: 'Gateway failed to start.' })),
      prepareCliFallback,
      getGatewayWs: vi.fn(),
      getConnectedGatewayWs: vi.fn(() => null),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const pending = handlers['chat:send']({}, 'hello from cli fallback', 'test-session', {});

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    first.emitOutput();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    second.emitOutput();

    const result = await pending;

    expect(prepareCliFallback).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      success: true,
      text: 'CLI retry after repair reply',
      sessionId: 'test-session',
    });
    expect(sendToRenderer).toHaveBeenCalledWith(
      'chat:status',
      expect.objectContaining({ message: 'Local memory service is recovering. Retrying automatically...' }),
    );
  });

  it('preserves workspace instructions when CLI fallback is used', async () => {
    const fakeChild = createCliFallbackChild('CLI workspace reply');
    spawnMock.mockReturnValue(fakeChild as any);

    const wrapWindowsCommand = vi.fn((command: string) => command);
    const workspaceDir = process.cwd();

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: false, error: 'Gateway warming up.' })),
      getGatewayWs: vi.fn(),
      getConnectedGatewayWs: vi.fn(() => null),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand,
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
  const pending = handlers['chat:send']({}, 'check project files', 'test-session', { workspacePath: workspaceDir });
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
  fakeChild.emitOutput();
  const result = await pending;
    const escapedWorkspaceDir = workspaceDir.replace(/\\/g, '\\\\');

    expect(result).toMatchObject({ success: true, text: 'CLI workspace reply', sessionId: 'test-session' });

    // On macOS/Linux the command goes through /bin/bash -c, not wrapWindowsCommand.
    // The workspace instructions are embedded in the -m message arg (escaped), inside the -c string.
    if (process.platform === 'win32') {
      expect(wrapWindowsCommand).toHaveBeenCalledWith(expect.stringContaining(`[Project working directory: ${escapedWorkspaceDir}]`));
      expect(wrapWindowsCommand).toHaveBeenCalledWith(expect.stringContaining('Do not treat this folder as the agent\'s home workspace'));
    } else {
      // spawnChatProcess('/bin/bash', ['--norc', '--noprofile', '-c', 'export PATH=...; openclaw ...'], { cwd })
      const spawnCall = spawnMock.mock.calls[0];
      const allArgs = JSON.stringify(spawnCall);
      expect(allArgs).toContain('[Project working directory:');
      expect(allArgs).toContain('Do not treat this folder as the agent');
    }
  });

  it('falls back to CLI when Gateway finishes with no assistant payload', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
        });
      }, 0);
      return { status: 'started' };
    });

    const cliFallbackChild = createCliFallbackChild('CLI recovered reply');
    spawnMock.mockReturnValue(cliFallbackChild as any);

    const sendToRenderer = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const pending = handlers['chat:send']({}, 'hello', 'test-session', {});
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    cliFallbackChild.emitOutput();
    const result = await pending;

    expect(result).toMatchObject({ success: true, text: 'CLI recovered reply', sessionId: 'test-session' });
    expect(sendToRenderer).toHaveBeenCalledWith(
      'chat:status',
      expect.objectContaining({
        type: 'gateway',
        message: 'Gateway returned an empty reply. Retrying through local CLI fallback...',
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('OpenClaw/Gateway completed the run with an empty assistant response'),
      expect.objectContaining({
        sessionId: 'test-session',
        sawFinalState: true,
        sawAssistantDelta: false,
      }),
    );

    warnSpy.mockRestore();
  });

  it('returns CLI fallback error when Gateway finishes empty and CLI recovery fails', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    const cliFallbackChild = createCliFallbackErrorChild(['CLI fallback failed after empty gateway reply'], 1);
    spawnMock.mockReturnValue(cliFallbackChild as any);

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const pending = handlers['chat:send']({}, 'hello', 'test-session', {});
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    cliFallbackChild.emitOutput();
    const result = await pending;

    expect(result).toMatchObject({
      success: false,
      sessionId: 'test-session',
    });
    expect(String(result.error || '')).toContain('CLI fallback failed after empty gateway reply');
  });

  it('uses assistant text from the final event when no delta text was streamed', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: 'final-only text',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    const sendToRenderer = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', {});

    expect(result).toMatchObject({ success: true, text: 'final-only text', sessionId: 'test-session' });
    expect(sendToRenderer).toHaveBeenCalledWith('chat:stream-end', {});
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Desktop received assistant text only in the final event and would misclassify it as No response'),
      expect.anything(),
    );

    warnSpy.mockRestore();
  });

  it('skips awareness_record when autoCapture is disabled', async () => {
    const ws = new FakeGatewayClient();
    const callMcpStrict = vi.fn(async () => ({}));

    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: 'normal answer',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict,
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
      readMemoryCapturePolicy: () => ({ autoCapture: false, blockedSources: [] }),
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', {});

    expect(result).toMatchObject({ success: true, text: 'normal answer', sessionId: 'test-session' });
    expect(callMcpStrict).not.toHaveBeenCalled();
  });

  it('skips awareness_record when desktop source is blocked', async () => {
    const ws = new FakeGatewayClient();
    const callMcpStrict = vi.fn(async () => ({}));

    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: 'normal answer',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict,
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
      readMemoryCapturePolicy: () => ({ autoCapture: true, blockedSources: ['desktop'] }),
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', {});

    expect(result).toMatchObject({ success: true, text: 'normal answer', sessionId: 'test-session' });
    expect(callMcpStrict).not.toHaveBeenCalled();
  });

  it('records memory when autoCapture is enabled and desktop source is allowed', async () => {
    const ws = new FakeGatewayClient();
    const callMcpStrict = vi.fn(async () => ({ result: { content: [{ text: '{}' }] } }));

    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: 'normal answer',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict,
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
      readMemoryCapturePolicy: () => ({ autoCapture: true, blockedSources: [] }),
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', {});

    expect(result).toMatchObject({ success: true, text: 'normal answer', sessionId: 'test-session' });
    expect(callMcpStrict).toHaveBeenCalledWith('awareness_record', expect.objectContaining({
      action: 'remember',
      event_type: 'turn_brief',
      source: 'desktop',
    }));
  });

  it('flags unverified local file-write success claims when gateway returns text without completed tools', async () => {
    const ws = new FakeGatewayClient();
    const callMcpStrict = vi.fn(async (toolName: string) => (
      toolName === 'awareness_init' ? createAwarenessInitResponse('Desktop memory snapshot') : {}
    ));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: 'I saved the file to E:\\新建文件夹2\\我是谁.txt',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict,
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, '在 E:\\新建文件夹2 里写一个 txt 文件', 'test-session', {});

    expect(result).toMatchObject({
      success: true,
      text: 'I saved the file to E:\\新建文件夹2\\我是谁.txt',
      sessionId: 'test-session',
      unverifiedLocalFileOperation: true,
    });
    expect(callMcpStrict).toHaveBeenCalledWith(
      'awareness_init',
      expect.objectContaining({ query: '在 E:\\新建文件夹2 里写一个 txt 文件' }),
      expect.any(Number),
    );
    expect(ws.chatSend).toHaveBeenCalledWith(
      'test-session',
      expect.stringContaining('Desktop already loaded the current Awareness memory context for this turn.'),
      expect.any(Object),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Assistant claimed a local filesystem mutation succeeded without any completed tool result'),
      expect.objectContaining({ sessionId: 'test-session' }),
    );

    warnSpy.mockRestore();
  });

  it('flags unverified local file-write claims when only non-filesystem tools completed', async () => {
    const ws = new FakeGatewayClient();

    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'awareness_lookup',
                input: { query: 'workspace memory' },
              },
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: [{ type: 'text', text: 'memory recall done' }],
              },
              {
                type: 'text',
                text: '我已在 E:\\新建文件夹2\\test-writing.txt 写入内容。',
              },
            ],
          },
        });
      }, 0);
      return { status: 'started' };
    });

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => createAwarenessInitResponse('Memory snapshot')),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, '在 E:\\新建文件夹2 里写一个 txt 文件', 'test-session', {});

    expect(result).toMatchObject({
      success: true,
      sessionId: 'test-session',
      unverifiedLocalFileOperation: true,
    });
  });

  it('does not flag unverified local file-write when a filesystem tool result completed', async () => {
    const ws = new FakeGatewayClient();

    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'exec',
                input: { command: "Set-Content -LiteralPath 'E:\\新建文件夹2\\test-writing.txt' -Value 'ok'" },
              },
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: [{ type: 'text', text: 'command finished' }],
              },
              {
                type: 'text',
                text: '我已在 E:\\新建文件夹2\\test-writing.txt 写入内容。',
              },
            ],
          },
        });
      }, 0);
      return { status: 'started' };
    });

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => createAwarenessInitResponse('Memory snapshot')),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, '在 E:\\新建文件夹2 里写一个 txt 文件', 'test-session', {});

    expect(result).toMatchObject({
      success: true,
      sessionId: 'test-session',
      text: '我已在 E:\\新建文件夹2\\test-writing.txt 写入内容。',
    });
    expect(result.unverifiedLocalFileOperation).toBeUndefined();
  });

  it('silently retries with CLI compatibility fallback when gateway reports special-use IP web blocking', async () => {
    const ws = new FakeGatewayClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fallbackChild = createCliFallbackChild('Fetched via exec fallback successfully');
    const runSpawn = vi.fn(() => {
      setTimeout(() => fallbackChild.emitOutput(), 0);
      return fallbackChild as any;
    });

    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: 'The web_fetch tool is unavailable or denied because the URL resolves to a private/internal/special-use IP address.',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async (toolName: string) => (
        toolName === 'awareness_init' ? createAwarenessInitResponse('Web memory snapshot') : {}
      )),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      runSpawn,
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, '请抓取 https://example.com 的标题', 'test-session', {});

    expect(result).toMatchObject({
      success: true,
      text: 'Fetched via exec fallback successfully',
      sessionId: 'test-session',
      preferResultText: true,
    });
    expect(ws.chatSend).toHaveBeenCalledWith(
      'test-session',
      expect.stringContaining('Treat the block below as the result of awareness_init'),
      expect.any(Object),
    );
    expect(runSpawn).toHaveBeenCalledTimes(1);
    const [, retryArgs] = runSpawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    const retryMessage = retryArgs[retryArgs.indexOf('-m') + 1] || '';
    expect(retryMessage).toContain('On Windows, prefer Invoke-WebRequest with -UseBasicParsing.');
    expect(retryMessage).toContain('Target public URL: https://example.com');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Web tool response indicates VPN/DNS special-use IP compatibility issue'),
      expect.objectContaining({ sessionId: 'test-session' }),
    );

    warnSpy.mockRestore();
  });

  it('retries through CLI compatibility mode when awareness_init fails inside a gateway tool result', async () => {
    const ws = new FakeGatewayClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fallbackChild = createCliFallbackChild('Recovered without awareness_init');
    const runSpawn = vi.fn(() => {
      setTimeout(() => fallbackChild.emitOutput(), 0);
      return fallbackChild as any;
    });

    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool-awareness', name: 'awareness_init', input: {} },
              {
                type: 'tool_result',
                tool_use_id: 'tool-awareness',
                is_error: true,
                content: [{ type: 'text', text: 'schema must be object or boolean' }],
              },
              { type: 'text', text: 'BROWSER_UNAVAILABLE' },
            ],
          },
        });
      }, 0);
      return { status: 'started' };
    });

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async (toolName: string) => (
        toolName === 'awareness_init' ? createAwarenessInitResponse('Recovered memory snapshot') : {}
      )),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      runSpawn,
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, '请浏览 https://example.com 并告诉我标题', 'test-session', {});

    expect(result).toMatchObject({
      success: true,
      text: 'Recovered without awareness_init',
      sessionId: 'test-session',
      preferResultText: true,
    });
    expect(runSpawn).toHaveBeenCalledTimes(1);
    const [, retryArgs] = runSpawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    const retryMessage = retryArgs[retryArgs.indexOf('-m') + 1] || '';
    expect(retryMessage).toContain('Do not call awareness_init on this retry.');
    expect(retryMessage).toContain('[Original runtime message]');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Awareness memory bootstrap compatibility issue detected; retrying without awareness_init'),
      expect.objectContaining({ sessionId: 'test-session' }),
    );

    warnSpy.mockRestore();
  });

  it('routes non-main agents via session key format agent:<id>:webchat:<sid>', async () => {
    // chat:send pre-validates agentId against ~/.openclaw/openclaw.json (added to prevent
    // stale-id ghost agents from triggering Gateway's silent embedded fallback). Stub the
    // config read so this test's synthetic 'researcher' agent passes validation.
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const realReadFileSync = fs.readFileSync;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (typeof p === 'string' && p === configPath) {
        return JSON.stringify({ agents: { list: [{ id: 'main' }, { id: 'researcher' }] } });
      }
      return (realReadFileSync as any)(p, ...rest);
    }) as any);

    const ws = new FakeGatewayClient();
    // The session key for non-main agents is agent:<agentId>:webchat:<rawSid>
    const expectedSid = 'agent:researcher:webchat:test-session';
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: expectedSid,
          state: 'final',
          message: {
            role: 'assistant',
            content: 'agent specific reply',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', { agentId: 'researcher' });

    expect(result).toMatchObject({ success: true, text: 'agent specific reply', sessionId: expectedSid });
    // agentId is NOT passed as a param — routing is via the session key format
    expect(ws.chatSend).toHaveBeenCalledWith(
      expectedSid,
      expect.stringContaining('hello'),
      expect.objectContaining({ verbose: 'full' }),
    );
    // Verify agentId is NOT in chat.send params (Gateway rejects additionalProperties)
    const callArgs = (ws.chatSend as any).mock.calls[0][2];
    expect(callArgs).not.toHaveProperty('agentId');

    readSpy.mockRestore();
  });

  it('downgrades stale agentId to main and emits chat:agent-invalidated when not in openclaw.json', async () => {
    // Reproduces the "ghost agent id" failure pattern: frontend persists a selectedAgentId
    // that no longer exists in OpenClaw config (deleted agent, failed-creation orphan, or
    // pre-upgrade ghost). Without pre-validation, this id reaches Gateway, OpenClaw silently
    // falls back to embedded, the run completes empty, and the user sees "No response".
    // After the fix, chat:send must downgrade to 'main' before any Gateway/CLI call.
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const realReadFileSync = fs.readFileSync;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (typeof p === 'string' && p === configPath) {
        return JSON.stringify({ agents: { list: [{ id: 'main' }] } });
      }
      return (realReadFileSync as any)(p, ...rest);
    }) as any);

    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        // Gateway must be addressed by the resolved (main) session key, not the ghost one.
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: { role: 'assistant', content: 'reply from main' },
        });
      }, 0);
      return { status: 'started' };
    });

    const sendToRenderer = vi.fn();
    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', { agentId: 'oc-1775488657793' });

    // Result must succeed via main, not return "No response"
    expect(result).toMatchObject({ success: true, text: 'reply from main' });
    // Session key must NOT be agent:oc-1775488657793:webchat:* — it should be the plain main sid
    expect(ws.chatSend).toHaveBeenCalledWith('test-session', expect.any(String), expect.any(Object));
    // Renderer must receive an explicit invalidation event so the store can self-heal
    const invalidatedCall = sendToRenderer.mock.calls.find((c) => c[0] === 'chat:agent-invalidated');
    expect(invalidatedCall).toBeTruthy();
    expect(invalidatedCall![1]).toMatchObject({
      requestedAgentId: 'oc-1775488657793',
      resolvedAgentId: 'main',
      reason: 'agent-not-in-config',
    });

    readSpy.mockRestore();
  });

  it('requests verbose full so gateway tool events include real output details', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: 'done',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', {});

    expect(result).toMatchObject({ success: true, text: 'done', sessionId: 'test-session' });
    expect(ws.chatSend).toHaveBeenCalledWith(
      'test-session',
      expect.stringContaining('hello'),
      expect.objectContaining({ verbose: 'full' }),
    );
  });

  it('treats the selected project folder as an operation root without switching agent workspace', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: 'workspace switched',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    const workspaceDir = process.cwd();

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', { workspacePath: workspaceDir });

    expect(result).toMatchObject({ success: true, text: 'workspace switched', sessionId: 'test-session' });
    expect(ws.chatSend).toHaveBeenCalledWith(
      'test-session',
      expect.stringContaining(`[Project working directory: ${workspaceDir}]`),
      expect.any(Object),
    );
    expect(ws.chatSend).toHaveBeenCalledWith(
      'test-session',
      expect.stringContaining("Do not treat this folder as the agent's home workspace"),
      expect.any(Object),
    );
  });

  it('continues chat when the selected project folder is missing and marks workspace fallback metadata', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: 'normal chat reply',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    const missingWorkspaceDir = path.join(os.tmpdir(), `awarenessclaw-missing-${Date.now()}`);

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', { workspacePath: missingWorkspaceDir });

    expect(result).toMatchObject({
      success: true,
      text: 'normal chat reply',
      sessionId: 'test-session',
      workspacePathInvalid: true,
      workspacePathIssue: 'missing',
      workspacePathOriginal: missingWorkspaceDir,
    });

    const firstChatSendCall = ws.chatSend.mock.calls[0] as unknown as any[] | undefined;
    const promptPayload = String(firstChatSendCall && firstChatSendCall.length > 1 ? firstChatSendCall[1] : '');
    expect(promptPayload).toContain('[Project folder unavailable]');
    expect(promptPayload).not.toContain('[Project working directory:');
  });

  it('uses home directory cwd for CLI fallback when selected project folder is missing', async () => {
    const fakeChild = createCliFallbackChild('CLI fallback reply');
    spawnMock.mockReturnValue(fakeChild as any);

    const missingWorkspaceDir = path.join(os.tmpdir(), `awarenessclaw-missing-${Date.now()}`);

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: false, error: 'Gateway failed to start.' })),
      getGatewayWs: vi.fn(),
      getConnectedGatewayWs: vi.fn(() => null),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const pending = handlers['chat:send']({}, 'hello from cli fallback', 'test-session', { workspacePath: missingWorkspaceDir });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(String(spawnOptions?.cwd || '')).toBe(os.homedir());

    fakeChild.emitOutput();
    await expect(pending).resolves.toMatchObject({
      success: true,
      text: 'CLI fallback reply',
      sessionId: 'test-session',
      workspacePathInvalid: true,
      workspacePathIssue: 'missing',
      workspacePathOriginal: missingWorkspaceDir,
    });
  });

  it('does not short-circuit filesystem requests when selected project folder is missing', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: 'Please choose the project folder again before I edit project files.',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    const missingWorkspaceDir = path.join(os.tmpdir(), `awarenessclaw-missing-${Date.now()}`);

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'create a file under src and update config', 'test-session', { workspacePath: missingWorkspaceDir });

    expect(result).toMatchObject({
      success: true,
      sessionId: 'test-session',
      workspacePathInvalid: true,
      workspacePathIssue: 'missing',
      workspacePathOriginal: missingWorkspaceDir,
    });
    expect(ws.chatSend).toHaveBeenCalledTimes(1);
  });

  it('injects desktop path context for natural-language desktop requests', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: 'checked desktop',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, '你看看我电脑桌面上有什么文件', 'test-session', {});

    expect(result).toMatchObject({ success: true, text: 'checked desktop', sessionId: 'test-session' });
    expect(ws.chatSend).toHaveBeenCalledWith(
      'test-session',
      expect.stringContaining('When the user asks about local files or folders on this machine, do not answer with a generic safety/privacy refusal'),
      expect.any(Object),
    );
    expect(ws.chatSend).toHaveBeenCalledWith(
      'test-session',
      expect.stringContaining(`Common ${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'} folders for this user are:`),
      expect.any(Object),
    );
    expect(ws.chatSend).toHaveBeenCalledWith(
      'test-session',
      expect.stringContaining(`desktop=${path.join(os.homedir(), 'Desktop')}`),
      expect.any(Object),
    );
    expect(ws.chatSend).toHaveBeenCalledWith(
      'test-session',
      expect.stringContaining('If the user says "桌面", "desktop", or "我的桌面"'),
      expect.any(Object),
    );
    expect(ws.chatSend).toHaveBeenCalledWith(
      'test-session',
      expect.stringContaining('[Current host exec approvals] security='),
      expect.any(Object),
    );
    expect(ws.chatSend).toHaveBeenCalledWith(
      'test-session',
      expect.stringContaining('If earlier conversation turns claimed local filesystem access was blocked by allowlist/privacy rules'),
      expect.any(Object),
    );
    expect(ws.chatSend).toHaveBeenCalledWith(
      'test-session',
      expect.stringContaining('Never claim a file or folder change succeeded unless a tool result confirms it'),
      expect.any(Object),
    );
    expect(ws.chatSend).toHaveBeenCalledWith(
      'test-session',
      expect.stringContaining('run a follow-up verification step'),
      expect.any(Object),
    );
    expect(ws.chatSend).toHaveBeenCalledWith(
      'test-session',
      expect.stringContaining('[Web compatibility note]'),
      expect.any(Object),
    );
  });

  it('uses direct openclaw spawn args for CLI fallback when runSpawn is available', async () => {
    const fakeChild = createCliFallbackChild('CLI fallback reply');
    const runSpawn = vi.fn(() => fakeChild as any);
    const wrapWindowsCommand = vi.fn((command: string) => command);
    const workspaceDir = process.cwd();
    const callMcpStrict = vi.fn(async (toolName: string) => (
      toolName === 'awareness_init' ? createAwarenessInitResponse('CLI file task memory') : {}
    ));

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: false, error: 'Gateway failed to start.' })),
      getGatewayWs: vi.fn(),
      getConnectedGatewayWs: vi.fn(() => null),
      callMcpStrict,
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      runSpawn,
      wrapWindowsCommand,
      stripAnsi: vi.fn((output: string) => output),
    });

    const handlers = getRegisteredHandlers();
    const pending = handlers['chat:send']({}, 'create a file and verify it', 'test-session', { workspacePath: workspaceDir });
    await vi.waitFor(() => expect(runSpawn).toHaveBeenCalledTimes(1));

    const [cmd, args, opts] = runSpawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe('openclaw');
    expect(args).toEqual(expect.arrayContaining(['agent', '--session-id', 'test-session', '-m', '--verbose', 'full']));
    expect(args).toEqual(expect.arrayContaining(['--local']));
    const messageArgIndex = args.indexOf('-m');
    expect(messageArgIndex).toBeGreaterThanOrEqual(0);
    expect(args[messageArgIndex + 1]).toContain(`[Project working directory: ${workspaceDir}]`);
    expect(args[messageArgIndex + 1]).toContain('Desktop already loaded the current Awareness memory context for this turn.');
    expect(args[messageArgIndex + 1]).toContain('Never claim a file or folder change succeeded unless a tool result confirms it');
    expect(opts).toMatchObject({ cwd: workspaceDir, stdio: 'pipe' });
    expect(wrapWindowsCommand).not.toHaveBeenCalled();
    expect(callMcpStrict).toHaveBeenCalledWith(
      'awareness_init',
      expect.objectContaining({ query: 'create a file and verify it' }),
      expect.any(Number),
    );

    fakeChild.emitOutput();
    await expect(pending).resolves.toMatchObject({ success: true, text: 'CLI fallback reply', sessionId: 'test-session' });
  });

  it('flags unverified local file-write success claims in CLI fallback output', async () => {
    const fakeChild = createCliFallbackChild('Saved the file to E:\\新建文件夹2\\我是谁.txt');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    spawnMock.mockReturnValue(fakeChild as any);

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: false, error: 'Gateway unavailable.' })),
      getGatewayWs: vi.fn(),
      getConnectedGatewayWs: vi.fn(() => null),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const pending = handlers['chat:send']({}, '在 E:\\新建文件夹2 里写一个 txt 文件', 'test-session', {});
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    fakeChild.emitOutput();
    const result = await pending;

    expect(result).toMatchObject({
      success: true,
      text: 'Saved the file to E:\\新建文件夹2\\我是谁.txt',
      sessionId: 'test-session',
      unverifiedLocalFileOperation: true,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('CLI fallback produced an unverified local filesystem success claim'),
      expect.objectContaining({ sessionId: 'test-session' }),
    );

    warnSpy.mockRestore();
  });

  it('silently retries CLI fallback when first CLI response is blocked by special-use IP policy', async () => {
    const fakeChildBlocked = createCliFallbackChild('The web_fetch tool is unavailable or denied because this URL resolves to a private/internal/special-use IP address.');
    const fakeChildRecovered = createCliFallbackChild('Downloaded via exec after compatibility retry.');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    spawnMock
      .mockReturnValueOnce(fakeChildBlocked as any)
      .mockReturnValueOnce(fakeChildRecovered as any);

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: false, error: 'Gateway unavailable.' })),
      getGatewayWs: vi.fn(),
      getConnectedGatewayWs: vi.fn(() => null),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const pending = handlers['chat:send']({}, '请抓取 https://example.com', 'test-session', {});
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    fakeChildBlocked.emitOutput();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    fakeChildRecovered.emitOutput();
    const result = await pending;

    expect(result).toMatchObject({
      success: true,
      text: 'Downloaded via exec after compatibility retry.',
      sessionId: 'test-session',
      preferResultText: true,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('CLI fallback indicates VPN/DNS special-use IP compatibility issue'),
      expect.objectContaining({ sessionId: 'test-session' }),
    );

    warnSpy.mockRestore();
  });

  it('forwards gateway agent tool events into chat status updates with tool output detail', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:agent', {
          runId: 'run-1',
          sessionKey: 'test-session',
          stream: 'tool',
          data: {
            phase: 'start',
            name: 'exec',
            toolCallId: 'tool-1',
            args: { command: 'ls -la ~/Desktop' },
          },
        });
        ws.emit('event:agent', {
          runId: 'run-1',
          sessionKey: 'test-session',
          stream: 'tool',
          data: {
            phase: 'result',
            name: 'exec',
            toolCallId: 'tool-1',
            result: { stdout: '.DS_Store\ntest.txt' },
          },
        });
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: 'done',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    const sendToRenderer = vi.fn();

    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', {});

    expect(result).toMatchObject({ success: true, text: 'done', sessionId: 'test-session' });
    expect(sendToRenderer).toHaveBeenCalledWith(
      'chat:status',
      expect.objectContaining({
        type: 'tool_call',
        tool: 'exec',
        toolId: 'tool-1',
        detail: expect.stringContaining('ls -la ~/Desktop'),
      }),
    );
    expect(sendToRenderer).toHaveBeenCalledWith(
      'chat:status',
      expect.objectContaining({
        type: 'tool_update',
        toolId: 'tool-1',
        toolStatus: 'completed',
        detail: expect.stringContaining('.DS_Store'),
      }),
    );
  });

  it('preserves structured thinking and tool blocks when loading chat history', async () => {
    const ws = new FakeGatewayClient();
    ws.chatHistory = vi.fn(async () => ([
      {
        __openclaw: { id: 'gw-msg-1' },
        role: 'assistant',
        timestamp: 1700000000000,
        model: 'openai/gpt-5.4',
        content: [
          { type: 'thinking', thinking: 'inspect files first' },
          { type: 'tool_use', id: 'tool-1', name: 'read', input: { filePath: '/tmp/demo.txt' } },
          { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'file contents' }] },
          { type: 'text', text: 'Done.' },
        ],
      },
    ]));

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:load-history']({}, 'test-session');

    expect(result).toMatchObject({ success: true });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      id: 'gw-msg-1',
      role: 'assistant',
      content: 'Done.',
      thinking: 'inspect files first',
      toolCalls: [
        expect.objectContaining({
          id: 'tool-1',
          name: 'read',
          status: 'completed',
          detail: expect.stringContaining('/tmp/demo.txt'),
          output: expect.stringContaining('file contents'),
        }),
      ],
    });
    expect(result.messages[0].contentBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thinking' }),
      expect.objectContaining({ type: 'tool_use' }),
      expect.objectContaining({ type: 'tool_result' }),
      expect.objectContaining({ type: 'text' }),
    ]));
  });

  it('merges tool results from later non-assistant history turns back into the originating assistant trace', async () => {
    const ws = new FakeGatewayClient();
    ws.chatHistory = vi.fn(async () => ([
      {
        __openclaw: { id: 'gw-msg-1' },
        role: 'assistant',
        timestamp: 1700000000000,
        model: 'openai/gpt-5.4',
        content: [
          { type: 'thinking', thinking: 'inspect files first' },
          { type: 'tool_use', id: 'tool-1', name: 'read', input: { filePath: '/tmp/demo.txt' } },
        ],
      },
      {
        __openclaw: { id: 'gw-msg-2' },
        role: 'user',
        timestamp: 1700000001000,
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'file contents' }] },
        ],
      },
      {
        __openclaw: { id: 'gw-msg-3' },
        role: 'assistant',
        timestamp: 1700000002000,
        model: 'openai/gpt-5.4',
        content: [{ type: 'text', text: 'Done.' }],
      },
    ]));

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:load-history']({}, 'test-session');

    expect(result).toMatchObject({ success: true });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      id: 'gw-msg-1',
      role: 'assistant',
      thinking: 'inspect files first',
      toolCalls: [
        expect.objectContaining({
          id: 'tool-1',
          name: 'read',
          status: 'completed',
          output: expect.stringContaining('file contents'),
        }),
      ],
    });
    expect(result.messages[0].contentBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use' }),
      expect.objectContaining({ type: 'tool_result' }),
    ]));
    expect(result.messages[1]).toMatchObject({
      id: 'gw-msg-3',
      role: 'assistant',
      content: 'Done.',
    });
  });

  it('forwards high-fidelity chat events for tool calls and tool results', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:agent', {
          runId: 'run-2',
          sessionKey: 'test-session',
          seq: 2,
          stream: 'tool',
          data: {
            phase: 'start',
            name: 'exec',
            toolCallId: 'tool-2',
            args: { command: 'pwd' },
          },
        });
        ws.emit('event:agent', {
          runId: 'run-2',
          sessionKey: 'test-session',
          seq: 3,
          stream: 'tool',
          data: {
            phase: 'result',
            name: 'exec',
            toolCallId: 'tool-2',
            result: { stdout: '/tmp/project' },
          },
        });
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: 'done',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    const sendToRenderer = vi.fn();

    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', {});

    expect(result).toMatchObject({ success: true, text: 'done', sessionId: 'test-session' });
    expect(sendToRenderer).toHaveBeenCalledWith(
      'chat:event',
      expect.objectContaining({
        stream: 'tool',
        phase: 'start',
        toolCallId: 'tool-2',
        toolName: 'exec',
        args: { command: 'pwd' },
      }),
    );
    expect(sendToRenderer).toHaveBeenCalledWith(
      'chat:event',
      expect.objectContaining({
        stream: 'tool',
        phase: 'result',
        toolCallId: 'tool-2',
        toolName: 'exec',
        result: { stdout: '/tmp/project' },
      }),
    );
  });

  it('forwards structured tool and thinking blocks from event:chat deltas as high-fidelity chat events', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'delta',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'inspect files first' },
              { type: 'tool_use', id: 'tool-3', name: 'read_file', input: { filePath: '/tmp/demo.txt' } },
              { type: 'tool_result', tool_use_id: 'tool-3', content: [{ type: 'text', text: 'hello world' }] },
              { type: 'text', text: 'done' },
            ],
          },
        });
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: 'done',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    const sendToRenderer = vi.fn();

    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', {});

    expect(result).toMatchObject({ success: true, text: 'done', sessionId: 'test-session' });
    expect(sendToRenderer).toHaveBeenCalledWith('chat:thinking', 'inspect files first');
    expect(sendToRenderer).toHaveBeenCalledWith(
      'chat:event',
      expect.objectContaining({
        stream: 'assistant',
        phase: 'thinking',
        thinking: 'inspect files first',
      }),
    );
    expect(sendToRenderer).toHaveBeenCalledWith(
      'chat:event',
      expect.objectContaining({
        stream: 'tool',
        phase: 'start',
        toolCallId: 'tool-3',
        toolName: 'read_file',
        args: { filePath: '/tmp/demo.txt' },
      }),
    );
    expect(sendToRenderer).toHaveBeenCalledWith(
      'chat:event',
      expect.objectContaining({
        stream: 'tool',
        phase: 'result',
        toolCallId: 'tool-3',
        result: expect.anything(),
      }),
    );
  });

  it('forwards structured tool and thinking blocks that only appear in the final chat event', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'search first, summarize after' },
              { type: 'tool_use', id: 'tool-final', name: 'tavily_search', input: { query: 'today news' } },
              { type: 'tool_result', tool_use_id: 'tool-final', content: [{ type: 'text', text: 'news result block' }] },
              { type: 'text', text: 'done' },
            ],
          },
        });
      }, 0);
      return { status: 'started' };
    });

    const sendToRenderer = vi.fn();

    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', {});

    expect(result).toMatchObject({ success: true, text: 'done', sessionId: 'test-session' });
    expect(sendToRenderer).toHaveBeenCalledWith('chat:thinking', 'search first, summarize after');
    expect(sendToRenderer).toHaveBeenCalledWith(
      'chat:event',
      expect.objectContaining({
        stream: 'tool',
        phase: 'start',
        toolCallId: 'tool-final',
        toolName: 'tavily_search',
      }),
    );
    expect(sendToRenderer).toHaveBeenCalledWith(
      'chat:status',
      expect.objectContaining({
        type: 'tool_update',
        toolId: 'tool-final',
        detail: expect.stringContaining('news result block'),
      }),
    );
  });

  it('normalizes real event:agent payloads with tool.call and tool.output into chat events', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:agent', {
          event: 'tool.call',
          runId: 'run-3',
          sessionKey: 'test-session',
          data: {
            toolCallId: 'tool-4',
            name: 'exec',
            args: { command: 'pwd' },
          },
        });
        ws.emit('event:agent', {
          event: 'tool.output',
          runId: 'run-3',
          sessionKey: 'test-session',
          data: {
            toolCallId: 'tool-4',
            name: 'exec',
            result: { stdout: '/tmp/project' },
          },
        });
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: 'done',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    const sendToRenderer = vi.fn();

    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', {});

    expect(result).toMatchObject({ success: true, text: 'done', sessionId: 'test-session' });
    expect(sendToRenderer).toHaveBeenCalledWith(
      'chat:event',
      expect.objectContaining({
        stream: 'tool',
        phase: 'start',
        toolCallId: 'tool-4',
        toolName: 'exec',
        args: { command: 'pwd' },
      }),
    );
    expect(sendToRenderer).toHaveBeenCalledWith(
      'chat:event',
      expect.objectContaining({
        stream: 'tool',
        phase: 'result',
        toolCallId: 'tool-4',
        toolName: 'exec',
        result: { stdout: '/tmp/project' },
      }),
    );
    expect(sendToRenderer).toHaveBeenCalledWith(
      'chat:status',
      expect.objectContaining({
        type: 'tool_update',
        toolId: 'tool-4',
        toolStatus: 'completed',
        detail: expect.stringContaining('/tmp/project'),
      }),
    );
  });

  it('normalizes agent:assistant reasoning payloads into visible thinking events', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:agent:assistant', {
          runId: 'run-4',
          sessionKey: 'test-session',
          data: {
            reasoning: 'inspect project structure before answering',
          },
        });
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: 'done',
          },
        });
      }, 0);
      return { status: 'started' };
    });

    const sendToRenderer = vi.fn();

    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', {});

    expect(result).toMatchObject({ success: true, text: 'done', sessionId: 'test-session' });
    expect(sendToRenderer).toHaveBeenCalledWith('chat:thinking', 'inspect project structure before answering');
    expect(sendToRenderer).toHaveBeenCalledWith(
      'chat:event',
      expect.objectContaining({
        stream: 'assistant',
        phase: 'thinking',
        thinking: 'inspect project structure before answering',
      }),
    );
  });

  it('passes user reasoningDisplay preference directly to chatSend instead of defaulting to on', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: { role: 'assistant', content: 'done' },
        });
      }, 0);
      return { status: 'started' };
    });

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();

    // When user selects 'stream', chatSend should receive 'stream' (not 'on')
    await handlers['chat:send']({}, 'hello', 'test-session', { reasoningDisplay: 'stream' });
    expect(ws.chatSend).toHaveBeenCalledWith(
      'test-session',
      expect.any(String),
      expect.objectContaining({ reasoning: 'stream' }),
    );
  });

  it('omits reasoning param when reasoningDisplay is off', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: { role: 'assistant', content: 'done' },
        });
      }, 0);
      return { status: 'started' };
    });

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    await handlers['chat:send']({}, 'hello', 'test-session', { reasoningDisplay: 'off' });

    const chatSendOptions = ws.chatSend.mock.calls[0][2];
    expect(chatSendOptions.reasoning).toBeUndefined();
  });

  it('forwards stream:thinking agent events as chat:thinking IPC messages', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        // Gateway sends stream:"thinking" events when reasoning='stream'
        ws.emit('event:agent', {
          stream: 'thinking',
          delta: 'analyzing the codebase structure',
          runId: 'run-5',
          sessionKey: 'test-session',
        });
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: { role: 'assistant', content: 'here is my analysis' },
        });
      }, 0);
      return { status: 'started' };
    });

    const sendToRenderer = vi.fn();

    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', { reasoningDisplay: 'stream' });

    expect(result).toMatchObject({ success: true, text: 'here is my analysis' });
    expect(sendToRenderer).toHaveBeenCalledWith('chat:thinking', 'analyzing the codebase structure');
    expect(sendToRenderer).toHaveBeenCalledWith('chat:status', { type: 'thinking' });
  });

  it('ignores stream:thinking events with empty delta/text', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        // Empty thinking event should be silently dropped
        ws.emit('event:agent', {
          stream: 'thinking',
          delta: '',
          runId: 'run-6',
          sessionKey: 'test-session',
        });
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: { role: 'assistant', content: 'done' },
        });
      }, 0);
      return { status: 'started' };
    });

    const sendToRenderer = vi.fn();

    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    await handlers['chat:send']({}, 'hello', 'test-session', {});

    const thinkingCalls = sendToRenderer.mock.calls.filter(
      ([channel]: [string]) => channel === 'chat:thinking',
    );
    expect(thinkingCalls).toHaveLength(0);
  });

  // --- L3: Chaos / Failure-mode tests for thinking stream ---

  it('does not crash when stream:thinking payload has null data field', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        // Malformed thinking event with null data
        ws.emit('event:agent', {
          stream: 'thinking',
          data: null,
          runId: 'run-chaos-1',
          sessionKey: 'test-session',
        });
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: { role: 'assistant', content: 'survived chaos' },
        });
      }, 0);
      return { status: 'started' };
    });

    const sendToRenderer = vi.fn();
    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', {});
    // Should complete without throwing
    expect(result).toMatchObject({ success: true, text: 'survived chaos' });
  });

  it('does not crash when event:agent payload is not an object', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        // Completely malformed payload — string instead of object
        ws.emit('event:agent', 'not-an-object');
        // Numeric payload
        ws.emit('event:agent', 42);
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: { role: 'assistant', content: 'survived non-object' },
        });
      }, 0);
      return { status: 'started' };
    });

    const sendToRenderer = vi.fn();
    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', {});
    expect(result).toMatchObject({ success: true, text: 'survived non-object' });
  });

  it('handles rapid stream:thinking bursts without losing final assistant response', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        // Burst of 50 thinking deltas
        for (let i = 0; i < 50; i++) {
          ws.emit('event:agent', {
            stream: 'thinking',
            delta: `step ${i}`,
            runId: 'run-burst',
            sessionKey: 'test-session',
          });
        }
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: { role: 'assistant', content: 'burst complete' },
        });
      }, 0);
      return { status: 'started' };
    });

    const sendToRenderer = vi.fn();
    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnMock as any,
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', {});

    expect(result).toMatchObject({ success: true, text: 'burst complete' });
    const thinkingCalls = sendToRenderer.mock.calls.filter(
      ([channel]: [string]) => channel === 'chat:thinking',
    );
    expect(thinkingCalls.length).toBe(50);
  });
});