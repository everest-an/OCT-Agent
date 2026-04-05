const NON_CHANNEL_IDS = new Set([
  '',
  'webchat',
  'internal',
  'main',
  'global',
  'unknown',
  'direct',
  'group',
  'channel',
]);

function normalizeChannelId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function deriveChannelFromSessionKey(sessionKey: unknown): string {
  const key = typeof sessionKey === 'string' ? sessionKey.trim().toLowerCase() : '';
  if (!key) return '';

  const segments = key.split(':').filter(Boolean);
  if (segments.length === 0) return '';

  // Canonical OpenClaw keys:
  // - agent:<agentId>:<channel>:direct:<peer>
  // - agent:<agentId>:<channel>:group:<peer>
  // - agent:<agentId>:<channel>:<accountId>:direct:<peer>
  if (segments[0] === 'agent' && segments.length >= 4) {
    const candidate = normalizeChannelId(segments[2]);
    const hasPeerKind = segments
      .slice(3, 6)
      .some((segment) => segment === 'direct' || segment === 'group' || segment === 'channel');
    if (candidate && hasPeerKind && !NON_CHANNEL_IDS.has(candidate)) {
      return candidate;
    }
    return '';
  }

  // Legacy keys:
  // - <channel>:direct:<peer>
  // - <channel>:group:<peer>
  // - <channel>:<accountId>:direct:<peer>
  const hasLegacyPeerKind = segments[1] === 'direct'
    || segments[1] === 'group'
    || segments[1] === 'channel'
    || segments[2] === 'direct'
    || segments[2] === 'group'
    || segments[2] === 'channel';
  if (hasLegacyPeerKind) {
    const candidate = normalizeChannelId(segments[0]);
    if (candidate && !NON_CHANNEL_IDS.has(candidate)) {
      return candidate;
    }
  }

  return '';
}

function resolveSessionChannelId(session: any): string {
  const candidate = normalizeChannelId(
    session?.channel
    || session?.lastChannel
    || session?.origin?.provider
    || deriveChannelFromSessionKey(session?.key),
  );
  return NON_CHANNEL_IDS.has(candidate) ? '' : candidate;
}

export function mapChannelSessions(
  sessions: any[],
  toFrontendId: (openclawId: string) => string,
) {
  return sessions
    .filter((session: any) => {
      const sessionKey = typeof session?.key === 'string' ? session.key : '';
      if (!sessionKey || sessionKey.includes(':subagent:')) return false;
      return Boolean(resolveSessionChannelId(session));
    })
    .map((session: any) => {
      const rawChannel = resolveSessionChannelId(session) || 'unknown';
      const channel = toFrontendId(rawChannel);
      const displayName = session.displayName || session.origin?.from || session.subject || session.key || '';
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