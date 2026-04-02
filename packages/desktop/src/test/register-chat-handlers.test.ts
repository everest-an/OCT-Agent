import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ipcHandleMock } = vi.hoisted(() => ({
  ipcHandleMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: ipcHandleMock,
  },
}));

import { registerChatHandlers } from '../../electron/ipc/register-chat-handlers';

class FakeGatewayClient extends EventEmitter {
  isConnected = true;
  chatSend = vi.fn(async () => ({ status: 'started' }));
  chatAbort = vi.fn(async () => undefined);
}

function getRegisteredHandlers() {
  return Object.fromEntries(
    ipcHandleMock.mock.calls.map(([channel, handler]) => [channel, handler]),
  ) as Record<string, (...args: any[]) => Promise<any>>;
}

describe('registerChatHandlers', () => {
  beforeEach(() => {
    ipcHandleMock.mockReset();
  });

  it('logs an upstream empty-response warning when Gateway finishes with no assistant payload', async () => {
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

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    registerChatHandlers({
      sendToRenderer: vi.fn(),
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', {});

    expect(result).toMatchObject({ success: true, text: 'No response', sessionId: 'test-session' });
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

  it('forwards non-main agent ids to the gateway chat.send call', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
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
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['chat:send']({}, 'hello', 'test-session', { agentId: 'researcher' });

    expect(result).toMatchObject({ success: true, text: 'agent specific reply', sessionId: 'test-session' });
    expect(ws.chatSend).toHaveBeenCalledWith(
      'test-session',
      'hello',
      expect.objectContaining({ agentId: 'researcher' }),
    );
  });
});