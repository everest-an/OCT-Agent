import { CheckCircle, Loader2 } from 'lucide-react';
import type { UsageStats } from '../../lib/usage';

export function SettingsUsagePanel({
  usageStats,
  t,
  onClear,
}: {
  usageStats: UsageStats;
  t: (key: string, fallback?: string) => string;
  onClear: () => void;
}) {
  return (
    <div className="settings-glass-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="settings-section-title">{t('settings.usage') || 'Usage (estimated)'}</h3>
        <button
          onClick={onClear}
          className="settings-btn settings-btn-danger text-[10px] px-2.5 py-1"
        >
          {t('settings.reset.btn')}
        </button>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="text-center">
          <div className="text-lg font-bold text-brand-400">{usageStats.todayMessages}</div>
          <div className="text-[10px] text-slate-500">{t('settings.usage.today') || 'Today'}</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold text-slate-200">{usageStats.totalMessages}</div>
          <div className="text-[10px] text-slate-500">{t('settings.usage.total') || 'Total (30d)'}</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold text-slate-200">{((usageStats.totalInputTokens + usageStats.totalOutputTokens) / 1000).toFixed(1)}k</div>
          <div className="text-[10px] text-slate-500">{t('settings.usage.tokens') || 'Est. tokens'}</div>
        </div>
      </div>
      {Object.keys(usageStats.byModel).length > 0 && (
        <div className="border-t border-slate-700/50 pt-2 space-y-1">
          {Object.entries(usageStats.byModel).slice(0, 5).map(([model, data]) => (
            <div key={model} className="flex items-center justify-between text-[10px]">
              <span className="text-slate-400 truncate max-w-[60%]">{model}</span>
              <span className="text-slate-500">{data.messages} msgs · {((data.inputTokens + data.outputTokens) / 1000).toFixed(1)}k tokens</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SettingsVersionPanel({
  packageVersion,
  versionInfo,
  t,
  onOpenGithub,
  githubOpening,
}: {
  packageVersion: string;
  versionInfo: {
    platform?: string;
    arch?: string;
    nodeVersion?: string;
    openclawVersion?: string;
    awarenessPluginVersion?: string;
    daemonRunning?: boolean;
    daemonVersion?: string;
    daemonStats?: { memories?: number; knowledge?: number; sessions?: number };
  } | null;
  t: (key: string, fallback?: string) => string;
  onOpenGithub: () => void;
  githubOpening: boolean;
}) {
  return (
    <div className="settings-glass-card p-4 space-y-2">
      <h3 className="settings-section-title mb-3">{t('settings.versions')}</h3>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex justify-between p-2 settings-glass-soft">
          <span className="text-slate-400">{t('app.name', 'OCT')}</span>
          <span className="text-slate-200 font-mono">v{packageVersion}</span>
        </div>
        <div className="flex justify-between p-2 settings-glass-soft">
          <span className="text-slate-400">{t('settings.versions.openclaw', 'OpenClaw')}</span>
          <span className={`font-mono ${versionInfo?.openclawVersion ? 'text-slate-200' : 'text-red-400'}`}>
            {versionInfo?.openclawVersion || t('settings.diagnostic.notInstalled')}
          </span>
        </div>
        <div className="flex justify-between p-2 settings-glass-soft">
          <span className="text-slate-400">Node.js</span>
          <span className={`font-mono ${versionInfo?.nodeVersion ? 'text-slate-200' : 'text-red-400'}`}>
            {versionInfo?.nodeVersion || t('settings.diagnostic.notInstalled')}
          </span>
        </div>
        <div className="flex justify-between p-2 settings-glass-soft">
          <span className="text-slate-400">{t('settings.versions.awarenessPlugin', 'Awareness Plugin')}</span>
          <span className={`font-mono ${versionInfo?.awarenessPluginVersion ? 'text-slate-200' : 'text-red-400'}`}>
            {versionInfo?.awarenessPluginVersion ? `v${versionInfo.awarenessPluginVersion}` : t('settings.diagnostic.notInstalled')}
          </span>
        </div>
        <div className="flex justify-between p-2 settings-glass-soft">
          <span className="text-slate-400">{t('settings.versions.localDaemon', 'Local Daemon')}</span>
          <span className={`font-mono ${versionInfo?.daemonRunning ? 'text-emerald-400' : 'text-red-400'} inline-flex items-center gap-1`}>
            {versionInfo?.daemonRunning
              ? <><span>{`v${versionInfo.daemonVersion || '?'}`}</span><CheckCircle size={12} /></>
              : t('settings.versions.offline', 'Offline')}
          </span>
        </div>
        <div className="flex justify-between p-2 settings-glass-soft">
          <span className="text-slate-400">{t('settings.diagnostic.platform')}</span>
          <span className="text-slate-200 font-mono">{versionInfo ? `${versionInfo.platform} ${versionInfo.arch}` : '...'}</span>
        </div>
      </div>
      {versionInfo?.daemonStats && (
        <div className="flex gap-4 justify-center text-[10px] text-slate-500 pt-1">
          <span>{versionInfo.daemonStats.memories || 0} {t('settings.versions.memories', 'memories')}</span>
          <span>{versionInfo.daemonStats.knowledge || 0} {t('settings.versions.knowledgeCards', 'knowledge cards')}</span>
          <span>{versionInfo.daemonStats.sessions || 0} {t('settings.versions.sessions', 'sessions')}</span>
        </div>
      )}
      <div className="flex justify-center pt-2">
        <button onClick={onOpenGithub} disabled={githubOpening} className="settings-btn settings-btn-secondary text-xs disabled:text-slate-500">
          {githubOpening ? <Loader2 size={12} className="animate-spin" /> : null}
          GitHub
        </button>
      </div>
    </div>
  );
}

export function SettingsSecuritySummary({
  issues,
  t,
}: {
  issues: Array<{ level: string; message: string; fix?: string }>;
  t: (key: string, fallback?: string) => string;
}) {
  if (issues.length === 0) {
    return (
      <div className="flex items-center gap-2 text-xs p-2 rounded-lg bg-emerald-500/10 text-emerald-400">
        <CheckCircle size={14} className="shrink-0" />
        <p>{t('settings.security.allGood', 'No security issues found')}</p>
      </div>
    );
  }

  return null;
}