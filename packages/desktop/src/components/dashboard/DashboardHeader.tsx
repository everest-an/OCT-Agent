import { CheckCircle2, ChevronDown, ExternalLink, FolderOpen, KeyRound, Loader2 } from 'lucide-react';
import { getProviderProfile, hasProviderCredentials } from '../../lib/store';
import ProviderIcon from '../ProviderIcon';
import appLogoUrl from '../../assets/logo.svg';

type Provider = {
  key: string;
  name: string;
  emoji: string;
  needsKey?: boolean;
  models: Array<{ id: string; label: string }>;
};

type AppConfig = {
  providerKey: string;
  modelId: string;
};

export function DashboardHeader({
  t,
  showSidebar,
  projectRoot,
  projectRootName,
  config,
  allProviders,
  showModelSelector,
  onToggleSidebar,
  onSelectProjectRoot,
  onToggleModelSelector,
  onCloseModelSelector,
  onNavigateModels,
  onSelectModel,
  onOpenDashboard,
  dashboardOpening,
}: {
  t: (key: string, fallback?: string) => string;
  logoUrl: string;
  showSidebar: boolean;
  projectRoot: string;
  projectRootName: string;
  config: AppConfig & Record<string, any>;
  allProviders: Provider[];
  showModelSelector: boolean;
  onToggleSidebar: () => void;
  onSelectProjectRoot: () => void;
  onToggleModelSelector: () => void;
  onCloseModelSelector: () => void;
  onNavigateModels: () => void;
  onSelectModel: (providerKey: string, modelId: string) => void;
  onOpenDashboard: () => void;
  dashboardOpening: boolean;
}) {
  const currentProvider = allProviders.find((provider) => provider.key === config.providerKey);
  const currentModel = currentProvider?.models.find((model) => model.id === config.modelId);

  return (
    <div className="px-4 py-2 border-b border-slate-200/70 dark:border-slate-800/60 flex items-center gap-2 flex-shrink-0 h-11 backdrop-blur-xl bg-white/72 dark:bg-slate-900/80">
      <button
        onClick={onToggleSidebar}
        className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100/80 dark:hover:text-slate-200 dark:hover:bg-slate-800/70 rounded-lg transition-all duration-150"
        title={t('chat.sessionList', 'Session list')}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="1.5" rx="0.75" fill="currentColor"/><rect x="2" y="7.25" width="12" height="1.5" rx="0.75" fill="currentColor"/><rect x="2" y="11.5" width="12" height="1.5" rx="0.75" fill="currentColor"/></svg>
      </button>

      <img src={appLogoUrl} alt="OCT Agent" className="h-5 w-5 object-contain opacity-90" />

      <button
        onClick={onSelectProjectRoot}
        aria-label={projectRoot ? t('chat.workspace.change', 'Change folder') : t('chat.workspace.select', 'Choose folder')}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left transition-all duration-150 hover:bg-slate-100/80 dark:hover:bg-slate-800/60 max-w-[200px] group"
        title={projectRoot || t('chat.workspace.select', 'Choose folder')}
      >
        <FolderOpen size={11} className="shrink-0 text-sky-600/70 dark:text-sky-400/60 group-hover:text-sky-700 dark:group-hover:text-sky-400/90 transition-colors" />
        <span className="truncate text-xs text-slate-500 group-hover:text-slate-900 dark:group-hover:text-slate-300 transition-colors">{projectRootName || t('chat.workspace.none', 'No folder')}</span>
      </button>

      <div className="flex-1" />

      <div className="relative">
        <button
          onClick={onToggleModelSelector}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] hover:bg-slate-100/80 dark:hover:bg-slate-800/70 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-300 transition-all duration-150 border border-transparent hover:border-slate-200/80 dark:hover:border-slate-700/50"
        >
          {currentProvider ? <ProviderIcon providerKey={currentProvider.key} size={11} /> : null}
          <span className="truncate max-w-[120px]">{currentModel?.label || config.modelId || t('chat.selectModel', 'Select model')}</span>
          <ChevronDown size={9} className="opacity-60" />
        </button>
        {showModelSelector && (
          <>
            <div className="fixed inset-0 z-40" onClick={onCloseModelSelector} />
            <div className="absolute top-full right-0 mt-1.5 w-72 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border border-slate-200/80 dark:border-slate-700/60 rounded-2xl shadow-2xl shadow-slate-900/10 dark:shadow-black/40 z-50 max-h-[400px] overflow-y-auto">
              {allProviders.map((provider) => {
                const isConfigured = hasProviderCredentials(config as any, provider.key, provider.needsKey ?? false);
                getProviderProfile(config as any, provider.key);

                return (
                  <div key={provider.key}>
                    <div className="px-3.5 py-2 text-[10px] font-semibold border-b border-slate-200/70 dark:border-slate-800/60 sticky top-0 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl flex items-center justify-between">
                      <span className="text-slate-500 inline-flex items-center gap-1.5">
                        <ProviderIcon providerKey={provider.key} size={11} />
                        {provider.name}
                      </span>
                      {isConfigured ? (
                        <CheckCircle2 size={11} className="text-emerald-500" />
                      ) : provider.needsKey ? (
                        <KeyRound size={11} className="text-amber-500" />
                      ) : (
                        <span className="text-slate-500 dark:text-slate-600">{t('chat.free', 'Free')}</span>
                      )}
                    </div>
                    {provider.models.map((model) => (
                      <button
                        key={model.id}
                        onClick={() => {
                          if (provider.needsKey && !isConfigured) {
                            onCloseModelSelector();
                            onNavigateModels();
                            return;
                          }
                          onSelectModel(provider.key, model.id);
                          onCloseModelSelector();
                        }}
                        className={`w-full text-left px-3.5 py-2 text-xs transition-all duration-150 ${
                          provider.needsKey && !isConfigured ? 'text-slate-500 hover:bg-slate-100/70 dark:hover:bg-slate-800/40' : 'hover:bg-slate-100/80 dark:hover:bg-slate-800/60'
                        } ${
                          config.providerKey === provider.key && config.modelId === model.id ? 'text-brand-600 dark:text-brand-400' : 'text-slate-700 dark:text-slate-300'
                        }`}
                        title={provider.needsKey && !isConfigured ? t('chat.configureInModels', 'Configure this provider in Models first') : undefined}
                      >
                        {model.label}
                        {config.providerKey === provider.key && config.modelId === model.id && (
                          <span className="ml-1 text-brand-400 font-medium inline-flex items-center gap-1">
                            <CheckCircle2 size={11} />
                            {t('chat.active', 'Active')}
                          </span>
                        )}
                        {provider.needsKey && !isConfigured && (
                          <span className="ml-1 text-[10px] text-amber-500">{t('chat.setupInModels', 'Set up in Models')}</span>
                        )}
                      </button>
                    ))}
                    {provider.needsKey && !isConfigured && (
                      <button
                        onClick={() => {
                          onCloseModelSelector();
                          onNavigateModels();
                        }}
                      className="w-full text-left px-3.5 py-2 text-[11px] text-sky-700 dark:text-sky-400 hover:bg-slate-100/80 dark:hover:bg-slate-800/60 transition-colors border-t border-slate-200/70 dark:border-slate-800/60"
                      >
                        {t('chat.openModelsToConfigure', 'Open Models to configure API Key / Base URL')}
                      </button>
                    )}
                  </div>
                );
              })}
              {currentProvider && (
                <button
                  onClick={() => {
                    onCloseModelSelector();
                    onNavigateModels();
                  }}
                  className="w-full text-left px-3.5 py-2.5 text-[11px] text-sky-700 dark:text-sky-400 hover:bg-slate-100/80 dark:hover:bg-slate-800/60 transition-colors border-t border-slate-200/70 dark:border-slate-800/60 rounded-b-2xl"
                >
                  {t('chat.switchProviderInModels', 'Open Models to switch provider')}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <div className="flex-1" />

      <button
        onClick={onOpenDashboard}
        disabled={dashboardOpening}
        className="p-1.5 text-slate-500 hover:text-slate-900 dark:text-slate-600 dark:hover:text-slate-300 disabled:text-slate-300 dark:disabled:text-slate-700 rounded-lg transition-all duration-150"
        title={t('chat.openclawDashboard', 'OpenClaw Dashboard')}
      >
        {dashboardOpening ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />}
      </button>
    </div>
  );
}
