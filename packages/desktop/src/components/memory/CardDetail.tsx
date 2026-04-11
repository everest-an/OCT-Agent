/**
 * F-031 Phase 3+4 — Desktop CardDetail first-cut.
 *
 * Minimal card detail view for the AwarenessClaw desktop app. Mirrors the
 * cloud CardDetailSheet contract but fetches nothing for now — real related /
 * backlinks lookups will be wired through the daemon REST proxy once that
 * surface is defined.
 */

import type { KnowledgeCard } from './memory-helpers';

const GROWTH: Record<string, { icon: string; label: string; className: string }> = {
  seedling: { icon: '🌱', label: 'Seedling', className: 'text-emerald-400' },
  budding: { icon: '🌿', label: 'Budding', className: 'text-emerald-500' },
  evergreen: { icon: '🌳', label: 'Evergreen', className: 'text-emerald-700' },
};

interface CardDetailProps {
  card: KnowledgeCard | null;
  onClose?: () => void;
  backlinksCount?: number;
}

export function CardDetail({ card, onClose, backlinksCount = 0 }: CardDetailProps) {
  if (!card) {
    return null;
  }

  const stageKey = (card.growth_stage ?? 'seedling') as keyof typeof GROWTH;
  const stage = GROWTH[stageKey] ?? GROWTH.seedling;
  const body = card.body ?? card.summary ?? '';
  const outbound = card.link_count_outgoing ?? 0;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-6">
      <div className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="absolute right-3 top-3 rounded px-2 py-0.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Close"
          >
            ✕
          </button>
        )}

        <header className="mb-4 space-y-2 pr-8">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-2xl font-bold leading-tight text-zinc-100">
              {card.title || 'Untitled Card'}
            </h2>
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium ${stage.className}`}
              title={stage.label}
            >
              <span aria-hidden>{stage.icon}</span>
              <span>{stage.label}</span>
            </span>
          </div>
          {card.question_this_answers && (
            <p className="text-sm italic text-zinc-400">{card.question_this_answers}</p>
          )}
        </header>

        <article className="mb-4 min-w-0 whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">
          {body || <span className="text-zinc-500">No body yet.</span>}
        </article>

        <footer className="flex flex-wrap items-center gap-3 border-t border-zinc-700/60 pt-3 text-xs text-zinc-500">
          <span>Outbound links: {outbound}</span>
          <span>Backlinks: {backlinksCount}</span>
          {card.language && (
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">
              {card.language}
            </span>
          )}
          {card.last_touched_at && (
            <span>Last touched: {new Date(card.last_touched_at).toLocaleString()}</span>
          )}
        </footer>
      </div>
    </div>
  );
}
