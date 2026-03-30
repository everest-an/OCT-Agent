import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useDynamicProviders, MODEL_PROVIDERS } from '../lib/store';

describe('useDynamicProviders', () => {
  const origApi = (window as any).electronAPI;

  beforeEach(() => {
    (window as any).electronAPI = {
      ...origApi,
      modelsReadProviders: () => Promise.resolve({
        success: true,
        providers: [
          {
            key: 'custom-llm',
            baseUrl: 'https://custom.api',
            hasApiKey: true,
            models: [{ id: 'custom-v1', name: 'Custom V1' }],
          },
        ],
        primaryModel: '',
      }),
    };
  });

  afterEach(() => {
    (window as any).electronAPI = origApi;
  });

  it('includes all hardcoded MODEL_PROVIDERS', async () => {
    const { result } = renderHook(() => useDynamicProviders());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const keys = result.current.providers.map(p => p.key);
    for (const hp of MODEL_PROVIDERS) {
      expect(keys).toContain(hp.key);
    }
  });

  it('includes the custom-llm provider from dynamic data', async () => {
    const { result } = renderHook(() => useDynamicProviders());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const custom = result.current.providers.find(p => p.key === 'custom-llm');
    expect(custom).toBeDefined();
    expect(custom!.models).toHaveLength(1);
    expect(custom!.models[0].id).toBe('custom-v1');
  });

  it('custom provider has tag "Custom"', async () => {
    const { result } = renderHook(() => useDynamicProviders());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const custom = result.current.providers.find(p => p.key === 'custom-llm');
    expect(custom).toBeDefined();
    expect(custom!.tag).toBe('Custom');
  });
});
