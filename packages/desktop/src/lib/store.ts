/**
 * Shared app config store — persists to localStorage + syncs to openclaw.json via IPC
 */

import { useState, useEffect, useCallback, useRef } from 'react';

const STORAGE_KEY = 'awareness-claw-config';

const DEFAULT_ALLOWED_TOOLS = [
  'exec',
  'awareness_init',
  'awareness_recall',
  'awareness_lookup',
  'awareness_record',
  'awareness_get_agent_prompt',
];

export interface ProviderStoredModel {
  id: string;
  label?: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
}

export interface ProviderProfile {
  apiKey: string;
  baseUrl: string;
  apiType?: string;
  models: ProviderStoredModel[];
  name?: string;
  emoji?: string;
  tag?: string;
  desc?: string;
  needsKey?: boolean;
  lastSyncedAt?: string;
}

export interface AppConfig {
  // Model
  providerKey: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  providerProfiles: Record<string, ProviderProfile>;
  // Memory
  autoRecall: boolean;
  autoCapture: boolean;
  recallLimit: number;
  memoryMode: 'local' | 'cloud';
  // Privacy — which sources are allowed to save to memory (empty = all allowed)
  memoryBlockedSources: string[];
  // Token optimization
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high';
  // Reasoning display — controls whether the model's thinking process is shown to the user
  reasoningDisplay: 'off' | 'on' | 'stream';
  // Appearance
  language: string;
  theme: 'dark' | 'light' | 'system';
  // System
  autoUpdate: boolean;
  autoStart: boolean;
  // Onboarding
  bootstrapCompleted: boolean;
  // Agent selection
  selectedAgentId: string;
}

const DEFAULT_CONFIG: AppConfig = {
  providerKey: '',
  modelId: '',
  apiKey: '',
  baseUrl: '',
  providerProfiles: {},
  autoRecall: true,
  autoCapture: true,
  recallLimit: 8,
  memoryMode: 'local',
  memoryBlockedSources: [],
  thinkingLevel: 'low',
  reasoningDisplay: 'on',
  language: 'zh',
  theme: 'dark',
  autoUpdate: true,
  autoStart: false,
  bootstrapCompleted: false,
  selectedAgentId: 'main',
};

function normalizeStoredModels(models: unknown): ProviderStoredModel[] {
  if (!Array.isArray(models)) return [];
  return models
    .filter((item): item is Record<string, any> => !!item && typeof item === 'object' && typeof item.id === 'string')
    .map((item) => ({
      id: item.id,
      ...(typeof item.label === 'string' ? { label: item.label } : {}),
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.reasoning === 'boolean' ? { reasoning: item.reasoning } : {}),
      ...(typeof item.contextWindow === 'number' ? { contextWindow: item.contextWindow } : {}),
      ...(typeof item.maxTokens === 'number' ? { maxTokens: item.maxTokens } : {}),
      ...(Array.isArray(item.input) ? { input: item.input.filter((value: unknown): value is string => typeof value === 'string') } : {}),
    }));
}

function normalizeProviderProfiles(profiles: unknown): Record<string, ProviderProfile> {
  if (!profiles || typeof profiles !== 'object') return {};

  const normalized: Record<string, ProviderProfile> = {};
  for (const [key, value] of Object.entries(profiles as Record<string, any>)) {
    if (!value || typeof value !== 'object') continue;
    normalized[key] = {
      apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
      baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
      ...(typeof value.apiType === 'string' ? { apiType: value.apiType } : {}),
      models: normalizeStoredModels(value.models),
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
      ...(typeof value.emoji === 'string' ? { emoji: value.emoji } : {}),
      ...(typeof value.tag === 'string' ? { tag: value.tag } : {}),
      ...(typeof value.desc === 'string' ? { desc: value.desc } : {}),
      ...(typeof value.needsKey === 'boolean' ? { needsKey: value.needsKey } : {}),
      ...(typeof value.lastSyncedAt === 'string' ? { lastSyncedAt: value.lastSyncedAt } : {}),
    };
  }
  return normalized;
}

// Migrate legacy provider keys to OpenClaw-aligned keys (one-time, idempotent)
const LEGACY_KEY_MAP: Record<string, string> = {
  'qwen-portal': 'qwen',
  'zhipu': 'zai',
  'alibaba': 'qwen',
};

function migrateProviderKeys(profiles: Record<string, ProviderProfile>, activeKey: string): { profiles: Record<string, ProviderProfile>; activeKey: string } {
  const migrated = { ...profiles };
  let newActiveKey = activeKey;
  for (const [oldKey, newKey] of Object.entries(LEGACY_KEY_MAP)) {
    if (migrated[oldKey]) {
      if (!migrated[newKey]) {
        migrated[newKey] = migrated[oldKey];
      }
      delete migrated[oldKey];
      if (newActiveKey === oldKey) newActiveKey = newKey;
    }
  }
  return { profiles: migrated, activeKey: newActiveKey };
}

function normalizeConfig(raw: Partial<AppConfig>): AppConfig {
  const rawProfiles = normalizeProviderProfiles(raw.providerProfiles);
  const { profiles: migratedProfiles, activeKey: migratedProviderKey } = migrateProviderKeys(
    rawProfiles,
    raw.providerKey || DEFAULT_CONFIG.providerKey,
  );

  const next: AppConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    providerKey: LEGACY_KEY_MAP[raw.providerKey || ''] || raw.providerKey || DEFAULT_CONFIG.providerKey,
    providerProfiles: migratedProfiles,
  };

  if (next.providerKey) {
    const existing = next.providerProfiles[next.providerKey] || {
      apiKey: '',
      baseUrl: '',
      models: [],
    };

    const activeProfile: ProviderProfile = {
      ...existing,
      // For the active provider, keep providerProfiles as source-of-truth.
      // This avoids stale top-level fields overriding freshly saved profile values.
      apiKey: existing.apiKey || next.apiKey || '',
      baseUrl: existing.baseUrl || next.baseUrl || '',
      models: existing.models || [],
      ...(existing.apiType ? { apiType: existing.apiType } : {}),
      ...(existing.name ? { name: existing.name } : {}),
      ...(existing.emoji ? { emoji: existing.emoji } : {}),
      ...(existing.tag ? { tag: existing.tag } : {}),
      ...(existing.desc ? { desc: existing.desc } : {}),
      ...(typeof existing.needsKey === 'boolean' ? { needsKey: existing.needsKey } : {}),
      ...(existing.lastSyncedAt ? { lastSyncedAt: existing.lastSyncedAt } : {}),
    };

    next.providerProfiles[next.providerKey] = activeProfile;
    next.apiKey = activeProfile.apiKey || '';
    next.baseUrl = activeProfile.baseUrl || '';
  }

  return next;
}

export function getProviderProfile(config: AppConfig, providerKey: string): ProviderProfile {
  const existing = config.providerProfiles?.[providerKey] || {
    apiKey: '',
    baseUrl: '',
    models: [],
  };

  if (providerKey && providerKey === config.providerKey) {
    return {
      ...existing,
      // Prefer profile values to avoid regressing to stale top-level fields.
      apiKey: existing.apiKey || config.apiKey || '',
      baseUrl: existing.baseUrl || config.baseUrl || '',
      models: existing.models || [],
    };
  }

  return {
    apiKey: existing.apiKey || '',
    baseUrl: existing.baseUrl || '',
    models: existing.models || [],
    ...(existing.apiType ? { apiType: existing.apiType } : {}),
    ...(existing.name ? { name: existing.name } : {}),
    ...(existing.emoji ? { emoji: existing.emoji } : {}),
    ...(existing.tag ? { tag: existing.tag } : {}),
    ...(existing.desc ? { desc: existing.desc } : {}),
    ...(typeof existing.needsKey === 'boolean' ? { needsKey: existing.needsKey } : {}),
    ...(existing.lastSyncedAt ? { lastSyncedAt: existing.lastSyncedAt } : {}),
  };
}

export function hasProviderCredentials(config: AppConfig, providerKey: string, needsKey: boolean): boolean {
  if (!needsKey) return true;
  return !!getProviderProfile(config, providerKey).apiKey;
}

function mergeProviderProfile(
  config: AppConfig,
  providerKey: string,
  profile: Partial<ProviderProfile>,
): AppConfig {
  const existing = getProviderProfile(config, providerKey);
  return {
    ...config,
    providerProfiles: {
      ...config.providerProfiles,
      [providerKey]: {
        ...existing,
        ...profile,
        models: profile.models ? normalizeStoredModels(profile.models) : existing.models,
      },
    },
  };
}

function getFallbackModels(providerKey: string, providers: ModelProviderDef[]): ProviderStoredModel[] {
  const provider = providers.find((item) => item.key === providerKey);
  return (provider?.models || []).map((model) => ({
    id: model.id,
    label: model.label,
    name: model.label,
  }));
}

function selectProviderModel(
  config: AppConfig,
  providerKey: string,
  modelId: string,
  providers: ModelProviderDef[],
): AppConfig {
  const provider = providers.find((item) => item.key === providerKey);
  const profile = getProviderProfile(config, providerKey);
  const effectiveModelId = modelId
    || profile.models[0]?.id
    || provider?.models[0]?.id
    || '';

  return {
    ...config,
    providerKey,
    modelId: effectiveModelId,
    apiKey: profile.apiKey || '',
    baseUrl: profile.baseUrl || provider?.baseUrl || '',
  };
}

function saveProviderSelection(
  config: AppConfig,
  input: {
    providerKey: string;
    modelId: string;
    apiKey?: string;
    baseUrl?: string;
    models?: ProviderStoredModel[];
    apiType?: string;
    name?: string;
    needsKey?: boolean;
  },
  providers: ModelProviderDef[],
): AppConfig {
  const provider = providers.find((item) => item.key === input.providerKey);
  const nextProfile: Partial<ProviderProfile> = {
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    ...(input.models ? { models: input.models } : {}),
    ...(input.apiType !== undefined ? { apiType: input.apiType } : provider?.apiType ? { apiType: provider.apiType } : {}),
    ...(input.name ? { name: input.name } : provider ? { name: provider.name } : {}),
    ...(typeof input.needsKey === 'boolean' ? { needsKey: input.needsKey } : provider ? { needsKey: provider.needsKey } : {}),
    lastSyncedAt: new Date().toISOString(),
  };

  const merged = mergeProviderProfile(config, input.providerKey, nextProfile);
  return selectProviderModel(merged, input.providerKey, input.modelId, providers);
}

function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeConfig(JSON.parse(raw));
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: AppConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  // Notify all useAppConfig instances to re-read (fixes language switch not updating Sidebar)
  window.dispatchEvent(new CustomEvent('awareness-config-changed'));
}

/** Sync relevant settings to ~/.openclaw/openclaw.json */
async function syncToOpenClaw(config: AppConfig, providers: ModelProviderDef[]) {
  if (!window.electronAPI) return;

  const openclawConfig: Record<string, any> = {
    gateway: {
      mode: 'local',
      bind: 'loopback',
      port: 18789,
    },
    plugins: {
      allow: ['openclaw-memory', 'browser'],
    },
    // Ensure coding profile (includes browser, file ops, exec, web tools) and Awareness tools
    tools: {
      profile: 'coding',
      alsoAllow: DEFAULT_ALLOWED_TOOLS,
    },
  };

  // Sync memory settings to plugin config (autoRecall, recallLimit, memoryMode)
  openclawConfig.plugins = {
    ...openclawConfig.plugins,
    slots: { memory: 'openclaw-memory' },
    entries: {
      'openclaw-memory': {
        enabled: true,
        config: {
          autoRecall: config.autoRecall,
          autoCapture: config.autoCapture,
          recallLimit: config.recallLimit,
          ...(config.memoryMode === 'local' ? { localUrl: 'http://127.0.0.1:37800' } : {}),
          ...(config.memoryBlockedSources?.length ? { blockedSources: config.memoryBlockedSources } : {}),
        },
      },
      'memory-core': { enabled: false },
      'memory-lancedb': { enabled: false },
    },
  };

  const providerKeys = new Set<string>([
    ...providers.map((provider) => provider.key),
    ...Object.keys(config.providerProfiles || {}),
  ]);

  const syncedProviders: Record<string, any> = {};

  for (const providerKey of providerKeys) {
    const provider = providers.find((item) => item.key === providerKey);
    const profile = getProviderProfile(config, providerKey);
    // OpenClaw schema requires baseUrl to be a non-empty string for every provider entry.
    // Use user-customized value if set, otherwise fall back to the hardcoded default.
    const effectiveBaseUrl = profile.baseUrl || provider?.baseUrl || '';
    const effectiveApiKey = profile.apiKey || '';
    const effectiveModels = (profile.models?.length ? profile.models : getFallbackModels(providerKey, providers))
      .map((model) => ({
        id: model.id,
        name: (model.name || model.label || model.id).split('（')[0].split('(')[0].trim(),
        ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : { reasoning: false }),
        ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
        ...(typeof model.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {}),
        input: Array.isArray(model.input) && model.input.length > 0 ? model.input : ['text'],
      }));

    // Skip providers that have no API key configured — writing empty-key providers
    // pollutes openclaw.json and confuses users (e.g. DeepSeek appearing without a key).
    // Exception: ollama (local) doesn't need an API key.
    if (!effectiveApiKey && providerKey !== 'ollama') continue;
    if (!effectiveBaseUrl && effectiveModels.length === 0 && !effectiveApiKey) continue;

    syncedProviders[providerKey] = {
      ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
      ...(effectiveApiKey ? { apiKey: effectiveApiKey } : {}),
      ...(profile.apiType || provider?.apiType ? { api: profile.apiType || provider?.apiType } : {}),
      ...(effectiveModels.length > 0 ? { models: effectiveModels } : {}),
    };
  }

  if (config.modelId) {
    const activeProvider = providers.find((item) => item.key === config.providerKey);
    const activeProfile = getProviderProfile(config, config.providerKey);
    const profileModelIds = (activeProfile.models?.length
      ? activeProfile.models
      : getFallbackModels(config.providerKey, providers)
    )
      .map((model) => String(model.id || '').trim())
      .filter(Boolean);

    const selectedModelId = String(config.modelId || '').trim();
    const fallbackModelId = profileModelIds[0] || activeProvider?.models[0]?.id || '';
    const effectiveModelId = selectedModelId || fallbackModelId;
    const normalizedModelId = effectiveModelId.includes('/')
      ? effectiveModelId
      : `${config.providerKey}/${effectiveModelId}`;

    openclawConfig.models = {
      providers: syncedProviders,
    };
    // reasoningDefault is per-agent (not allowed in agents.defaults), so set it on each agent in the list
    const reasoningDefault = config.reasoningDisplay && config.reasoningDisplay !== 'off' ? config.reasoningDisplay : 'on';
    openclawConfig.agents = {
      defaults: {
        model: { primary: normalizedModelId },
        verboseDefault: 'full',
        thinkingDefault: config.thinkingLevel || 'low',
      },
      list: [
        { id: 'main', reasoningDefault },
      ],
    };
  }

  await window.electronAPI.saveConfig(openclawConfig);
}

// React hook — all instances share state via CustomEvent
export function useAppConfig() {
  const [config, setConfigState] = useState<AppConfig>(loadConfig);
  const configRef = useRef<AppConfig>(config);

  // Listen for config changes from other components (e.g. Settings → Sidebar language sync)
  useEffect(() => {
    const handler = () => setConfigState(loadConfig());
    window.addEventListener('awareness-config-changed', handler);
    return () => window.removeEventListener('awareness-config-changed', handler);
  }, []);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const applyConfig = useCallback((updater: (prev: AppConfig) => AppConfig): AppConfig => {
    const prev = normalizeConfig(configRef.current);
    const next = updater(prev);
    configRef.current = next;
    saveConfig(next);
    setConfigState(next);
    return next;
  }, []);

  const updateConfig = useCallback((partial: Partial<AppConfig>) => {
    return applyConfig((prev) => normalizeConfig({ ...prev, ...partial }));
  }, [applyConfig]);

  const syncConfig = useCallback(async (providers: ModelProviderDef[], nextConfig?: AppConfig) => {
    await syncToOpenClaw(nextConfig || normalizeConfig(configRef.current), providers);
  }, []);

  const selectModel = useCallback((providerKey: string, modelId: string, providers: ModelProviderDef[]) => {
    return applyConfig((prev) => selectProviderModel(prev, providerKey, modelId, providers));
  }, [applyConfig]);

  const saveProviderConfig = useCallback((input: {
    providerKey: string;
    modelId: string;
    apiKey?: string;
    baseUrl?: string;
    models?: ProviderStoredModel[];
    apiType?: string;
    name?: string;
    needsKey?: boolean;
  }, providers: ModelProviderDef[]) => {
    return applyConfig((prev) => saveProviderSelection(prev, input, providers));
  }, [applyConfig]);

  return { config, updateConfig, syncConfig, selectModel, saveProviderConfig };
}

// Model provider definition (shared between Setup and Settings)
export interface ModelProviderDef {
  key: string;
  name: string;
  emoji: string;
  tag: string;
  desc: string;
  baseUrl: string;
  apiType?: string;
  models: { id: string; label: string }[];
  needsKey: boolean;
}

// UI-only provider catalog — keys match OpenClaw's built-in provider IDs.
// baseUrl is kept ONLY as a placeholder hint for the UI input field.
// syncToOpenClaw() will NOT write baseUrl to openclaw.json unless the user
// explicitly overrides it (OpenClaw auto-resolves built-in endpoints).
export const MODEL_PROVIDERS: ModelProviderDef[] = [
  {
    key: 'qwen', name: '通义千问 Qwen', emoji: '☁️', tag: '🆓 每模型100万免费',
    desc: '阿里云百炼，中文最强，多模态',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen3.5-plus', label: 'Qwen 3.5 Plus（推荐）' },
      { id: 'qwen-turbo-latest', label: 'Qwen Turbo（最快最便宜）' },
      { id: 'qwen-plus-latest', label: 'Qwen Plus（均衡）' },
      { id: 'qwen-max-latest', label: 'Qwen Max（最强）' },
      { id: 'qwq-plus', label: 'QwQ Plus（深度推理）' },
      { id: 'qwen-long', label: 'Qwen Long（超长文本）' },
    ],
    needsKey: true,
  },
  {
    key: 'deepseek', name: 'DeepSeek', emoji: '🔬', tag: '🆓 免费额度',
    desc: '免费额度充足，推理能力强',
    baseUrl: 'https://api.deepseek.com/v1',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat（通用对话）' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner（深度推理）' },
    ],
    needsKey: true,
  },
  {
    key: 'openai', name: 'OpenAI', emoji: '⚡', tag: '全球最流行',
    desc: 'GPT 系列，需付费',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o（多模态旗舰）' },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini（快速便宜）' },
      { id: 'o3-mini', label: 'o3-mini（推理增强）' },
    ],
    needsKey: true,
  },
  {
    key: 'anthropic', name: 'Claude', emoji: '🧠', tag: '超强推理',
    desc: 'Anthropic 出品，代码分析最强',
    baseUrl: 'https://api.anthropic.com/v1',
    models: [
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4（推荐）' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5（快速）' },
      { id: 'claude-opus-4-20250514', label: 'Claude Opus 4（最强）' },
    ],
    needsKey: true,
  },
  {
    key: 'zai', name: '智谱 AI', emoji: '🇨🇳', tag: '🆓 Flash 免费',
    desc: 'GLM 系列，Flash 模型完全免费',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
    models: [
      { id: 'glm-5.1', label: 'GLM 5.1（最新）' },
      { id: 'glm-4-flash-250414', label: 'GLM-4 Flash（免费）' },
      { id: 'glm-4-plus', label: 'GLM-4 Plus（高性能）' },
    ],
    needsKey: true,
  },
  {
    key: 'moonshot', name: '月之暗面 Kimi', emoji: '🌙', tag: '超长上下文',
    desc: 'Kimi K2.5，256K 上下文',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [
      { id: 'kimi-k2.5', label: 'Kimi K2.5（最新多模态）' },
      { id: 'moonshot-v1-auto', label: 'Moonshot V1 Auto' },
      { id: 'moonshot-v1-128k', label: 'Moonshot V1 128K' },
    ],
    needsKey: true,
  },
  {
    key: 'xai', name: 'xAI Grok', emoji: '🚀', tag: '推理强',
    desc: 'Grok 系列，推理能力突出',
    baseUrl: 'https://api.x.ai/v1',
    models: [
      { id: 'grok-4', label: 'Grok 4（最新）' },
      { id: 'grok-3', label: 'Grok 3' },
    ],
    needsKey: true,
  },
  {
    key: 'mistral', name: 'Mistral', emoji: '🌊', tag: '欧洲开源',
    desc: '开源旗舰，多语言',
    baseUrl: 'https://api.mistral.ai/v1',
    models: [
      { id: 'mistral-large-latest', label: 'Mistral Large（旗舰）' },
      { id: 'mistral-small-latest', label: 'Mistral Small（快速）' },
    ],
    needsKey: true,
  },
  {
    key: 'minimax', name: 'MiniMax 海螺', emoji: '🐚', tag: '长上下文',
    desc: '204K 上下文',
    baseUrl: 'https://api.minimaxi.com/v1',
    models: [
      { id: 'MiniMax-M2.7', label: 'MiniMax M2.7（最新）' },
      { id: 'MiniMax-M2.5', label: 'MiniMax M2.5' },
    ],
    needsKey: true,
  },
  {
    key: 'openrouter', name: 'OpenRouter', emoji: '🔀', tag: '聚合路由',
    desc: '聚合多模型，统一 API',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      { id: 'auto', label: 'Auto（智能路由）' },
    ],
    needsKey: true,
  },
  {
    key: 'groq', name: 'Groq', emoji: '⚡', tag: '🆓 免费极速',
    desc: '最快推理，免费无需信用卡',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B（极速）' },
    ],
    needsKey: true,
  },
  {
    key: 'ollama', name: 'Ollama 本地', emoji: '🏠', tag: '完全离线免费',
    desc: '在你电脑上本地运行',
    baseUrl: 'http://localhost:11434/v1',
    models: [
      { id: 'qwen2.5:7b', label: 'Qwen 2.5 7B（推荐）' },
      { id: 'llama3.1:8b', label: 'Llama 3.1 8B' },
      { id: 'deepseek-r1:8b', label: 'DeepSeek R1 8B' },
    ],
    needsKey: false,
  },
];

/**
 * Hook to get merged providers: hardcoded MODEL_PROVIDERS + dynamic from openclaw.json.
 * Custom providers added via CLI appear under "Custom" section.
 * Models from openclaw.json override hardcoded model lists for known providers.
 */
export function useDynamicProviders(): { providers: ModelProviderDef[]; loading: boolean } {
  const [merged, setMerged] = useState<ModelProviderDef[]>(MODEL_PROVIDERS);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const handler = () => setRefreshKey((value) => value + 1);
    window.addEventListener('awareness-config-changed', handler);
    return () => window.removeEventListener('awareness-config-changed', handler);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      const localConfig = loadConfig();
      const hardcodedKeys = new Set(MODEL_PROVIDERS.map((provider) => provider.key));
      const dynamicMap = new Map<string, any>();

      for (const [key, profile] of Object.entries(localConfig.providerProfiles || {})) {
        dynamicMap.set(key, {
          key,
          baseUrl: profile.baseUrl,
          apiType: profile.apiType,
          hasApiKey: !!profile.apiKey,
          name: profile.name,
          needsKey: profile.needsKey,
          models: (profile.models || []).map((model) => ({
            id: model.id,
            name: model.name || model.label || model.id,
            reasoning: model.reasoning,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
          })),
        });
      }

      if (window.electronAPI?.modelsReadProviders) {
        try {
          const res = await (window.electronAPI as any).modelsReadProviders();
          if (res?.success && Array.isArray(res.providers)) {
            for (const provider of res.providers) {
              const existing = dynamicMap.get(provider.key) || {};
              dynamicMap.set(provider.key, {
                ...provider,
                ...existing,
                models: existing.models?.length ? existing.models : (provider.models || []),
                hasApiKey: existing.hasApiKey || provider.hasApiKey,
                baseUrl: existing.baseUrl || provider.baseUrl || '',
                apiType: existing.apiType || provider.apiType,
              });
            }
          }
        } catch {
          // ignore openclaw read errors and fall back to local profiles
        }
      }

      const result = MODEL_PROVIDERS.map((hardcodedProvider) => {
        const dynamicProvider = dynamicMap.get(hardcodedProvider.key);
        if (!dynamicProvider) return hardcodedProvider;

        const hardcodedModelMap = new Map(hardcodedProvider.models.map((model) => [model.id, model.label]));
        const mergedModels = (dynamicProvider.models || []).map((model: any) => ({
          id: model.id,
          label: hardcodedModelMap.get(model.id) || model.label || model.name || model.id,
        }));

        for (const hardcodedModel of hardcodedProvider.models) {
          if (!mergedModels.some((model: any) => model.id === hardcodedModel.id)) {
            mergedModels.push(hardcodedModel);
          }
        }

        return {
          ...hardcodedProvider,
          name: dynamicProvider.name || hardcodedProvider.name,
          desc: hardcodedProvider.desc,
          baseUrl: dynamicProvider.baseUrl || hardcodedProvider.baseUrl,
          apiType: dynamicProvider.apiType || hardcodedProvider.apiType,
          models: mergedModels,
          needsKey: typeof dynamicProvider.needsKey === 'boolean' ? dynamicProvider.needsKey : hardcodedProvider.needsKey,
        };
      });

      for (const [key, dynamicProvider] of dynamicMap.entries()) {
        if (!hardcodedKeys.has(key)) {
          result.push({
            key,
            name: dynamicProvider.name || key,
            emoji: dynamicProvider.emoji || '🔌',
            tag: dynamicProvider.tag || 'Custom',
            desc: dynamicProvider.desc || dynamicProvider.baseUrl || 'Custom provider',
            baseUrl: dynamicProvider.baseUrl || '',
            apiType: dynamicProvider.apiType,
            models: (dynamicProvider.models || []).map((model: any) => ({
              id: model.id,
              label: model.label || model.name || model.id,
            })),
            needsKey: typeof dynamicProvider.needsKey === 'boolean' ? dynamicProvider.needsKey : true,
          });
        }
      }

      if (!cancelled) {
        setMerged(result);
        setLoading(false);
      }
    };

    setLoading(true);
    hydrate();

    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return { providers: merged, loading };
}
