import { useState, useEffect, useCallback, useMemo } from 'react';
import { X, Loader2, Sparkles, Check, AlertCircle, Send, Star } from 'lucide-react';

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

const TABS: { key: TabKey; label: string }[] = [
  { key: 'featured', label: '⭐ 推荐' },
  { key: 'consumer', label: '📚 日常工作' },
  { key: 'prosumer', label: '💼 专业场景' },
  { key: 'engineering', label: '🔧 工程开发' },
  { key: 'all', label: '全部' },
];

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
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<MarketAgentDetail | null>(null);
  const [showShareForm, setShowShareForm] = useState(false);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    setError(null);
    const api = (window as any).electronAPI;
    if (!api?.marketplaceList) {
      setError('桌面应用未加载 marketplace IPC,请重启 AwarenessClaw');
      setLoading(false);
      return;
    }
    try {
      const params: { tier?: string; featured?: boolean } = {};
      if (tab === 'featured') params.featured = true;
      else if (tab !== 'all') params.tier = tab;

      const [listResp, slugResp] = await Promise.all([
        api.marketplaceList(params),
        api.marketplaceInstalledSlugs?.() ?? Promise.resolve({ success: true, slugs: [] }),
      ]);
      if (!listResp?.success) {
        setError(listResp?.error || '无法连接到 agent 集市');
      } else {
        setAgents(listResp.data?.agents ?? []);
      }
      if (slugResp?.success) {
        setInstalledSlugs(new Set(slugResp.slugs || []));
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

  const handleInstall = async (slug: string) => {
    const api = (window as any).electronAPI;
    setInstalling((s) => new Set(s).add(slug));
    try {
      const res = await api.marketplaceInstall(slug);
      if (res?.success) {
        setInstalledSlugs((s) => new Set(s).add(slug));
        onInstalled();
      } else {
        setError(res?.error || '安装失败');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInstalling((s) => {
        const next = new Set(s);
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
          <Sparkles className="h-6 w-6 text-violet-500" />
          <div>
            <h1 className="text-lg font-semibold">Agent 集市</h1>
            <p className="text-xs text-slate-500">浏览精选 agent,一键安装到你的 AwarenessClaw</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowShareForm(true)}
            className="text-xs px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1"
            title="分享你创建的 agent"
          >
            <Send className="h-3.5 w-3.5" />
            分享我的 Agent
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
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
              const isInstalling = installing.has(agent.slug);
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
          installing={installing.has(detail.slug)}
          onClose={() => setDetail(null)}
          onInstall={() => handleInstall(detail.slug)}
        />
      )}

      {showShareForm && (
        <ShareForm
          onClose={() => setShowShareForm(false)}
          onSubmitted={() => {
            setShowShareForm(false);
          }}
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
  installing,
  onClose,
  onInstall,
}: {
  detail: MarketAgentDetail;
  installed: boolean;
  installing: boolean;
  onClose: () => void;
  onInstall: () => void;
}) {
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

          <details className="border-t pt-3">
            <summary className="text-xs font-semibold text-slate-500 cursor-pointer">
              查看完整 system prompt
            </summary>
            <pre className="mt-2 text-[10px] leading-relaxed whitespace-pre-wrap bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded p-3 font-mono overflow-x-auto max-h-96 overflow-y-auto">
              {detail.markdown}
            </pre>
          </details>

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
                <Check className="h-4 w-4" /> 已安装到 AwarenessClaw
              </span>
            ) : installing ? (
              <span className="flex items-center justify-center gap-1.5">
                <Loader2 className="h-4 w-4 animate-spin" /> 安装中...
              </span>
            ) : (
              '+ 安装到 AwarenessClaw'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function ShareForm({ onClose, onSubmitted }: { onClose: () => void; onSubmitted: () => void }) {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('lifestyle');
  const [tier, setTier] = useState<Tier>('consumer');
  const [emoji, setEmoji] = useState('🤖');
  const [markdown, setMarkdown] = useState(`---
name: My Agent
description: Describe what this agent does.
color: slate
emoji: 🤖
---

# My Agent

## Identity & Memory
...

## Core Mission
...

## Rules You Must Follow
- ...

## Communication Style
...
`);
  const [contact, setContact] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    setMessage(null);
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(slug)) {
      setError('slug 必须是 3-64 位小写字母/数字/连字符,且以字母开头');
      return;
    }
    setSubmitting(true);
    try {
      const api = (window as any).electronAPI;
      const res = await api.marketplaceSubmit({
        slug,
        name,
        description,
        category,
        tier,
        emoji,
        markdown,
        author_contact: contact || undefined,
      });
      if (res?.success) {
        setMessage('已提交!我们审核后会加入集市 🎉');
        setTimeout(() => {
          onSubmitted();
        }, 1500);
      } else {
        setError(res?.error || '提交失败');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h2 className="font-semibold">分享我的 Agent</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-xs text-slate-500">
            提交你创建的 agent 供其他用户安装。请不要包含隐私信息——所有投稿都会经过我们人工审核。
          </p>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="block">
              <span className="text-xs text-slate-500">Slug (URL 标识)</span>
              <input
                className="mt-1 w-full px-2 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="my-agent"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Emoji</span>
              <input
                className="mt-1 w-full px-2 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                maxLength={4}
              />
            </label>
            <label className="col-span-2 block">
              <span className="text-xs text-slate-500">名称</span>
              <input
                className="mt-1 w-full px-2 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="col-span-2 block">
              <span className="text-xs text-slate-500">简短描述</span>
              <textarea
                className="mt-1 w-full px-2 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">分类</span>
              <input
                className="mt-1 w-full px-2 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Tier</span>
              <select
                className="mt-1 w-full px-2 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                value={tier}
                onChange={(e) => setTier(e.target.value as Tier)}
              >
                <option value="consumer">consumer (日常)</option>
                <option value="prosumer">prosumer (专业)</option>
                <option value="engineering">engineering (工程)</option>
              </select>
            </label>
            <label className="col-span-2 block">
              <span className="text-xs text-slate-500">联系方式 (可选,我们审核通过后会告知)</span>
              <input
                className="mt-1 w-full px-2 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="邮箱 / X / GitHub 用户名"
              />
            </label>
            <label className="col-span-2 block">
              <span className="text-xs text-slate-500">Markdown 内容 (frontmatter + body)</span>
              <textarea
                className="mt-1 w-full px-2 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 font-mono text-[11px]"
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                rows={14}
              />
            </label>
          </div>

          {error && <div className="text-xs text-red-600">{error}</div>}
          {message && <div className="text-xs text-emerald-600">{message}</div>}

          <div className="flex gap-2 justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm rounded border border-slate-300 dark:border-slate-700"
            >
              取消
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="px-4 py-2 text-sm rounded bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-60"
            >
              {submitting ? '提交中...' : '提交审核'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
