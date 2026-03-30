import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAppConfig } from '../lib/store';

const STORAGE_KEY = 'awareness-claw-config';

describe('Config sync (useAppConfig)', () => {
  beforeEach(() => {
    localStorage.clear();
    // Set a known baseline
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ language: 'en', autoRecall: true }));
  });

  it('updateConfig({ language: "zh" }) persists to localStorage', () => {
    const { result } = renderHook(() => useAppConfig());

    act(() => {
      result.current.updateConfig({ language: 'zh' });
    });

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.language).toBe('zh');
  });

  it('updateConfig({ autoRecall: false }) is reflected when re-reading config', () => {
    const { result } = renderHook(() => useAppConfig());

    act(() => {
      result.current.updateConfig({ autoRecall: false });
    });

    expect(result.current.config.autoRecall).toBe(false);

    // Also verify localStorage
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.autoRecall).toBe(false);
  });

  it('dispatches CustomEvent "awareness-config-changed" on updateConfig', () => {
    const handler = vi.fn();
    window.addEventListener('awareness-config-changed', handler);

    const { result } = renderHook(() => useAppConfig());

    act(() => {
      result.current.updateConfig({ language: 'ja' });
    });

    expect(handler).toHaveBeenCalledTimes(1);

    window.removeEventListener('awareness-config-changed', handler);
  });
});
