export function mapChannelSessions(
  sessions: any[],
  toFrontendId: (openclawId: string) => string,
) {
  return sessions
    .filter((session: any) => {
      const provider = session.origin?.provider || session.lastChannel || '';
      return provider && provider !== 'webchat' && !session.key?.includes(':subagent:');
    })
    .map((session: any) => {
      const rawChannel = session.lastChannel || session.origin?.provider || 'unknown';
      const channel = toFrontendId(rawChannel);
      const displayName = session.origin?.from || session.displayName || session.key || '';
      return {
        sessionKey: session.key,
        sessionId: session.sessionId,
        channel,
        displayName,
        status: session.status || 'idle',
        updatedAt: session.updatedAt,
        model: session.model,
      };
    });
}

export function mapChannelHistory(messages: any[]) {
  return (messages || []).map((message: any) => ({
    role: message.role,
    content: Array.isArray(message.content)
      ? message.content.map((chunk: any) => chunk.text || '').join('')
      : (message.content || ''),
    timestamp: message.timestamp || 0,
    model: message.model,
    id: message.__openclaw?.id || `ch-${message.timestamp || Date.now()}`,
  }));
}