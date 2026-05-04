import fs from 'fs';
import path from 'path';
import {
  enforceDesktopChannelSessionIsolation,
  GATEWAY_DEFAULTS,
  migrateLegacyChannelConfig,
  normalizePluginAllow,
  writeDesktopExecApprovalDefaults,
} from './openclaw-config';
import { readJsonFileWithBom, safeWriteJsonFile } from './json-file';

const REDACTED_VALUE = '__REDACTED__';
export const DESKTOP_LEGACY_BROWSER_WEB_MIGRATION_ID = 'desktop-legacy-browser-web-defaults-v3-2026-04-04';

const DESKTOP_DEFAULT_ALLOWED_TOOLS = [
  'exec',
  'awareness_init',
  'awareness_recall',
  'awareness_lookup',
  'awareness_record',
  'awareness_get_agent_prompt',
];
const DESKTOP_BROWSER_WEB_ALLOWED_TOOLS = ['browser', 'web_search', 'web_fetch'];

const DESKTOP_REQUIRED_PLUGINS = ['openclaw-memory', 'browser'];
const DESKTOP_DEFAULT_WEB_SEARCH_PROVIDER = 'duckduckgo';
const DESKTOP_LEGACY_INVALID_WEB_SEARCH_PROVIDER = 'browser';
const LEGACY_WINDOWS_SAFE_MODE_HOOK_NAME = 'awareness-workspace-inject';
const LEGACY_WINDOWS_SAFE_MODE_TOOL_DENYLIST = new Set([
  'browser',
  'web_search',
  'web_fetch',
  'sessions_spawn',
  'agents_list',
]);
const LEGACY_WINDOWS_SAFE_MODE_PLUGIN_DENYLIST = new Set([
  'browser',
  'openclaw-memory',
  'memory-core',
  'memory-lancedb',
]);

export function shouldUseLegacyWindowsOpenClawSafeMode(
  platform: string,
  version: string | null | undefined,
) {
  const normalizedVersion = typeof version === 'string'
    ? (version.match(/(\d+\.\d+\.\d+)/)?.[1] || version)
    : '';
  return platform === 'win32' && normalizedVersion === '2026.4.10';
}

export function stripLegacyWindowsOpenClawRiskyConfig(config: Record<string, any>) {
  if (config.browser) {
    delete config.browser;
  }

  if (config.session?.dmScope !== undefined) {
    delete config.session.dmScope;
    if (Object.keys(config.session).length === 0) {
      delete config.session;
    }
  }

  if (config.tools) {
    if (config.tools.web) {
      delete config.tools.web;
    }
    if (config.tools.agentToAgent) {
      delete config.tools.agentToAgent;
    }
    if (Array.isArray(config.tools.alsoAllow)) {
      config.tools.alsoAllow = config.tools.alsoAllow.filter(
        (tool: string) => !LEGACY_WINDOWS_SAFE_MODE_TOOL_DENYLIST.has(tool),
      );
      if (config.tools.alsoAllow.length === 0) {
        delete config.tools.alsoAllow;
      }
    }
  }

  if (config.plugins) {
    if (config.plugins.entries && typeof config.plugins.entries === 'object') {
      for (const pluginId of LEGACY_WINDOWS_SAFE_MODE_PLUGIN_DENYLIST) {
        delete config.plugins.entries[pluginId];
      }
      if (Object.keys(config.plugins.entries).length === 0) {
        delete config.plugins.entries;
      }
    }
    const normalizedAllow = normalizePluginAllow(config.plugins.allow);
    if (normalizedAllow) {
      config.plugins.allow = normalizedAllow.filter((pluginId) => !LEGACY_WINDOWS_SAFE_MODE_PLUGIN_DENYLIST.has(pluginId));
      if (config.plugins.allow.length === 0) {
        delete config.plugins.allow;
      }
    }
    if (config.plugins.slots?.memory) {
      delete config.plugins.slots.memory;
      if (Object.keys(config.plugins.slots).length === 0) {
        delete config.plugins.slots;
      }
    }
  }

  if (config.hooks?.internal?.entries?.[LEGACY_WINDOWS_SAFE_MODE_HOOK_NAME]) {
    delete config.hooks.internal.entries[LEGACY_WINDOWS_SAFE_MODE_HOOK_NAME];
    if (Object.keys(config.hooks.internal.entries).length === 0) {
      delete config.hooks.internal.entries;
    }
    if (Object.keys(config.hooks.internal).every((key) => key === 'enabled')) {
      delete config.hooks.internal.enabled;
    }
    if (Object.keys(config.hooks.internal).length === 0) {
      delete config.hooks.internal;
    }
    if (Object.keys(config.hooks).length === 0) {
      delete config.hooks;
    }
  }

  if (config.agents?.defaults?.subagents) {
    delete config.agents.defaults.subagents;
  }

  if (Array.isArray(config.agents?.list)) {
    for (const agent of config.agents.list) {
      if (!agent || typeof agent !== 'object') continue;
      if (agent.agentDir !== undefined) delete agent.agentDir;
      if (agent.workspace !== undefined) delete agent.workspace;
      if (agent.subagents !== undefined) delete agent.subagents;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepMergePlainObjects(target: Record<string, any>, source: Record<string, any>) {
  const merged: Record<string, any> = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = deepMergePlainObjects(merged[key], value);
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

export function hasAwarenessPluginInstalled(homedir: string) {
  return fs.existsSync(path.join(homedir, '.openclaw', 'extensions', 'openclaw-memory', 'package.json'));
}

function hasWeixinPluginInstalled(homedir: string) {
  return fs.existsSync(path.join(homedir, '.openclaw', 'extensions', 'openclaw-weixin', 'package.json'));
}

function hasWhatsappPluginInstalled(homedir: string) {
  return fs.existsSync(path.join(homedir, '.openclaw', 'extensions', 'whatsapp', 'package.json'));
}

function stripDesktopOnlyConfigMarkers(config: Record<string, any>) {
  const containers = [
    config.channels,
    config.plugins?.entries,
  ];

  for (const container of containers) {
    if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
    for (const value of Object.values(container)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      delete (value as Record<string, any>).disabledByDesktop;
      delete (value as Record<string, any>).disabledReason;
    }
  }
}

export function ensureDesktopDefaultToolPermissions(config: Record<string, any>) {
  config.tools = {
    ...(config.tools || {}),
    profile: config.tools?.profile || 'coding',
  };

  const existingAllow = new Set<string>(config.tools.alsoAllow || []);
  for (const tool of DESKTOP_DEFAULT_ALLOWED_TOOLS) {
    existingAllow.add(tool);
  }
  config.tools.alsoAllow = [...existingAllow];
}

function ensureDesktopPluginAllowlist(config: Record<string, any>) {
  if (!config.plugins) return;

  const normalizedAllow = normalizePluginAllow(config.plugins.allow);
  if (!normalizedAllow) return;

  const allow = new Set<string>(normalizedAllow);
  for (const pluginId of DESKTOP_REQUIRED_PLUGINS) {
    allow.add(pluginId);
  }
  config.plugins.allow = [...allow];
}

export function needsDesktopLegacyBrowserWebMigration(config: Record<string, any>) {
  const normalizedAllow = normalizePluginAllow(config.plugins?.allow);
  if (normalizedAllow && !normalizedAllow.includes('browser')) {
    return true;
  }

  const allowedTools = new Set<string>(config.tools?.alsoAllow || []);
  for (const tool of DESKTOP_BROWSER_WEB_ALLOWED_TOOLS) {
    if (!allowedTools.has(tool)) {
      return true;
    }
  }

  return config.browser?.enabled === false
    || config.tools?.web?.search?.enabled === false
    || config.tools?.web?.search?.provider === DESKTOP_LEGACY_INVALID_WEB_SEARCH_PROVIDER
    || config.tools?.web?.fetch?.enabled === false;
}

export function forceEnableDesktopBrowserAndWebCapabilities(config: Record<string, any>) {
  config.browser = {
    ...(config.browser || {}),
    enabled: true,
  };

  config.tools = {
    ...(config.tools || {}),
  };

  const web = isPlainObject(config.tools.web) ? { ...config.tools.web } : {};
  const search = isPlainObject(web.search) ? { ...web.search } : {};
  const fetch = isPlainObject(web.fetch) ? { ...web.fetch } : {};

  search.enabled = true;
  search.provider = DESKTOP_DEFAULT_WEB_SEARCH_PROVIDER;
  fetch.enabled = true;

  web.search = search;
  web.fetch = fetch;
  config.tools.web = web;

  const alsoAllow = new Set<string>(config.tools.alsoAllow || []);
  for (const tool of DESKTOP_BROWSER_WEB_ALLOWED_TOOLS) {
    alsoAllow.add(tool);
  }
  config.tools.alsoAllow = [...alsoAllow];

  ensureDesktopPluginAllowlist(config);
}

export function ensureDesktopBrowserAndWebDefaults(config: Record<string, any>) {
  config.browser = {
    ...(config.browser || {}),
  };
  if (config.browser.enabled === undefined) {
    config.browser.enabled = true;
  }

  config.tools = {
    ...(config.tools || {}),
  };

  const web = isPlainObject(config.tools.web) ? { ...config.tools.web } : {};
  const search = isPlainObject(web.search) ? { ...web.search } : {};
  const fetch = isPlainObject(web.fetch) ? { ...web.fetch } : {};

  if (search.enabled === undefined) {
    search.enabled = true;
  }
  if (typeof search.provider !== 'string' || !search.provider.trim()) {
    search.provider = DESKTOP_DEFAULT_WEB_SEARCH_PROVIDER;
  }
  if (fetch.enabled === undefined) {
    fetch.enabled = true;
  }

  web.search = search;
  web.fetch = fetch;
  config.tools.web = web;

  ensureDesktopPluginAllowlist(config);
}

export function applyDesktopAwarenessPluginConfig(
  config: Record<string, any>,
  options?: { enableSlot?: boolean },
) {
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.entries) config.plugins.entries = {};

  ensureDesktopDefaultToolPermissions(config);
  ensureDesktopBrowserAndWebDefaults(config);

  config.plugins.entries['openclaw-memory'] = {
    ...(config.plugins.entries['openclaw-memory'] || {}),
    enabled: true,
    config: {
      ...(config.plugins.entries['openclaw-memory']?.config || {}),
      autoRecall: true,
      autoCapture: true,
      recallLimit: 8,
      localUrl: 'http://127.0.0.1:37800',
      baseUrl: 'https://awareness.market/api/v1',
      embeddingLanguage: 'multilingual',
    },
  };

  config.plugins.allow = Array.from(new Set([...(normalizePluginAllow(config.plugins.allow) || []), ...DESKTOP_REQUIRED_PLUGINS]));
  config.plugins.entries['memory-core'] = {
    ...(config.plugins.entries['memory-core'] || {}),
    enabled: false,
  };

  if (options?.enableSlot) {
    config.plugins.slots = {
      ...(config.plugins.slots || {}),
      memory: 'openclaw-memory',
    };
  }
}

export function sanitizeDesktopAwarenessPluginConfig(config: Record<string, any>, homedir: string) {
  stripDesktopOnlyConfigMarkers(config);
  ensureDesktopDefaultToolPermissions(config);
  ensureDesktopBrowserAndWebDefaults(config);
  migrateLegacyChannelConfig(config);
  enforceDesktopChannelSessionIsolation(config);

  config.gateway = {
    ...(config.gateway || {}),
    mode: GATEWAY_DEFAULTS.mode,
    bind: config.gateway?.bind || GATEWAY_DEFAULTS.bind,
    port: Number(config.gateway?.port) || GATEWAY_DEFAULTS.port,
  };

  if (!config.plugins) return;

  const normalizedAllow = normalizePluginAllow(config.plugins.allow);
  if (normalizedAllow) config.plugins.allow = normalizedAllow;
  else delete config.plugins.allow;

  if (config.plugins.entries?.['memory-awareness']) {
    delete config.plugins.entries['memory-awareness'];
  }

  if (!hasWeixinPluginInstalled(homedir)) {
    if (config.channels?.['openclaw-weixin']) {
      delete config.channels['openclaw-weixin'];
      if (Object.keys(config.channels).length === 0) delete config.channels;
    }
    if (Array.isArray(config.bindings)) {
      config.bindings = config.bindings.filter((binding: any) => binding?.match?.channel !== 'openclaw-weixin');
      if (config.bindings.length === 0) delete config.bindings;
    }
    if (config.plugins.entries?.['openclaw-weixin']) {
      delete config.plugins.entries['openclaw-weixin'];
    }
    if (Array.isArray(config.plugins.allow)) {
      config.plugins.allow = config.plugins.allow.filter((pluginId: string) => (
        pluginId !== 'openclaw-weixin' && pluginId !== '@tencent-weixin/openclaw-weixin'
      ));
    }
  }

  // If WhatsApp plugin package is missing and the channel is not currently enabled,
  // drop stale plugin references so OpenClaw doesn't spam "plugin not found" on every
  // CLI command. Keep active WhatsApp channel config untouched.
  if (!hasWhatsappPluginInstalled(homedir)) {
    const whatsappActive = config.channels?.whatsapp?.enabled === true
      || config.plugins?.entries?.whatsapp?.enabled === true;

    if (!whatsappActive) {
      if (config.plugins.entries?.whatsapp) {
        delete config.plugins.entries.whatsapp;
      }
      if (Array.isArray(config.plugins.allow)) {
        config.plugins.allow = config.plugins.allow.filter((pluginId: string) => (
          pluginId !== 'whatsapp' && pluginId !== '@openclaw/whatsapp'
        ));
      }
    }
  }

  // Workaround for OpenClaw upstream bug: `memory-lancedb` schema requires
  // `config.embedding` even when the entry is `enabled: false`, so an empty
  // or stub entry crashes `openclaw doctor` and blocks the runtime. We don't
  // ship lancedb (we use awareness-memory), so it's safe to remove the entry
  // whenever it's empty/disabled/missing the required `embedding` field.
  // If a power user has deliberately filled in a complete lancedb config we
  // leave it alone.
  const lancedbEntry = config.plugins.entries?.['memory-lancedb'];
  if (lancedbEntry && !lancedbEntry?.config?.embedding) {
    delete config.plugins.entries['memory-lancedb'];
  }

  // Strip auto-generated `agents.list[].workspace` fields that hard-sandbox
  // sub-agents into ~/.openclaw/workspace-<slug>/. When this field is set,
  // OpenClaw's write/exec/fs_read tools refuse to operate outside that dir,
  // so users see "I can't save the file" / "tool not ready" hallucinations
  // when asking a sub-agent to write into ~/Documents/anywhere. The `main`
  // agent has no such field by default and can write anywhere — sub-agents
  // should match. We only remove the field when it points at the auto path
  // pattern `~/.openclaw/workspace-<slug>`; if a power user has manually set
  // a real path (e.g. their actual project folder) we leave it alone.
  // Compatible with all OpenClaw versions because `workspace` is an optional
  // field — main agent has been running without it forever.
  const agentList: any[] = Array.isArray(config.agents?.list) ? config.agents.list : [];
  const autoWorkspacePrefix = path.join(homedir, '.openclaw', 'workspace-');
  for (const a of agentList) {
    const ws = a?.workspace;
    if (typeof ws === 'string' && ws.startsWith(autoWorkspacePrefix)) {
      delete a.workspace;
    }
  }

  const awarenessConfig = config.plugins.entries?.['openclaw-memory']?.config;
  if (awarenessConfig?.localUrl === 'http://localhost:37800') {
    awarenessConfig.localUrl = 'http://127.0.0.1:37800';
  }

  if (!hasAwarenessPluginInstalled(homedir) && config.plugins.entries?.['openclaw-memory']) {
    delete config.plugins.entries['openclaw-memory'];
  }

  if (Array.isArray(config.plugins.allow)) {
    config.plugins.allow = config.plugins.allow.filter((pluginId: string) => pluginId !== 'memory-awareness');
    if (!hasAwarenessPluginInstalled(homedir)) {
      config.plugins.allow = config.plugins.allow.filter((pluginId: string) => pluginId !== 'openclaw-memory');
    }
    if (config.plugins.allow.length === 0) delete config.plugins.allow;
  }

  if (config.plugins.slots?.memory === 'memory-awareness') {
    delete config.plugins.slots.memory;
  }

  if (config.plugins.slots?.memory === 'openclaw-memory' && !hasAwarenessPluginInstalled(homedir)) {
    delete config.plugins.slots.memory;
  }

  if (config.plugins.slots && Object.keys(config.plugins.slots).length === 0) {
    delete config.plugins.slots;
  }
}

export function persistDesktopAwarenessPluginConfig(
  homedir: string,
  options?: { enableSlot?: boolean },
) {
  const configDir = path.join(homedir, '.openclaw');
  const configPath = path.join(configDir, 'openclaw.json');
  fs.mkdirSync(configDir, { recursive: true });

  let config: Record<string, any> = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    config = {};
  }

  applyDesktopAwarenessPluginConfig(config, options);
  sanitizeDesktopAwarenessPluginConfig(config, homedir);
  safeWriteJsonFile(configPath, config);
  writeDesktopExecApprovalDefaults(homedir);
}

export function mergeDesktopOpenClawConfig(
  existing: Record<string, any>,
  incoming: Record<string, any>,
  homedir: string,
) {
  const merged = JSON.parse(JSON.stringify(existing || {}));

  for (const [key, value] of Object.entries(incoming || {})) {
    if (key === 'models') {
      merged.models = { ...(merged.models || {}) };
      const incomingModels = value as any;
      if (incomingModels?.providers) {
        merged.models.providers = { ...(merged.models.providers || {}) };
        for (const [providerKey, providerValue] of Object.entries(incomingModels.providers)) {
          merged.models.providers[providerKey] = {
            ...(merged.models.providers[providerKey] || {}),
            ...(providerValue as any),
          };
        }
      }
    } else if (key === 'agents') {
      merged.agents = JSON.parse(JSON.stringify(merged.agents || {}));
      const incomingAgents = value as any;
      if (incomingAgents?.defaults?.workspace !== undefined) {
        if (!merged.agents.defaults) merged.agents.defaults = {};
        merged.agents.defaults.workspace = incomingAgents.defaults.workspace;
      }
      if (incomingAgents?.defaults?.model?.primary) {
        if (!merged.agents.defaults) merged.agents.defaults = {};
        if (!merged.agents.defaults.model) merged.agents.defaults.model = {};
        merged.agents.defaults.model.primary = incomingAgents.defaults.model.primary;
      }
      // Merge verboseDefault and thinkingDefault into agents.defaults
      if (incomingAgents?.defaults?.verboseDefault) {
        if (!merged.agents.defaults) merged.agents.defaults = {};
        merged.agents.defaults.verboseDefault = incomingAgents.defaults.verboseDefault;
      }
      if (incomingAgents?.defaults?.thinkingDefault) {
        if (!merged.agents.defaults) merged.agents.defaults = {};
        merged.agents.defaults.thinkingDefault = incomingAgents.defaults.thinkingDefault;
      }
      // Merge per-agent settings (reasoningDefault is per-agent, not in defaults)
      if (Array.isArray(incomingAgents?.list)) {
        if (!merged.agents.list) merged.agents.list = [];
        for (const incomingAgent of incomingAgents.list) {
          const existing = merged.agents.list.find((a: any) => a.id === incomingAgent.id);
          if (existing) {
            Object.assign(existing, incomingAgent);
          } else {
            merged.agents.list.push(incomingAgent);
          }
        }
      }
    } else if (key === 'plugins') {
      merged.plugins = JSON.parse(JSON.stringify(merged.plugins || {}));
      const incomingPlugins = value as any;
      const normalizedAllow = normalizePluginAllow(incomingPlugins.allow);
      if (normalizedAllow) {
        const allow = new Set<string>(normalizePluginAllow(merged.plugins.allow) || []);
        for (const pluginId of normalizedAllow) allow.add(pluginId);
        merged.plugins.allow = [...allow];
      }
      if (incomingPlugins.slots) merged.plugins.slots = { ...(merged.plugins.slots || {}), ...incomingPlugins.slots };
      if (incomingPlugins.entries) {
        if (!merged.plugins.entries) merged.plugins.entries = {};
        for (const [entryId, entryConfig] of Object.entries(incomingPlugins.entries)) {
          const previous = merged.plugins.entries[entryId] || {};
          merged.plugins.entries[entryId] = { ...previous, ...(entryConfig as any) };
          if ((entryConfig as any)?.config && previous?.config) {
            merged.plugins.entries[entryId].config = { ...previous.config, ...(entryConfig as any).config };
          }
        }
      }
    } else if (key === 'gateway') {
      merged.gateway = {
        ...(merged.gateway || {}),
        ...(value as any),
      };
    } else if (key === 'tools') {
      merged.tools = JSON.parse(JSON.stringify(merged.tools || {}));
      const incomingTools = value as any;
      const toolExtras = { ...(incomingTools || {}) };

      delete toolExtras.alsoAllow;
      delete toolExtras.denied;
      delete toolExtras.profile;

      if (Object.keys(toolExtras).length > 0) {
        merged.tools = deepMergePlainObjects(merged.tools, toolExtras);
      }

      if (incomingTools.alsoAllow) {
        const existingAllow = new Set(merged.tools.alsoAllow || []);
        for (const tool of incomingTools.alsoAllow) existingAllow.add(tool);
        merged.tools.alsoAllow = [...existingAllow];
      }
      if (incomingTools.denied && incomingTools.denied.length > 0) merged.tools.denied = incomingTools.denied;
      if (incomingTools.profile) merged.tools.profile = incomingTools.profile;
    } else {
      merged[key] = value;
    }
  }

  sanitizeDesktopAwarenessPluginConfig(merged, homedir);

  return merged;
}

export function redactSensitiveValues(value: any): any {
  if (Array.isArray(value)) return value.map(redactSensitiveValues);
  if (!value || typeof value !== 'object') return value;

  const redacted: Record<string, any> = {};
  const sensitiveKeyPattern = /(api.?key|token|secret|password|appsecret|bot.?token|webhook|authorization)/i;

  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKeyPattern.test(key)) redacted[key] = REDACTED_VALUE;
    else redacted[key] = redactSensitiveValues(child);
  }

  return redacted;
}

export function stripRedactedValues(value: any): any {
  if (Array.isArray(value)) {
    return value.map(stripRedactedValues).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== 'object') {
    return value === REDACTED_VALUE ? undefined : value;
  }

  const cleaned: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    const next = stripRedactedValues(child);
    if (next !== undefined) cleaned[key] = next;
  }
  return cleaned;
}
