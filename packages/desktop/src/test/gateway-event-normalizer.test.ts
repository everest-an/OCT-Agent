import { describe, expect, it } from 'vitest';
import { normalizeAgentGatewayEvent, type NormalizedAgentEvent } from '../../electron/ipc/gateway-event-normalizer';

// L1 Contract Guard: every stream type declared in NormalizedAgentEvent must be
// producible by normalizeAgentGatewayEvent, and the type union must include 'thinking'.

describe('gateway-event-normalizer contract', () => {
  it('produces stream="thinking" from payload.stream="thinking" with delta', () => {
    const result = normalizeAgentGatewayEvent('agent', {
      stream: 'thinking',
      delta: 'analyzing code',
      runId: 'run-1',
      sessionKey: 'sess-1',
    }) as NormalizedAgentEvent;

    expect(result).not.toBeNull();
    expect(result.stream).toBe('thinking');
    expect(result.delta).toBe('analyzing code');
    expect(result.text).toBe('analyzing code');
  });

  it('produces stream="thinking" with text fallback when delta is absent', () => {
    const result = normalizeAgentGatewayEvent('agent', {
      stream: 'thinking',
      text: 'fallback text',
      runId: 'run-2',
      sessionKey: 'sess-2',
    }) as NormalizedAgentEvent;

    expect(result).not.toBeNull();
    expect(result.stream).toBe('thinking');
    expect(result.delta).toBe('fallback text');
  });

  it('produces stream="thinking" reading delta from nested data object', () => {
    const result = normalizeAgentGatewayEvent('agent', {
      stream: 'thinking',
      data: { delta: 'nested delta' },
      runId: 'run-3',
      sessionKey: 'sess-3',
    }) as NormalizedAgentEvent;

    expect(result).not.toBeNull();
    expect(result.stream).toBe('thinking');
    expect(result.delta).toBe('nested delta');
  });

  it('produces empty delta for thinking event with no text content', () => {
    const result = normalizeAgentGatewayEvent('agent', {
      stream: 'thinking',
      runId: 'run-4',
      sessionKey: 'sess-4',
    }) as NormalizedAgentEvent;

    expect(result).not.toBeNull();
    expect(result.stream).toBe('thinking');
    expect(result.delta).toBe('');
  });

  it('still produces assistant/tool/lifecycle for their respective stream values', () => {
    const assistant = normalizeAgentGatewayEvent('agent', {
      stream: 'assistant',
      data: { text: 'hello' },
      runId: 'r1',
    });
    expect(assistant?.stream).toBe('assistant');

    const tool = normalizeAgentGatewayEvent('agent', {
      stream: 'tool',
      data: { toolCallId: 'tc1', phase: 'start' },
      runId: 'r2',
    });
    expect(tool?.stream).toBe('tool');

    const lifecycle = normalizeAgentGatewayEvent('agent', {
      stream: 'lifecycle',
      data: { phase: 'done' },
      runId: 'r3',
    });
    expect(lifecycle?.stream).toBe('lifecycle');
  });

  it('returns null for unknown stream types', () => {
    const result = normalizeAgentGatewayEvent('agent', {
      stream: 'unknown-stream',
      data: { foo: 'bar' },
    });
    expect(result).toBeNull();
  });

  it('returns null for non-object payloads', () => {
    expect(normalizeAgentGatewayEvent('agent', null)).toBeNull();
    expect(normalizeAgentGatewayEvent('agent', 'string')).toBeNull();
    expect(normalizeAgentGatewayEvent('agent', 42)).toBeNull();
  });

  // Type-level contract: NormalizedAgentEvent.stream must include 'thinking'.
  // This is a compile-time check — if 'thinking' is removed from the union,
  // this assignment will fail to compile.
  it('type-level: NormalizedAgentEvent.stream includes thinking (compile-time guard)', () => {
    const streamVal: NormalizedAgentEvent['stream'] = 'thinking';
    expect(streamVal).toBe('thinking');
  });

  // L1 Contract: stream:"item" events (globally broadcast tool progress) normalize to tool events
  it('normalizes stream="item" start event to tool stream with phase start', () => {
    const result = normalizeAgentGatewayEvent('agent', {
      stream: 'item',
      runId: 'run-item-1',
      sessionKey: 'agent:main:webchat:ac-123',
      data: {
        itemId: 'tool:toolu_abc',
        phase: 'start',
        kind: 'tool',
        title: 'exec',
        status: 'running',
        name: 'exec',
        meta: 'ls -la',
        toolCallId: 'toolu_abc',
      },
    }) as NormalizedAgentEvent;

    expect(result).not.toBeNull();
    expect(result.stream).toBe('tool');
    expect(result.phase).toBe('start');
    expect(result.toolCallId).toBe('toolu_abc');
    expect(result.toolName).toBe('exec');
    expect(result.args).toEqual({ command: 'ls -la' });
  });

  it('normalizes stream="item" end event to tool stream with phase result', () => {
    const result = normalizeAgentGatewayEvent('agent', {
      stream: 'item',
      runId: 'run-item-2',
      data: {
        itemId: 'tool:toolu_def',
        phase: 'end',
        kind: 'tool',
        title: 'exec',
        status: 'completed',
        name: 'exec',
        toolCallId: 'toolu_def',
        summary: 'Listed 15 files',
      },
    }) as NormalizedAgentEvent;

    expect(result).not.toBeNull();
    expect(result.stream).toBe('tool');
    expect(result.phase).toBe('result');
    expect(result.result).toBe('Listed 15 files');
    expect(result.isError).toBe(false);
  });

  it('normalizes stream="item" with failed status as error', () => {
    const result = normalizeAgentGatewayEvent('agent', {
      stream: 'item',
      runId: 'run-item-3',
      data: {
        phase: 'end',
        status: 'failed',
        error: 'command not found',
        toolCallId: 'toolu_ghi',
      },
    }) as NormalizedAgentEvent;

    expect(result).not.toBeNull();
    expect(result.isError).toBe(true);
    expect(result.result).toBe('command not found');
  });

  // L1 Contract: stream:"command_output" events normalize to tool update/result
  it('normalizes stream="command_output" delta to tool update', () => {
    const result = normalizeAgentGatewayEvent('agent', {
      stream: 'command_output',
      runId: 'run-cmd-1',
      sessionKey: 'agent:main:webchat:ac-456',
      data: {
        itemId: 'command:toolu_xyz',
        phase: 'delta',
        title: 'exec',
        toolCallId: 'toolu_xyz',
        output: 'total 42\ndrwxr-xr-x  5 user  staff',
        status: 'running',
      },
    }) as NormalizedAgentEvent;

    expect(result).not.toBeNull();
    expect(result.stream).toBe('tool');
    expect(result.phase).toBe('update');
    expect(result.toolCallId).toBe('toolu_xyz');
    expect(result.partialResult).toBe('total 42\ndrwxr-xr-x  5 user  staff');
  });

  it('normalizes stream="command_output" end to tool result with exit code', () => {
    const result = normalizeAgentGatewayEvent('agent', {
      stream: 'command_output',
      runId: 'run-cmd-2',
      data: {
        phase: 'end',
        toolCallId: 'toolu_fin',
        name: 'exec',
        output: 'done',
        exitCode: 0,
        status: 'completed',
      },
    }) as NormalizedAgentEvent;

    expect(result).not.toBeNull();
    expect(result.stream).toBe('tool');
    expect(result.phase).toBe('result');
    expect(result.result).toBe('done');
    expect(result.isError).toBe(false);
  });

  it('normalizes stream="command_output" end with non-zero exit as error', () => {
    const result = normalizeAgentGatewayEvent('agent', {
      stream: 'command_output',
      runId: 'run-cmd-3',
      data: {
        phase: 'end',
        toolCallId: 'toolu_err',
        exitCode: 1,
        status: 'failed',
      },
    }) as NormalizedAgentEvent;

    expect(result).not.toBeNull();
    expect(result.isError).toBe(true);
    expect(result.phase).toBe('result');
  });
});
