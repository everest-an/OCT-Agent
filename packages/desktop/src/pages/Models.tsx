import { useEffect, useMemo, useState } from 'react';
import { Check, Database, Loader2, Plus, RefreshCw, Sparkles, X } from 'lucide-react';
import PasswordInput from '../components/PasswordInput';
import { SettingsSection } from '../components/settings/SettingsPrimitives';
import { useI18n } from '../lib/i18n';
import {
  getProviderProfile,
  useAppConfig,
  useDynamicProviders,
  type ModelProviderDef,
  type ProviderStoredModel,
} from '../lib/store';

type EditableModel = {
  id: string;
  label: string;
  source: 'catalog' | 'detected' | 'custom';
};

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
    baseUrl: profile.baseUrl || provider.baseUrl || '',
    apiType: profile.apiType || provider.apiType || 'openai-completions',
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

  const [selectedProviderKey, setSelectedProviderKey] = useState('');
  const [customMode, setCustomMode] = useState(false);
  const [providerKeyInput, setProviderKeyInput] = useState('');
  const [providerName, setProviderName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiType, setApiType] = useState('openai-completions');
  const [needsKey, setNeedsKey] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [models, setModels] = useState<EditableModel[]>([]);
  const [customModelInput, setCustomModelInput] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discoverState, setDiscoverState] = useState<'idle' | 'success' | 'error'>('idle');
  const [savedState, setSavedState] = useState<'idle' | 'done'>('idle');

  const activeProvider = allProviders.find((provider) => provider.key === config.providerKey);
  const activeModel = activeProvider?.models.find((model) => model.id === config.modelId);
  const effectiveProviderKey = customMode ? slugifyProviderKey(providerKeyInput || providerName) : selectedProviderKey;

  useEffect(() => {
    if (customMode) return;
    if (selectedProviderKey && allProviders.some((provider) => provider.key === selectedProviderKey)) return;
    setSelectedProviderKey(config.providerKey || allProviders[0]?.key || '');
  }, [allProviders, config.providerKey, customMode, selectedProviderKey]);

  useEffect(() => {
    if (customMode) return;
    const provider = allProviders.find((item) => item.key === selectedProviderKey);
    if (!provider) return;
    const draft = buildProviderDraft(provider, config);
    setProviderKeyInput(draft.providerKey);
    setProviderName(draft.providerName);
    setBaseUrl(draft.baseUrl);
    setApiType(draft.apiType);
    setNeedsKey(draft.needsKey);
    setApiKey(draft.apiKey);
    setModels(draft.models);
    setSelectedModelId(draft.selectedModelId);
    setCustomModelInput('');
    setDiscoverState('idle');
  }, [allProviders, config, customMode, selectedProviderKey]);

  const beginCustomProvider = () => {
    setCustomMode(true);
    setSelectedProviderKey('');
    setProviderKeyInput('');
    setProviderName('');
    setBaseUrl('');
    setApiType('openai-completions');
    setNeedsKey(true);
    setApiKey('');
    setModels([]);
    setSelectedModelId('');
    setCustomModelInput('');
    setDiscoverState('idle');
    setSavedState('idle');
  };

  const selectProvider = (providerKey: string) => {
    setCustomMode(false);
    setSelectedProviderKey(providerKey);
    setSavedState('idle');
  };

  const addCustomModel = () => {
    const normalizedId = customModelInput.trim();
    if (!normalizedId) return;
    const nextModels = mergeModels(models, [{ id: normalizedId, label: normalizedId, source: 'custom' }]);
    setModels(nextModels);
    setSelectedModelId((current) => current || normalizedId);
    setCustomModelInput('');
    setDiscoverState('idle');
  };

  const removeModel = (modelId: string) => {
    const nextModels = models.filter((model) => model.id !== modelId);
    setModels(nextModels);
    if (selectedModelId === modelId) {
      setSelectedModelId(nextModels[0]?.id || '');
    }
    setDiscoverState('idle');
  };

  const discoverModels = async () => {
    const api = window.electronAPI as any;
    if (!api?.modelsDiscover || !baseUrl || !effectiveProviderKey) return;

    setDiscovering(true);
    setDiscoverState('idle');
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
        }));
        const customModels = models.filter((model) => model.source === 'custom');
        const nextModels = mergeModels(detectedModels, customModels);
        setModels(nextModels);
        if (!nextModels.some((model) => model.id === selectedModelId)) {
          setSelectedModelId(nextModels[0]?.id || '');
        }
        setDiscoverState('success');
      } else {
        setDiscoverState('error');
      }
    } catch {
      setDiscoverState('error');
    }
    setDiscovering(false);
  };

  const saveProvider = async () => {
    const effectiveModelId = selectedModelId || models[0]?.id || '';
    if (!effectiveProviderKey || !providerName.trim() || !baseUrl.trim() || !effectiveModelId) return;

    saveProviderConfig({
      providerKey: effectiveProviderKey,
      modelId: effectiveModelId,
      apiKey,
      baseUrl: baseUrl.trim(),
      apiType: apiType.trim() || undefined,
      name: providerName.trim(),
      needsKey,
      models: toStoredModels(models),
    }, allProviders);
    await syncConfig(allProviders);
    setSavedState('done');
    setCustomMode(false);
    setSelectedProviderKey(effectiveProviderKey);
  };

  const saveDisabled = !effectiveProviderKey || !providerName.trim() || !baseUrl.trim() || !models.length || !selectedModelId || (needsKey && !apiKey.trim());
  const selectedProvider = allProviders.find((provider) => provider.key === selectedProviderKey);
  const sourceSummary = useMemo(() => {
    if (customMode) return t('models.source.customDraft', 'This provider lives in your local profile until you save it.');
    if (!selectedProvider) return t('models.source.empty', 'Choose a provider to inspect its live model catalog.');
    return t('models.source.dynamic', 'Catalog = built-in defaults + saved provider profile + OpenClaw-discovered models.');
  }, [customMode, selectedProvider, t]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-6 py-4 border-b border-slate-800">
        <h1 className="text-lg font-semibold">🤖 {t('models.title', 'Models')}</h1>
        <p className="mt-1 text-sm text-slate-400">{t('models.subtitle', 'Manage the active model, OpenClaw-supported providers, and your own custom model catalog in one place.')}</p>
      </div>

      <div className="p-6 space-y-6">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <div className="space-y-4">
            <SettingsSection title={t('models.current', 'Current Model')}>
              <div className="p-4 space-y-2">
                <div className="text-sm font-medium text-slate-100">
                  {activeProvider
                    ? `${activeProvider.emoji} ${activeProvider.name} / ${activeModel?.label || config.modelId}`
                    : t('models.notConfigured', 'No active model configured')}
                </div>
                <div className="text-xs text-slate-500">
                  {t('models.currentHint', 'Saving here updates both Desktop local state and OpenClaw primary model.')}
                </div>
              </div>
            </SettingsSection>

            <SettingsSection title={t('models.providers', 'Providers')}>
              <div className="p-3 space-y-3">
                <button
                  onClick={beginCustomProvider}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${customMode ? 'border-brand-500 bg-brand-600/10 text-slate-100' : 'border-dashed border-slate-700 bg-slate-900/60 text-slate-300 hover:border-slate-500'}`}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Plus size={14} /> {t('models.addProvider', 'Add Custom Provider')}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">{t('models.addProviderHint', 'Define your own provider key, base URL, and model IDs.')}</div>
                </button>

                {loading && (
                  <div className="flex items-center gap-2 px-2 py-1 text-xs text-slate-500">
                    <Loader2 size={12} className="animate-spin" />
                    {t('common.loading', 'Loading...')}
                  </div>
                )}

                {allProviders.map((provider) => {
                  const providerProfile = getProviderProfile(config, provider.key);
                  const isActive = provider.key === config.providerKey;
                  const isSelected = !customMode && provider.key === selectedProviderKey;
                  const modelCount = mergeModels(
                    provider.models.map((model) => ({ id: model.id, label: model.label, source: 'catalog' as const })),
                    providerProfile.models.map((model) => ({ id: model.id, label: model.label || model.name || model.id, source: 'custom' as const })),
                  ).length;
                  return (
                    <button
                      key={provider.key}
                      onClick={() => selectProvider(provider.key)}
                      className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${isSelected ? 'border-brand-500 bg-brand-600/10' : 'border-slate-700 bg-slate-900/60 hover:border-slate-500'}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-slate-100">{provider.emoji} {provider.name}</div>
                          <div className="mt-1 text-xs text-slate-500">{provider.tag || provider.key}</div>
                        </div>
                        {isActive && (
                          <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-300">
                            {t('models.active', 'Active')}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                        <Database size={12} />
                        <span>{t('models.catalogCount', '{count} models').replace('{count}', String(modelCount))}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </SettingsSection>
          </div>

          <div className="space-y-4">
            <SettingsSection title={customMode ? t('models.editor.customTitle', 'Custom Provider') : t('models.editor.title', 'Provider Configuration')}>
              <div className="p-4 space-y-5">
                <div className="rounded-xl border border-sky-500/20 bg-sky-500/10 px-3 py-3 text-xs text-sky-100">
                  <div className="font-medium">{t('models.dynamicFlow', 'Dynamic flow')}</div>
                  <div className="mt-1 opacity-80">{sourceSummary}</div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">{t('models.providerName', 'Provider Name')}</label>
                    <input
                      type="text"
                      value={providerName}
                      onChange={(event) => setProviderName(event.target.value)}
                      disabled={!customMode}
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
                      placeholder={t('models.providerNamePlaceholder', 'My Provider')}
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">{t('models.providerKey', 'Provider Key')}</label>
                    <input
                      type="text"
                      value={providerKeyInput}
                      onChange={(event) => setProviderKeyInput(event.target.value)}
                      disabled={!customMode}
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
                      placeholder={t('models.providerKeyPlaceholder', 'custom-openai')}
                    />
                    {customMode && effectiveProviderKey && (
                      <div className="mt-1 text-[11px] text-slate-500">{t('models.providerKeyPreview', 'Will save as:')} {effectiveProviderKey}</div>
                    )}
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_160px]">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">{t('settings.model.baseUrl', 'API Base URL')}</label>
                    <input
                      type="text"
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none"
                      placeholder="https://api.example.com/v1"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">{t('models.apiType', 'API Type')}</label>
                    <input
                      type="text"
                      value={apiType}
                      onChange={(event) => setApiType(event.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none"
                      placeholder="openai-completions"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-3">
                  <div>
                    <div className="text-sm font-medium text-slate-100">{t('models.requiresKey', 'Requires API key')}</div>
                    <div className="mt-1 text-xs text-slate-500">{t('models.requiresKeyHint', 'Turn this off for local or unauthenticated endpoints such as Ollama.')}</div>
                  </div>
                  <button
                    onClick={() => setNeedsKey((value) => !value)}
                    className={`rounded-full px-3 py-1 text-xs font-medium ${needsKey ? 'bg-brand-600 text-white' : 'bg-slate-700 text-slate-300'}`}
                  >
                    {needsKey ? t('common.on', 'on') : t('common.off', 'off')}
                  </button>
                </div>

                {needsKey && (
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">{t('settings.model.apiKey', 'API Key')}</label>
                    <PasswordInput
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={t('common.pasteApiKey', 'Paste your API Key...')}
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none"
                    />
                  </div>
                )}

                <div className="space-y-3 rounded-xl border border-slate-700 bg-slate-900/60 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-slate-100">{t('models.catalog', 'Model Catalog')}</div>
                      <div className="mt-1 text-xs text-slate-500">{t('models.catalogHint', 'Pick the active model, refresh from OpenClaw, and keep any manual model IDs you add.')}</div>
                    </div>
                    <button
                      onClick={() => { void discoverModels(); }}
                      disabled={discovering || !baseUrl.trim() || !effectiveProviderKey || (needsKey && !apiKey.trim())}
                      className="inline-flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-200 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {discovering ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      {t('models.discover', 'Refresh from OpenClaw')}
                    </button>
                  </div>

                  {discoverState === 'success' && (
                    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                      {t('models.discoverSuccess', 'Model list refreshed. Custom model IDs were kept.')}
                    </div>
                  )}
                  {discoverState === 'error' && (
                    <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                      {t('models.discoverFailed', 'OpenClaw could not fetch models. Check the provider key, base URL, and API key.')}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {models.map((model) => (
                      <div
                        key={model.id}
                        className={`group inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${selectedModelId === model.id ? 'border-brand-500 bg-brand-600/15 text-slate-100' : 'border-slate-700 bg-slate-800 text-slate-300'}`}
                      >
                        <button onClick={() => setSelectedModelId(model.id)} className="flex items-center gap-2 text-left">
                          <span>{model.label}</span>
                          <span className="text-[10px] uppercase tracking-wide text-slate-500">{model.source}</span>
                        </button>
                        <button onClick={() => removeModel(model.id)} className="text-slate-500 transition-colors hover:text-rose-300">
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>

                  {!models.length && (
                    <div className="rounded-lg border border-dashed border-slate-700 px-3 py-3 text-xs text-slate-500">
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
                      className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none"
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

                <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-3 text-xs text-amber-100">
                  <div className="flex items-start gap-2">
                    <Sparkles size={14} className="mt-0.5" />
                    <span>{t('models.saveHint', 'Save writes this provider profile into Desktop local config and syncs the same catalog to openclaw.json.models.providers.')}</span>
                  </div>
                  <button
                    onClick={() => { void saveProvider(); }}
                    disabled={saveDisabled}
                    className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
                  >
                    <Check size={12} /> {t('models.saveAndActivate', 'Save & Activate')}
                  </button>
                </div>

                {savedState === 'done' && (
                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                    {t('models.saved', 'Model configuration saved. New chats will use the selected primary model.')}
                  </div>
                )}
              </div>
            </SettingsSection>
          </div>
        </div>
      </div>
    </div>
  );
}
