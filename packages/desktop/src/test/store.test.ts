import { describe, it, expect, beforeEach } from 'vitest';
import { MODEL_PROVIDERS } from '../lib/store';

describe('MODEL_PROVIDERS', () => {
  it('should have at least 10 providers', () => {
    expect(MODEL_PROVIDERS.length).toBeGreaterThanOrEqual(10);
  });

  it('all providers should have required fields', () => {
    for (const p of MODEL_PROVIDERS) {
      expect(p.key).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.baseUrl).toBeTruthy();
      expect(p.models.length).toBeGreaterThan(0);
      expect(typeof p.needsKey).toBe('boolean');
    }
  });

  it('all model IDs should be unique within provider', () => {
    for (const p of MODEL_PROVIDERS) {
      const ids = p.models.map(m => m.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    }
  });

  it('provider keys should be unique', () => {
    const keys = MODEL_PROVIDERS.map(p => p.key);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it('base URLs should be valid HTTP(S) URLs or localhost', () => {
    for (const p of MODEL_PROVIDERS) {
      expect(p.baseUrl).toMatch(/^https?:\/\//);
    }
  });

  it('should include major Chinese providers', () => {
    const keys = MODEL_PROVIDERS.map(p => p.key);
    expect(keys).toContain('qwen');
    expect(keys).toContain('deepseek');
    expect(keys).toContain('zai');
    expect(keys).toContain('moonshot');
  });

  it('should include major international providers', () => {
    const keys = MODEL_PROVIDERS.map(p => p.key);
    expect(keys).toContain('openai');
    expect(keys).toContain('anthropic');
    expect(keys).toContain('groq');
  });

  it('ollama should not require API key', () => {
    const ollama = MODEL_PROVIDERS.find(p => p.key === 'ollama');
    expect(ollama).toBeDefined();
    expect(ollama!.needsKey).toBe(false);
  });
});
