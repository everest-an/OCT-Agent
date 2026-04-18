import { describe, expect, it } from 'vitest';
import { buildDynamicSectionsFromSchema, setValueAtPath } from '../lib/openclaw-capabilities';
import {
  forceEnableDesktopBrowserAndWebCapabilities,
  mergeDesktopOpenClawConfig,
  needsDesktopLegacyBrowserWebMigration,
  sanitizeDesktopAwarenessPluginConfig,
  shouldUseLegacyWindowsOpenClawSafeMode,
  stripLegacyWindowsOpenClawRiskyConfig,
} from '../../electron/desktop-openclaw-config';

describe('openclaw capability schema helpers', () => {
  it('builds dynamic web-search fields from OpenClaw schema', () => {
    const schema = {
      properties: {
        tools: {
          properties: {
            web: {
              properties: {
                search: {
                  type: 'object',
                  properties: {
                    enabled: { type: 'boolean' },
                    provider: { type: 'string', enum: ['brave', 'gemini', 'grok', 'kimi', 'perplexity', 'firecrawl', 'exa', 'tavily', 'duckduckgo', 'ollama-web-search', 'browser'] },
                    apiKey: { anyOf: [{ type: 'string' }, { type: 'object' }] },
                    maxResults: { type: 'integer', maximum: 20 },
                  },
                },
              },
            },
          },
        },
      },
    };

    const sections = buildDynamicSectionsFromSchema(schema, 'tools.web', {
      search: { provider: 'brave' },
    });

    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe('Web Search');
    expect(sections[0].fields.map((field) => field.path)).toEqual([
      'tools.web.search.enabled',
      'tools.web.search.provider',
      'tools.web.search.apiKey',
      'tools.web.search.maxResults',
    ]);
    expect(sections[0].fields[1].type).toBe('select');
    expect(sections[0].fields[2].type).toBe('password');
    expect(sections[0].fields.find((field) => field.path === 'tools.web.search.provider')?.prominence).toBe('primary');
    expect(sections[0].fields.find((field) => field.path === 'tools.web.search.apiKey')?.prominence).toBe('primary');
    expect(sections[0].fields.find((field) => field.path === 'tools.web.search.enabled')?.prominence).toBe('advanced');
  });

  it('falls back to PROVIDER_LABELS dropdown when schema has no enum', () => {
    const schema = {
      properties: {
        tools: {
          properties: {
            web: {
              properties: {
                search: {
                  type: 'object',
                  properties: {
                    provider: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    };

    const sections = buildDynamicSectionsFromSchema(schema, 'tools.web', {
      search: { provider: 'tavily' },
    });

    const providerField = sections[0].fields.find((field) => field.path === 'tools.web.search.provider');
    expect(providerField?.type).toBe('select');
    expect(providerField?.options?.length).toBeGreaterThanOrEqual(10);
    expect(providerField?.options?.some((o) => o.value === 'tavily')).toBe(true);
    expect(providerField?.options?.some((o) => o.value === 'duckduckgo')).toBe(true);
    expect(providerField?.options?.some((option) => option.value === 'browser')).toBe(false);
  });

  it('prefers schema-provided search provider options over fallback desktop metadata', () => {
    const schema = {
      properties: {
        tools: {
          properties: {
            web: {
              properties: {
                search: {
                  type: 'object',
                  properties: {
                    provider: {
                      type: 'string',
                      enum: ['duckduckgo', 'brave'],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const sections = buildDynamicSectionsFromSchema(schema, 'tools.web');
    const providerField = sections[0].fields.find((field) => field.path === 'tools.web.search.provider');

    expect(providerField?.options).toEqual([
      { value: 'duckduckgo', label: 'DuckDuckGo' },
      { value: 'brave', label: 'Brave Search' },
    ]);
  });

  it('writes nested values immutably for schema-driven forms', () => {
    const next = setValueAtPath({ search: { provider: 'brave' } }, 'search.maxResults', 8);
    expect(next).toEqual({ search: { provider: 'brave', maxResults: 8 } });
  });
});

describe('desktop openclaw config merge', () => {
  it('merges nested tools.web config without dropping existing search fields', () => {
    const merged = mergeDesktopOpenClawConfig(
      {
        tools: {
          profile: 'coding',
          web: {
            search: {
              provider: 'brave',
              maxResults: 5,
            },
          },
        },
      },
      {
        tools: {
          web: {
            search: {
              apiKey: 'secret',
            },
          },
        },
      },
      '/tmp',
    );

    expect(merged.tools.web.search).toEqual({
      provider: 'brave',
      enabled: true,
      maxResults: 5,
      apiKey: 'secret',
    });
  });

  it('fills missing keyless web defaults and keeps browser in restrictive plugin allowlists', () => {
    const merged = mergeDesktopOpenClawConfig(
      {
        plugins: {
          allow: ['openclaw-memory'],
        },
      },
      {},
      '/tmp',
    );

    expect(merged.browser.enabled).toBe(true);
    expect(merged.tools.web.search.enabled).toBe(true);
    expect(merged.tools.web.search.provider).toBe('duckduckgo');
    expect(merged.tools.web.fetch.enabled).toBe(true);
    expect(merged.plugins.allow).toEqual(expect.arrayContaining(['browser']));
  });

  it('preserves explicit web choices instead of overwriting them with desktop defaults', () => {
    const merged = mergeDesktopOpenClawConfig(
      {
        browser: {
          enabled: false,
        },
        tools: {
          web: {
            search: {
              enabled: false,
              provider: 'perplexity',
            },
            fetch: {
              enabled: false,
            },
          },
        },
      },
      {},
      '/tmp',
    );

    expect(merged.browser.enabled).toBe(false);
    expect(merged.tools.web.search.enabled).toBe(false);
    expect(merged.tools.web.search.provider).toBe('perplexity');
    expect(merged.tools.web.fetch.enabled).toBe(false);
  });

  it('one-time legacy migration force-enables browser and keyless web defaults for old desktop installs', () => {
    const config: Record<string, any> = {
      browser: {
        enabled: false,
      },
      plugins: {
        allow: ['openclaw-memory'],
      },
      tools: {
        web: {
          search: {
            enabled: false,
            provider: 'perplexity',
          },
          fetch: {
            enabled: false,
          },
        },
      },
    };

    expect(needsDesktopLegacyBrowserWebMigration(config)).toBe(true);

    forceEnableDesktopBrowserAndWebCapabilities(config);

    expect(config.browser.enabled).toBe(true);
    expect(config.tools.alsoAllow).toEqual(expect.arrayContaining(['browser', 'web_search', 'web_fetch']));
    expect(config.tools.web.search.enabled).toBe(true);
    expect(config.tools.web.search.provider).toBe('duckduckgo');
    expect(config.tools.web.fetch.enabled).toBe(true);
    expect(config.plugins.allow).toEqual(expect.arrayContaining(['browser']));
  });

  it('marks old configs without browser and web tools in alsoAllow as needing migration', () => {
    expect(needsDesktopLegacyBrowserWebMigration({
      browser: { enabled: true },
      plugins: { allow: ['openclaw-memory', 'browser'] },
      tools: {
        alsoAllow: ['exec', 'awareness_recall'],
        web: {
          search: { enabled: true, provider: 'duckduckgo' },
          fetch: { enabled: true },
        },
      },
    })).toBe(true);
  });

  it('marks legacy browser search provider values as needing migration', () => {
    expect(needsDesktopLegacyBrowserWebMigration({
      browser: { enabled: true },
      plugins: { allow: ['openclaw-memory', 'browser'] },
      tools: {
        alsoAllow: ['exec', 'browser', 'web_search', 'web_fetch'],
        web: {
          search: { enabled: true, provider: 'browser' },
          fetch: { enabled: true },
        },
      },
    })).toBe(true);
  });

  it('removes stale WeChat channel references when plugin is not installed', () => {
    const config: Record<string, any> = {
      channels: {
        'openclaw-weixin': {
          enabled: true,
          appId: 'demo',
        },
      },
      bindings: [
        { type: 'route', agentId: 'main', match: { channel: 'openclaw-weixin' } },
        { type: 'route', agentId: 'main', match: { channel: 'telegram' } },
      ],
      plugins: {
        allow: ['openclaw-memory', 'openclaw-weixin', '@tencent-weixin/openclaw-weixin'],
        entries: {
          'openclaw-memory': {
            enabled: true,
            config: {
              memoryId: 'stale',
            },
          },
          'openclaw-weixin': { enabled: true },
        },
        slots: {
          memory: 'openclaw-memory',
        },
      },
    };

    sanitizeDesktopAwarenessPluginConfig(config, '/tmp/awareness-desktop-test');

    expect(config.channels).toBeUndefined();
    expect(config.bindings).toEqual([
      { type: 'route', agentId: 'main', match: { channel: 'telegram' } },
    ]);
    expect(config.plugins.allow).toEqual(expect.arrayContaining(['browser']));
    expect(config.plugins.allow).not.toContain('openclaw-memory');
    expect(config.plugins.allow).not.toContain('openclaw-weixin');
    expect(config.plugins.allow).not.toContain('@tencent-weixin/openclaw-weixin');
    expect(config.plugins.entries['openclaw-memory']).toBeUndefined();
    expect(config.plugins.entries['openclaw-weixin']).toBeUndefined();
    expect(config.plugins.slots?.memory).toBeUndefined();
  });

  it('removes stale openclaw-memory slot assignments even when the plugin exists on disk', () => {
    const config: Record<string, any> = {
      plugins: {
        allow: ['openclaw-memory', 'browser'],
        entries: {
          'openclaw-memory': {
            enabled: true,
            config: { localUrl: 'http://127.0.0.1:37800' },
          },
        },
        slots: {
          memory: 'openclaw-memory',
        },
      },
    };

    sanitizeDesktopAwarenessPluginConfig(config, 'C:/Users/admin');

    expect(config.plugins.entries['openclaw-memory']).toBeDefined();
    expect(config.plugins.allow).toEqual(expect.arrayContaining(['openclaw-memory', 'browser']));
    expect(config.plugins.slots?.memory).toBeUndefined();
  });

  it('detects Windows OpenClaw 2026.4.10 as legacy safe-mode target', () => {
    expect(shouldUseLegacyWindowsOpenClawSafeMode('win32', '2026.4.10')).toBe(true);
    expect(shouldUseLegacyWindowsOpenClawSafeMode('win32', 'OpenClaw 2026.4.10 (44e5b62)')).toBe(true);
    expect(shouldUseLegacyWindowsOpenClawSafeMode('darwin', '2026.4.10')).toBe(false);
    expect(shouldUseLegacyWindowsOpenClawSafeMode('win32', '2026.4.14')).toBe(false);
  });

  it('strips startup config fields that are unsafe in Windows legacy safe mode', () => {
    const config: Record<string, any> = {
      browser: { enabled: true },
      session: { dmScope: 'per-channel-peer' },
      hooks: {
        internal: {
          enabled: true,
          entries: {
            'awareness-workspace-inject': {
              enabled: true,
              path: 'C:/Users/admin/.openclaw/hooks/awareness-workspace-inject/index.cjs',
            },
          },
        },
      },
      tools: {
        profile: 'coding',
        alsoAllow: ['exec', 'browser', 'web_search', 'sessions_spawn', 'awareness_recall'],
        web: {
          search: { enabled: true, provider: 'duckduckgo' },
        },
        agentToAgent: { enabled: true, allow: ['*'] },
      },
      plugins: {
        allow: ['qwen', 'browser', 'openclaw-memory', 'memory-core'],
        slots: { memory: 'openclaw-memory' },
        entries: {
          browser: { enabled: true },
          'openclaw-memory': { enabled: true },
          'memory-core': { enabled: false },
        },
      },
      agents: {
        defaults: {
          model: { primary: 'qwen/qwen-turbo-latest' },
          thinkingDefault: 'low',
          subagents: { maxSpawnDepth: 2 },
        },
        list: [
          {
            id: 'main',
            agentDir: 'C:/Users/admin/.openclaw/agents/main/agent',
            workspace: 'C:/Users/admin/.openclaw/workspace-main',
            subagents: { allowAgents: ['*'] },
          },
        ],
      },
    };

    stripLegacyWindowsOpenClawRiskyConfig(config);

    expect(config.browser).toBeUndefined();
    expect(config.session).toBeUndefined();
    expect(config.hooks).toBeUndefined();
    expect(config.tools.alsoAllow).toEqual(['exec', 'awareness_recall']);
    expect(config.tools.web).toBeUndefined();
    expect(config.tools.agentToAgent).toBeUndefined();
    expect(config.plugins.allow).toEqual(['qwen']);
    expect(config.plugins.entries).toBeUndefined();
    expect(config.plugins.slots).toBeUndefined();
    expect(config.agents.defaults.subagents).toBeUndefined();
    expect(config.agents.list[0].agentDir).toBeUndefined();
    expect(config.agents.list[0].workspace).toBeUndefined();
    expect(config.agents.list[0].subagents).toBeUndefined();
  });
});