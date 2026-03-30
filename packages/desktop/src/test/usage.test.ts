import { describe, it, expect, beforeEach } from 'vitest';
import { trackUsage, getUsageStats, clearUsage } from '../lib/usage';

describe('usage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('getUsageStats returns all zeros when no data', () => {
    const stats = getUsageStats();
    expect(stats.totalMessages).toBe(0);
    expect(stats.totalInputTokens).toBe(0);
    expect(stats.totalOutputTokens).toBe(0);
    expect(stats.todayMessages).toBe(0);
    expect(stats.todayInputTokens).toBe(0);
    expect(stats.todayOutputTokens).toBe(0);
    expect(stats.byModel).toEqual({});
  });

  it('trackUsage records and getUsageStats reflects correct totals and today counts', () => {
    trackUsage('openai', 'gpt-4', 'hello', 'world');

    const stats = getUsageStats();
    expect(stats.totalMessages).toBe(1);
    expect(stats.todayMessages).toBe(1);
    expect(stats.totalInputTokens).toBeGreaterThan(0);
    expect(stats.totalOutputTokens).toBeGreaterThan(0);
    expect(stats.todayInputTokens).toBe(stats.totalInputTokens);
    expect(stats.todayOutputTokens).toBe(stats.totalOutputTokens);
  });

  it('trackUsage groups byModel correctly after multiple calls', () => {
    trackUsage('openai', 'gpt-4', 'a', 'b');
    trackUsage('openai', 'gpt-4', 'c', 'd');
    trackUsage('anthropic', 'claude-3', 'e', 'f');

    const stats = getUsageStats();
    expect(stats.totalMessages).toBe(3);

    expect(stats.byModel['openai/gpt-4']).toBeDefined();
    expect(stats.byModel['openai/gpt-4'].messages).toBe(2);

    expect(stats.byModel['anthropic/claude-3']).toBeDefined();
    expect(stats.byModel['anthropic/claude-3'].messages).toBe(1);
  });

  it('clearUsage resets getUsageStats to zeros', () => {
    trackUsage('openai', 'gpt-4', 'hello', 'world');
    expect(getUsageStats().totalMessages).toBe(1);

    clearUsage();

    const stats = getUsageStats();
    expect(stats.totalMessages).toBe(0);
    expect(stats.totalInputTokens).toBe(0);
    expect(stats.totalOutputTokens).toBe(0);
    expect(stats.todayMessages).toBe(0);
    expect(stats.byModel).toEqual({});
  });

  it('estimates tokens reasonably for pure English text', () => {
    // "hello world" = 11 chars, English only → Math.ceil(11 / 4) = 3 tokens
    trackUsage('test', 'model', 'hello world', '');

    const stats = getUsageStats();
    expect(stats.totalInputTokens).toBe(3);
  });
});
