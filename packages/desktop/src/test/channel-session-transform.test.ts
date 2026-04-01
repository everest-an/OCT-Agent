import { describe, expect, it, vi } from 'vitest';
import { mapChannelHistory, mapChannelSessions } from '../../electron/ipc/channel-session-transform';

describe('channel session transforms', () => {
  it('filters non-channel sessions and maps openclaw ids to frontend ids', () => {
    const toFrontendId = vi.fn((channel: string) => channel === 'openclaw-weixin' ? 'wechat' : channel);
    const result = mapChannelSessions([
      {
        key: 'session-1',
        sessionId: 'sid-1',
        lastChannel: 'openclaw-weixin',
        origin: { from: 'Alice' },
        status: 'active',
        updatedAt: 100,
        model: 'gpt',
      },
      {
        key: 'session-2:subagent:1',
        lastChannel: 'telegram',
      },
      {
        key: 'session-3',
        lastChannel: 'webchat',
      },
    ], toFrontendId);

    expect(result).toEqual([
      {
        sessionKey: 'session-1',
        sessionId: 'sid-1',
        channel: 'wechat',
        displayName: 'Alice',
        status: 'active',
        updatedAt: 100,
        model: 'gpt',
      },
    ]);
    expect(toFrontendId).toHaveBeenCalledWith('openclaw-weixin');
  });

  it('flattens array message content and preserves openclaw ids', () => {
    const result = mapChannelHistory([
      {
        role: 'assistant',
        content: [{ text: 'Hello' }, { text: ' world' }],
        timestamp: 123,
        model: 'claude',
        __openclaw: { id: 'msg-1' },
      },
      {
        role: 'user',
        content: 'Plain text',
      },
    ]);

    expect(result[0]).toEqual({
      role: 'assistant',
      content: 'Hello world',
      timestamp: 123,
      model: 'claude',
      id: 'msg-1',
    });
    expect(result[1].content).toBe('Plain text');
    expect(result[1].id).toMatch(/^ch-/);
  });
});