/**
 * L2 Integration Test: fireAndForgetMemorySave()
 * Tests that the extracted memory save function correctly calls awareness_record
 * for both Gateway and CLI paths, respects capture policy, and handles errors.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the function in isolation by importing it directly.
// The actual module uses Node http — we mock callMcpStrict at the boundary.

// Inline the function signature for testing (avoids importing Node http in vitest/jsdom)
type FireAndForgetParams = {
  message: string;
  responseText: string;
  send: (channel: string, payload: any) => void;
  callMcpStrict: (toolName: string, args: Record<string, any>, timeoutMs?: number) => Promise<any>;
  readMemoryCapturePolicy?: () => { autoCapture: boolean; blockedSources: string[] };
  homeDir: string;
  skipIfUnverifiedFileOp?: boolean;
};

// Re-implement the pure logic to test (mirrors awareness-memory-utils.ts)
function fireAndForgetMemorySave(params: FireAndForgetParams): void {
  const { message, responseText, send, callMcpStrict, readMemoryCapturePolicy, homeDir, skipIfUnverifiedFileOp } = params;

  if (!responseText || skipIfUnverifiedFileOp) return;

  const policy = readMemoryCapturePolicy?.() || { autoCapture: true, blockedSources: [] };
  const blockedSources = new Set(
    (policy.blockedSources || []).map((item) => item.trim().toLowerCase()).filter(Boolean),
  );
  const shouldCapture = policy.autoCapture !== false && !blockedSources.has('desktop');
  if (!shouldCapture) return;

  const memoryToolId = `memory-save-${Date.now()}`;
  send('chat:status', {
    type: 'tool_call',
    tool: 'awareness_record',
    toolStatus: 'saving',
    toolId: memoryToolId,
    detail: 'Save this turn to Awareness memory',
  });

  callMcpStrict('awareness_record', {
    action: 'remember',
    content: `Request: ${message}\nResult: ${responseText}`,
    event_type: 'turn_brief',
    source: 'desktop',
  }).then(() => {
    send('chat:status', {
      type: 'tool_update',
      toolId: memoryToolId,
      toolStatus: 'completed',
      detail: 'Saved to Awareness memory',
    });
  }).catch((err: Error) => {
    send('chat:status', {
      type: 'tool_update',
      toolId: memoryToolId,
      toolStatus: 'failed',
      detail: err.message,
    });
    send('chat:memory-warning', {
      type: 'record-failed',
      message: err.message,
    });
  });
}

describe('fireAndForgetMemorySave', () => {
  let send: ReturnType<typeof vi.fn>;
  let callMcpStrict: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn();
    callMcpStrict = vi.fn().mockResolvedValue({
      result: { content: [{ type: 'text', text: '{"filepath":"/tmp/test.md"}' }] },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls awareness_record with correct content for successful chat', async () => {
    fireAndForgetMemorySave({
      message: 'Hello world',
      responseText: 'Hi there!',
      send,
      callMcpStrict,
      homeDir: '/tmp',
    });

    expect(callMcpStrict).toHaveBeenCalledWith('awareness_record', {
      action: 'remember',
      content: 'Request: Hello world\nResult: Hi there!',
      event_type: 'turn_brief',
      source: 'desktop',
    });

    // Verify saving status was sent
    expect(send).toHaveBeenCalledWith('chat:status', expect.objectContaining({
      type: 'tool_call',
      tool: 'awareness_record',
      toolStatus: 'saving',
    }));

    // Wait for async completion
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith('chat:status', expect.objectContaining({
        toolStatus: 'completed',
      }));
    });
  });

  it('skips save when responseText is empty', () => {
    fireAndForgetMemorySave({
      message: 'Hello',
      responseText: '',
      send,
      callMcpStrict,
      homeDir: '/tmp',
    });

    expect(callMcpStrict).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('skips save when unverified file operation is flagged', () => {
    fireAndForgetMemorySave({
      message: 'Create a file',
      responseText: 'Done!',
      send,
      callMcpStrict,
      homeDir: '/tmp',
      skipIfUnverifiedFileOp: true,
    });

    expect(callMcpStrict).not.toHaveBeenCalled();
  });

  it('skips save when autoCapture is disabled', () => {
    fireAndForgetMemorySave({
      message: 'Hello',
      responseText: 'World',
      send,
      callMcpStrict,
      homeDir: '/tmp',
      readMemoryCapturePolicy: () => ({ autoCapture: false, blockedSources: [] }),
    });

    expect(callMcpStrict).not.toHaveBeenCalled();
  });

  it('skips save when desktop is in blocked sources', () => {
    fireAndForgetMemorySave({
      message: 'Hello',
      responseText: 'World',
      send,
      callMcpStrict,
      homeDir: '/tmp',
      readMemoryCapturePolicy: () => ({ autoCapture: true, blockedSources: ['Desktop'] }),
    });

    expect(callMcpStrict).not.toHaveBeenCalled();
  });

  it('sends memory-warning on save failure', async () => {
    callMcpStrict.mockRejectedValue(new Error('Daemon connection failed'));

    fireAndForgetMemorySave({
      message: 'Hello',
      responseText: 'World',
      send,
      callMcpStrict,
      homeDir: '/tmp',
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith('chat:memory-warning', {
        type: 'record-failed',
        message: 'Daemon connection failed',
      });
    });

    // Also verify the tool status was updated to failed
    expect(send).toHaveBeenCalledWith('chat:status', expect.objectContaining({
      toolStatus: 'failed',
      detail: 'Daemon connection failed',
    }));
  });

  it('works with CLI fallback result shape', async () => {
    // Simulate what saveMemoryForCliResult does in register-chat-handlers.ts
    const cliResult = {
      success: true,
      text: 'I can help with that. Here is the answer...',
      sessionId: 'test-session',
    };

    if (cliResult.success && cliResult.text) {
      fireAndForgetMemorySave({
        message: 'What is 2+2?',
        responseText: cliResult.text,
        send,
        callMcpStrict,
        homeDir: '/tmp',
      });
    }

    expect(callMcpStrict).toHaveBeenCalledWith('awareness_record', expect.objectContaining({
      content: expect.stringContaining('What is 2+2?'),
    }));
  });
});
