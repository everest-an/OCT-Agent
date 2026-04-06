// Extracted from register-chat-handlers.ts — pure functions for message formatting.
// No logic changes, only moved.

export function normalizeDesktopRole(role: unknown): 'user' | 'assistant' {
  return role === 'user' ? 'user' : 'assistant';
}

export function normalizeContentBlocks(message: any): any[] {
  return Array.isArray(message?.content)
    ? message.content.filter((block: any) => block && typeof block === 'object')
    : [];
}

export function extractAssistantText(message: any): string {
  if (!message) return '';
  if (Array.isArray(message.content)) {
    return message.content
      .map((contentBlock: any) => contentBlock?.type === 'text' ? (contentBlock.text || '') : '')
      .join('');
  }
  if (typeof message.content === 'string') {
    return message.content;
  }
  return '';
}

export function extractAssistantThinking(message: any): string {
  if (!message) return '';
  if (Array.isArray(message.content)) {
    const parts = message.content
      .map((contentBlock: any) => {
        if (contentBlock?.type === 'thinking') return contentBlock.thinking || contentBlock.text || '';
        if (contentBlock?.type === 'reasoning') return contentBlock.reasoning || contentBlock.text || '';
        return '';
      })
      .filter((part: string) => Boolean(part?.trim()));
    if (parts.length > 0) return parts.join('\n');
  }
  if (typeof message.content === 'string' && message.content.startsWith('Reasoning:')) {
    return message.content.replace(/^Reasoning:\s*/, '').trim();
  }
  return '';
}

export function truncateDetail(text: string, maxChars = 600): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return text;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export function extractToolDetail(value: unknown, maxChars = 10000): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? truncateDetail(trimmed, maxChars) : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractToolDetail(entry, maxChars))
      .filter((entry): entry is string => Boolean(entry));
    return parts.length > 0 ? truncateDetail(parts.join('\n'), maxChars) : undefined;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const directKeys = ['text', 'output', 'stdout', 'stderr', 'message', 'detail', 'summary'];
    for (const key of directKeys) {
      const extracted = extractToolDetail(record[key], maxChars);
      if (extracted) return extracted;
    }
    if (Array.isArray(record.content)) {
      const contentParts = (record.content as unknown[])
        .map((entry) => {
          if (entry && typeof entry === 'object') {
            const block = entry as Record<string, unknown>;
            return extractToolDetail(block.text ?? block.content ?? block.output, maxChars);
          }
          return extractToolDetail(entry, maxChars);
        })
        .filter((entry): entry is string => Boolean(entry));
      if (contentParts.length > 0) return truncateDetail(contentParts.join('\n'), maxChars);
    }
    try {
      return truncateDetail(JSON.stringify(record), maxChars);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function extractToolArgs(block: Record<string, unknown>): unknown {
  return block.input ?? block.arguments ?? block.args ?? {};
}

export function extractToolOutput(block: Record<string, unknown>): string | undefined {
  if (Array.isArray(block.content)) {
    const contentText = extractToolDetail(block.content, Number.POSITIVE_INFINITY);
    if (contentText) return contentText;
  }
  return extractToolDetail(block.result ?? block.output ?? block.stdout ?? block.stderr ?? block.text ?? block.message, Number.POSITIVE_INFINITY);
}

export function buildToolCallsFromBlocks(contentBlocks: any[]): Array<Record<string, unknown>> {
  const toolCalls = new Map<string, Record<string, unknown>>();
  for (const rawBlock of contentBlocks) {
    const block = rawBlock as Record<string, unknown>;
    const type = String(block.type || '');
    if (type === 'tool_use' || type === 'toolcall' || type === 'tool_call') {
      const toolId = String(block.id || block.toolCallId || `tool-${toolCalls.size + 1}`);
      const args = extractToolArgs(block);
      toolCalls.set(toolId, {
        id: toolId,
        name: String(block.name || 'tool'),
        status: 'running',
        timestamp: Date.now(),
        detail: extractToolDetail(args, Number.POSITIVE_INFINITY),
        args,
      });
      continue;
    }

    if (type === 'tool_result' || type === 'toolresult' || type === 'tool_result_block') {
      const toolId = String(block.tool_use_id || block.toolCallId || block.id || `tool-result-${toolCalls.size + 1}`);
      const existing = toolCalls.get(toolId);
      toolCalls.set(toolId, {
        id: toolId,
        name: String(block.name || existing?.name || 'tool'),
        status: block.is_error || block.isError ? 'failed' : 'completed',
        timestamp: Date.now(),
        detail: existing?.detail,
        args: existing?.args,
        output: extractToolOutput(block),
      });
    }
  }

  return [...toolCalls.values()];
}

export function buildDesktopMessage(msg: any) {
  const contentBlocks = normalizeContentBlocks(msg);
  const toolCalls = buildToolCallsFromBlocks(contentBlocks);
  return {
    id: msg.__openclaw?.id || `gw-${msg.timestamp || Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    role: normalizeDesktopRole(msg.role),
    content: extractAssistantText(msg),
    timestamp: msg.timestamp || Date.now(),
    model: msg.model,
    thinking: extractAssistantThinking(msg) || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
  };
}

export function mergeToolResultIntoAssistantMessage(
  assistantMessage: Record<string, any>,
  block: Record<string, unknown>,
) {
  const toolId = String(block.tool_use_id || block.toolCallId || block.id || '');
  if (!toolId) return;

  const existingToolCalls = Array.isArray(assistantMessage.toolCalls) ? assistantMessage.toolCalls : [];
  const output = extractToolOutput(block);
  const nextToolCalls = existingToolCalls.map((toolCall: Record<string, unknown>) => (
    toolCall.id === toolId
      ? {
          ...toolCall,
          status: block.is_error || block.isError ? 'failed' : 'completed',
          output: output || toolCall.output,
        }
      : toolCall
  ));
  assistantMessage.toolCalls = nextToolCalls;
  assistantMessage.contentBlocks = [
    ...(Array.isArray(assistantMessage.contentBlocks) ? assistantMessage.contentBlocks : []),
    block,
  ];
}

export function buildDesktopHistory(rawMessages: any[]): Array<Record<string, any>> {
  const desktopMessages: Array<Record<string, any>> = [];
  const assistantMessageByToolId = new Map<string, Record<string, any>>();

  for (const rawMessage of rawMessages || []) {
    const desktopMessage = buildDesktopMessage(rawMessage);
    const contentBlocks = normalizeContentBlocks(rawMessage);
    const toolResultBlocks = contentBlocks.filter((block: any) => {
      const type = String(block?.type || '');
      return type === 'tool_result' || type === 'toolresult' || type === 'tool_result_block';
    });

    if (desktopMessage.role === 'assistant') {
      desktopMessages.push(desktopMessage);
      for (const toolCall of desktopMessage.toolCalls || []) {
        if (toolCall?.id) assistantMessageByToolId.set(String(toolCall.id), desktopMessage);
      }
      continue;
    }

    let mergedToolResultCount = 0;
    for (const block of toolResultBlocks) {
      const toolId = String(block.tool_use_id || block.toolCallId || block.id || '');
      const assistantMessage = assistantMessageByToolId.get(toolId);
      if (!assistantMessage) continue;
      mergeToolResultIntoAssistantMessage(assistantMessage, block);
      mergedToolResultCount += 1;
    }

    const hasOwnVisibleContent = Boolean(desktopMessage.content?.trim()) || Boolean(desktopMessage.thinking?.trim());
    const hasUnmergedBlocks = contentBlocks.length > mergedToolResultCount;
    if (hasOwnVisibleContent || hasUnmergedBlocks) {
      desktopMessages.push(desktopMessage);
    }
  }

  return desktopMessages;
}
