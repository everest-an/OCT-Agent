import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, Database, Loader2, Plus, RefreshCw, Sparkles, X } from 'lucide-react';
import PasswordInput from '../components/PasswordInput';
import ProviderIcon from '../components/ProviderIcon';
import { SettingsModalShell, SettingsSection } from '../components/settings/SettingsPrimitives';
import { useI18n } from '../lib/i18n';
import {
  getProviderProfile,
  MODEL_PROVIDERS,
  useAppConfig,
  useDynamicProviders,
  type ModelProviderDef,
  type ProviderStoredModel,
} from '../lib/store';

type EditableModel = {
  id: string;
  label: string;
  source: 'catalog' | 'detected' | 'custom';
  ownedBy?: string;
  providerHint?: string;
};

type DiscoveredModelBuckets = {
  aligned: EditableModel[];
  crossVendor: EditableModel[];
};

const DEFAULT_API_TYPE = 'openai-completions';
const CUSTOM_API_TYPE = '__custom__';
const NON_CHAT_MODEL_PATTERN = /(embed|embedding|rerank|whisper|tts|speech|transcri|moderat|omni-moderation|dall|image|vision-preview|audio)/i;

function isKnownApiType(value: string, providers: ModelProviderDef[]): boolean {
  const normalized = value.trim();
  if (!normalized) return true;
  if (normalized === DEFAULT_API_TYPE || normalized === 'anthropic') return true;
  return providers.some((provider) => provider.apiType?.trim() === normalized);
}

function mergeModels(...groups: Array<EditableModel[] | undefined>): EditableModel[] {
  const merged = new Map<string, EditableModel>();
  for (const group of groups) {
    for (const model of group || []) {
      const normalizedId = model.id.trim();
      if (!normalizedId) continue;
      if (!merged.has(normalizedId)) {
        merged.set(normalizedId, { ...model, id: normalizedId, label: model.label.trim() || normalizedId });
        continue;
      }
      const existing = merged.get(normalizedId)!;
      merged.set(normalizedId, {
        ...existing,
        label: existing.label || model.label || normalizedId,
        source: existing.source === 'custom' ? existing.source : model.source,
      });
    }
  }
  return Array.from(merged.values());
}

function tokenizeModelId(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function getBuiltinProviderCatalog(providerKey: string): ModelProviderDef | undefined {
  return MODEL_PROVIDERS.find((provider) => provider.key === providerKey);
}

function buildProviderAffinityTokens(provider: ModelProviderDef): Set<string> {
  const tokens = new Set<string>();

  for (const token of tokenizeModelId(provider.key)) {
    tokens.add(token);
  }

  for (const token of tokenizeModelId(provider.name)) {
    tokens.add(token);
  }

  for (const model of provider.models) {
    for (const token of tokenizeModelId(model.id)) {
      tokens.add(token);
    }
    for (const token of tokenizeModelId(model.label)) {
      tokens.add(token);
    }
  }

  return tokens;
}

function buildDiscoveryOwnershipTokens(model: EditableModel): Set<string> {
  const tokens = new Set<string>();
  for (const rawValue of [model.ownedBy, model.providerHint]) {
    for (const token of tokenizeModelId(rawValue || '')) {
      tokens.add(token);
    }
  }
  return tokens;
}

function partitionDiscoveredModelsByAffinity(provider: ModelProviderDef | undefined, discoveredModels: EditableModel[]): DiscoveredModelBuckets {
  const chatLikeModels = discoveredModels.filter((model) => !NON_CHAT_MODEL_PATTERN.test(`${model.id} ${model.label}`));
  if (!provider) {
    return {
      aligned: chatLikeModels,
      crossVendor: [],
    };
  }

  const trustedProvider = getBuiltinProviderCatalog(provider.key);
  if (!trustedProvider) {
    return {
      aligned: chatLikeModels,
      crossVendor: [],
    };
  }

  const affinityTokens = buildProviderAffinityTokens(trustedProvider);
  const trustedCatalogIds = new Set(
    trustedProvider.models.map((model) => model.id.trim().toLowerCase()).filter(Boolean),
  );
  if (affinityTokens.size === 0) {
    return {
      aligned: chatLikeModels,
      crossVendor: [],
    };
  }

  const aligned = chatLikeModels.filter((model) => {
    const normalizedId = model.id.trim().toLowerCase();
    if (trustedCatalogIds.has(normalizedId)) {
      return true;
    }

    const ownershipTokens = buildDiscoveryOwnershipTokens(model);
    if (ownershipTokens.size > 0) {
      for (const token of ownershipTokens) {
        if (affinityTokens.has(token)) {
          return true;
        }
      }
      return false;
    }

    const haystack = `${model.id} ${model.label}`.toLowerCase();
    for (const token of affinityTokens) {
      if (haystack.includes(token)) {
        return true;
      }
    }
    return false;
  });

  return {
    aligned,
    crossVendor: chatLikeModels.filter((model) => !aligned.some((candidate) => candidate.id === model.id)),
  };
}

function toStoredModels(models: EditableModel[]): ProviderStoredModel[] {
  return models.map((model) => ({ id: model.id, label: model.label, name: model.label }));
}

function slugifyProviderKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildProviderDraft(provider: ModelProviderDef, config: ReturnType<typeof useAppConfig>['config']) {
  const profile = getProviderProfile(config, provider.key);
  const mergedModels = mergeModels(
    provider.models.map((model) => ({ id: model.id, label: model.label, source: 'catalog' as const })),
    profile.models.map((model) => ({
      id: model.id,
      label: model.label || model.name || model.id,
      source: 'custom' as const,
    })),
  );

  return {
    providerKey: provider.key,
    providerName: profile.name || provider.name,
    // Show user-customized baseUrl; fall back to hardcoded default for display only.
    // syncToOpenClaw will skip writing baseUrl if it equals the hardcoded default.
    baseUrl: profile.baseUrl || provider.baseUrl || '',
    apiType: profile.apiType || provider.apiType || DEFAULT_API_TYPE,
    needsKey: typeof profile.needsKey === 'boolean' ? profile.needsKey : provider.needsKey,
    apiKey: profile.apiKey || '',
    models: mergedModels,
    selectedModelId: provider.key === config.providerKey
      ? config.modelId
      : profile.models[0]?.id || provider.models[0]?.id || mergedModels[0]?.id || '',
  };
}

export default function Models() {
  const { t } = useI18n();
  const { config, saveProviderConfig, syncConfig } = useAppConfig();
  const { providers: allProviders, loading } = useDynamicProviders();

  const [editingProviderKey, setEditingProviderKey] = useState<string | null>(null);
  const [customMode, setCustomMode] = useState(false);
  const [providerKeyInput, setProviderKeyInput] = useState('');
  const [providerName, setProviderName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiType, setApiType] = useState(DEFAULT_API_TYPE);
  const [needsKey, setNeedsKey] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [models, setModels] = useState<EditableModel[]>([]);
  const [customModelInput, setCustomModelInput] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoverState, setDiscoverState] = useState<'idle' | 'success' | 'error'>('idle');
  const [discoveredModelIds, setDiscoveredModelIds] = useState<Set<string>>(new Set());
  const [crossVendorDiscoveredModelIds, setCrossVendorDiscoveredModelIds] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState('');
  const [savedState, setSavedState] = useState<'idle' | 'done'>('idle');
  const lastAutoDiscoverKeyRef = useRef('');
  const legacyCustomModelIdsRef = useRef<Set<string>>(new Set());
  const sessionCustomModelIdsRef = useRef<Set<string>>(new Set());
  // Track the last provider key we initialized from, so allProviders reference-churn
  // (e.g. useDynamicProviders re-hydration creating a new array with the same data)
  // does NOT reset in-progress session additions.
  const initializedForProviderKeyRef = useRef<string | null>(null);
  // Always-current ref for models, so discoverModels (which may run from a stale
  // auto-discover setTimeout closure) reads the latest models state rather than
  // the one captured at the time the 500 ms timer was scheduled.
  const modelsRef = useRef<EditableModel[]>(models);
  modelsRef.current = models; // keep in sync with every render

  const activeProvider = allProviders.find((provider) => provider.key === config.providerKey);
  const activeModel = activeProvider?.models.find((model) => model.id === config.modelId);
  const editingProvider = allProviders.find((provider) => provider.key === editingProviderKey);
  const effectiveProviderKey = customMode ? slugifyProviderKey(providerKeyInput || providerName) : editingProviderKey || '';
  const modalOpen = customMode || !!editingProviderKey;
  const apiTypeOptions = useMemo(() => {
    const values = new Set<string>();
    values.add(DEFAULT_API_TYPE);

    for (const provider of allProviders) {
      if (provider.apiType?.trim()) {
        values.add(provider.apiType.trim());
      }
      if (provider.key === 'anthropic') {
        values.add('anthropic');
      }
    }

    if (effectiveProviderKey === 'anthropic') {
      values.add('anthropic');
    }

    return Array.from(values).map((value) => {
      if (value === DEFAULT_API_TYPE) {
        return {
          value,
          label: t('models.apiTypeOption.openai', 'OpenAI compatible'),
          hint: t('models.apiTypeOption.openaiHint', 'Best for OpenAI-style endpoints such as OpenAI, DeepSeek, Ollama, Groq, and most proxy services.'),
        };
      }

      if (value === 'anthropic') {
        return {
          value,
          label: t('models.apiTypeOption.anthropic', 'Anthropic native'),
          hint: t('models.apiTypeOption.anthropicHint', 'Uses Anthropic-style request and header conventions.'),
        };
      }

      return { value, label: value, hint: '' };
    });
  }, [allProviders, effectiveProviderKey, t]);
  const selectedApiTypeOption = isKnownApiType(apiType, allProviders)
    ? apiType.trim()
    : CUSTOM_API_TYPE;
  const selectedApiTypeMeta = apiTypeOptions.find((option) => option.value === apiType.trim()) || null;
  const currentProviderDefaultBaseUrl = editingProvider?.baseUrl || '';
  const baseUrlTrimmed = baseUrl.trim();
  const hasEndpointOverride = customMode
    || (!!baseUrlTrimmed && !currentProviderDefaultBaseUrl)
    || (!!baseUrlTrimmed && !!currentProviderDefaultBaseUrl && baseUrlTrimmed !== currentProviderDefaultBaseUrl.trim());
  const shouldAutoValidate = modalOpen && !!effectiveProviderKey && !!baseUrlTrimmed && (!needsKey || !!apiKey.trim());
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const selectedModelInCatalog = models.some((model) => model.id === selectedModelId);
  const selectedModelDiscovered = discoveredModelIds.has(selectedModelId);
  const selectedModelCrossVendor = crossVendorDiscoveredModelIds.has(selectedModelId);
  const requiresStrictValidation = hasEndpointOverride;
  const selectionNeedsReview = !!selectedModelId && discoverState === 'success' && !selectedModelInCatalog;
  const hasCrossVendorDiscoveries = crossVendorDiscoveredModelIds.size > 0;

  useEffect(() => {
    if (customMode || !editingProviderKey) return;
    const provider = allProviders.find((item) => item.key === editingProviderKey);
    if (!provider) return;
    const draft = buildProviderDraft(provider, config);
    setProviderKeyInput(draft.providerKey);
    setProviderName(draft.providerName);
    setBaseUrl(draft.baseUrl);
    setApiType(draft.apiType);
    setNeedsKey(draft.needsKey);
    setApiKey(draft.apiKey);
    setShowAdvanced(!isKnownApiType(draft.apiType, allProviders));

    // Only do a full reset (models + session refs) when the user first opens this
    // provider, not on every re-render caused by allProviders reference-churn
    // (e.g. useDynamicProviders completing its async hydration with the same data).
    // This prevents in-progress manual model additions from being wiped out.
    if (initializedForProviderKeyRef.current !== editingProviderKey) {
      initializedForProviderKeyRef.current = editingProviderKey;
      setModels(draft.models);
      legacyCustomModelIdsRef.current = new Set(
        draft.models
          .filter((model) => model.source === 'custom')
          .map((model) => model.id),
      );
      setSelectedModelId(draft.selectedModelId);
      setCustomModelInput('');
      setDiscoverState('idle');
      setDiscoveredModelIds(new Set());
      setCrossVendorDiscoveredModelIds(new Set());
      sessionCustomModelIdsRef.current = new Set();
    }
  }, [allProviders, config, customMode, editingProviderKey]);

  const beginCustomProvider = () => {
    setCustomMode(true);
    setEditingProviderKey(null);
    setProviderKeyInput('');
    setProviderName('');
    setBaseUrl('');
    setApiType(DEFAULT_API_TYPE);
    setNeedsKey(true);
    setApiKey('');
    setModels([]);
    setSelectedModelId('');
    setShowAdvanced(false);
    setCustomModelInput('');
    setDiscoverState('idle');
    setDiscoveredModelIds(new Set());
    setCrossVendorDiscoveredModelIds(new Set());
    legacyCustomModelIdsRef.current = new Set();
    sessionCustomModelIdsRef.current = new Set();
    setSavedState('idle');
    setSaveError('');
  };

  const openProviderModal = (providerKey: string) => {
    setCustomMode(false);
    setEditingProviderKey(providerKey);
    setSavedState('idle');
    setDiscoverState('idle');
  };

  const closeModal = () => {
    setCustomMode(false);
    setEditingProviderKey(null);
    setCustomModelInput('');
    setDiscoverState('idle');
    setDiscoveredModelIds(new Set());
    setCrossVendorDiscoveredModelIds(new Set());
    legacyCustomModelIdsRef.current = new Set();
    sessionCustomModelIdsRef.current = new Set();
    initializedForProviderKeyRef.current = null;
    setSaveError('');
  };

  const addCustomModel = () => {
    const normalizedId = customModelInput.trim();
    if (!normalizedId) return;
    const nextModels = mergeModels(models, [{ id: normalizedId, label: normalizedId, source: 'custom' }]);
    legacyCustomModelIdsRef.current.delete(normalizedId);
    sessionCustomModelIdsRef.current.add(normalizedId);
    setModels(nextModels);
    setSelectedModelId((current) => current || normalizedId);
    setCustomModelInput('');
    setDiscoverState('idle');
    setSaveError('');
  };

  const removeModel = (modelId: string) => {
    const nextModels = models.filter((model) => model.id !== modelId);
    legacyCustomModelIdsRef.current.delete(modelId);
    sessionCustomModelIdsRef.current.delete(modelId);
    setModels(nextModels);
    if (selectedModelId === modelId) {
      setSelectedModelId(nextModels[0]?.id || '');
    }
    setDiscoverState('idle');
    setSaveError('');
  };

  const persistProviderSelection = async (effectiveModelId: string, nextModels: EditableModel[]) => {
    if (!effectiveProviderKey || !providerName.trim() || !effectiveModelId) return;
    if (customMode && !baseUrl.trim()) return;

    const next = saveProviderConfig({
      providerKey: effectiveProviderKey,
      modelId: effectiveModelId,
      apiKey,
      baseUrl: baseUrl.trim() || undefined,
      apiType: apiType.trim() || undefined,
      name: providerName.trim(),
      needsKey,
      models: toStoredModels(nextModels),
    }, allProviders);
    await syncConfig(allProviders, next);
    setSaveError('');
    setSavedState('done');
    setCustomMode(false);
    setEditingProviderKey(null);
  };

  const discoverModels = async (options?: { silent?: boolean; force?: boolean }) => {
    const api = window.electronAPI as any;
    if (!api?.modelsDiscover || !baseUrl || !effectiveProviderKey) return;

    const discoverKey = `${effectiveProviderKey}::${baseUrl.trim()}::${apiType.trim()}::${needsKey ? 'key' : 'nokey'}`;
    if (!options?.force && options?.silent && lastAutoDiscoverKeyRef.current === discoverKey && discoverState === 'success') {
      return;
    }

    setDiscovering(true);
    if (!options?.silent) setDiscoverState('idle');
    try {
      const result = await api.modelsDiscover({
        providerKey: effectiveProviderKey,
        baseUrl,
        apiKey,
      });

      if (result?.success && Array.isArray(result.models) && result.models.length > 0) {
        const detectedModels = result.models.map((model: any) => ({
          id: String(model.id || '').trim(),
          label: String(model.name || model.id || '').trim(),
          source: 'detected' as const,
          ...(typeof model.ownedBy === 'string' ? { ownedBy: String(model.ownedBy).trim() } : {}),
          ...(typeof model.providerHint === 'string' ? { providerHint: String(model.providerHint).trim() } : {}),
        }));
        const { aligned, crossVendor } = partitionDiscoveredModelsByAffinity(editingProvider, detectedModels);
        const builtinCatalogModels = (getBuiltinProviderCatalog(effectiveProviderKey)?.models || []).map((model) => ({
          id: model.id,
          label: model.label,
          source: 'catalog' as const,
        }));
        const visibleDetectedModels = builtinCatalogModels.length > 0 ? aligned : [...aligned, ...crossVendor];
        const hardcodedCatalogModels = MODEL_PROVIDERS.find((provider) => provider.key === effectiveProviderKey)?.models || [];
        const providerCatalogModelIds = new Set(hardcodedCatalogModels.map((model) => model.id));
        const filteredDetectedModels = visibleDetectedModels.filter(
          (model) => !legacyCustomModelIdsRef.current.has(model.id)
            || sessionCustomModelIdsRef.current.has(model.id)
            || providerCatalogModelIds.has(model.id),
        );
        const filteredCrossVendorModelIds = new Set(crossVendor.map((model) => model.id));
        // Use modelsRef (not the closure-captured `models`) so stale auto-discover
        // timers don't overwrite models that were added after the timer was scheduled.
        const customModels = modelsRef.current.filter((model) => model.source === 'custom' && sessionCustomModelIdsRef.current.has(model.id));
        const nextModels = mergeModels(builtinCatalogModels, filteredDetectedModels, customModels);
        setModels(nextModels);
        setDiscoveredModelIds(new Set(filteredDetectedModels.map((model) => model.id)));
        setCrossVendorDiscoveredModelIds(filteredCrossVendorModelIds);
        if (!selectedModelId && nextModels.length > 0) {
          setSelectedModelId(nextModels[0]?.id || '');
        }
        const hasValidatedCatalog = filteredDetectedModels.length > 0 || filteredCrossVendorModelIds.size > 0;
        setDiscoverState(hasValidatedCatalog ? 'success' : 'error');
        if (hasValidatedCatalog) {
          lastAutoDiscoverKeyRef.current = discoverKey;
        }
      } else {
        setDiscoverState('error');
        setDiscoveredModelIds(new Set());
        setCrossVendorDiscoveredModelIds(new Set());
      }
    } catch {
      setDiscoverState('error');
      setDiscoveredModelIds(new Set());
      setCrossVendorDiscoveredModelIds(new Set());
    }
    setDiscovering(false);
  };

  useEffect(() => {
    if (!shouldAutoValidate) return;

    const timer = setTimeout(() => {
      void discoverModels({ silent: true });
    }, 500);

    return () => clearTimeout(timer);
  }, [apiKey, baseUrl, effectiveProviderKey, apiType, needsKey, shouldAutoValidate]);

  const saveProvider = async () => {
    const effectiveModelId = selectedModelId || models[0]?.id || '';
    // Built-in providers don't require baseUrl (OpenClaw auto-resolves endpoints);
    // only custom providers must have an explicit baseUrl.
    if (!effectiveProviderKey || !providerName.trim() || !effectiveModelId) return;
    if (customMode && !baseUrl.trim()) return;

    if (!selectedModelInCatalog) {
      setSaveError(selectionNeedsReview
        ? t('models.saveSelectionRequiredAfterRefresh', 'Your previous model is no longer in the refreshed catalog. Choose a model explicitly before saving.')
        : t('models.saveInvalidModel', 'Selected model is invalid. Please choose a model from the catalog.'));
      return;
    }

    if (requiresStrictValidation) {
      if (discoverState !== 'success') {
        setSaveError(t('models.saveNeedsValidation', 'Endpoint not validated yet. Please wait for auto-check or click Refresh from OpenClaw.'));
        return;
      }
      if (!selectedModelDiscovered) {
        setSaveError(t('models.saveModelNotDiscovered', 'Model name is invalid for this endpoint. Please select a model returned by the auto-fetched list.'));
        return;
      }
    }

    await persistProviderSelection(effectiveModelId, models);
  };

  const saveDisabled = !effectiveProviderKey || !providerName.trim() || !models.length || !selectedModelId || (needsKey && !apiKey.trim()) || (customMode && !baseUrl.trim());
  const sourceSummary = useMemo(() => {
    if (customMode) return t('models.source.customDraft', 'This provider lives in your local profile until you save it.');
    if (!editingProvider) return t('models.source.empty', 'Choose a provider to inspect its live model catalog.');
    return t('models.source.dynamic', 'Catalog = built-in defaults + saved provider profile + OpenClaw-discovered models.');
  }, [customMode, editingProvider, t]);

  return (
    <div className="h-full flex flex-col relative z-0">
      <div className="ui-page-header relative z-10">
        <h1 className="ui-page-title">
          <span className="ui-title-icon">
            <Bot size={16} />
          </span>
          {t('models.title', 'Models')}
        </h1>
        <p className="ui-page-subtitle">{t('models.subtitle', 'Manage the active model, OpenClaw-supported providers, and your own custom model catalog in one place.')}</p>
      </div>

      <div className="flex-1 overflow-y-auto p-8 relative">
        <div className="absolute top-0 right-0 w-96 h-96 bg-brand-500/5 blur-[100px] pointer-events-none rounded-full z-0" />

        {savedState === 'done' && (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-5 py-4 text-[13px] font-medium text-emerald-700 dark:text-emerald-200 mb-6 flex items-start gap-2 relative z-10">
            <Check size={16} className="shrink-0 mt-0.5 text-emerald-500 dark:text-emerald-300" />
            {t('models.saved', 'Model configuration saved. New chats will use the selected primary model.')}
          </div>
        )}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)] relative z-10">
          <div className="space-y-6">
            <SettingsSection title={t('models.providers', 'Providers')}>
              <div className="p-1 space-y-4">
                <div className="mt-1 text-[13px] text-slate-500 dark:text-slate-400">{t('models.pickProviderHint', 'Click any provider card to open its setup dialog. The main page should stay clean; detailed settings live in the popup.')}</div>

                {loading && (
                  <div className="flex items-center justify-center gap-2 mb-6 py-6 border border-black/[0.04] dark:border-white/[0.04] bg-white/50 dark:bg-slate-900/40 backdrop-blur-xl rounded-2xl text-[13px] font-medium text-slate-500 dark:text-slate-400">
                    <Loader2 size={16} className="animate-spin text-brand-400" />
                    {t('common.loading', 'Loading...')}
                  </div>
                )}

                <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3 mt-4">
                  <button
                    onClick={beginCustomProvider}
                    className="ui-surface ui-card-interactive border-dashed p-5 text-left group"
                  >
                    <div className="flex items-center gap-4">
                      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500/10 text-brand-400 group-hover:scale-110 group-hover:bg-brand-500/20 transition-all">
                        <Plus size={20} />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-slate-900 dark:text-slate-200 dark:group-hover:text-white transition-colors">{t('models.addProvider', 'Add Custom Provider')}</div>
                        <div className="text-[12px] text-slate-500 dark:text-slate-500 mt-0.5 leading-tight">{t('models.addProviderHint', 'Define your own provider key, base URL, and model IDs.')}</div>
                      </div>
                    </div>
                  </button>

                  {allProviders.map((provider) => {
                    const providerProfile = getProviderProfile(config, provider.key);
                    const mergedProviderModels = mergeModels(
                      provider.models.map((model) => ({ id: model.id, label: model.label, source: 'catalog' as const })),
                      providerProfile.models.map((model) => ({ id: model.id, label: model.label || model.name || model.id, source: 'custom' as const })),
                    );
                    const isActive = provider.key === config.providerKey;

                    return (
                      <button
                        key={provider.key}
                        onClick={() => openProviderModal(provider.key)}
                        className={`ui-surface ui-card-interactive relative overflow-hidden p-5 text-left group ${isActive ? 'border-brand-500/40 bg-brand-500/5 dark:bg-brand-500/10' : ''}`}
                      >
                        {isActive && (
                          <div className="absolute top-0 right-0 w-32 h-32 bg-brand-500/10 blur-[40px] rounded-full pointer-events-none" />
                        )}
                        <div className="flex items-start justify-between gap-3 relative z-10">
                          <div>
                            <div className="text-[15px] font-semibold text-slate-900 dark:text-slate-200 inline-flex items-center gap-2.5">
                              <ProviderIcon providerKey={provider.key} size={20} className="drop-shadow-md" />
                              {provider.name}
                            </div>
                            <div className="mt-1 text-[12px] text-slate-500 font-medium">{provider.tag || provider.key}</div>
                          </div>
                          {isActive && (
                            <span className="rounded-full bg-brand-500/15 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-brand-300 border border-brand-500/20">
                              {t('models.active', 'ACTIVE')}
                            </span>
                          )}
                        </div>

                        <div className="mt-4 text-[13px] text-slate-500 dark:text-slate-400 leading-relaxed line-clamp-2 relative z-10 min-h-[40px]">{provider.desc}</div>

                        <div className="mt-5 flex items-center justify-between text-[12px] text-slate-500 font-medium relative z-10">
                          <span className="inline-flex items-center gap-1.5 bg-slate-100/80 dark:bg-slate-950/40 px-2 py-1 rounded-md border border-black/[0.03] dark:border-white/[0.02]">
                            <Database size={12} className="text-slate-400" />
                            {t('models.catalogCount', '{count} models').replace('{count}', String(mergedProviderModels.length))}
                          </span>
                          <span className={`${isActive ? 'text-brand-500 dark:text-brand-400 opacity-100' : 'text-slate-700 dark:text-white opacity-0 group-hover:opacity-100'} transition-opacity flex items-center gap-1`}>
                            {isActive ? t('models.configureActive', 'Edit Active') : t('models.configureProvider', 'Configure')}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </SettingsSection>
          </div>

          <div className="space-y-6">
            <SettingsSection title={t('models.current', 'Current Model')} seamless>
              <div className="ui-surface p-6 relative overflow-hidden group">
                <div className="absolute -top-10 -right-10 w-40 h-40 bg-brand-500/10 blur-[50px] rounded-full pointer-events-none group-hover:bg-brand-500/20 transition-all" />
                <div className="text-[11px] uppercase tracking-widest font-semibold text-brand-400 mb-2 relative z-10">{t('models.current', 'ACTIVE')}</div>
                <div className="text-xl font-bold text-slate-900 dark:text-white mb-2 relative z-10">
                  {activeProvider
                    ? activeProvider.name
                    : t('models.notConfigured', 'No configuration')}
                </div>
                {activeProvider && (
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-slate-100/80 dark:bg-slate-950/40 border border-black/[0.04] dark:border-white/[0.04] rounded-xl text-[13px] font-medium text-slate-700 dark:text-slate-300 mb-4 relative z-10">
                    <ProviderIcon providerKey={activeProvider.key} size={16} />
                    {activeProvider.key}
                  </div>
                )}
                <div className="text-[13px] text-slate-500 dark:text-slate-400 relative z-10 bg-slate-100/80 dark:bg-black/20 rounded-xl p-3 border border-black/[0.03] dark:border-white/[0.02]">
                  <span className="text-slate-500 block mb-1 uppercase text-[10px] font-bold tracking-wider">{t('settings.modelId', 'Model ID')}</span>
                  <span className="text-slate-900 dark:text-slate-200 font-mono tracking-tight">{activeModel?.label || config.modelId || t('models.notConfigured', 'None')}</span>
                </div>
              </div>
            </SettingsSection>
            
            <SettingsSection title={t('models.dynamicFlow', 'Dynamic flow')} seamless>
              <div className="ui-surface p-6 border-sky-500/20 bg-sky-500/5">
                <div className="text-sm font-semibold text-sky-300">{t('models.dialogFlowTitle', 'Cleaner flow')}</div>
                <div className="mt-2 text-[13px] leading-relaxed text-sky-200/80">{t('models.dialogFlowHint', 'On this page you only choose the provider. All connection details, API type, model discovery, and custom model IDs are edited inside a dialog so the page stays readable.')}</div>
                <div className="mt-3 text-[12px] font-medium text-sky-400/80">{sourceSummary}</div>
              </div>
            </SettingsSection>
          </div>
        </div>

        {modalOpen && (
          <SettingsModalShell
            title={(
              <span className="flex items-center gap-2">
                {customMode ? <Sparkles size={14} className="text-amber-300" /> : <ProviderIcon providerKey={editingProvider?.key} size={14} />}
                {customMode ? t('models.editor.customTitle', 'Custom Provider') : `${editingProvider?.name || t('models.editor.title', 'Provider Configuration')}`}
              </span>
            )}
            onClose={closeModal}
            maxWidthClass="max-w-5xl"
            maxHeightClass="max-h-[90vh]"
            paddingClass="p-0"
            footer={(
              <div className="flex items-center justify-between gap-3 px-6 py-4">
                <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-100">
                  <Sparkles size={14} className="mt-0.5 text-amber-600 dark:text-amber-300" />
                  <span>{t('models.saveHint', 'Save writes this provider profile into Desktop local config and syncs the same catalog to openclaw.json.models.providers.')}</span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={closeModal}
                    className="rounded-lg bg-slate-100 px-4 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    {t('common.cancel', 'Cancel')}
                  </button>
                  <button
                    onClick={() => { void saveProvider(); }}
                    disabled={saveDisabled}
                    className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-500 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 dark:disabled:bg-slate-700 dark:disabled:text-slate-500"
                  >
                    <Check size={12} /> {t('models.saveAndActivate', 'Save & Activate')}
                  </button>
                </div>
              </div>
            )}
          >
            <div className="p-6 space-y-6">
              {!!saveError && (
                <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-200">
                  {saveError}
                </div>
              )}
              <div className="rounded-2xl border border-slate-200/80 bg-white/70 px-4 py-4 dark:border-slate-700 dark:bg-slate-900/50">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="text-base font-medium text-slate-900 inline-flex items-center gap-2 dark:text-slate-100">
                      {!customMode && <ProviderIcon providerKey={editingProvider?.key || effectiveProviderKey} size={16} />}
                      {customMode ? t('models.quickSetup', 'Quick Setup') : `${editingProvider?.name || providerName}`}
                    </div>
                    <div className="mt-1 text-xs text-slate-600 dark:text-slate-500">{customMode ? t('models.quickSetupHint', 'Start with the provider name, endpoint, and API type. Advanced fields stay tucked away until you need them.') : editingProvider?.desc || sourceSummary}</div>
                  </div>
                  {!customMode && editingProvider?.tag && (
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">{editingProvider.tag}</span>
                  )}
                </div>
              </div>

              <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
                <div className="space-y-5">
                  <div className="rounded-2xl border border-slate-200/80 bg-white/70 p-4 space-y-4 dark:border-slate-700 dark:bg-slate-900/50">
                    <div>
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('models.quickSetup', 'Quick Setup')}</div>
                      <div className="mt-1 text-xs text-slate-600 dark:text-slate-500">{t('models.quickSetupHint', 'Start with the provider name, endpoint, and API type. Advanced fields stay tucked away until you need them.')}</div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px]">
                      <div>
                        <label htmlFor="models-provider-name" className="block text-xs font-medium text-slate-600 mb-1 dark:text-slate-400">{t('models.providerName', 'Provider Name')}</label>
                        <input
                          id="models-provider-name"
                          type="text"
                          value={providerName}
                          onChange={(event) => setProviderName(event.target.value)}
                          disabled={!customMode}
                          className="w-full rounded-lg border border-slate-300/80 bg-white/80 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                          placeholder={t('models.providerNamePlaceholder', 'My Provider')}
                        />
                        <div className="mt-1 text-[11px] text-slate-500">
                          {t('models.providerKeyPreview', 'Will save as:')} {effectiveProviderKey || t('models.providerKeyAuto', 'generated automatically')}
                        </div>
                      </div>

                      <div>
                        <label htmlFor="models-api-type" className="block text-xs font-medium text-slate-600 mb-1 dark:text-slate-400">{t('models.apiType', 'API Type')}</label>
                        <select
                          id="models-api-type"
                          aria-label={t('models.apiType', 'API Type')}
                          value={selectedApiTypeOption}
                          onChange={(event) => {
                            const nextValue = event.target.value;
                            if (nextValue === CUSTOM_API_TYPE) {
                              setShowAdvanced(true);
                              return;
                            }
                            setApiType(nextValue);
                          }}
                          className="w-full rounded-lg border border-slate-300/80 bg-white/80 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                        >
                          {apiTypeOptions.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                          <option value={CUSTOM_API_TYPE}>{t('models.apiTypeCustom', 'Custom API type')}</option>
                        </select>
                        <div className="mt-1 text-[11px] text-slate-500">
                          {selectedApiTypeMeta?.hint || t('models.apiTypeHint', 'Use the preset that matches your provider protocol. Most hosted endpoints use OpenAI compatible.')}
                        </div>
                      </div>
                    </div>

                    <div>
                      <label htmlFor="models-base-url" className="block text-xs font-medium text-slate-600 mb-1 dark:text-slate-400">
                        {t('settings.model.baseUrl', 'API Base URL')}
                      </label>
                      <input
                        id="models-base-url"
                        type="text"
                        value={baseUrl}
                        onChange={(event) => setBaseUrl(event.target.value)}
                        className="w-full rounded-lg border border-slate-300/80 bg-white/80 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                        placeholder="https://api.example.com/v1"
                      />
                      {!customMode && baseUrl === (editingProvider?.baseUrl || '') && (
                        <div className="mt-1 text-[11px] text-slate-500">
                          {t('models.baseUrlDefault', 'Default endpoint from OpenClaw. Change it if you use a proxy or custom gateway.')}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200/80 bg-white/70 p-4 space-y-4 dark:border-slate-700 dark:bg-slate-900/50">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('models.requiresKey', 'Requires API key')}</div>
                        <div className="mt-1 text-xs text-slate-600 dark:text-slate-500">{t('models.requiresKeyHint', 'Turn this off for local or unauthenticated endpoints such as Ollama.')}</div>
                      </div>
                      <button
                        onClick={() => setNeedsKey((value) => !value)}
                        className={`rounded-full px-3 py-1 text-xs font-medium ${needsKey ? 'bg-brand-600 text-white' : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'}`}
                      >
                        {needsKey ? t('common.on', 'on') : t('common.off', 'off')}
                      </button>
                    </div>

                    {needsKey && (
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1 dark:text-slate-400">{t('settings.model.apiKey', 'API Key')}</label>
                        <PasswordInput
                          value={apiKey}
                          onChange={(event) => setApiKey(event.target.value)}
                          placeholder={t('common.pasteApiKey', 'Paste your API Key...')}
                          className="w-full rounded-lg border border-slate-300/80 bg-white/80 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                        />
                      </div>
                    )}
                  </div>

                  <div className="rounded-2xl border border-slate-200/80 bg-white/60 p-4 space-y-3 dark:border-slate-700 dark:bg-slate-900/40">
                    <button
                      type="button"
                      onClick={() => setShowAdvanced((value) => !value)}
                      className="flex w-full items-center justify-between text-left"
                    >
                      <div>
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('models.advanced', 'Advanced Settings')}</div>
                        <div className="mt-1 text-xs text-slate-600 dark:text-slate-500">{t('models.advancedHint', 'Override the generated provider key or enter a protocol name that is not in the preset list.')}</div>
                      </div>
                      <span className="text-xs text-slate-500 dark:text-slate-400">{showAdvanced ? t('models.hideAdvanced', 'Hide') : t('models.showAdvanced', 'Show')}</span>
                    </button>

                    {showAdvanced && (
                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <label htmlFor="models-provider-key" className="block text-xs font-medium text-slate-600 mb-1 dark:text-slate-400">{t('models.providerKey', 'Provider Key')}</label>
                          <input
                            id="models-provider-key"
                            type="text"
                            value={providerKeyInput}
                            onChange={(event) => setProviderKeyInput(event.target.value)}
                            disabled={!customMode}
                            className="w-full rounded-lg border border-slate-300/80 bg-white/80 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                            placeholder={t('models.providerKeyPlaceholder', 'custom-openai')}
                          />
                        </div>

                        <div>
                          <label htmlFor="models-api-type-custom" className="block text-xs font-medium text-slate-600 mb-1 dark:text-slate-400">{t('models.apiTypeCustom', 'Custom API type')}</label>
                          <input
                            id="models-api-type-custom"
                            type="text"
                            value={apiType}
                            onChange={(event) => setApiType(event.target.value)}
                            className="w-full rounded-lg border border-slate-300/80 bg-white/80 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                            placeholder={t('models.apiTypeCustomPlaceholder', 'Enter the exact protocol value expected by OpenClaw')}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-5">
                  <div className="rounded-2xl border border-slate-200/80 bg-white/70 p-4 space-y-4 dark:border-slate-700 dark:bg-slate-900/50">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('models.catalog', 'Model Catalog')}</div>
                        <div className="mt-1 text-xs text-slate-600 dark:text-slate-500">{t('models.catalogHint', 'Pick the active model, refresh from OpenClaw, and keep any manual model IDs you add.')}</div>
                      </div>
                      <button
                        onClick={() => { void discoverModels(); }}
                        disabled={discovering || !baseUrl.trim() || !effectiveProviderKey || (needsKey && !apiKey.trim())}
                        className="inline-flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                      >
                        {discovering ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                        {t('models.discover', 'Refresh from OpenClaw')}
                      </button>
                    </div>

                    {discoverState === 'success' && (
                      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-200">
                        {t('models.discoverSuccess', 'Model list refreshed. Custom model IDs were kept.')}
                      </div>
                    )}
                    {hasCrossVendorDiscoveries && (
                      <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-100">
                        {t('models.discoverCrossVendor', 'This endpoint also returned models from other vendors. They stay visible for manual use, but OCT will not switch to them automatically.')}
                      </div>
                    )}
                    {selectionNeedsReview && (
                      <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-100">
                        {t('models.discoverSelectionReview', 'Your previous selection is no longer in this refreshed catalog. Pick a model explicitly before saving.')}
                      </div>
                    )}
                    {discoverState === 'error' && (
                      <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-200">
                        {t('models.discoverFailed', 'OpenClaw could not fetch models. Check the provider key, base URL, and API key.')}
                      </div>
                    )}
                    {selectedModelCrossVendor && selectedModel?.source === 'detected' && (
                      <div className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-xs text-sky-700 dark:text-sky-100">
                        {t('models.selectedCrossVendor', 'This model comes from the endpoint\'s mixed vendor pool. Desktop keeps it opt-in and never auto-selects it for you.')}
                      </div>
                    )}

                    <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
                      {models.map((model) => (
                        <div
                          key={model.id}
                          className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-3 ${selectedModelId === model.id ? 'border-brand-500 bg-brand-600/10' : 'border-slate-200 bg-white/80 dark:border-slate-700 dark:bg-slate-900/70'}`}
                        >
                          <button onClick={() => setSelectedModelId(model.id)} className="min-w-0 flex-1 text-left">
                            <div className="text-sm font-medium text-slate-900 truncate dark:text-slate-100">{model.label}</div>
                            <div className="mt-1 text-[10px] uppercase tracking-wide text-slate-500">
                              {model.source === 'catalog'
                                ? t('models.source.catalog', 'Built-in')
                                : model.source === 'custom'
                                  ? t('models.source.custom', 'Manual')
                                  : crossVendorDiscoveredModelIds.has(model.id)
                                    ? t('models.source.detectedExternal', 'Endpoint · other vendor')
                                    : t('models.source.detected', 'Endpoint')}
                            </div>
                          </button>
                          <button
                            onClick={() => removeModel(model.id)}
                            className="text-slate-500 transition-colors hover:text-rose-600 dark:hover:text-rose-300"
                            aria-label={t('common.delete', 'Delete')}
                            title={t('common.delete', 'Delete')}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>

                    {!models.length && (
                      <div className="rounded-lg border border-dashed border-slate-300 px-3 py-3 text-xs text-slate-500 dark:border-slate-700">
                        {t('models.catalogEmpty', 'No models yet. Add a model ID manually or use Refresh from OpenClaw.')}
                      </div>
                    )}

                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={customModelInput}
                        onChange={(event) => setCustomModelInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addCustomModel();
                          }
                        }}
                        className="flex-1 rounded-lg border border-slate-300/80 bg-white/80 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                        placeholder={t('models.customModelPlaceholder', 'Add model ID, for example gpt-4.1-mini')}
                      />
                      <button
                        onClick={addCustomModel}
                        className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-500"
                      >
                        <Plus size={12} /> {t('models.addModel', 'Add Model')}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </SettingsModalShell>
        )}
      </div>
    </div>
  );
}
