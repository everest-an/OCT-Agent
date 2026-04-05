import { ChevronDown, ChevronRight, Loader2, AlarmClock, TriangleAlert, Bell } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../../lib/i18n';
import {
  type KnowledgeCard,
  type PerceptionSignal,
  getCategoryDisplay,
  memoryMarkdownComponents,
} from './memory-helpers.js';

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query.trim() || !text) return <>{text}</>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
          ? <mark key={i} className="bg-amber-500/30 text-amber-200 rounded-sm px-0.5">{part}</mark>
          : part
      )}
    </>
  );
}

export interface KnowledgeCardsTabProps {
  displayCards: KnowledgeCard[];
  loading: boolean;
  searchQuery: string;
  searchResults: unknown[] | null;
  selectedCategory: string;
  setSelectedCategory: (v: string) => void;
  expandedCard: string | null;
  toggleCardExpand: (cardId: string) => void;
  cardEvolution: Array<{ id: string; title: string; created_at?: string; status?: string; evolution_type?: string }> | null;
  evolutionLoading: boolean;
  signals: PerceptionSignal[];
  tasks: Array<{ id: string; title: string; description?: string; priority: string; status: string; created_at?: string }>;
}

export function KnowledgeCardsTab({
  displayCards,
  loading,
  searchQuery,
  searchResults,
  selectedCategory,
  setSelectedCategory,
  expandedCard,
  toggleCardExpand,
  cardEvolution,
  evolutionLoading,
  signals,
  tasks,
}: KnowledgeCardsTabProps) {
  const { t } = useI18n();

  // When "tasks" filter is active, show tasks instead of knowledge cards
  if (selectedCategory === '_tasks') {
    return (
      <>
        {tasks.length === 0 ? (
          <div className="text-center py-12 text-slate-500 space-y-2">
            <p className="text-sm">{t('memory.noTasks', 'No open tasks')}</p>
          </div>
        ) : (
          tasks.map((task) => (
            <div key={task.id} className="p-4 rounded-xl border bg-slate-800/50 border-slate-700/50 hover:border-slate-600 transition-colors">
              <div className="flex items-center gap-2 mb-2">
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                  task.priority === 'high' ? 'bg-red-500/20 text-red-300 border border-red-500/30'
                  : task.priority === 'medium' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'bg-slate-700 text-slate-400'
                }`}>
                  {task.priority}
                </span>
                <span className={`text-xs px-1.5 py-0.5 rounded ${
                  task.status === 'open' ? 'bg-blue-500/20 text-blue-300' : 'bg-emerald-500/20 text-emerald-300'
                }`}>
                  {task.status}
                </span>
                {task.created_at && (
                  <span className="ml-auto text-[11px] text-slate-500">
                    {new Date(task.created_at).toLocaleDateString()}
                  </span>
                )}
              </div>
              <h4 className="font-medium text-sm text-slate-200">{task.title}</h4>
              {task.description && (
                <p className="mt-1 text-sm text-slate-400">{task.description}</p>
              )}
            </div>
          ))
        )}
      </>
    );
  }

  return (
    <>
      {displayCards.length === 0 && !loading && (
        <div className="text-center py-12 text-slate-500 space-y-2">
          {searchQuery && searchResults !== null ? (
            <>
              <p className="text-sm">{t('memory.noResults', 'No results for "{query}"').replace('{query}', searchQuery)}</p>
              <p className="text-xs text-slate-600">{t('memory.noData.hint')}</p>
            </>
          ) : selectedCategory !== 'all' ? (
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
            <>
              <p>{t('memory.noData')}</p>
              <p className="text-xs mt-1">{t('memory.noData.hint')}</p>
            </>
          )}
        </div>
      )}

      {displayCards.map((card: any, i: number) => {
        const catDisplay = getCategoryDisplay(card.category);
        const CategoryIcon = catDisplay.icon;
        const isExpanded = expandedCard === card.id;
        const relatedSignal = signals.find(s => s.card_id === card.id || (s.card_title && s.card_title === card.title));
        const RelatedSignalIcon = relatedSignal?.type === 'staleness'
          ? AlarmClock
          : relatedSignal?.type === 'contradiction'
            ? TriangleAlert
            : Bell;
        return (
          <div
            key={card.id || i}
            onClick={() => card.id && toggleCardExpand(card.id)}
            className={`p-4 rounded-xl border transition-colors cursor-pointer ${
              card.status === 'superseded'
                ? 'bg-slate-800/30 border-slate-700/30 opacity-60'
                : isExpanded
                  ? 'bg-slate-800/70 border-brand-500/50 ring-1 ring-brand-500/20'
                  : 'bg-slate-800/50 border-slate-700/50 hover:border-slate-600'
            }`}
          >
            <div className="flex items-center gap-2 mb-2">
              <CategoryIcon size={14} className={catDisplay.color} />
              <span className={`text-xs font-medium ${catDisplay.color}`}>{t(catDisplay.label, catDisplay.label)}</span>
              {card.created_at && (
                <>
                  <span className="text-xs text-slate-600">&middot;</span>
                  <span className="text-xs text-slate-500">{new Date(card.created_at).toLocaleDateString()}</span>
                </>
              )}
              {card.confidence != null && card.confidence > 0 && (
                <span className="text-xs text-sky-400/70 font-medium">{Math.round(card.confidence * 100)}%</span>
              )}
              {card.days_ago != null && (
                <span className="text-xs text-slate-500">
                  {card.days_ago === 0 ? t('memory.today', 'today') : `${card.days_ago}d ago`}
                </span>
              )}
              {card.tokens_est != null && card.tokens_est > 0 && (
                <span className="text-[10px] text-slate-600">~{card.tokens_est}tok</span>
              )}
              {card.status === 'superseded' && (
                <span className="text-xs px-1.5 py-0.5 bg-amber-600/20 rounded text-amber-500 border border-amber-600/30">
                  {t('memory.superseded', 'Superseded')}
                </span>
              )}
              {relatedSignal && (
                <span className="text-xs px-1.5 py-0.5 bg-purple-600/20 rounded text-purple-400 border border-purple-600/30">
                  <RelatedSignalIcon size={11} className="inline mr-1" />{relatedSignal.type}
                </span>
              )}
              <span className="ml-auto text-xs text-slate-600">
                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </span>
            </div>
            <h4 className={`font-medium text-sm mb-1 ${card.status === 'superseded' ? 'line-through text-slate-500' : ''}`}>
              <HighlightText text={card.title} query={searchQuery} />
            </h4>
            <div className="text-sm text-slate-400 leading-relaxed">
              {searchQuery ? (
                <p><HighlightText text={card.summary} query={searchQuery} /></p>
              ) : (
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={memoryMarkdownComponents}>
                  {card.summary}
                </ReactMarkdown>
              )}
            </div>

            {/* Expanded detail: tags + evolution chain */}
            {isExpanded && (
              <div className="mt-3 pt-3 border-t border-slate-700/50 space-y-2" onClick={(e) => e.stopPropagation()}>
                {/* Tags */}
                {card.tags && (() => {
                  const tags = typeof card.tags === 'string' ? (() => { try { return JSON.parse(card.tags); } catch { return []; } })() : card.tags;
                  return Array.isArray(tags) && tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {tags.map((tag: string, j: number) => (
                        <span key={j} className="text-xs px-1.5 py-0.5 bg-slate-700/60 rounded text-slate-400">{tag}</span>
                      ))}
                    </div>
                  ) : null;
                })()}

                {/* Evolution chain */}
                {evolutionLoading ? (
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Loader2 size={12} className="animate-spin" />
                    {t('memory.loadingEvolution', 'Loading history...')}
                  </div>
                ) : cardEvolution && cardEvolution.length > 0 ? (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-slate-400">{t('memory.evolutionChain', 'Version History')}</p>
                    {cardEvolution.map((ver, j: number) => (
                      <div key={j} className={`text-xs p-2 rounded ${ver.id === card.id ? 'bg-brand-500/10 border border-brand-500/20' : 'bg-slate-800/50'}`}>
                        <span className="text-slate-500">{ver.created_at ? new Date(ver.created_at).toLocaleDateString() : ''}</span>
                        {' '}
                        <span className={ver.status === 'superseded' ? 'line-through text-slate-600' : 'text-slate-300'}>{ver.title || '(no title)'}</span>
                        {ver.evolution_type && ver.evolution_type !== 'initial' && (
                          <span className="ml-1 text-amber-400">({ver.evolution_type})</span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : cardEvolution !== null ? (
                  <p className="text-xs text-slate-600">{t('memory.noEvolution', 'No version history')}</p>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
