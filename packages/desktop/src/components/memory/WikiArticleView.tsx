import { useState, useEffect } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../../lib/i18n';
import { getCategoryDisplay, memoryMarkdownComponents } from './memory-helpers';
import type { KnowledgeCard } from './memory-helpers';
import { DAEMON_API_BASE } from './wiki-types';

const GROWTH: Record<string, { icon: string; label: string; color: string }> = {
  seedling: { icon: '🌱', label: 'Seedling', color: 'text-emerald-400' },
  budding: { icon: '🌿', label: 'Budding', color: 'text-emerald-500' },
  evergreen: { icon: '🌳', label: 'Evergreen', color: 'text-emerald-600' },
};

interface WikiArticleViewProps {
  cardId: string;
  /** Pre-loaded cards for fast lookup; fallback to API fetch */
  preloadedCards: KnowledgeCard[];
  onBack: () => void;
  onNavigateToCard: (cardId: string) => void;
}

export function WikiArticleView({
  cardId,
  preloadedCards,
  onBack,
  onNavigateToCard,
}: WikiArticleViewProps) {
  const { t } = useI18n();
  const preloaded = preloadedCards.find((c) => c.id === cardId) ?? null;
  const [fetchedCard, setFetchedCard] = useState<KnowledgeCard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (preloaded) {
      setFetchedCard(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${DAEMON_API_BASE}/knowledge/${encodeURIComponent(cardId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setFetchedCard(data as KnowledgeCard);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [cardId, preloaded]);

  const card = preloaded ?? fetchedCard;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-brand-500" />
      </div>
    );
  }

  if (error || !card) {
    return (
      <div className="flex-1 flex items-center justify-center py-20">
        <p className="text-sm text-red-400">{error ?? t('memory.wiki.cardNotFound', 'Card not found')}</p>
      </div>
    );
  }

  const catDisplay = getCategoryDisplay(card.category);
  const CategoryIcon = catDisplay.icon;
  const stageKey = (card.growth_stage ?? 'seedling') as keyof typeof GROWTH;
  const stage = GROWTH[stageKey] ?? GROWTH.seedling;
  const body = card.body ?? card.summary ?? '';
  const tags = parseTags(card.tags);

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      {/* Back button */}
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-200 transition-colors"
      >
        <ArrowLeft size={16} />
        {t('memory.wiki.back', 'Back')}
      </button>

      {/* Header */}
      <header className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-2xl font-bold text-slate-100 leading-tight">
            {card.title || 'Untitled'}
          </h2>
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium ${stage.color}`}
          >
            <span aria-hidden>{stage.icon}</span>
            <span>{stage.label}</span>
          </span>
        </div>

        {/* Metadata row */}
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className={`inline-flex items-center gap-1 ${catDisplay.color}`}>
            <CategoryIcon size={12} />
            {card.category.replace(/_/g, ' ')}
          </span>
          {card.confidence != null && card.confidence > 0 && (
            <span className="text-sky-400/70">{Math.round(card.confidence * 100)}%</span>
          )}
          {card.created_at && (
            <span>{new Date(card.created_at).toLocaleDateString()}</span>
          )}
          {card.language && (
            <span className="rounded bg-slate-800 px-1.5 py-0.5">{card.language}</span>
          )}
          {card.link_count_outgoing != null && card.link_count_outgoing > 0 && (
            <span>{card.link_count_outgoing} outbound</span>
          )}
          {card.link_count_incoming != null && card.link_count_incoming > 0 && (
            <span>{card.link_count_incoming} inbound</span>
          )}
        </div>

        {card.question_this_answers && (
          <p className="text-sm italic text-slate-400 border-l-2 border-brand-500/40 pl-3">
            {card.question_this_answers}
          </p>
        )}
      </header>

      {/* Body */}
      <article className="text-sm text-slate-300 leading-relaxed">
        {card.body_format === 'markdown' || body.includes('**') || body.includes('- ') || body.includes('```') ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={memoryMarkdownComponents}>
            {body}
          </ReactMarkdown>
        ) : (
          <div className="whitespace-pre-wrap">{body || <span className="text-slate-600">No body yet.</span>}</div>
        )}
      </article>

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-2 border-t border-slate-700/40">
          {tags.map((tag, i) => (
            <span key={i} className="text-xs px-2 py-0.5 bg-slate-800/60 rounded-lg text-slate-400">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Footer metadata */}
      {card.last_touched_at && (
        <div className="text-[11px] text-slate-600 pt-1">
          Last touched: {new Date(card.last_touched_at).toLocaleString()}
        </div>
      )}
    </div>
  );
}

function parseTags(tags: string | undefined): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return tags.split(',').map((t) => t.trim()).filter(Boolean);
  }
}
