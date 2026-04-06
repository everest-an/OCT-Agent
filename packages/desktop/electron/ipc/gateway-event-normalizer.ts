// Extracted from register-chat-handlers.ts — Gateway event normalization.
// No logic changes, only moved.

import { extractToolDetail } from './chat-message-builders';

function extractAssistantEventText(data: Record<string, unknown>): string | undefined {
  return extractToolDetail(
    data.thinking
    ?? data.reasoning
    ?? data.text
    ?? data.delta
    ?? data.content,
    Number.POSITIVE_INFINITY,
  );
}

export type NormalizedAgentEvent = {
  stream: 'assistant' | 'tool' | 'lifecycle';
  phase?: string;
  runId?: unknown;
  sessionKey?: string;
  seq?: unknown;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  text?: string;
  thinking?: string;
  raw?: unknown;
};

export function normalizeAgentGatewayEvent(eventName: string, payload: any): NormalizedAgentEvent | null {
  if (!payload || typeof payload !== 'object') return null;

  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const sessionKey = typeof payload?.sessionKey === 'string'
    ? payload.sessionKey
    : typeof data?.sessionKey === 'string'
      ? data.sessionKey
      : '';

  if (typeof payload?.stream === 'string') {
    if (payload.stream === 'tool') {
      const toolCallId = typeof data?.toolCallId === 'string' ? data.toolCallId : '';
      const toolName = typeof data?.name === 'string'
        ? data.name
        : typeof data?.tool === 'string'
          ? data.tool
          : undefined;
      return {
        stream: 'tool',
        phase: typeof data?.phase === 'string' ? data.phase : '',
        runId: payload?.runId,
        sessionKey,
        seq: payload?.seq,
        toolCallId,
        toolName,
        args: data?.args,
        partialResult: data?.partialResult,
        result: data?.result,
        isError: Boolean(data?.isError),
        raw: data,
      };
    }

    if (payload.stream === 'assistant') {
      const assistantText = extractAssistantEventText(data);
      if (!assistantText) return null;
      const isThinking = Boolean(data?.thinking || data?.reasoning)
        || (typeof data?.phase === 'string' && data.phase === 'thinking');
      return {
        stream: 'assistant',
        phase: isThinking ? 'thinking' : 'text',
        runId: payload?.runId,
        sessionKey,
        seq: payload?.seq,
        text: !isThinking && typeof data?.text === 'string' ? data.text : assistantText,
        thinking: isThinking ? assistantText : undefined,
        raw: data,
      };
    }

    if (payload.stream === 'lifecycle') {
      return {
        stream: 'lifecycle',
        phase: typeof data?.phase === 'string' ? data.phase : '',
        runId: payload?.runId,
        sessionKey,
        seq: payload?.seq,
        raw: data,
      };
    }
  }

  const nestedEvent = typeof payload?.event === 'string' ? payload.event : '';

  if (eventName === 'agent:assistant') {
    const assistantText = extractAssistantEventText(data);
    if (!assistantText) return null;
    const isThinking = Boolean(data?.thinking || data?.reasoning)
      || (typeof data?.phase === 'string' && data.phase === 'thinking');
    return {
      stream: 'assistant',
      phase: isThinking ? 'thinking' : 'text',
      runId: payload?.runId,
      sessionKey,
      seq: payload?.seq,
      text: !isThinking && typeof data?.text === 'string' ? data.text : assistantText,
      thinking: isThinking ? assistantText : undefined,
      raw: data,
    };
  }

  if (eventName === 'agent:lifecycle') {
    return {
      stream: 'lifecycle',
      phase: nestedEvent || (typeof data?.phase === 'string' ? data.phase : ''),
      runId: payload?.runId,
      sessionKey,
      seq: payload?.seq,
      raw: payload,
    };
  }

  if (eventName === 'agent:tool' || nestedEvent === 'tool.call' || nestedEvent === 'tool.output') {
    const toolCallId = typeof data?.toolCallId === 'string'
      ? data.toolCallId
      : typeof data?.id === 'string'
        ? data.id
        : '';
    const toolName = typeof data?.name === 'string'
      ? data.name
      : typeof data?.tool === 'string'
        ? data.tool
        : undefined;
    const phase = nestedEvent === 'tool.call'
      ? 'start'
      : data?.partialResult != null || data?.delta != null || data?.chunk != null
        ? 'update'
        : 'result';
    return {
      stream: 'tool',
      phase,
      runId: payload?.runId,
      sessionKey,
      seq: payload?.seq,
      toolCallId,
      toolName,
      args: data?.args ?? data?.input ?? data?.arguments,
      partialResult: data?.partialResult ?? data?.delta ?? data?.chunk,
      result: data?.result ?? data?.output ?? data?.stdout ?? data?.stderr ?? data?.content,
      isError: Boolean(data?.isError || data?.error),
      raw: payload,
    };
  }

  if (eventName === 'agent' && nestedEvent) {
    if (nestedEvent.startsWith('agent.')) {
      return {
        stream: 'lifecycle',
        phase: nestedEvent,
        runId: payload?.runId,
        sessionKey,
        seq: payload?.seq,
        raw: payload,
      };
    }
  }

  return null;
}
