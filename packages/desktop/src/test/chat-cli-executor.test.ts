import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

import { chatSendViaCli } from '../../electron/ipc/chat-cli-executor';
import { CHAT_IDLE_TIMEOUT_MS, chatState } from '../../electron/ipc/chat-types';

function createPendingCliChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('chatSendViaCli', () => {
  it('does not keep CLI fallback alive on stderr-only plugin noise', async () => {
    vi.useFakeTimers();
    try {
      const child = createPendingCliChild();
      const runSpawn = vi.fn(() => child as any);
      const send = vi.fn();

      const pending = chatSendViaCli('hello', 'test-session', { forceLocal: true }, send, {
        getEnhancedPath: vi.fn(() => process.env.PATH || ''),
        runSpawn,
        wrapWindowsCommand: vi.fn((command: string) => command),
        stripAnsi: vi.fn((output: string) => output),
      });

      child.stderr.emit('data', Buffer.from('plugins.entries.openclaw-weixin: channel plugin manifest warning\n'));
      await vi.advanceTimersByTimeAsync(CHAT_IDLE_TIMEOUT_MS + 1);

      await expect(pending).resolves.toMatchObject({
        success: false,
        sessionId: 'test-session',
      });
      expect(child.kill).toHaveBeenCalled();
      expect(chatState.activeChatChild).toBe(child);
    } finally {
      chatState.activeChatChild = null;
      vi.useRealTimers();
    }
  });

  it('keeps CLI fallback alive for meaningful output without newline boundaries', async () => {
    vi.useFakeTimers();
    try {
      const child = createPendingCliChild();
      const runSpawn = vi.fn(() => child as any);
      const send = vi.fn();

      const pending = chatSendViaCli('hello', 'test-session', { forceLocal: true }, send, {
        getEnhancedPath: vi.fn(() => process.env.PATH || ''),
        runSpawn,
        wrapWindowsCommand: vi.fn((command: string) => command),
        stripAnsi: vi.fn((output: string) => output),
      });

      await vi.advanceTimersByTimeAsync(CHAT_IDLE_TIMEOUT_MS - 500);
      child.stdout.emit('data', Buffer.from('This is a long assistant reply chunk without newline'));
      await vi.advanceTimersByTimeAsync(600);

      expect(child.kill).not.toHaveBeenCalled();

      child.emit('exit', 0);
      await expect(pending).resolves.toMatchObject({
        success: true,
        sessionId: 'test-session',
        text: 'This is a long assistant reply chunk without newline',
      });
    } finally {
      chatState.activeChatChild = null;
      vi.useRealTimers();
    }
  });

  it('returns actionable message when process exits without code or output', async () => {
    const child = createPendingCliChild();
    const runSpawn = vi.fn(() => child as any);
    const send = vi.fn();

    const pending = chatSendViaCli('hello', 'test-session', { forceLocal: true }, send, {
      getEnhancedPath: vi.fn(() => process.env.PATH || ''),
      runSpawn,
      wrapWindowsCommand: vi.fn((command: string) => command),
      stripAnsi: vi.fn((output: string) => output),
    });

    child.emit('exit', null, null);

    await expect(pending).resolves.toMatchObject({
      success: false,
      sessionId: 'test-session',
      error: 'OpenClaw ended unexpectedly before returning a response. Please retry.',
    });
  });
});
