import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import {
  Search, RefreshCw, Loader2, AlertCircle, HardDrive, Cloud,
  Clock, Share2, SlidersHorizontal, Brain, Play, BookOpen, ArrowDownUp,
  FolderOpen,
} from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { useExternalNavigator } from '../lib/useExternalNavigator';
import { useMemorySettings } from '../hooks/useMemorySettings';
import { useDaemonConnection } from '../hooks/useDaemonConnection';
import { useMemoryData } from '../hooks/useMemoryData';
import { useMemorySearch } from '../hooks/useMemorySearch';
import { useWikiData } from '../hooks/useWikiData';
import './memory-graph.css';
import { MemorySettingsPanel } from '../components/memory/MemorySettingsPanel';
import { SyncConflictPanel } from '../components/SyncConflictPanel';
import { TimelineTab } from '../components/memory/TimelineTab';
import { WikiSidebar } from '../components/memory/WikiSidebar';
import { WikiContentArea } from '../components/memory/WikiContentArea';
import { SettingsCloudAuthModal } from '../components/settings/SettingsCloudAuthModal';
import type { TabView } from '../components/memory/memory-helpers.js';
import type { WikiSelectedItem } from '../components/memory/wiki-types';

/**
 * Small header chip showing which workspace the Memory page is currently
 * reading from. Mirrors the chat header workspace selector — any change there
 * propagates here via the `workspace:changed` IPC event.
 */
interface WorkspaceIndicatorProps {
  activePath: string | null;
  daemonProjectDir: string | null;
  t: (key: string, fallback?: string) => string;
}

function WorkspaceIndicator({ activePath, daemonProjectDir, t }: WorkspaceIndicatorProps) {
  // Resolve a short display label: the basename of the active workspace, or
  // "OpenClaw" when the daemon is using the global default.
  const resolved = activePath && activePath.trim() ? activePath : daemonProjectDir;
  const isDefault = !activePath || !activePath.trim();

  const label = (() => {
    if (isDefault) return t('memory.workspace.openclawDefault', 'OpenClaw');
    const parts = (resolved || '').split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] || resolved || 'unknown';
  })();

  const titleText = isDefault
    ? t('memory.workspace.openclawTooltip', 'Global workspace: {path}').replace('{path}', resolved || '~/.openclaw')
    : t('memory.workspace.projectTooltip', 'Project workspace: {path}').replace('{path}', resolved || '');

  return (
    <div
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border ${
        isDefault
          ? 'border-slate-700/60 bg-slate-800/40 text-slate-400'
          : 'border-brand-500/40 bg-brand-600/10 text-brand-200'
      }`}
      title={titleText}
    >
      <FolderOpen size={12} className={isDefault ? 'text-slate-500' : 'text-brand-300'} />
      <span className="truncate max-w-[180px]">{label}</span>
    </div>
  );
}

function MemoryLayerInfo({ className = '' }: { className?: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={className}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
      >
        {expanded ? '▾' : '▸'}
        <span>{t('memory.architecture')}</span>
      </button>
      {expanded && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="p-3 rounded-xl border border-blue-500/20 bg-blue-500/5">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Cloud size={12} className="text-blue-400" />
              <span className="text-xs font-medium text-blue-400">{t('memory.awareness.title')}</span>
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">{t('memory.awareness.desc')}</p>
          </div>
          <div className="p-3 rounded-xl border border-slate-500/20 bg-slate-500/5">
            <div className="flex items-center gap-1.5 mb-1.5">
              <HardDrive size={12} className="text-slate-400" />
              <span className="text-xs font-medium text-slate-400">{t('memory.openclaw.title')}</span>
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">{t('memory.openclaw.desc')}</p>
          </div>
        </div>
      )}
    </div>
  );
}

const KnowledgeGraph = lazy(() => import('../components/memory/KnowledgeGraph'));

export default function Memory() {
  const { t } = useI18n();
  const { openExternal, isOpening } = useExternalNavigator();
  const {
    config, cloudMode, showCloudAuth, cloudAuthStep, cloudUserCode, cloudVerifyUrl,
    cloudMemories, setCloudAuthStep, openCloudAuth, closeCloudAuth, startCloudAuth,
    selectCloudMemory, disconnectCloud, selectMemoryMode, toggleMemoryOption,
    setRecallLimit, setBlockedSourceAllowed, clearAllMemories,
  } = useMemorySettings();

  const [activeTab, setActiveTab] = useState<TabView>('overview');
  const [selectedEventType, setSelectedEventType] = useState<string>('all');
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);
  const [sourceView, setSourceView] = useState<'chat' | 'dev' | 'all'>('chat');
  const [graphSize, setGraphSize] = useState({ width: 600, height: 400 });
  const [wikiSelectedItem, setWikiSelectedItem] = useState<WikiSelectedItem>({ type: 'overview' });
  const [activeWorkspace, setActiveWorkspace] = useState<{ path: string | null; daemonProjectDir: string | null }>({ path: null, daemonProjectDir: null });
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const autoStartAttemptedRef = useRef(false);

  const api = window.electronAPI as any;

  // Stable no-op callbacks (Self-Improvement removed)
  const noop = useRef(async () => {}).current;

  // Data loading
  const memoryData = useMemoryData(api, t, sourceView, noop, noop);
  const {
    cards, events, fullEvents, eventsTotal, eventsOffset, tasks, loading,
    error, setEvents, setLoading, setError, setEventsOffset,
    loadCards, loadEvents, loadContext, loadPerception, loadDailySummary, loadTasks,
    reloadMemoryData,
  } = memoryData;

  // Wiki data (topics, skills, timeline days from daemon REST API)
  const wikiData = useWikiData();
  const { topics, skills, timelineDays, loadAllWikiData } = wikiData;

  // Daemon connection
  const daemon = useDaemonConnection(api, t, reloadMemoryData);
  const { daemonHealth, daemonStarting, daemonConnected, checkHealth, startDaemonAndReload, handleStartDaemon } = daemon;

  // Search
  const search = useMemorySearch(api, activeTab === 'overview' ? 'timeline' : activeTab, setEvents, memoryData.setEventsTotal);
  const { searchQuery, searchResults, searching, setSearchQuery, setSearchResults, handleSearch } = search;

  // Graph container measurement
  useEffect(() => {
    if (activeTab !== 'graph') return;
    let frameId: number | null = null;
    const measure = () => {
      const el = graphContainerRef.current;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      const nextWidth = Math.floor(width);
      const nextHeight = Math.floor(height);
      if (nextWidth > 0 && nextHeight > 0) {
        setGraphSize((prev) => (
          prev.width === nextWidth && prev.height === nextHeight ? prev : { width: nextWidth, height: nextHeight }
        ));
      } else {
        frameId = requestAnimationFrame(measure);
      }
    };
    frameId = requestAnimationFrame(measure);
    const el = graphContainerRef.current;
    if (!el) return () => { if (frameId !== null) cancelAnimationFrame(frameId); };
    const ro = new ResizeObserver(() => { measure(); });
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [activeTab]);

  // Initial load
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      try {
        const connected = await checkHealth();
        if (connected) {
          await Promise.all([reloadMemoryData(), loadAllWikiData()]);
        } else {
          let autoStarted = false;
          if (!autoStartAttemptedRef.current) {
            autoStartAttemptedRef.current = true;
            autoStarted = await startDaemonAndReload(true);
            if (autoStarted) {
              await loadAllWikiData();
            }
          }
          if (!autoStarted) {
            await loadTasks();
          }
        }
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [checkHealth, reloadMemoryData, loadAllWikiData, startDaemonAndReload, loadTasks, setLoading]);

  // Read initial active workspace on mount (shared with chat header via ~/.awarenessclaw/active-workspace.json)
  useEffect(() => {
    const readInitial = async () => {
      if (!api?.workspaceGetActive) return;
      try {
        const result = await api.workspaceGetActive();
        if (result?.success) {
          setActiveWorkspace({ path: result.path || null, daemonProjectDir: null });
        }
      } catch { /* preload API may not exist in older builds */ }
    };
    readInitial();
  }, [api]);

  // Subscribe to workspace changes (triggered by chat header picking a new directory)
  // so Memory UI reloads cards/topics/skills/timeline for the new project.
  useEffect(() => {
    if (!api?.onWorkspaceChanged) return undefined;
    const unsubscribe = api.onWorkspaceChanged(async (payload: {
      path: string | null;
      daemonProjectDir: string;
      daemonSwitched: boolean;
      daemonError: string | null;
    }) => {
      setActiveWorkspace({ path: payload.path, daemonProjectDir: payload.daemonProjectDir });
      if (!payload.daemonSwitched) {
        setError(t('memory.workspaceSwitchFailed', 'Failed to switch workspace: {error}').replace('{error}', payload.daemonError || 'unknown error'));
        return;
      }
      // Reload all memory + wiki data for the new workspace
      setLoading(true);
      setError(null);
      try {
        const connected = await checkHealth();
        if (connected) {
          await Promise.all([reloadMemoryData(), loadAllWikiData()]);
        }
      } finally {
        setLoading(false);
      }
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [api, checkHealth, reloadMemoryData, loadAllWikiData, setLoading, setError, t]);

  // Reload events when source view changes
  useEffect(() => {
    if (daemonConnected) {
      setEventsOffset(0);
      loadEvents(0, false, sourceView);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceView, daemonConnected]);

  // Auto-refresh on focus
  useEffect(() => {
    const onFocus = () => {
      if (daemonConnected) {
        checkHealth();
        loadEvents(0, false, sourceView);
        loadCards();
        loadPerception();
        loadAllWikiData();
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemonConnected, sourceView]);

  const handleRefresh = async () => {
    setLoading(true);
    setError(null);
    const connected = await checkHealth();
    if (connected) {
      const contextLoaded = await loadContext();
      await Promise.all([
        contextLoaded ? Promise.resolve() : loadCards(),
        loadEvents(0),
        loadPerception(),
        contextLoaded ? Promise.resolve() : loadDailySummary(),
        loadAllWikiData(),
      ]);
    }
    setLoading(false);
  };

  // Derived state
  const displayedEvents = events.filter((event) => selectedEventType === 'all' || event.type === selectedEventType);

  const filteredEventCount = events.filter(e => {
    if (sourceView === 'chat') return e.source !== 'mcp';
    if (sourceView === 'dev') return e.source === 'mcp';
    return true;
  }).length;

  const memoryTabItems: Array<{ id: TabView; label: string; hint: string; icon: typeof Clock; count?: number }> = [
    { id: 'overview', label: t('memory.overview', 'Overview'), hint: t('memory.overviewHint', 'Timeline and recent activity'), icon: Clock, count: daemonHealth?.stats?.totalMemories },
    { id: 'wiki', label: t('memory.wiki', 'Wiki'), hint: t('memory.wikiHint', 'Knowledge base and skills'), icon: BookOpen, count: daemonHealth?.stats?.totalKnowledge ?? cards.length },
    { id: 'graph', label: t('memory.graph', 'Graph'), hint: t('memory.graphHint', 'Relationships across memories'), icon: Share2 },
    { id: 'sync', label: t('memory.sync', 'Sync'), hint: t('memory.syncHint', 'Cloud sync and conflicts'), icon: ArrowDownUp },
    { id: 'settings', label: t('memory.settingsTab', 'Settings'), hint: t('memory.settingsTabHint', 'Capture, sync, privacy'), icon: SlidersHorizontal },
  ];

  const switchTab = (tab: TabView) => {
    setActiveTab(tab);
    setSearchQuery('');
    setSearchResults(null);
    if (tab !== 'overview') { setEvents(fullEvents); setSelectedEventType('all'); }
  };

  const activeModeText = config.memoryMode === 'cloud' ? t('settings.memory.cloud', 'Cloud') : t('settings.memory.local', 'Local');
  const cloudStateText = cloudMode === 'hybrid' || cloudMode === 'cloud'
    ? t('memory.settings.cloudConnected', 'Connected')
    : t('memory.settings.cloudDisconnected', 'Local only');
  const statsText = daemonHealth?.stats
    ? t('memory.stats', '{memories} memories, {knowledge} cards, {sessions} sessions')
        .replace('{memories}', String(sourceView === 'all' ? daemonHealth.stats.totalMemories : filteredEventCount))
        .replace('{knowledge}', String(daemonHealth.stats.totalKnowledge))
        .replace('{sessions}', String(daemonHealth.stats.totalSessions))
    : null;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-800">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold">
              <Brain size={18} className="text-brand-300" />
              {t('memory.title')}
            </h1>
            <p className="text-xs text-slate-500">
              {error ? <span className="text-amber-500">{error}</span>
                : statsText ? <span className="text-slate-400">{statsText}</span>
                : t('memory.subtitle')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <WorkspaceIndicator
              activePath={activeWorkspace.path}
              daemonProjectDir={activeWorkspace.daemonProjectDir}
              t={t}
            />
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 bg-slate-800 rounded-lg transition-colors"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {t('common.refresh')}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {memoryTabItems.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => switchTab(tab.id)}
                className={`group inline-flex min-w-[140px] items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left transition-all ${
                  active
                    ? 'border-brand-500/60 bg-brand-600/12 shadow-[0_0_0_1px_rgba(59,130,246,0.12)]'
                    : 'border-slate-700/60 bg-slate-900/30 hover:border-slate-600/80 hover:bg-slate-800/45'
                }`}
              >
                <div className={`flex h-9 w-9 flex-none items-center justify-center rounded-xl ${active ? 'bg-brand-600 text-white' : 'bg-slate-800 text-slate-300 group-hover:bg-slate-700'}`}>
                    <Icon size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="truncate text-sm font-medium text-slate-100">{tab.label}</div>
                    {typeof tab.count === 'number' && (
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${active ? 'bg-brand-500/20 text-brand-200' : 'bg-slate-800 text-slate-400'}`}>
                        {tab.count}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-slate-500">{tab.hint}</div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Search bar for Overview tab */}
        {activeTab === 'overview' && (
          <div className="relative mt-4">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); if (!e.target.value) setSearchResults(null); }}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder={t('memory.searchHint')}
              className="w-full rounded-2xl border border-slate-700/60 bg-slate-900/50 py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/50"
            />
            {searching && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-brand-400" />}
          </div>
        )}
      </div>

      {/* Content */}
      <div className={`flex-1 overflow-hidden ${activeTab === 'wiki' ? 'flex' : 'overflow-y-auto'}`}>
        {/* Daemon offline state */}
        {!loading && !daemonConnected && (
          <div className="flex flex-col items-center justify-center py-16 space-y-4 w-full">
            <div className="w-16 h-16 rounded-2xl bg-slate-800 flex items-center justify-center">
              <HardDrive size={28} className="text-slate-500" />
            </div>
            <div className="text-center space-y-1">
              <p className="text-sm font-medium text-slate-300">{t('memory.daemonOffline')}</p>
              <p className="text-xs text-slate-500 max-w-xs">{t('memory.daemonOffline.hint')}</p>
            </div>
            <button
              onClick={handleStartDaemon}
              disabled={daemonStarting}
              className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-colors"
            >
              {daemonStarting ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
              {daemonStarting ? t('memory.startingDaemon') : t('memory.startDaemon')}
            </button>
            <p className="text-[11px] text-slate-600 font-mono select-all">
              npx @awareness-sdk/local start
            </p>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-12 w-full">
            <Loader2 size={24} className="animate-spin text-brand-500" />
          </div>
        )}

        {!loading && daemonConnected && (
          <>
            {/* Degraded search warning */}
            {daemonHealth?.search_mode && daemonHealth.search_mode !== 'hybrid' && activeTab !== 'wiki' && (
              <div className="flex items-start gap-2.5 p-3 rounded-xl border border-amber-500/30 bg-amber-500/5 mx-6 mt-3">
                <AlertCircle size={14} className="text-amber-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-xs font-medium text-amber-400">{t('memory.searchDegraded', 'Semantic search unavailable')}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {t('memory.searchDegraded.hint', 'Text search is active, but vector similarity is disabled.')}
                  </p>
                </div>
              </div>
            )}

            {/* ── Overview Tab ─────────────────────────────────── */}
            {activeTab === 'overview' && (
              <div className="p-6 space-y-3">
                <TimelineTab
                  events={events}
                  displayedEvents={displayedEvents}
                  eventsTotal={eventsTotal}
                  eventsOffset={eventsOffset}
                  sourceView={sourceView}
                  selectedEventType={selectedEventType}
                  expandedEvent={expandedEvent}
                  searchQuery={searchQuery}
                  searchResults={searchResults}
                  setSourceView={setSourceView}
                  setSelectedEventType={setSelectedEventType}
                  setExpandedEvent={setExpandedEvent}
                  loadEvents={loadEvents}
                />
              </div>
            )}

            {/* ── Wiki Tab ────────────────────────────────────── */}
            {activeTab === 'wiki' && (
              <>
                <WikiSidebar
                  cards={cards}
                  topics={topics}
                  skills={skills}
                  timelineDays={timelineDays}
                  tasks={tasks}
                  selectedItem={wikiSelectedItem}
                  onSelect={setWikiSelectedItem}
                />
                <main className="flex-1 overflow-y-auto">
                  <WikiContentArea
                    selectedItem={wikiSelectedItem}
                    onSelect={setWikiSelectedItem}
                    cards={cards}
                    topics={topics}
                    skills={skills}
                    timelineDays={timelineDays}
                    tasks={tasks}
                  />
                </main>
              </>
            )}

            {/* ── Graph Tab ───────────────────────────────────── */}
            {activeTab === 'graph' && (
              <div ref={graphContainerRef} className="flex-1 memory-graph-container h-full">
                <Suspense fallback={
                  <div className="flex items-center justify-center h-full">
                    <Loader2 size={24} className="animate-spin text-brand-500" />
                  </div>
                }>
                  <KnowledgeGraph
                    cards={cards}
                    events={fullEvents}
                    width={graphSize.width}
                    height={graphSize.height}
                  />
                </Suspense>
              </div>
            )}

            {/* ── Sync Tab ────────────────────────────────────── */}
            {activeTab === 'sync' && (
              <div className="p-6 space-y-4">
                <SyncConflictPanel memoryId={(daemonHealth as { memory_id?: string } | null)?.memory_id || ''} />
              </div>
            )}

            {/* ── Settings Tab ────────────────────────────────── */}
            {activeTab === 'settings' && (
              <div className="p-6 space-y-4">
                <div className="rounded-[24px] border border-slate-700/60 bg-slate-900/55 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-500">{t('memory.settingsTab', 'Settings')}</div>
                      <h2 className="mt-2 text-lg font-semibold text-slate-100">{t('memory.settings.heroTitle', 'Tune how memory behaves')}</h2>
                      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
                        {t('memory.settings.heroDesc', 'Keep capture, sync, and privacy controls separate from the timeline so each memory pane stays focused.')}
                      </p>
                    </div>
                    <div className="grid min-w-[220px] gap-2 sm:grid-cols-3">
                      <div className="rounded-2xl border border-slate-700/70 bg-slate-950/70 px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{t('memory.settings.activeMode', 'Active mode')}</div>
                        <div className="mt-1 text-sm font-medium text-slate-100">{activeModeText}</div>
                      </div>
                      <div className="rounded-2xl border border-slate-700/70 bg-slate-950/70 px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{t('settings.memory.recallCount')}</div>
                        <div className="mt-1 text-sm font-medium text-slate-100">{config.recallLimit}</div>
                      </div>
                      <div className="rounded-2xl border border-slate-700/70 bg-slate-950/70 px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{t('memory.settings.cloudState', 'Cloud state')}</div>
                        <div className="mt-1 text-sm font-medium text-slate-100">{cloudStateText}</div>
                      </div>
                    </div>
                  </div>
                  <MemoryLayerInfo className="mt-4" />
                </div>

                <MemorySettingsPanel
                  t={t}
                  config={config}
                  cloudMode={cloudMode}
                  onToggle={toggleMemoryOption}
                  onRecallLimitChange={setRecallLimit}
                  onSelectMode={selectMemoryMode}
                  onCloudConnect={openCloudAuth}
                  onCloudDisconnect={disconnectCloud}
                  onToggleSource={setBlockedSourceAllowed}
                  onClearAll={() => {
                    void clearAllMemories(
                      t('settings.privacy.clearConfirm', 'Delete ALL local memories? This cannot be undone.'),
                      t('settings.privacy.cleared', 'All knowledge cards deleted.'),
                      t('settings.privacy.clearFailed', 'Failed to clear memories. Is the daemon running?'),
                    );
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>

      <SettingsCloudAuthModal
        t={t}
        open={showCloudAuth}
        step={cloudAuthStep}
        userCode={cloudUserCode}
        verifyUrl={cloudVerifyUrl}
        memories={cloudMemories}
        onClose={closeCloudAuth}
        onOpenBrowser={() => { void openExternal(cloudVerifyUrl, 'memory-cloud-auth'); }}
        browserOpening={isOpening('memory-cloud-auth')}
        onRefreshCode={() => {
          closeCloudAuth();
          openCloudAuth();
        }}
        onSelectMemory={selectCloudMemory}
        onRetry={() => {
          setCloudAuthStep('init');
          void startCloudAuth();
        }}
      />
    </div>
  );
}
