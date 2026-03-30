import { useState, useEffect } from 'react';
import { Search, RefreshCw, Loader2, AlertCircle, Zap, HardDrive, Cloud, ChevronDown, ChevronRight, Calendar } from 'lucide-react';
import { useI18n } from '../lib/i18n';

interface PerceptionSignal {
  type: string;
  message: string;
}

interface KnowledgeCard {
  id: string;
  category: string;
  title: string;
  summary: string;
  created_at?: string;
  status?: string;
}

// Known categories with curated icons/colors. Unknown categories get a generic fallback.
const CATEGORY_CONFIG: Record<string, { emoji: string; labelKey: string; color: string }> = {
  decision: { emoji: '💡', labelKey: 'memory.category.decision', color: 'text-amber-400' },
  problem_solution: { emoji: '🔧', labelKey: 'memory.category.problem_solution', color: 'text-emerald-400' },
  workflow: { emoji: '📋', labelKey: 'memory.category.workflow', color: 'text-blue-400' },
  pitfall: { emoji: '⚠️', labelKey: 'memory.category.pitfall', color: 'text-red-400' },
  insight: { emoji: '✨', labelKey: 'memory.category.insight', color: 'text-purple-400' },
  key_point: { emoji: '📌', labelKey: 'memory.category.key_point', color: 'text-cyan-400' },
  personal_preference: { emoji: '👤', labelKey: 'memory.category.personal_preference', color: 'text-pink-400' },
  important_detail: { emoji: '📎', labelKey: 'memory.category.important_detail', color: 'text-orange-400' },
  skill: { emoji: '🛠️', labelKey: 'memory.category.skill', color: 'text-indigo-400' },
};

/** Fallback for unknown/custom categories — renders with a generic icon and auto-generates label */
function getCategoryDisplay(category: string): { emoji: string; label: string; color: string } {
  const known = CATEGORY_CONFIG[category];
  if (known) return { emoji: known.emoji, label: known.labelKey, color: known.color };
  // Unknown category: use generic icon, humanize the snake_case name as label
  const humanized = category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return { emoji: '🏷️', label: humanized, color: 'text-slate-400' };
}

/** Parse MCP JSON-RPC response into knowledge cards. Returns i18n error keys. */
function parseMcpResponse(result: any): { cards: KnowledgeCard[]; errorKey?: string } {
  if (result?.error) return { cards: [], errorKey: 'memory.serviceDisconnected' };

  const text = result?.result?.content?.[0]?.text;
  if (!text) return { cards: [], errorKey: 'memory.emptyResponse' };

  try {
    const parsed = JSON.parse(text);
    if (parsed.error) return { cards: [], errorKey: 'memory.serviceDisconnected' };

    // awareness_lookup returns { knowledge_cards: [...], total, mode }
    const items = parsed.knowledge_cards || parsed.items || parsed.cards || [];
    if (Array.isArray(items)) return { cards: items };

    return { cards: [] };
  } catch {
    return { cards: [], errorKey: 'memory.parseFailed' };
  }
}

function MemoryLayerInfo() {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{t('memory.architecture')}</span>
      </button>
      {expanded && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="p-3 rounded-xl border border-blue-500/20 bg-blue-500/5">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Cloud size={12} className="text-blue-400" />
              <span className="text-xs font-medium text-blue-400">{t('memory.awareness.title')}</span>
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              {t('memory.awareness.desc')}
            </p>
          </div>
          <div className="p-3 rounded-xl border border-slate-500/20 bg-slate-500/5">
            <div className="flex items-center gap-1.5 mb-1.5">
              <HardDrive size={12} className="text-slate-400" />
              <span className="text-xs font-medium text-slate-400">{t('memory.openclaw.title')}</span>
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              {t('memory.openclaw.desc')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Memory() {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMockData, setIsMockData] = useState(false);
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [signals, setSignals] = useState<PerceptionSignal[]>([]);
  const [searching, setSearching] = useState(false);
  const [dailySummary, setDailySummary] = useState<{ recentCards: KnowledgeCard[]; openTasks: number } | null>(null);

  // Load cards on mount
  useEffect(() => {
    loadCards();
    loadPerception();
    loadDailySummary();
  }, []);

  const loadCards = async () => {
    setLoading(true);
    setError(null);

    if (!window.electronAPI) {
      // Dev mode: use mock data
      setCards(MOCK_CARDS);
      setIsMockData(true);
      setLoading(false);
      return;
    }

    try {
      const result = await (window.electronAPI as any).memoryGetCards();
      const parsed = parseMcpResponse(result);
      if (parsed.errorKey) {
        setError(t(parsed.errorKey));
        setCards(MOCK_CARDS);
        setIsMockData(true);
      } else if (parsed.cards.length > 0) {
        setCards(parsed.cards);
        setIsMockData(false);
      } else {
        setCards(MOCK_CARDS);
        setIsMockData(true);
        setError(t('memory.noMemoryData'));
      }
    } catch {
      setError(t('memory.cannotConnect'));
      setCards(MOCK_CARDS);
      setIsMockData(true);
    }

    setLoading(false);
  };

  const loadPerception = async () => {
    if (!window.electronAPI) return;
    try {
      const result = await (window.electronAPI as any).memoryGetPerception();
      const text = result?.result?.content?.[0]?.text;
      if (text) {
        const parsed = JSON.parse(text);
        setSignals(parsed.signals || []);
      }
    } catch { /* no perception data */ }
  };

  const loadDailySummary = async () => {
    if (!window.electronAPI) return;
    try {
      const result = await (window.electronAPI as any).memoryGetDailySummary();
      const cardsText = result?.cards?.result?.content?.[0]?.text;
      const tasksText = result?.tasks?.result?.content?.[0]?.text;
      let recentCards: KnowledgeCard[] = [];
      let openTasks = 0;
      if (cardsText) {
        try {
          const parsed = JSON.parse(cardsText);
          recentCards = (parsed.knowledge_cards || []).slice(0, 5);
        } catch { /* ignore */ }
      }
      if (tasksText) {
        try {
          const parsed = JSON.parse(tasksText);
          openTasks = (parsed.action_items || parsed.items || []).length;
        } catch { /* ignore */ }
      }
      if (recentCards.length > 0 || openTasks > 0) {
        setDailySummary({ recentCards, openTasks });
      }
    } catch { /* daemon not running */ }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }

    setSearching(true);
    if (window.electronAPI) {
      try {
        const result = await (window.electronAPI as any).memorySearch(searchQuery);
        // Recall returns plain text, not JSON knowledge cards
        const text = result?.result?.content?.[0]?.text || '';
        if (text) {
          // Parse recall text into pseudo-cards for display
          const lines = text.split('\n').filter((l: string) => l.trim());
          const searchCards = lines
            .filter((l: string) => l.match(/^\d+\.\s/))
            .map((l: string, i: number) => {
              const match = l.match(/^\d+\.\s\[(\w+)\]\s(.+)/);
              return {
                id: `search-${i}`,
                category: match?.[1] || 'key_point',
                title: match?.[2]?.split('\n')[0] || l.replace(/^\d+\.\s/, ''),
                summary: l,
              };
            });
          setSearchResults(searchCards.length > 0 ? searchCards : []);
        } else {
          setSearchResults([]);
        }
      } catch {
        setSearchResults([]);
      }
    }
    setSearching(false);
  };

  const filteredCards = cards.filter((card) => {
    if (selectedCategory !== 'all' && card.category !== selectedCategory) return false;
    if (searchQuery && !searchResults && !card.title?.includes(searchQuery) && !card.summary?.includes(searchQuery)) return false;
    return true;
  });

  const displayCards = searchResults || filteredCards;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-800">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-lg font-semibold">🧠 {t('memory.title')}</h1>
            <p className="text-xs text-slate-500">
              {error ? <span className="text-amber-500">{error}</span> : t('memory.subtitle')}
            </p>
          </div>
          <button
            onClick={loadCards}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 bg-slate-800 rounded-lg transition-colors"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {t('common.refresh')}
          </button>
        </div>

        {/* Search */}
        <div className="relative mb-3">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); if (!e.target.value) setSearchResults(null); }}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder={t('memory.searchHint')}
            className="w-full pl-10 pr-4 py-2.5 bg-slate-800 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/50"
          />
          {searching && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-brand-400" />}
        </div>

        {/* Category filter */}
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => { setSelectedCategory('all'); setSearchResults(null); }}
            className={`px-3 py-1 text-xs rounded-lg transition-colors ${
              selectedCategory === 'all' ? 'bg-brand-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            {t('memory.all')} ({cards.length})
          </button>
          {/* Dynamic category tabs — derived from actual card data, not hardcoded */}
          {[...new Set(cards.map(c => c.category).filter(Boolean))].map((cat) => {
            const count = cards.filter(c => c.category === cat).length;
            const display = getCategoryDisplay(cat);
            return (
              <button
                key={cat}
                onClick={() => { setSelectedCategory(cat); setSearchResults(null); }}
                className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                  selectedCategory === cat ? 'bg-brand-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                }`}
              >
                {display.emoji} {t(display.label, display.label)} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-3">
        {/* Mock data indicator */}
        {isMockData && !loading && (
          <div className="p-3 bg-amber-600/10 border border-amber-600/20 rounded-xl text-xs text-amber-400 space-y-1.5">
            <div className="flex items-center gap-2">
              <AlertCircle size={14} />
              <span>{t('memory.mockHint')}</span>
            </div>
            <div className="pl-5 text-amber-400/70 font-mono bg-black/20 rounded px-2 py-1 select-all">
              {t('memory.mockGuide', 'npx @awareness-sdk/local start')}
            </div>
          </div>
        )}

        {/* Daily Summary */}
        {dailySummary && !loading && !isMockData && (
          <div className="p-4 bg-brand-500/5 border border-brand-500/20 rounded-xl">
            <div className="flex items-center gap-2 mb-2">
              <Calendar size={14} className="text-brand-400" />
              <span className="text-xs font-medium text-brand-400">{t('memory.dailySummary') || 'Daily Summary'}</span>
              {dailySummary.openTasks > 0 && (
                <span className="ml-auto text-[10px] text-amber-400">{dailySummary.openTasks} {t('memory.openTasks') || 'open tasks'}</span>
              )}
            </div>
            <div className="space-y-1">
              {dailySummary.recentCards.map((card, i) => {
                const cfg = getCategoryDisplay(card.category);
                return (
                  <div key={i} className="flex items-start gap-2 text-[11px]">
                    <span>{cfg.emoji}</span>
                    <span className="text-slate-300 line-clamp-1">{card.title || card.summary}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-brand-500" />
          </div>
        )}

        {/* Memory Architecture Info */}
        <MemoryLayerInfo />

        {/* Perception Signals */}
        {signals.length > 0 && (
          <div className="space-y-2 mb-4">
            <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wider flex items-center gap-1">
              <Zap size={12} /> {t('memory.perception')}
            </h3>
            {signals.map((signal, i) => {
              const config: Record<string, { emoji: string; color: string }> = {
                contradiction: { emoji: '⚡', color: 'border-red-500/30 bg-red-500/5' },
                pattern: { emoji: '🔄', color: 'border-amber-500/30 bg-amber-500/5' },
                resonance: { emoji: '💫', color: 'border-purple-500/30 bg-purple-500/5' },
                staleness: { emoji: '⏰', color: 'border-slate-500/30 bg-slate-500/5' },
              };
              const c = config[signal.type] || { emoji: '💡', color: 'border-brand-500/30 bg-brand-500/5' };
              return (
                <div key={i} className={`p-3 rounded-xl border ${c.color} flex items-start gap-2.5`}>
                  <span className="text-base">{c.emoji}</span>
                  <p className="text-sm text-slate-200">{signal.message}</p>
                </div>
              );
            })}
          </div>
        )}

        {!loading && displayCards.length === 0 && (
          <div className="text-center py-12 text-slate-500 space-y-2">
            {searchQuery && searchResults !== null ? (
              // Active search with no matches
              <>
                <p className="text-sm">{t('memory.noResults', 'No results for "{query}"').replace('{query}', searchQuery)}</p>
                <p className="text-xs text-slate-600">{t('memory.noData.hint')}</p>
              </>
            ) : selectedCategory !== 'all' ? (
              // Category filter with no matching cards
              <>
                <p className="text-sm">{t('memory.noCategoryCards', 'No cards in this category')}</p>
                <button
                  onClick={() => setSelectedCategory('all')}
                  className="text-xs text-brand-400 hover:text-brand-300 underline underline-offset-2"
                >
                  {t('memory.clearFilter', 'Clear filter')}
                </button>
              </>
            ) : (
              // No memories at all
              <>
                <p>{t('memory.noData')}</p>
                <p className="text-xs mt-1">{t('memory.noData.hint')}</p>
              </>
            )}
          </div>
        )}

        {!loading && displayCards.map((card: any, i: number) => {
          const catDisplay = getCategoryDisplay(card.category);
          return (
            <div
              key={card.id || i}
              className="p-4 bg-slate-800/50 rounded-xl border border-slate-700/50 hover:border-slate-600 transition-colors"
            >
              <div className="flex items-center gap-2 mb-2">
                <span>{catDisplay.emoji}</span>
                <span className={`text-xs font-medium ${catDisplay.color}`}>{t(catDisplay.label, catDisplay.label)}</span>
                {card.created_at && (
                  <>
                    <span className="text-xs text-slate-600">•</span>
                    <span className="text-xs text-slate-500">{new Date(card.created_at).toLocaleDateString()}</span>
                  </>
                )}
                {card.status === 'superseded' && (
                  <span className="text-xs px-1.5 py-0.5 bg-slate-700 rounded text-slate-500">{t('memory.superseded')}</span>
                )}
              </div>
              <h4 className="font-medium text-sm mb-1">{card.title}</h4>
              <p className="text-sm text-slate-400 leading-relaxed">{card.summary}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Fallback mock data when daemon is not connected
const MOCK_CARDS: KnowledgeCard[] = [
  { id: '1', category: 'decision', title: '使用 PostgreSQL 作为主数据库', summary: '评估了 MongoDB 和 PostgreSQL，选择 PostgreSQL 因为需要 pgvector 支持。', created_at: '2026-03-29' },
  { id: '2', category: 'pitfall', title: 'Docker build 必须用 nohup', summary: 'SSH 前台执行 docker build 会超时断开，导致部署中断。', created_at: '2026-03-29' },
  { id: '3', category: 'personal_preference', title: '中文交流，代码用英文', summary: '用户偏好推理和回复用中文，代码用英文。', created_at: '2026-03-28' },
];
