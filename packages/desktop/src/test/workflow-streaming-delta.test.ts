/**
 * Tests for the streaming delta path in register-workflow-handlers.ts.
 *
 * Verifies:
 *   - state=delta tokens are buffered and flushed on a 200ms timer (token-bomb throttle)
 *   - Multiple deltas within the window coalesce into a single IPC send
 *   - Final/error/aborted flush pending delta before sending task:status-update
 *   - Main-agent deltas (no ':subagent:' in sessionKey) are ignored
 *   - Delta shapes {delta: string}, {delta: {content}}, {message: {content: [...]}} all work
 *
 * Reference: docs/features/team-tasks/03-ACCEPTANCE.md Journey 10 + L3.12
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
  BrowserWindow: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    unlinkSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  unlinkSync: vi.fn(),
}));

vi.mock('../../electron/json-file', () => ({
  readJsonFileWithBom: vi.fn().mockReturnValue({}),
}));

const SUB_KEY = 'agent:main:subagent:abc-123';
const MAIN_KEY = 'agent:main:main';
const FLUSH_MS = 200;

async function setupWithCapturedListener() {
  // Fresh module state per test — the listener attach flag is module-level.
  vi.resetModules();

  const send = vi.fn();
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send },
  };

  // Capture the 'event:chat' handler that the module registers via ws.on(...).
  const listeners = new Map<string, (payload: any) => void>();
  const mockGatewayWs = {
    isConnected: true,
    chatSend: vi.fn().mockResolvedValue({ runId: 'run-1' }),
    chatAbort: vi.fn().mockResolvedValue(undefined),
    chatHistory: vi.fn().mockResolvedValue([]),
    on: vi.fn((event: string, cb: (payload: any) => void) => {
      listeners.set(event, cb);
    }),
  };

  const { registerWorkflowHandlers } = await import('../../electron/ipc/register-workflow-handlers');
  const { ipcMain } = await import('electron');

  registerWorkflowHandlers({
    home: '/mock/home',
    safeShellExecAsync: vi.fn().mockResolvedValue(null),
    runAsync: vi.fn().mockResolvedValue(''),
    runSpawnAsync: vi.fn().mockResolvedValue(''),
    getGatewayWs: vi.fn().mockResolvedValue(mockGatewayWs),
    getMainWindow: vi.fn().mockReturnValue(mockWindow),
  });

  // Trigger the listener attach by invoking the task:create handler, which calls
  // attachSubagentListener(deps) internally. The handler itself can fail — we only
  // care that the listener got wired up on the mock gateway.
  const handle = ipcMain.handle as ReturnType<typeof vi.fn>;
  const taskCreateHandler = handle.mock.calls.find((c) => c[0] === 'task:create')?.[1];
  if (taskCreateHandler) {
    try { await taskCreateHandler({}, { title: 't', agentId: 'main' }); } catch { /* ignore */ }
  }

  // Let the getGatewayWs().then(...) promise chain resolve so ws.on(...) fires.
  await Promise.resolve();
  await Promise.resolve();

  const chatHandler = listeners.get('event:chat');
  if (!chatHandler) throw new Error('event:chat listener was not attached');

  return { chatHandler, send };
}

describe('register-workflow-handlers · streaming delta', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('buffers delta tokens and flushes once per 200ms window', async () => {
    const { chatHandler, send } = await setupWithCapturedListener();

    // Burst 5 deltas within the window — should coalesce into 1 flush.
    chatHandler({ sessionKey: SUB_KEY, runId: 'r1', state: 'delta', delta: 'Hel' });
    chatHandler({ sessionKey: SUB_KEY, runId: 'r1', state: 'delta', delta: 'lo ' });
    chatHandler({ sessionKey: SUB_KEY, runId: 'r1', state: 'delta', delta: 'wor' });
    chatHandler({ sessionKey: SUB_KEY, runId: 'r1', state: 'delta', delta: 'ld!' });

    // Before the timer fires, no stream-delta should have been sent.
    expect(send).not.toHaveBeenCalledWith('task:stream-delta', expect.anything());

    vi.advanceTimersByTime(FLUSH_MS);

    const deltaCalls = send.mock.calls.filter((c) => c[0] === 'task:stream-delta');
    expect(deltaCalls).toHaveLength(1);
    expect(deltaCalls[0][1]).toEqual({
      sessionKey: SUB_KEY,
      runId: 'r1',
      chunk: 'Hello world!',
    });
  });

  it('schedules additional flushes when more deltas arrive after a flush', async () => {
    const { chatHandler, send } = await setupWithCapturedListener();

    chatHandler({ sessionKey: SUB_KEY, runId: 'r1', state: 'delta', delta: 'A' });
    vi.advanceTimersByTime(FLUSH_MS);

    chatHandler({ sessionKey: SUB_KEY, runId: 'r1', state: 'delta', delta: 'B' });
    vi.advanceTimersByTime(FLUSH_MS);

    const deltaCalls = send.mock.calls.filter((c) => c[0] === 'task:stream-delta');
    expect(deltaCalls).toHaveLength(2);
    expect(deltaCalls[0][1].chunk).toBe('A');
    expect(deltaCalls[1][1].chunk).toBe('B');
  });

  it('flushes pending delta before sending the terminal task:status-update', async () => {
    const { chatHandler, send } = await setupWithCapturedListener();

    chatHandler({ sessionKey: SUB_KEY, runId: 'r1', state: 'delta', delta: 'tail-' });
    chatHandler({ sessionKey: SUB_KEY, runId: 'r1', state: 'delta', delta: 'token' });

    // final arrives before the 200ms timer — the delta must still be flushed first.
    chatHandler({
      sessionKey: SUB_KEY,
      runId: 'r1',
      state: 'final',
      message: { content: [{ type: 'text', text: 'Result OK' }] },
    });

    const calls = send.mock.calls.map((c) => c[0]);
    const deltaIdx = calls.indexOf('task:stream-delta');
    const statusIdx = calls.indexOf('task:status-update');
    expect(deltaIdx).toBeGreaterThanOrEqual(0);
    expect(statusIdx).toBeGreaterThan(deltaIdx);

    expect(send).toHaveBeenCalledWith('task:stream-delta', {
      sessionKey: SUB_KEY,
      runId: 'r1',
      chunk: 'tail-token',
    });
    expect(send).toHaveBeenCalledWith('task:status-update', expect.objectContaining({
      event: 'completed',
      result: 'Result OK',
    }));
  });

  it('ignores delta events from main-agent sessions (non subagent)', async () => {
    const { chatHandler, send } = await setupWithCapturedListener();

    chatHandler({ sessionKey: MAIN_KEY, runId: 'r-main', state: 'delta', delta: 'noise' });
    vi.advanceTimersByTime(FLUSH_MS);

    expect(send).not.toHaveBeenCalledWith('task:stream-delta', expect.anything());
  });

  it('accepts multiple delta shapes: string / {content} / message.content', async () => {
    const { chatHandler, send } = await setupWithCapturedListener();

    // Shape A — plain string delta
    chatHandler({ sessionKey: SUB_KEY, runId: 'r1', state: 'delta', delta: 'A-' });
    // Shape B — object with content
    chatHandler({ sessionKey: SUB_KEY, runId: 'r1', state: 'delta', delta: { content: 'B-' } });
    // Shape C — message content array (rare but defensive)
    chatHandler({
      sessionKey: SUB_KEY,
      runId: 'r1',
      state: 'delta',
      message: { content: [{ type: 'text', text: 'C' }] },
    });

    vi.advanceTimersByTime(FLUSH_MS);

    const deltaCalls = send.mock.calls.filter((c) => c[0] === 'task:stream-delta');
    expect(deltaCalls).toHaveLength(1);
    expect(deltaCalls[0][1].chunk).toBe('A-B-C');
  });

  it('does not emit task:stream-delta for empty extraction', async () => {
    const { chatHandler, send } = await setupWithCapturedListener();

    chatHandler({ sessionKey: SUB_KEY, runId: 'r1', state: 'delta', delta: '' });
    chatHandler({ sessionKey: SUB_KEY, runId: 'r1', state: 'delta' });
    vi.advanceTimersByTime(FLUSH_MS);

    expect(send).not.toHaveBeenCalledWith('task:stream-delta', expect.anything());
  });

  it('keeps separate buffers per session', async () => {
    const { chatHandler, send } = await setupWithCapturedListener();
    const SUB_A = 'agent:main:subagent:aaa';
    const SUB_B = 'agent:main:subagent:bbb';

    chatHandler({ sessionKey: SUB_A, runId: 'rA', state: 'delta', delta: 'alpha' });
    chatHandler({ sessionKey: SUB_B, runId: 'rB', state: 'delta', delta: 'beta' });
    vi.advanceTimersByTime(FLUSH_MS);

    const deltaCalls = send.mock.calls.filter((c) => c[0] === 'task:stream-delta');
    expect(deltaCalls).toHaveLength(2);
    const chunks = deltaCalls.map((c) => c[1]).sort((a, b) => a.chunk.localeCompare(b.chunk));
    expect(chunks[0]).toEqual({ sessionKey: SUB_A, runId: 'rA', chunk: 'alpha' });
    expect(chunks[1]).toEqual({ sessionKey: SUB_B, runId: 'rB', chunk: 'beta' });
  });

  it('clears buffer on terminal state so later deltas start fresh', async () => {
    const { chatHandler, send } = await setupWithCapturedListener();

    chatHandler({ sessionKey: SUB_KEY, runId: 'r1', state: 'delta', delta: 'first' });
    chatHandler({
      sessionKey: SUB_KEY,
      runId: 'r1',
      state: 'final',
      message: { content: [{ type: 'text', text: 'done' }] },
    });

    send.mockClear();

    // New run reuses the same session (unlikely in real use but should not leak state)
    chatHandler({ sessionKey: SUB_KEY, runId: 'r2', state: 'delta', delta: 'fresh' });
    vi.advanceTimersByTime(FLUSH_MS);

    const deltaCalls = send.mock.calls.filter((c) => c[0] === 'task:stream-delta');
    expect(deltaCalls).toHaveLength(1);
    expect(deltaCalls[0][1]).toEqual({
      sessionKey: SUB_KEY,
      runId: 'r2',
      chunk: 'fresh',
    });
  });
});
