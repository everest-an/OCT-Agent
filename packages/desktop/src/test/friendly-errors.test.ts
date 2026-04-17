/**
 * Unit tests for friendly-errors helper.
 */

import { describe, it, expect } from 'vitest';
import { friendlyErrorMessage } from '../components/mission-flow/friendly-errors';

const t = (key: string, fallback?: string) => {
  const map: Record<string, string> = {
    'missionFlow.error.timeout': 'An agent stopped responding. Try again.',
    'missionFlow.error.agent_crash': 'An agent crashed.',
    'missionFlow.error.context_overflow': 'Task grew too large.',
    'missionFlow.error.permission_denied': 'Action blocked.',
    'missionFlow.error.tool_rejected': 'Tool call rejected.',
    'missionFlow.error.network_error': 'Network hiccup.',
    'missionFlow.error.unknown': 'Something unexpected.',
  };
  return map[key] ?? fallback ?? key;
};

describe('friendlyErrorMessage', () => {
  it('maps known codes to localized sentence', () => {
    expect(friendlyErrorMessage({ code: 'timeout' }, t)).toBe('An agent stopped responding. Try again.');
    expect(friendlyErrorMessage({ code: 'agent_crash' }, t)).toBe('An agent crashed.');
    expect(friendlyErrorMessage({ code: 'context_overflow' }, t)).toBe('Task grew too large.');
    expect(friendlyErrorMessage({ code: 'permission_denied' }, t)).toBe('Action blocked.');
    expect(friendlyErrorMessage({ code: 'network_error' }, t)).toBe('Network hiccup.');
  });

  it('falls back to raw text when code is unknown', () => {
    expect(friendlyErrorMessage({ code: 'foo', raw: 'raw message' }, t)).toBe('raw message');
  });

  it('detects timeout-like wording in raw text', () => {
    expect(friendlyErrorMessage({ raw: 'step idle for 900s' }, t)).toMatch(/Try again/);
  });

  it('detects permission-like wording in raw text', () => {
    expect(friendlyErrorMessage({ raw: 'permission denied for fs.write' }, t)).toMatch(/blocked/);
  });

  it('detects network-like wording in raw text', () => {
    expect(friendlyErrorMessage({ raw: 'fetch failed: ECONNREFUSED' }, t)).toMatch(/Network/);
  });

  it('detects context overflow wording', () => {
    expect(friendlyErrorMessage({ raw: 'context overflow — token limit exceeded' }, t)).toMatch(/too large/);
  });

  it('returns generic unknown for empty input', () => {
    expect(friendlyErrorMessage({}, t)).toBe('Something unexpected.');
  });

  it('prefers code match over raw keywords', () => {
    expect(friendlyErrorMessage({ code: 'timeout', raw: 'permission denied' }, t)).toBe('An agent stopped responding. Try again.');
  });

  it('tool_rejected known code maps correctly', () => {
    expect(friendlyErrorMessage({ code: 'tool_rejected' }, t)).toBe('Tool call rejected.');
  });
});
