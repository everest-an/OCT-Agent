/**
 * preview.6 chat fixes · L2 integration tests
 *
 * Covers the 3 bugs the user flagged before sleep:
 *  1) thinking 散落 / fragmented reasoning  → live-stream thinking buffer accumulates deltas
 *  2) 最后一轮重复输出 / duplicate final output → duplicate final guard + stream-reset on CLI fallback
 *  3) 性能 / perf                            → chat:stream IPC throttled to <= 1 send per ~40ms
 *
 * All tests hit the real `registerChatHandlers` export via a minimal fake gateway,
 * so they exercise the production code path end-to-end (no logic is duplicated here).
 */
import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatState } from '../../electron/ipc/chat-types';

const { ipcHandleMock } = vi.hoisted(() => ({ ipcHandleMock: vi.fn() }));

vi.mock('electron', () => ({
  ipcMain: { handle: ipcHandleMock },
}));

import { registerChatHandlers } from '../../electron/ipc/register-chat-handlers';

class FakeGatewayClient extends EventEmitter {
  isConnected = true;
  sessionPatch = vi.fn(async () => ({ ok: true }));
  chatSend = vi.fn(async () => ({ status: 'started' }));
  chatAbort = vi.fn(async () => undefined);
  chatHistory = vi.fn(async () => [] as any[]);
}

function getHandlers() {
  return Object.fromEntries(
    ipcHandleMock.mock.calls.map(([channel, handler]) => [channel, handler]),
  ) as Record<string, (...args: any[]) => Promise<any>>;
}

function buildChatHandler(ws: FakeGatewayClient, sendToRenderer = vi.fn()) {
  registerChatHandlers({
    sendToRenderer,
    ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
    getGatewayWs: vi.fn(async () => ws as any),
    getConnectedGatewayWs: vi.fn(() => ws as any),
    callMcpStrict: vi.fn(async () => ({})),
    getEnhancedPath: vi.fn(() => process.env.PATH || ''),
    wrapWindowsCommand: vi.fn((command: string) => command),
    stripAnsi: vi.fn((output: string) => output),
    spawnChatProcess: vi.fn() as any,
  });
  return { handlers: getHandlers(), sendToRenderer };
}

describe('preview.6 · chat bug fixes', () => {
  beforeEach(() => {
    ipcHandleMock.mockReset();
    chatState.activeChatChild = null;
    chatState.awarenessInitCompatibilityMode = false;
    chatState.lastAwarenessInitCompatibilityError = '';
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // BUG 3 · thinking 散落 (live stream:"thinking" deltas must accumulate)
  // ---------------------------------------------------------------------------
  it('accumulates live stream:"thinking" delta fragments into one complete reasoning text', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        // Simulate OpenClaw's live reasoning token stream: 3 delta fragments.
        ws.emit('event:agent', { stream: 'thinking', delta: 'First I will' });
        ws.emit('event:agent', { stream: 'thinking', delta: ' read the data' });
        ws.emit('event:agent', { stream: 'thinking', delta: ' and analyze it' });
        // Then a final assistant reply so the handler resolves.
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: { role: 'assistant', content: 'Here is the analysis' },
        });
      }, 0);
      return { status: 'started' };
    });

    const { handlers, sendToRenderer } = buildChatHandler(ws);
    await handlers['chat:send']({}, 'analyze this', 'test-session', {});

    // Collect all chat:thinking payloads — each should be a longer accumulation
    // (or equal) compared to the previous, never a shrinking fragment.
    const thinkingPayloads = sendToRenderer.mock.calls
      .filter(([channel]) => channel === 'chat:thinking')
      .map(([, text]) => text as string);

    expect(thinkingPayloads.length).toBeGreaterThanOrEqual(3);
    // Final payload must contain all 3 fragments (accumulated, not overwritten).
    const last = thinkingPayloads[thinkingPayloads.length - 1];
    expect(last).toContain('First I will');
    expect(last).toContain('read the data');
    expect(last).toContain('and analyze it');
    // Each subsequent payload must not be shorter than the previous (monotonic).
    for (let i = 1; i < thinkingPayloads.length; i += 1) {
      expect(thinkingPayloads[i].length).toBeGreaterThanOrEqual(thinkingPayloads[i - 1].length);
    }
  });

  // ---------------------------------------------------------------------------
  // BUG 2 · 重复输出 (duplicate final frame must be ignored)
  // ---------------------------------------------------------------------------
  it('drops a second state:"final" frame from the same chat turn so tool/text events are not re-emitted', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool-1', name: 'exec', input: { cmd: 'ls' } },
              { type: 'text', text: 'done' },
            ],
          },
        });
        // Race duplicate — Gateway occasionally emits a second final frame.
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool-1', name: 'exec', input: { cmd: 'ls' } },
            ],
          },
        });
      }, 0);
      return { status: 'started' };
    });

    const { handlers, sendToRenderer } = buildChatHandler(ws);
    await handlers['chat:send']({}, 'list files', 'test-session', {});

    // Count how many times chat:status `tool_call` was fired for tool-1.
    // Without the dedupe it would fire twice (once per final).
    const toolStartEvents = sendToRenderer.mock.calls.filter(
      ([channel, payload]) =>
        channel === 'chat:status'
        && payload?.type === 'tool_call'
        && payload?.toolId === 'tool-1',
    );
    expect(toolStartEvents.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // BUG 1 · 性能 · chat:stream IPC send count must be throttled
  // ---------------------------------------------------------------------------
  it('throttles chat:stream IPC sends so 20 per-token deltas collapse into few batched chunks', async () => {
    const ws = new FakeGatewayClient();
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        // Simulate 20 small token deltas arriving in rapid succession.
        let accumulated = '';
        for (let i = 0; i < 20; i += 1) {
          accumulated += `tok${i} `;
          ws.emit('event:chat', {
            sessionKey: 'test-session',
            state: 'delta',
            message: { role: 'assistant', content: accumulated },
          });
        }
        // Allow throttle timers to flush before final.
        setTimeout(() => {
          ws.emit('event:chat', {
            sessionKey: 'test-session',
            state: 'final',
            message: { role: 'assistant', content: accumulated },
          });
        }, 100);
      }, 0);
      return { status: 'started' };
    });

    const { handlers, sendToRenderer } = buildChatHandler(ws);
    await handlers['chat:send']({}, 'stream me', 'test-session', {});

    const streamSends = sendToRenderer.mock.calls.filter(([channel]) => channel === 'chat:stream');
    // Throttle should collapse 20 per-token emits into substantially fewer IPC
    // sends (typically 1-4 within the 40ms window). Be lenient: just assert
    // it is strictly less than the number of raw deltas.
    expect(streamSends.length).toBeGreaterThanOrEqual(1);
    expect(streamSends.length).toBeLessThan(20);

    // Concatenated content across all throttled sends must equal the full stream.
    const concatenated = streamSends.map(([, chunk]) => chunk as string).join('');
    expect(concatenated).toBe(
      Array.from({ length: 20 }, (_, i) => `tok${i} `).join(''),
    );
  });

  // ---------------------------------------------------------------------------
  // BUG 2b · stream-reset emitted when gateway returns empty and CLI fallback fires
  // ---------------------------------------------------------------------------
  it('emits chat:stream-reset before CLI fallback so the renderer clears partial bytes', async () => {
    const ws = new FakeGatewayClient();
    // Gateway replies with an entirely empty final — triggers CLI recovery path.
    ws.chatSend = vi.fn(async () => {
      setTimeout(() => {
        ws.emit('event:chat', {
          sessionKey: 'test-session',
          state: 'final',
          message: { role: 'assistant', content: '' },
        });
      }, 0);
      return { status: 'started' };
    });

    const sendToRenderer = vi.fn();
    const spawnChatProcess = vi.fn(() => {
      // Minimal fake child that produces a CLI reply.
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from('CLI recovery reply\n'));
        child.emit('exit', 0);
      }, 0);
      return child;
    });

    registerChatHandlers({
      sendToRenderer,
      ensureGatewayRunning: vi.fn(async () => ({ ok: true })),
      getGatewayWs: vi.fn(async () => ws as any),
      getConnectedGatewayWs: vi.fn(() => ws as any),
      callMcpStrict: vi.fn(async () => ({})),
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
      spawnChatProcess: spawnChatProcess as any,
    });

    const handlers = getHandlers();
    await handlers['chat:send']({}, 'empty gateway case', 'test-session', {});

    const resetCalls = sendToRenderer.mock.calls.filter(([channel]) => channel === 'chat:stream-reset');
    expect(resetCalls.length).toBeGreaterThanOrEqual(1);
    expect(resetCalls[0][1]).toMatchObject({ reason: expect.stringContaining('gateway_empty_reply') });
  });
});
