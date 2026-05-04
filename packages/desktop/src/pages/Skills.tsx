import { useState, useEffect, useCallback } from 'react';
import { Search, Download, Check, ExternalLink, Loader2, Trash2, RefreshCw, Package, AlertCircle, X, Save } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { useExternalNavigator } from '../lib/useExternalNavigator';

interface InstalledSkill {
  slug: string;
  version: string;
  installedAt: number;
}

interface InstallSpec {
  id: string;
  kind: string;
  label: string;
  bins: string[];
  package?: string;
  formula?: string;   // brew formula (e.g., "1password-cli")
  module?: string;    // go module path (e.g., "github.com/.../cmd/foo@latest")
}

interface LocalSkillStatus {
  name: string;
  description: string;
  source: string;
  skillKey?: string;
  emoji?: string;
  homepage?: string;
  primaryEnv?: string;
  bundled?: boolean;
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  /** OS platforms this skill supports, from SKILL.md metadata.os */
  supportedOs?: string[];
  missing?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
    os?: string[];
  };
  install?: InstallSpec[];
}

interface RemoteSkill {
  slug: string;
  name?: string;
  displayName?: string;
  description?: string;
  summary?: string;
  owner?: string;
  version?: string;
  emoji?: string;
  downloads?: number;
  score?: number;
}

interface SkillDetail {
  slug: string;
  name?: string;
  displayName?: string;
  description?: string;
  summary?: string;
  owner?: string;
  version?: string;
  emoji?: string;
  readme?: string;
  skillMd?: string;
  source?: string;
  bundled?: boolean;
  eligible?: boolean;
  disabled?: boolean;
  blockedByAllowlist?: boolean;
  homepage?: string;
  primaryEnv?: string;
  missing?: LocalSkillStatus['missing'];
  install?: InstallSpec[];
  // Dynamic OS compatibility from ClawHub metadata (null = cross-platform)
  supportedOs?: string[] | null;
  // ClawHub page URL (e.g., https://clawhub.ai/owner/slug)
  clawhubUrl?: string | null;
}

const PAGE_SIZE = 20;
const LOCAL_STATUS_TABS = ['all', 'ready', 'needs-setup', 'disabled'] as const;

type LocalStatusFilter = (typeof LOCAL_STATUS_TABS)[number];
type TranslateFunc = (key: string, fallback?: string) => string;

const OS_LABELS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

function summarizeMissing(skill: LocalSkillStatus) {
  const missing = skill.missing || {};
  // Show OS incompatibility prominently
  if (missing.os && missing.os.length > 0) {
    const osNames = missing.os.map(os => OS_LABELS[os] || os).join('/');
    return `${osNames} only`;
  }
  const parts = [
    ...(missing.bins || []).map(bin => `bin:${bin}`),
    ...(missing.env || []).map(env => `env:${env}`),
    ...(missing.config || []).map(config => `config:${config}`),
  ];
  return parts.slice(0, 3).join(' · ');
}

function getSkillStatusLabel(skill: Pick<LocalSkillStatus, 'eligible' | 'disabled' | 'blockedByAllowlist'>, t: TranslateFunc) {
  if (skill.disabled) return { label: t('skills.status.disabled', 'Disabled'), className: 'text-slate-500 dark:text-slate-400 bg-slate-200/60 dark:bg-slate-700/60' };
  if (skill.blockedByAllowlist) return { label: t('skills.status.blocked', 'Blocked'), className: 'text-amber-600 dark:text-amber-300 bg-amber-500/10' };
  if (skill.eligible) return { label: t('skills.status.ready', 'Ready'), className: 'text-emerald-600 dark:text-emerald-300 bg-emerald-500/10' };
  return { label: t('skills.status.needsSetup', 'Needs Setup'), className: 'text-amber-600 dark:text-amber-300 bg-amber-500/10' };
}

function buildLocalDetail(skill: LocalSkillStatus): SkillDetail {
  return {
    slug: skill.skillKey || skill.name,
    name: skill.name,
    displayName: skill.name,
    description: skill.description,
    emoji: skill.emoji,
    source: skill.source,
    bundled: skill.bundled,
    eligible: skill.eligible,
    disabled: skill.disabled,
    blockedByAllowlist: skill.blockedByAllowlist,
    homepage: skill.homepage,
    primaryEnv: skill.primaryEnv,
    supportedOs: skill.supportedOs,
    missing: skill.missing,
    install: skill.install,
  };
}

function buildFallbackInstallSpecs(skill: SkillDetail): InstallSpec[] {
  const bins = skill.missing?.bins || [];
  return bins.map((bin, idx) => ({
    id: `${skill.slug}-bin-${idx}`,
    kind: 'auto',
    label: `Install ${bin}`,
    bins: [bin],
    package: bin,
  }));
}

function matchesLocalStatus(skill: LocalSkillStatus, filter: LocalStatusFilter) {
  if (filter === 'all') return true;
  if (filter === 'disabled') return skill.disabled;
  if (filter === 'ready') return skill.eligible && !skill.disabled;
  return !skill.eligible && !skill.disabled && !skill.blockedByAllowlist;
}

function getLocalGroupLabel(source: string, t: TranslateFunc) {
  if (source === 'openclaw-bundled') return t('skills.group.builtin', 'Built-in Skills');
  if (source.includes('workspace')) return t('skills.group.workspace', 'Workspace Skills');
  if (source === 'agents-skills-project') return t('skills.group.projectAgent', 'Project Agent Skills');
  if (source === 'agents-skills-personal') return t('skills.group.personalAgent', 'Personal Agent Skills');
  if (source.includes('managed')) return t('skills.group.managed', 'Managed Skills');
  if (source === 'openclaw-extra') return t('skills.group.extra', 'Extra Skills');
  return source;
}

export default function Skills() {
  const { t } = useI18n();
  const { openExternal, isOpening } = useExternalNavigator();
  const [installed, setInstalled] = useState<Record<string, InstalledSkill>>({});
  const [localSkills, setLocalSkills] = useState<LocalSkillStatus[]>([]);
  const [remoteSkills, setRemoteSkills] = useState<RemoteSkill[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RemoteSkill[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'installed' | 'builtin'>('all');
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [actionSlug, setActionSlug] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<{ success: boolean; message: string } | null>(null);
  const [detailSkill, setDetailSkill] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [skillConfig, setSkillConfig] = useState<Record<string, string>>({});
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [localStatusFilter, setLocalStatusFilter] = useState<LocalStatusFilter>('all');

  const api = window.electronAPI as any;

  const loadData = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    const [installedRes, exploreRes] = await Promise.all([
      api.skillListInstalled(),
      api.skillExplore(),
    ]);
    if (installedRes.success) {
      setInstalled(installedRes.skills || {});
      setLocalSkills(Array.isArray(installedRes.report?.skills) ? installedRes.report.skills : []);
    }
    if (exploreRes.success && Array.isArray(exploreRes.skills)) {
      setRemoteSkills(exploreRes.skills);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const progressLabels: Record<string, string> = {
      matching: t('skills.progress.matching', 'Matching packages...'),
      downloading: t('skills.progress.downloading', 'Downloading from ClawHub...'),
      installing: t('skills.progress.installing', 'Installing...'),
      verifying: t('skills.progress.verifying', 'Verifying installation...'),
      error: t('skills.progress.error', 'Error'),
    };
    const cleanup = api?.onSkillInstallProgress?.((data: { stage: string; detail?: string }) => {
      const label = progressLabels[data.stage] || data.stage;
      setInstallProgress(data.detail ? `${label} ${data.detail}` : label);
      if (data.stage === 'verifying' || data.stage === 'error') {
        setTimeout(() => setInstallProgress(null), 2000);
      }
    });
    return () => cleanup?.();
  }, []);

  const handleSearch = async () => {
    if (!searchQuery.trim() || !api) return;
    setSearching(true);
    setSearchResults(null);
    setVisibleCount(PAGE_SIZE);
    const res = await api.skillSearch(searchQuery.trim());
    if (res.success) {
      setSearchResults(Array.isArray(res.results) ? res.results : []);
    }
    setSearching(false);
  };

  const handleInstall = async (slug: string) => {
    if (!api) return;
    setActionSlug(slug);
    setActionError(null);
    setInstallResult(null);
    setInstallProgress(t('skills.progress.downloading', 'Downloading from ClawHub...'));
    const res = await api.skillInstall(slug);
    setInstallProgress(null);
    if (res.success) {
      setInstallResult({ success: true, message: t('skills.installed', 'Installed') });
      const r = await api.skillListInstalled();
      if (r.success) {
        setInstalled(r.skills || {});
        setLocalSkills(Array.isArray(r.report?.skills) ? r.report.skills : []);
      }
    } else {
      setActionError(res.error || t('skills.installFailed', 'Install failed'));
      setInstallResult({ success: false, message: res.error || t('skills.installFailed', 'Install failed') });
    }
    setActionSlug(null);
  };

  const handleUninstall = async (slug: string) => {
    if (!api) return;
    setActionSlug(slug);
    setActionError(null);
    setInstallResult(null);
    const res = await api.skillUninstall(slug);
    if (res.success) {
      setInstallResult({ success: true, message: t('skills.uninstall', 'Uninstall') });
      const r = await api.skillListInstalled();
      if (r.success) {
        setInstalled(r.skills || {});
        setLocalSkills(Array.isArray(r.report?.skills) ? r.report.skills : []);
      }
    } else {
      setActionError(res.error || t('skills.uninstallFailed', 'Uninstall failed'));
      setInstallResult({ success: false, message: res.error || t('skills.uninstallFailed', 'Uninstall failed') });
    }
    setActionSlug(null);
  };

  const handleInstallDeps = async (skill: SkillDetail) => {
    if (!api) return;
    const specs = (skill.install && skill.install.length > 0) ? skill.install : buildFallbackInstallSpecs(skill);
    if (specs.length === 0) {
      setActionError(t('skills.installDepsNoop', 'No installable dependencies found.'));
      return;
    }

    setActionSlug(skill.slug);
    setActionError(null);
    setInstallResult(null);
    setInstallProgress(t('skills.progress.installingDeps', 'Installing dependencies...'));

    // Pass skill slug (CLI identifier), NOT skill.name (may be display name like "Apple Notes")
    const res = await api.skillInstallDeps(specs, skill.slug);
    setInstallProgress(null);

    if (res?.success) {
      // Check if target binaries were actually verified after install.
      // Install command may exit 0 but install the wrong package (e.g., `brew install grizzly`
      // installs Grafana's tool, not Bear Notes CLI). Show honest feedback.
      const unverified: string[] = res.unverified || [];
      if (unverified.length > 0) {
        // Install ran but binary not found — guide user to manual install
        setInstallResult({
          success: false,
          message: t('skills.installDepsUnverified', 'Install ran but {bins} not detected. Please install manually or check the install guide.').replace('{bins}', unverified.join(', ')),
        });
      } else {
        setInstallResult({ success: true, message: t('skills.installDepsSuccess', 'Dependencies installed') });
      }
      const listRes = await api.skillListInstalled();
      if (listRes?.success) {
        setInstalled(listRes.skills || {});
        const updatedSkills = Array.isArray(listRes.report?.skills) ? listRes.report.skills : [];
        setLocalSkills(updatedSkills);
        // Sync detailSkill with patched data so the modal shows updated status
        const updated = updatedSkills.find((s: LocalSkillStatus) => s.name === skill.name || s.skillKey === skill.slug);
        if (updated) {
          setDetailSkill(prev => prev ? { ...prev, eligible: updated.eligible, missing: updated.missing } : prev);
        }
      }
    } else {
      const msg = res?.error || t('skills.installDepsFailed', 'Dependency install failed');
      setActionError(msg);
      setInstallResult({ success: false, message: msg });
    }

    setActionSlug(null);
  };

  const openDetail = async (slug: string, localSkill?: LocalSkillStatus) => {
    if (!api) return;
    setDetailLoading(true);
    setInstallResult(null);
    setDetailSkill(localSkill ? buildLocalDetail(localSkill) : null);
    setConfigDirty(false);

    // Fetch ClawHub detail + config + local info (for install specs) in parallel
    const [detailRes, configRes, localInfoRes] = await Promise.all([
      api.skillDetail(slug),
      api.skillGetConfig?.(slug).catch(() => ({ success: false, config: {} })),
      localSkill?.bundled && !localSkill.eligible
        ? api.skillLocalInfo?.(localSkill.name).catch(() => ({ success: false }))
        : Promise.resolve(null),
    ]);
    if (detailRes.success && detailRes.skill) {
      setDetailSkill(prev => ({
        ...prev,
        ...detailRes.skill,
        // Prefer ClawHub API's supportedOs when available; fall back to local SKILL.md data.
        supportedOs: detailRes.skill.supportedOs ?? prev?.supportedOs,
      }));
    } else {
      const basic = fullList.find(s => s.slug === slug);
      if (basic) {
        setDetailSkill(prev => ({
          ...prev,
          slug,
          name: basic.name,
          displayName: basic.displayName,
          description: basic.description,
          summary: basic.summary,
          owner: basic.owner,
          version: basic.version,
          emoji: basic.emoji,
        }));
      }
    }
    // Merge install specs from openclaw skills info --json
    if (localInfoRes?.success && localInfoRes.info?.install) {
      setDetailSkill(prev => prev ? {
        ...prev,
        install: localInfoRes.info.install,
        homepage: localInfoRes.info.homepage || prev.homepage,
      } : prev);
    }
    setSkillConfig(configRes?.config || {});
    setDetailLoading(false);
  };

  const saveSkillConfig = async () => {
    if (!api || !detailSkill) return;
    setConfigSaving(true);
    await api.skillSaveConfig(detailSkill.slug, skillConfig);
    setConfigDirty(false);
    setConfigSaving(false);
  };

  const localInstalledSkills = localSkills.filter(skill => !skill.bundled);
  const localBuiltinSkills = localSkills.filter(skill => Boolean(skill.bundled || skill.source.includes('bundled')));
  const localStatusCounts = {
    all: localSkills.length,
    ready: localSkills.filter(skill => skill.eligible && !skill.disabled).length,
    needsSetup: localSkills.filter(skill => !skill.eligible && !skill.disabled && !skill.blockedByAllowlist).length,
    disabled: localSkills.filter(skill => skill.disabled).length,
  };
  const filteredLocalSkills = localSkills.filter(skill => matchesLocalStatus(skill, localStatusFilter));
  const localSkillGroups = Object.entries(
    filteredLocalSkills.reduce<Record<string, LocalSkillStatus[]>>((acc, skill) => {
      const key = getLocalGroupLabel(skill.source, t);
      if (!acc[key]) acc[key] = [];
      acc[key].push(skill);
      return acc;
    }, {}),
  );

  // Full list (before pagination)
  const fullList: RemoteSkill[] = (() => {
    if (searchResults !== null) return searchResults;
    if (filter === 'installed') {
      return [];
    }
    return remoteSkills;
  })();

  // Paginated display list
  const displayList = fullList.slice(0, visibleCount);
  const hasMore = fullList.length > visibleCount;

  const installedSlugs = new Set(Object.keys(installed));

  const recommendedList = remoteSkills
    .filter(skill => !installedSlugs.has(skill.slug))
    .slice(0, 4);

  const showRecommended = filter === 'all' && !searchResults && recommendedList.length > 0;
  const showBuiltin = filter === 'builtin';
  const showInstalled = filter === 'installed' && searchResults === null;

  return (
    <div className="h-full flex flex-col relative z-0">
      {/* Header */}
      <div className="ui-page-header relative z-10">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="ui-page-title">
              <span className="ui-title-icon">
                <Package size={16} />
              </span>
              {t('skills.title')}
            </h1>
            <p className="ui-page-subtitle">
              {t('skills.localSummary', '{count} local skills').replace('{count}', String(localStatusCounts.all))}
              {remoteSkills.length > 0 && ` · ${t('skills.remoteSummary', '{count} popular ClawHub skills').replace('{count}', String(remoteSkills.length))}`}
            </p>
          </div>
          <div className="flex gap-2 relative z-10">
            <button
              onClick={loadData}
              disabled={loading}
              className="ui-toolbar-button"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {t('skills.refresh')}
            </button>
            <button
              onClick={() => { void openExternal('https://clawhub.ai', 'skills-clawhub'); }}
              disabled={isOpening('skills-clawhub')}
              className="ui-toolbar-button disabled:opacity-50"
            >
              {isOpening('skills-clawhub') ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />} ClawHub
            </button>
          </div>
        </div>

        <div className="flex gap-3">
          <div className="relative flex-1 group">
            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-brand-500 transition-colors" />
            <input
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); if (!e.target.value) { setSearchResults(null); setVisibleCount(PAGE_SIZE); } }}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder={t('skills.search.placeholder')}
              className="ui-input w-full pl-10 pr-4 py-2.5 text-[13px] placeholder-slate-500"
            />
          </div>
          {searching && <Loader2 size={16} className="animate-spin text-brand-400 self-center" />}
          <div className="ui-surface-soft flex p-1">
            <button
              onClick={() => { setFilter('all'); setSearchResults(null); setSearchQuery(''); setVisibleCount(PAGE_SIZE); }}
              className={`px-3 py-1.5 text-[13px] font-medium rounded-xl transition-all ${filter === 'all' && !searchResults ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'}`}
            >
              {t('skills.explore')}
            </button>
            <button
              onClick={() => { setFilter('builtin'); setSearchResults(null); setSearchQuery(''); }}
              className={`px-3 py-1.5 text-[13px] font-medium rounded-xl transition-all ${filter === 'builtin' ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'}`}
            >
              {t('skills.showBuiltin')}
            </button>
            <button
              onClick={() => { setFilter('installed'); setSearchResults(null); setSearchQuery(''); setVisibleCount(PAGE_SIZE); }}
              className={`px-3 py-1.5 text-[13px] font-medium rounded-xl transition-all ${filter === 'installed' ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'}`}
            >
              {t('skills.installed')}
            </button>
          </div>
        </div>
      </div>

      {/* Error banner */}
      {actionError && (
        <div className="mx-8 mt-4 p-4 bg-red-500/10 border border-red-500/20 rounded-2xl text-[13px] text-red-600 dark:text-red-400 flex items-start gap-3 backdrop-blur-xl shadow-sm">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <div className="flex-1 font-medium">{actionError}</div>
          <button onClick={() => setActionError(null)} className="text-red-500/70 hover:text-red-600 dark:hover:text-red-300 transition-colors"><X size={16} /></button>
        </div>
      )}

      {/* Install progress banner */}
      {installProgress && !actionError && (
        <div className="mx-8 mt-4 p-4 bg-brand-500/10 border border-brand-500/20 rounded-2xl text-[13px] font-medium text-brand-600 dark:text-brand-300 flex items-center gap-3 backdrop-blur-xl shadow-sm">
          <Loader2 size={16} className="animate-spin flex-shrink-0" />
          <span>{installProgress}</span>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8 space-y-8 relative">
        <div className="absolute top-0 right-0 w-96 h-96 bg-brand-500/5 blur-[100px] pointer-events-none rounded-full z-0" />
        {filter === 'all' && searchResults === null && localSkills.length > 0 && (
          <div className="relative z-10">
            <h2 className="text-[15px] font-semibold text-slate-900 dark:text-slate-200 mb-1">{t('skills.localSectionTitle', 'OpenClaw Local Skills')}</h2>
            <p className="text-[13px] text-slate-500 dark:text-slate-400 mb-6">{t('skills.localSectionDesc', 'Official local skill status from openclaw skills list --json, aligned with the Control UI.')}</p>
            <div className="grid grid-cols-4 gap-4 mb-6">
              <div className="ui-surface p-4">
                <div className="text-[11px] font-bold tracking-widest text-slate-500 mb-1">{t('skills.status.all', 'ALL')}</div>
                <div className="text-2xl font-bold text-slate-900 dark:text-slate-100">{localStatusCounts.all}</div>
              </div>
              <div className="p-4 bg-emerald-500/5 dark:bg-emerald-500/10 backdrop-blur-xl border border-emerald-500/20 rounded-3xl shadow-sm">
                <div className="text-[11px] font-bold tracking-widest text-emerald-600 dark:text-emerald-400 mb-1">{t('skills.status.ready', 'READY')}</div>
                <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-300">{localStatusCounts.ready}</div>
              </div>
              <div className="p-4 bg-amber-500/5 dark:bg-amber-500/10 backdrop-blur-xl border border-amber-500/20 rounded-3xl shadow-sm">
                <div className="text-[11px] font-bold tracking-widest text-amber-600 dark:text-amber-400 mb-1">{t('skills.status.needsSetup', 'NEEDS SETUP')}</div>
                <div className="text-2xl font-bold text-amber-600 dark:text-amber-300">{localStatusCounts.needsSetup}</div>
              </div>
              <div className="ui-surface p-4">
                <div className="text-[11px] font-bold tracking-widest text-slate-500 mb-1">{t('skills.status.disabled', 'DISABLED')}</div>
                <div className="text-2xl font-bold text-slate-600 dark:text-slate-300">{localStatusCounts.disabled}</div>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap mb-6">
              {LOCAL_STATUS_TABS.map(tab => {
                const count = tab === 'all'
                  ? localStatusCounts.all
                  : tab === 'ready'
                    ? localStatusCounts.ready
                    : tab === 'needs-setup'
                      ? localStatusCounts.needsSetup
                      : localStatusCounts.disabled;
                return (
                  <button
                    key={tab}
                    onClick={() => setLocalStatusFilter(tab)}
                    className={`px-3 py-1.5 text-[12px] font-medium rounded-xl transition-all border shadow-sm ${localStatusFilter === tab ? 'bg-brand-500/10 border-brand-500/20 text-brand-600 dark:text-brand-300' : 'bg-white/40 dark:bg-slate-900/40 border-black/[0.04] dark:border-white/[0.04] text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'}`}
                  >
                    {t(`skills.status.${tab === 'needs-setup' ? 'needsSetup' : tab}`, tab)} <span className="opacity-70">{count}</span>
                  </button>
                );
              })}
            </div>
            {localSkillGroups.length === 0 ? (
              <div className="ui-surface text-center py-10 text-slate-500 relative z-10">
                <p className="text-[13px]">{t('skills.localEmpty', 'No local skills in this status.')}</p>
              </div>
            ) : (
              <div className="space-y-6 relative z-10">
                {localSkillGroups.map(([groupLabel, skills]) => (
                  <div key={groupLabel} className="ui-surface overflow-hidden">
                    <div className="px-6 py-4 border-b border-black/[0.04] dark:border-white/[0.04] flex items-center justify-between bg-slate-50/50 dark:bg-slate-950/20">
                      <h3 className="text-[14px] font-semibold text-slate-900 dark:text-slate-200 tracking-tight">{groupLabel}</h3>
                      <span className="text-[12px] font-medium text-slate-500 dark:text-slate-400 bg-black/5 dark:bg-white/10 px-2 py-0.5 rounded-md">{skills.length}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-4 p-6">
                      {skills.map(skill => {
                        const status = getSkillStatusLabel(skill, t);
                        return (
                          <div
                            key={skill.skillKey || skill.name}
                            onClick={() => openDetail(skill.skillKey || skill.name, skill)}
                            className="ui-surface-soft ui-card-interactive p-5 cursor-pointer group"
                          >
                            <div className="flex items-start gap-4">
                              <div className="text-3xl leading-none group-hover:scale-110 transition-transform duration-300 drop-shadow-sm">{skill.emoji || '🧩'}</div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <h4 className="text-[14px] font-semibold text-slate-900 dark:text-slate-200 truncate group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors">{skill.name}</h4>
                                  {skill.bundled && <span className="text-[10px] font-bold tracking-wider uppercase text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{t('skills.builtInBadge', 'Built-in')}</span>}
                                </div>
                                <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-1 line-clamp-2 leading-relaxed">{skill.description}</p>
                              </div>
                            </div>
                            <div className="mt-4 flex items-center justify-between gap-2 border-t border-black/[0.02] dark:border-white/[0.02] pt-3">
                              <span className={`px-2 py-1 rounded-md text-[10px] font-bold tracking-wider uppercase border border-black/[0.02] dark:border-white/[0.02] shadow-sm ${status.className}`}>{status.label}</span>
                              <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 dark:text-slate-500 truncate">{summarizeMissing(skill) || skill.source}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Built-in section */}
        {showBuiltin && (
          <div className="relative z-10">
            <h2 className="text-[15px] font-semibold text-slate-900 dark:text-slate-200 mb-1">{t('skills.builtin')}</h2>
            <p className="text-[13px] text-slate-500 dark:text-slate-400 mb-6">{t('skills.builtinSectionDesc', 'Bundled OpenClaw skills from the official local status report.')}</p>
            <div className="grid grid-cols-2 gap-4">
              {localBuiltinSkills.map(skill => {
                const status = getSkillStatusLabel(skill, t);
                return (
                  <div
                    key={skill.skillKey || skill.name}
                    onClick={() => openDetail(skill.skillKey || skill.name, skill)}
                    className="ui-surface ui-card-interactive p-5 cursor-pointer group"
                  >
                    <div className="flex items-start gap-4">
                      <span className="text-3xl drop-shadow-sm group-hover:scale-110 transition-transform duration-300">{skill.emoji || '🧩'}</span>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[14px] font-semibold text-slate-900 dark:text-slate-200 truncate group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors">{skill.name}</h4>
                        <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-1 line-clamp-2 leading-relaxed">{skill.description}</p>
                      </div>
                    </div>
                    <div className="mt-4 flex items-center justify-between gap-2 border-t border-black/[0.02] dark:border-white/[0.02] pt-3">
                      <span className={`px-2 py-1 rounded-md text-[10px] font-bold tracking-wider uppercase border border-black/[0.02] dark:border-white/[0.02] shadow-sm ${status.className}`}>{status.label}</span>
                      <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 dark:text-slate-500 truncate">{summarizeMissing(skill) || skill.source}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Installed local skills section */}
        {showInstalled && (
          <div className="relative z-10">
            <h2 className="text-[15px] font-semibold text-slate-900 dark:text-slate-200 mb-1">{t('skills.installed')}</h2>
            <p className="text-[13px] text-slate-500 dark:text-slate-400 mb-6">{t('skills.installedSectionDesc', 'Workspace and managed skills visible to the current OpenClaw workspace.')}</p>
            {localInstalledSkills.length === 0 ? (
              <div className="ui-surface text-center py-16 text-slate-500">
                <Package size={32} className="mx-auto mb-4 text-slate-400 opacity-50" />
                <p className="text-[13px] font-medium">{t('skills.noInstalled')}</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                {localInstalledSkills.map(skill => {
                  const status = getSkillStatusLabel(skill, t);
                  return (
                    <div
                      key={skill.skillKey || skill.name}
                      onClick={() => openDetail(skill.skillKey || skill.name, skill)}
                      className="ui-surface ui-card-interactive p-5 cursor-pointer group"
                    >
                      <div className="flex items-start gap-4">
                        <span className="text-3xl drop-shadow-sm group-hover:scale-110 transition-transform duration-300">{skill.emoji || '🧩'}</span>
                        <div className="flex-1 min-w-0">
                          <h4 className="text-[14px] font-semibold text-slate-900 dark:text-slate-200 truncate group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors">{skill.name}</h4>
                          <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-1 line-clamp-2 leading-relaxed">{skill.description}</p>
                        </div>
                      </div>
                      <div className="mt-4 flex items-center justify-between gap-2 border-t border-black/[0.02] dark:border-white/[0.02] pt-3">
                        <span className={`px-2 py-1 rounded-md text-[10px] font-bold tracking-wider uppercase border border-black/[0.02] dark:border-white/[0.02] shadow-sm ${status.className}`}>{status.label}</span>
                        <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 dark:text-slate-500 truncate">{skill.source}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Popular Skills section (only on Explore tab, not during search) */}
        {showRecommended && (
          <div className="relative z-10">
            <h2 className="text-[15px] font-semibold text-slate-900 dark:text-slate-200 mb-1">{t('skills.popular', 'Popular on ClawHub')}</h2>
            <p className="text-[13px] text-slate-500 dark:text-slate-400 mb-6">{t('skills.popular.desc', 'Official ClawHub list sorted by downloads with nonSuspiciousOnly=true.')}</p>
            <div className="grid grid-cols-2 gap-4">
              {recommendedList.map(skill => {
                const isInstalled = installedSlugs.has(skill.slug);
                const isActioning = actionSlug === skill.slug;
                return (
                  <div
                    key={skill.slug}
                    onClick={() => openDetail(skill.slug)}
                    className="p-5 bg-gradient-to-br from-brand-500/10 dark:from-brand-600/10 to-transparent backdrop-blur-xl border border-brand-500/20 dark:border-brand-500/30 rounded-3xl hover:border-brand-500/40 dark:hover:border-brand-500/50 hover:shadow-md transition-all duration-200 cursor-pointer shadow-sm group"
                  >
                    <div className="flex items-start gap-4">
                      <span className="text-3xl drop-shadow-sm group-hover:scale-110 transition-transform duration-300">{skill.emoji || '⭐'}</span>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[14px] font-semibold text-slate-900 dark:text-slate-200 truncate group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors">{skill.displayName || skill.name || skill.slug}</h4>
                        <p className="text-[11px] font-medium text-brand-600/70 dark:text-brand-300/70 mt-1">{t('skills.popular.rankHint', 'Ranked from official ClawHub popularity data')}</p>
                        <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-2 line-clamp-1 leading-relaxed">{skill.summary || skill.description}</p>
                      </div>
                    </div>
                    <div className="mt-4 flex justify-end border-t border-brand-500/10 pt-3">
                      {isInstalled ? (
                        <span className="flex items-center gap-1 text-[12px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded-lg">
                          <Check size={14} /> {t('skills.installed')}
                        </span>
                      ) : (
                        <button
                          onClick={e => { e.stopPropagation(); handleInstall(skill.slug); }}
                          disabled={isActioning}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700 text-white rounded-xl transition-colors shadow-sm"
                        >
                          {isActioning ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                          {isActioning ? t('skills.installing') : t('skills.install')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Skills grid (explore / installed / search results) */}
        {!showBuiltin && !showInstalled && (
          <div className="relative z-10">
            {showRecommended && displayList.length > 0 && (
              <h2 className="text-[15px] font-semibold text-slate-900 dark:text-slate-200 mb-6">{t('skills.explore')}</h2>
            )}
            {loading ? (
              <div className="flex items-center justify-center h-40 text-[13px] text-slate-500 dark:text-slate-400">
                <Loader2 size={20} className="animate-spin mr-2 text-brand-500" /> {t('skills.loading')}
              </div>
            ) : displayList.length === 0 && !showRecommended ? (
              <div className="ui-surface text-center py-16 text-slate-500">
                <Package size={32} className="mx-auto mb-4 text-slate-400 opacity-50" />
                <p className="text-[13px] font-medium">{searchResults !== null ? t('skills.noResults') : filter === 'installed' ? t('skills.noInstalled') : t('skills.noSkills')}</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4">
                  {displayList.map(skill => {
                    const isInstalled = installedSlugs.has(skill.slug);
                    const isActioning = actionSlug === skill.slug;
                    const installedInfo = installed[skill.slug];

                    return (
                      <div
                        key={skill.slug}
                        onClick={() => openDetail(skill.slug)}
                        className="ui-surface ui-card-interactive p-5 cursor-pointer group"
                      >
                        <div className="flex items-start gap-4">
                          <span className="text-3xl drop-shadow-sm group-hover:scale-110 transition-transform duration-300">{skill.emoji || '🧩'}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <h4 className="text-[14px] font-semibold text-slate-900 dark:text-slate-200 truncate group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors">{skill.displayName || skill.name || skill.slug}</h4>
                              <span className="text-[10px] font-medium tracking-wider text-slate-400 dark:text-slate-500 bg-black/5 dark:bg-white/10 px-1.5 py-0.5 rounded">
                                v{isInstalled ? installedInfo?.version : skill.version || '?'}
                              </span>
                            </div>
                            <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-1 line-clamp-2 leading-relaxed">
                              {skill.summary || skill.description || skill.slug}
                            </p>
                            {skill.owner && (
                              <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500 mt-2 inline-block">@{skill.owner}</span>
                            )}
                          </div>
                        </div>
                        <div className="mt-4 flex justify-end gap-2 border-t border-black/[0.02] dark:border-white/[0.02] pt-3">
                          {isInstalled ? (
                            <>
                              <span className="flex items-center gap-1 text-[12px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded-lg mr-auto">
                                <Check size={14} /> {t('skills.installed')}
                              </span>
                              <button
                                onClick={e => { e.stopPropagation(); handleUninstall(skill.slug); }}
                                disabled={isActioning}
                                className="flex items-center gap-1 px-3 py-1.5 text-[12px] font-medium text-red-600 dark:text-red-400 hover:text-white hover:bg-red-500 rounded-xl transition-colors shadow-sm border border-red-500/20 hover:border-red-500"
                              >
                                {isActioning ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                                {t('skills.uninstall')}
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={e => { e.stopPropagation(); handleInstall(skill.slug); }}
                              disabled={isActioning}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700 text-white rounded-xl transition-colors shadow-sm"
                            >
                              {isActioning ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                              {isActioning ? t('skills.installing') : t('skills.install')}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Load More button */}
                {hasMore && (
                  <div className="text-center pt-2">
                    <button
                      onClick={() => setVisibleCount(prev => prev + PAGE_SIZE)}
                      className="px-6 py-2 text-xs text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-xl transition-colors"
                    >
                      {t('skills.loadMore')} ({t('skills.loadMoreCount', '{count} more').replace('{count}', String(fullList.length - visibleCount))})
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Skill Detail Modal */}
      {(detailSkill || detailLoading) && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[60] p-8">
          <div className="bg-white/90 dark:bg-slate-950/90 border border-black/[0.08] dark:border-white/[0.08] backdrop-blur-2xl rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl shadow-black/60">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-black/[0.06] dark:border-white/[0.06]">
              {detailLoading ? (
                <div className="flex items-center gap-2 text-slate-400 dark:text-slate-500">
                  <Loader2 size={16} className="animate-spin" /> {t('common.loading', 'Loading...')}
                </div>
              ) : (
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-2xl">{detailSkill?.emoji || '🧩'}</span>
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold truncate text-slate-900 dark:text-white">{detailSkill?.displayName || detailSkill?.name || detailSkill?.slug}</h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      v{detailSkill?.version || '?'}
                      {detailSkill?.owner && ` · ${detailSkill.owner}`}
                    </p>
                  </div>
                </div>
              )}
              <button onClick={() => setDetailSkill(null)} aria-label={t('common.close', 'Close')} title={t('common.close', 'Close')} className="text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-white flex-shrink-0 transition-colors">
                <X size={20} />
              </button>
            </div>

            {/* Content */}
            {detailSkill && (
              <div className="flex-1 overflow-y-auto p-6 space-y-5">
                {(detailSkill.description || detailSkill.summary) && (
                  <p className="text-[15px] text-slate-900 dark:text-slate-200 leading-relaxed">{detailSkill.description || detailSkill.summary}</p>
                )}

                {(detailSkill.source || detailSkill.homepage || detailSkill.primaryEnv || detailSkill.missing) && (
                  <div className="bg-white/60 dark:bg-slate-900/60 backdrop-blur-xl rounded-2xl p-4 border border-black/[0.04] dark:border-white/[0.04] space-y-2">
                    <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">{t('skills.openclawStatus', 'OpenClaw Status')}</h4>
                    {detailSkill.source && <p className="text-xs text-slate-500 dark:text-slate-400">{t('skills.sourceLabel', 'Source')}: {detailSkill.source}</p>}
                    {(typeof detailSkill.eligible === 'boolean' || typeof detailSkill.disabled === 'boolean') && (
                      <p className="text-xs text-slate-500 dark:text-slate-400">{t('skills.statusLabel', 'Status')}: {getSkillStatusLabel({ eligible: Boolean(detailSkill.eligible), disabled: Boolean(detailSkill.disabled), blockedByAllowlist: Boolean(detailSkill.blockedByAllowlist) }, t).label}</p>
                    )}
                    {detailSkill.primaryEnv && <p className="text-xs text-slate-500 dark:text-slate-400">{t('skills.primaryEnvLabel', 'Primary env')}: {detailSkill.primaryEnv}</p>}
                    {detailSkill.homepage && (
                      <button
                        onClick={() => { void openExternal(detailSkill.homepage || '', `skill-homepage-${detailSkill.slug}`); }}
                        disabled={isOpening(`skill-homepage-${detailSkill.slug}`)}
                        className="text-xs text-brand-600 dark:text-brand-300 hover:underline"
                      >
                        {t('skills.openHomepage', 'Open homepage')}
                      </button>
                    )}
                    {detailSkill.clawhubUrl && (
                      <button
                        onClick={() => { void openExternal(detailSkill.clawhubUrl || '', `skill-clawhub-${detailSkill.slug}`); }}
                        disabled={isOpening(`skill-clawhub-${detailSkill.slug}`)}
                        className="text-xs text-brand-600 dark:text-brand-300 hover:underline"
                      >
                        {t('skills.viewOnClawHub', 'View on ClawHub (install guide & docs)')}
                      </button>
                    )}
                    {/* OS compatibility: from ClawHub API or local SKILL.md metadata.os */}
                    {(() => {
                      const osList = detailSkill.supportedOs;
                      if (!osList || osList.length === 0) return null;
                      const currentOs = navigator.platform?.startsWith('Win') ? 'win32'
                        : navigator.platform?.startsWith('Mac') ? 'darwin' : 'linux';
                      const compatible = osList.includes(currentOs);
                      return (
                        <p className={`text-xs flex items-center gap-1 ${compatible ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-500 dark:text-amber-300'}`}>
                          <span>{compatible ? '✓' : '⚠'}</span>
                          <span>
                            {compatible
                              ? t('skills.osCompatible', 'Compatible with {os}').replace('{os}', OS_LABELS[currentOs] || currentOs)
                              : t('skills.osIncompatible', 'Requires {os}').replace('{os}', osList.map(o => OS_LABELS[o] || o).join(', '))}
                          </span>
                        </p>
                      );
                    })()}
                    {detailSkill.missing && summarizeMissing({
                      name: detailSkill.name || detailSkill.slug,
                      description: detailSkill.description || '',
                      source: detailSkill.source || '',
                      eligible: Boolean(detailSkill.eligible),
                      disabled: Boolean(detailSkill.disabled),
                      blockedByAllowlist: Boolean(detailSkill.blockedByAllowlist),
                      missing: detailSkill.missing,
                    }) && (
                      <p className="text-xs text-amber-500 dark:text-amber-300">{t('skills.missingLabel', 'Missing')}: {summarizeMissing({
                        name: detailSkill.name || detailSkill.slug,
                        description: detailSkill.description || '',
                        source: detailSkill.source || '',
                        eligible: Boolean(detailSkill.eligible),
                        disabled: Boolean(detailSkill.disabled),
                        blockedByAllowlist: Boolean(detailSkill.blockedByAllowlist),
                        missing: detailSkill.missing,
                      })}</p>
                    )}
                  </div>
                )}

                {(detailSkill.skillMd || detailSkill.readme) && (
                  <div className="bg-white/70 dark:bg-slate-900/70 backdrop-blur rounded-2xl p-4 border border-black/[0.04] dark:border-white/[0.04]">
                    <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2">{t('skills.documentation', 'Documentation')}</h4>
                    <pre className="text-xs text-slate-700 dark:text-slate-200 whitespace-pre-wrap font-mono max-h-60 overflow-y-auto">
                      {detailSkill.skillMd || detailSkill.readme}
                    </pre>
                  </div>
                )}

                {(installedSlugs.has(detailSkill.slug) || !!detailSkill.primaryEnv || (detailSkill.missing?.env?.length ?? 0) > 0 || (detailSkill.missing?.config?.length ?? 0) > 0) && (
                  <div className="bg-white/70 dark:bg-slate-900/70 backdrop-blur rounded-2xl p-4 border border-black/[0.04] dark:border-white/[0.04]">
                    <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-3">{t('skills.configuration', 'Configuration')}</h4>
                    {Object.keys(skillConfig).length === 0 ? (
                      <p className="text-xs text-slate-400 dark:text-slate-500">{t('skills.noConfigOptions', 'No configuration options. Add key-value pairs below.')}</p>
                    ) : null}
                    <div className="space-y-2">
                      {Object.entries(skillConfig).map(([key, val]) => (
                        <div key={key} className="flex items-center gap-2">
                          <span className="text-xs font-mono text-slate-500 dark:text-slate-400 w-32 truncate flex-shrink-0">{key}</span>
                          <input
                            value={val}
                            onChange={e => { setSkillConfig(prev => ({ ...prev, [key]: e.target.value })); setConfigDirty(true); }}
                            aria-label={key}
                            title={key}
                            className="flex-1 px-2 py-1 bg-white dark:bg-slate-900 border border-black/[0.08] dark:border-white/[0.08] rounded text-xs font-mono text-slate-900 dark:text-white focus:outline-none focus:border-brand-500"
                          />
                          <button
                            onClick={() => { const next = { ...skillConfig }; delete next[key]; setSkillConfig(next); setConfigDirty(true); }}
                            aria-label={t('common.remove', 'Remove')}
                            title={t('common.remove', 'Remove')}
                            className="text-slate-400 hover:text-red-500 dark:text-slate-500 dark:hover:text-red-400"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <input
                        placeholder={t('skills.configKeyPlaceholder', 'key')}
                        id="new-config-key"
                        className="flex-1 px-2 py-1 bg-white dark:bg-slate-900 border border-black/[0.08] dark:border-white/[0.08] rounded text-xs font-mono text-slate-900 dark:text-white focus:outline-none focus:border-brand-500"
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            const input = e.target as HTMLInputElement;
                            const k = input.value.trim();
                            if (k && !(k in skillConfig)) { setSkillConfig(prev => ({ ...prev, [k]: '' })); setConfigDirty(true); input.value = ''; }
                          }
                        }}
                      />
                      <button
                        onClick={() => {
                          const input = document.getElementById('new-config-key') as HTMLInputElement;
                          const k = input?.value.trim();
                          if (k && !(k in skillConfig)) { setSkillConfig(prev => ({ ...prev, [k]: '' })); setConfigDirty(true); input.value = ''; }
                        }}
                        className="px-2 py-1 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded transition-colors"
                      >
                        {t('skills.addConfig', '+ Add')}
                      </button>
                    </div>
                    {configDirty && (
                      <button
                        onClick={saveSkillConfig}
                        disabled={configSaving}
                        className="mt-3 flex items-center gap-1 px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700 text-white rounded-lg transition-colors"
                      >
                        {configSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                        {t('skills.saveConfig', 'Save Config')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Footer actions */}
            {detailSkill && (
              <div className="flex justify-end gap-2 p-6 border-t border-black/[0.06] dark:border-white/[0.06] bg-white/70 dark:bg-slate-900/70 rounded-b-3xl">
                {detailSkill.eligible ? (
                  /* Skill is ready — show installed badge */
                  <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 mr-auto">
                    <Check size={12} /> {t('skills.status.ready', 'Ready')}
                  </span>
                ) : detailSkill.bundled && !detailSkill.eligible ? (
                  /* Built-in skill needs setup — show install guidance */
                  (detailSkill.missing?.os?.length ?? 0) > 0 ? (
                    /* OS incompatible — show clear message, no install button */
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 rounded-lg">
                        <span className="text-red-500 dark:text-red-400 text-sm">
                          {t('skills.osIncompatible', 'This skill requires {os} and is not available on your system.').replace('{os}', (detailSkill.missing?.os || []).map(os => os === 'darwin' ? 'macOS' : os === 'win32' ? 'Windows' : os === 'linux' ? 'Linux' : os).join(' / '))}
                        </span>
                      </div>
                    </div>
                  ) : (
                  /* Installable — show install specs + auto-install button */
                  <div className="flex items-center gap-2 w-full">
                    <div className="flex-1 space-y-1">
                      {(detailSkill.install && detailSkill.install.length > 0) ? (
                        detailSkill.install.map((spec: InstallSpec) => (
                          <div key={spec.id} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                            <span className="px-1.5 py-0.5 bg-slate-200 dark:bg-slate-800 rounded text-[10px] uppercase">{spec.kind}</span>
                            <span>{spec.label}</span>
                          </div>
                        ))
                      ) : (detailSkill.missing?.bins?.length ?? 0) > 0 ? (
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {t('skills.missingBinsHint', 'Install the required tools: {bins}').replace('{bins}', (detailSkill.missing?.bins || []).join(', '))}
                        </p>
                      ) : (detailSkill.missing?.env?.length ?? 0) > 0 ? (
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {t('skills.missingEnvHint', 'Set required environment variables: {env}').replace('{env}', (detailSkill.missing?.env || []).join(', '))}
                        </p>
                      ) : null}
                      {actionSlug === detailSkill.slug && installProgress && (
                        <p className="text-xs text-sky-600 dark:text-sky-400 animate-pulse">
                          {installProgress}
                        </p>
                      )}
                      {installResult && (
                        <p className={`text-xs ${installResult.success ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>
                          {installResult.message}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={async () => { await handleInstallDeps(detailSkill); }}
                      disabled={actionSlug === detailSkill.slug}
                      className="flex items-center gap-1 px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700 text-white rounded-xl transition-colors flex-shrink-0"
                    >
                      {actionSlug === detailSkill.slug ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                      {actionSlug === detailSkill.slug ? t('skills.installing', 'Installing...') : t('skills.installDeps', 'Auto Install')}
                    </button>
                    {detailSkill.homepage && (
                      <button
                        onClick={() => { void openExternal(detailSkill.homepage || '', `skill-install-${detailSkill.slug}`); }}
                        disabled={isOpening(`skill-install-${detailSkill.slug}`)}
                        className="flex items-center gap-1 px-4 py-2 text-sm bg-white dark:bg-slate-900 border border-black/[0.08] dark:border-white/[0.08] text-slate-700 dark:text-slate-200 rounded-xl transition-colors flex-shrink-0 hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        <ExternalLink size={14} />
                        {t('skills.openInstallGuide', 'Install Guide')}
                      </button>
                    )}
                  </div>
                  )
                ) : installedSlugs.has(detailSkill.slug) ? (
                  /* ClawHub installed skill — show usage guide + uninstall */
                  <>
                    <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 mr-auto">
                      <Check size={12} /> {t('skills.installed')}
                    </span>
                    {detailSkill.clawhubUrl && (
                      <button
                        onClick={() => { void openExternal(detailSkill.clawhubUrl || '', `skill-guide-${detailSkill.slug}`); }}
                        disabled={isOpening(`skill-guide-${detailSkill.slug}`)}
                        className="flex items-center gap-1 px-4 py-2 text-sm bg-white dark:bg-slate-900 border border-black/[0.08] dark:border-white/[0.08] text-slate-700 dark:text-slate-200 rounded-xl transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        <ExternalLink size={14} />
                        {t('skills.usageGuide', 'Usage Guide')}
                      </button>
                    )}
                    <button
                      onClick={async () => { await handleUninstall(detailSkill.slug); }}
                      disabled={actionSlug === detailSkill.slug}
                      className="flex items-center gap-1 px-4 py-2 text-sm text-red-500 dark:text-red-400 hover:bg-red-500/10 rounded-xl transition-colors"
                    >
                      {actionSlug === detailSkill.slug ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                      {t('skills.uninstall')}
                    </button>
                  </>
                ) : (
                  /* ClawHub skill — install from registry */
                  <button
                    onClick={async () => { await handleInstall(detailSkill.slug); }}
                    disabled={actionSlug === detailSkill.slug}
                    className="flex items-center gap-1 px-5 py-2 text-sm bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700 text-white rounded-xl transition-colors"
                  >
                    {actionSlug === detailSkill.slug ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                    {actionSlug === detailSkill.slug ? (installProgress || t('skills.installing')) : t('skills.install')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
