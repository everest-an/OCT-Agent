import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ArrowLeft, Loader2, Sparkles, Check, AlertCircle, Star, X } from 'lucide-react';

type Tier = 'consumer' | 'prosumer' | 'engineering';

interface MarketAgent {
  slug: string;
  name: string;
  name_zh?: string | null;
  description: string;
  description_zh?: string | null;
  category: string;
  tier: Tier;
  emoji: string;
  color: string;
  tags: string[];
  tools: string[];
  featured: boolean;
  install_count: number;
}

interface MarketAgentDetail extends MarketAgent {
  markdown: string;
}

type TabKey = 'featured' | 'consumer' | 'prosumer' | 'engineering' | 'all';
type InstallStage = 'converting' | 'writing-workspace' | 'registering' | 'applying-identity' | 'done';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'featured', label: '⭐ 推荐' },
  { key: 'consumer', label: '📚 日常工作' },
  { key: 'prosumer', label: '💼 专业场景' },
  { key: 'engineering', label: '🔧 工程开发' },
  { key: 'all', label: '全部' },
];

const STAGE_LABELS: Record<InstallStage, string> = {
  converting: '转换内容...',
  'writing-workspace': '写入工作区...',
  registering: '注册到 OpenClaw (~15-30 秒,首次加载插件较慢)...',
  'applying-identity': '应用身份...',
  done: '完成',
};

interface Props {
  onClose: () => void;
  onInstalled: () => void;
}

export default function AgentMarketplace({ onClose, onInstalled }: Props) {
  const [tab, setTab] = useState<TabKey>('featured');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<MarketAgent[]>([]);
  const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(new Set());
  const [installing, setInstalling] = useState<Map<string, InstallStage>>(new Map());
  const [detail, setDetail] = useState<MarketAgentDetail | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    setError(null);
    const api = (window as any).electronAPI;
    if (!api?.marketplaceList) {
      setError('桌面应用未加载 marketplace IPC,请重启 OCT');
      setLoading(false);
      return;
    }
    try {
      const params: { tier?: string; featured?: boolean } = {};
      if (tab === 'featured') params.featured = true;
      else if (tab !== 'all') params.tier = tab;

      const [listResp, slugResp, statusResp] = await Promise.all([
        api.marketplaceList(params),
        api.marketplaceInstalledSlugs?.() ?? Promise.resolve({ success: true, slugs: [] }),
        api.marketplaceInstallStatus?.() ?? Promise.resolve({ success: true, inFlight: [] }),
      ]);
      if (!listResp?.success) {
        setError(listResp?.error || '无法连接到 agent 集市');
      } else {
        setAgents(listResp.data?.agents ?? []);
      }
      if (slugResp?.success) {
        setInstalledSlugs(new Set(slugResp.slugs || []));
      }
      if (statusResp?.success && Array.isArray(statusResp.inFlight)) {
        const map = new Map<string, InstallStage>();
        for (const { slug, stage } of statusResp.inFlight) {
          map.set(slug, (stage || 'converting') as InstallStage);
        }
        if (map.size > 0) setInstalling(map);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  // Subscribe to main-process install progress events. Survives remount.
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.onMarketplaceInstallProgress) return;
    const unsub = api.onMarketplaceInstallProgress(
      (payload: { slug: string; stage: InstallStage }) => {
        setInstalling((prev) => {
          const next = new Map(prev);
          if (payload.stage === 'done') {
            next.delete(payload.slug);
          } else {
            next.set(payload.slug, payload.stage);
          }
          return next;
        });
        if (payload.stage === 'done') {
          // Refresh installed slugs + trigger Agents page reload.
          api.marketplaceInstalledSlugs?.().then((r: any) => {
            if (r?.success) setInstalledSlugs(new Set(r.slugs || []));
          });
          onInstalled();
        }
      }
    );
    unsubRef.current = unsub;
    return () => {
      if (unsubRef.current) unsubRef.current();
    };
  }, [onInstalled]);

  const handleInstall = async (slug: string) => {
    const api = (window as any).electronAPI;
    if (installing.has(slug) || installedSlugs.has(slug)) return;

    // Optimistically mark installing — progress events will overwrite stage.
    setInstalling((s) => {
      const next = new Map(s);
      next.set(slug, 'converting');
      return next;
    });

    try {
      const res = await api.marketplaceInstall(slug);
      if (res?.success) {
        setInstalledSlugs((s) => new Set(s).add(slug));
        onInstalled();
      } else if (res?.error === 'install-in-progress') {
        // Silent — another window/tab is already installing; progress events will update.
      } else {
        setError(res?.error || '安装失败');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInstalling((s) => {
        const next = new Map(s);
        next.delete(slug);
        return next;
      });
    }
  };

  const handleOpenDetail = async (slug: string) => {
    const api = (window as any).electronAPI;
    try {
      const res = await api.marketplaceDetail(slug);
      if (res?.success) setDetail(res.data);
    } catch {
      /* ignore */
    }
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return agents;
    const q = search.toLowerCase();
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.name_zh || '').toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        (a.description_zh || '').toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [agents, search]);

  return (
    <div className="h-full flex flex-col bg-gradient-to-br from-slate-50 to-blue-50/30 dark:from-slate-900 dark:to-slate-950">
      <header className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/70 backdrop-blur">
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title="返回 Agent 列表"
          >
            <ArrowLeft className="h-4 w-4" />
            返回
          </button>
          <div className="h-6 border-r border-slate-300 dark:border-slate-700" />
          <Sparkles className="h-5 w-5 text-violet-500" />
          <div>
            <h1 className="text-base font-semibold">Agent 集市</h1>
            <p className="text-xs text-slate-500">浏览精选 agent,一键安装到你的 OCT</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-400">
            想分享你创建的 agent?到"多 Agent"页面,点 agent 卡片上的"分享"按钮。
          </span>
        </div>
      </header>

      <div className="px-6 py-3 flex items-center gap-4 flex-wrap border-b border-slate-200 dark:border-slate-800 bg-white/40 dark:bg-slate-900/40">
        <div className="flex gap-1.5 flex-wrap">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
                tab === t.key
                  ? 'bg-violet-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="搜索 agent 名称 / 标签..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[200px] max-w-md text-sm px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-400"
        />
      </div>

      <main className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 p-3 rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div className="flex-1">{error}</div>
            <button onClick={fetchAgents} className="text-xs underline">
              重试
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16 text-slate-500 text-sm">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            加载中...
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-sm text-slate-500">
            {search ? `没找到 "${search}" 相关的 agent` : '这个分类下暂无 agent'}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filtered.map((agent) => {
              const installed = installedSlugs.has(agent.slug);
              const stage = installing.get(agent.slug);
              const isInstalling = !!stage;
              return (
                <div
                  key={agent.slug}
                  className="group rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 hover:shadow-md hover:border-violet-300 dark:hover:border-violet-700 transition-all cursor-pointer flex flex-col"
                  onClick={() => handleOpenDetail(agent.slug)}
                >
                  <div className="flex items-start gap-3 mb-3">
                    <span className="text-3xl">{agent.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <h3 className="font-semibold text-sm truncate">
                          {agent.name_zh || agent.name}
                        </h3>
                        {agent.featured && (
                          <Star className="h-3.5 w-3.5 text-amber-500 flex-shrink-0 fill-current" />
                        )}
                      </div>
                      <p className="text-xs text-slate-500 truncate">
                        {agent.category}
                      </p>
                    </div>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400 line-clamp-3 mb-3 flex-1">
                    {agent.description_zh || agent.description}
                  </p>

                  {isInstalling && (
                    <div className="mb-2 px-2 py-1.5 rounded bg-violet-50 dark:bg-violet-950/40 text-[11px] text-violet-700 dark:text-violet-300 flex items-center gap-1.5">
                      <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />
                      <span className="truncate">{STAGE_LABELS[stage]}</span>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-slate-400">
                      📥 {agent.install_count}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!installed && !isInstalling) handleInstall(agent.slug);
                      }}
                      disabled={installed || isInstalling}
                      className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                        installed
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 cursor-default'
                          : isInstalling
                          ? 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 cursor-wait'
                          : 'bg-violet-600 hover:bg-violet-700 text-white'
                      }`}
                    >
                      {installed ? (
                        <span className="flex items-center gap-1">
                          <Check className="h-3 w-3" /> 已安装
                        </span>
                      ) : isInstalling ? (
                        <span className="flex items-center gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" /> 安装中
                        </span>
                      ) : (
                        '+ 安装'
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {detail && (
        <DetailDrawer
          detail={detail}
          installed={installedSlugs.has(detail.slug)}
          installingStage={installing.get(detail.slug)}
          onClose={() => setDetail(null)}
          onInstall={() => handleInstall(detail.slug)}
        />
      )}

    </div>
  );
}

// ------------------------------------------------------------------
// Sub-components
// ------------------------------------------------------------------

function DetailDrawer({
  detail,
  installed,
  installingStage,
  onClose,
  onInstall,
}: {
  detail: MarketAgentDetail;
  installed: boolean;
  installingStage: InstallStage | undefined;
  onClose: () => void;
  onInstall: () => void;
}) {
  const installing = !!installingStage;
  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-stretch justify-end"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-white dark:bg-slate-900 shadow-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 p-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl">{detail.emoji}</span>
            <div>
              <h2 className="font-semibold">{detail.name_zh || detail.name}</h2>
              <p className="text-xs text-slate-500">{detail.category}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-sm text-slate-700 dark:text-slate-300">
            {detail.description_zh || detail.description}
          </p>

          {detail.tools.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">可用工具</h3>
              <div className="flex flex-wrap gap-1.5">
                {detail.tools.map((t) => (
                  <span
                    key={t}
                    className="text-xs px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {detail.tags.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">标签</h3>
              <div className="flex flex-wrap gap-1.5">
                {detail.tags.map((t) => (
                  <span
                    key={t}
                    className="text-xs px-2 py-0.5 rounded bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300"
                  >
                    #{t}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="text-xs text-slate-500">
            📥 {detail.install_count} 人已安装
          </div>

          <details className="border-t pt-3" open>
            <summary className="text-xs font-semibold text-slate-500 cursor-pointer">
              查看完整 system prompt
            </summary>
            <pre className="mt-2 text-[10px] leading-relaxed whitespace-pre-wrap bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded p-3 font-mono overflow-x-auto max-h-96 overflow-y-auto">
              {detail.markdown}
            </pre>
          </details>

          {installing && installingStage && (
            <div className="px-3 py-2 rounded bg-violet-50 dark:bg-violet-950/40 text-xs text-violet-700 dark:text-violet-300 flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{STAGE_LABELS[installingStage]}</span>
            </div>
          )}

          <button
            onClick={onInstall}
            disabled={installed || installing}
            className={`w-full py-2.5 rounded-md font-medium text-sm transition-colors ${
              installed
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                : installing
                ? 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
                : 'bg-violet-600 hover:bg-violet-700 text-white'
            }`}
          >
            {installed ? (
              <span className="flex items-center justify-center gap-1.5">
                <Check className="h-4 w-4" /> 已安装到 OCT
              </span>
            ) : installing ? (
              <span className="flex items-center justify-center gap-1.5">
                <Loader2 className="h-4 w-4 animate-spin" /> 安装中...
              </span>
            ) : (
              '+ 安装到 OCT'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// Share flow lives in <ShareAgentForm> and is triggered from the Agents page
// per-card. The marketplace page no longer hosts a share button.

