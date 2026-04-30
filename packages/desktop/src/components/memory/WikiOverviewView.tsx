import { useMemo, type ReactNode } from 'react';
import { BookMarked, Zap, FileText, Clock, CheckSquare } from 'lucide-react';
import { useI18n } from '../../lib/i18n';
import { getCategoryDisplay } from './memory-helpers';
import type { KnowledgeCard } from './memory-helpers';
import type { WikiSelectedItem, TopicItem, SkillItem, TimelineDayItem } from './wiki-types';

interface WikiOverviewViewProps {
  cards: KnowledgeCard[];
  topics: TopicItem[];
  skills: SkillItem[];
  timelineDays: TimelineDayItem[];
  tasks: Array<{ id: string; title: string; priority: string; status: string }>;
  onSelect: (item: WikiSelectedItem) => void;
}

export function WikiOverviewView({
  cards,
  topics,
  skills,
  timelineDays,
  tasks,
  onSelect,
}: WikiOverviewViewProps) {
  const { t } = useI18n();

  const recentCards = useMemo(
    () => [...cards]
      .sort((a, b) => {
        const da = a.created_at ? new Date(a.created_at).getTime() : 0;
        const db = b.created_at ? new Date(b.created_at).getTime() : 0;
        return db - da;
      })
      .slice(0, 8),
    [cards],
  );

  const evergreens = useMemo(
    () => cards.filter((c) => c.growth_stage === 'evergreen'),
    [cards],
  );

  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto">
      {/* Stats summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label={t('memory.wiki.totalCards', 'Cards')} value={cards.length} icon={<FileText size={16} />} />
        <StatCard label={t('memory.wiki.topics', 'Topics')} value={topics.length} icon={<BookMarked size={16} />} />
        <StatCard label={t('memory.wiki.skills', 'Skills')} value={skills.length} icon={<Zap size={16} />} />
        <StatCard label={t('memory.wiki.openTasks', 'Open Tasks')} value={tasks.filter((task) => task.status === 'open').length} icon={<CheckSquare size={16} />} />
      </div>

      {/* Topics grid */}
      {topics.length > 0 && (
        <section>
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
            <BookMarked size={14} />
            {t('memory.wiki.topics', 'Topics')}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {topics.slice(0, 8).map((topic) => (
              <button
                key={topic.id}
                type="button"
                onClick={() => onSelect({ type: 'topic', id: topic.id, title: topic.title ?? '' })}
                className="flex items-start gap-3 p-3 rounded-xl border border-slate-700/50 bg-slate-800/40 hover:border-slate-600 hover:bg-slate-800/70 transition-colors text-left"
              >
                <span className="text-lg shrink-0 mt-0.5">📚</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-200 truncate">{topic.title ?? 'Untitled'}</p>
                  {topic.summary && (
                    <p className="mt-0.5 text-xs text-slate-500 line-clamp-2">{topic.summary}</p>
                  )}
                  <span className="text-[10px] text-slate-600">{topic.card_count} cards</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Evergreens highlight */}
      {evergreens.length > 0 && (
        <section>
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
            🌳 {t('memory.wiki.evergreens', 'Evergreen Knowledge')}
          </h3>
          <div className="divide-y divide-slate-700/30 rounded-xl border border-slate-700/50">
            {evergreens.slice(0, 6).map((card) => (
              <CardRow key={card.id} card={card} onSelect={onSelect} />
            ))}
          </div>
        </section>
      )}

      {/* Recent cards */}
      {recentCards.length > 0 && (
        <section>
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
            <Clock size={14} />
            {t('memory.wiki.recentCards', 'Recently Added')}
          </h3>
          <div className="divide-y divide-slate-700/30 rounded-xl border border-slate-700/50">
            {recentCards.map((card) => (
              <CardRow key={card.id} card={card} onSelect={onSelect} />
            ))}
          </div>
        </section>
      )}

      {/* Skills quick list */}
      {skills.length > 0 && (
        <section>
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
            <Zap size={14} />
            {t('memory.wiki.skills', 'Skills')}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {skills.slice(0, 6).map((skill) => (
              <button
                key={skill.id}
                type="button"
                onClick={() => onSelect({ type: 'skills' })}
                className="flex items-center gap-3 p-3 rounded-xl border border-slate-700/50 bg-slate-800/40 hover:border-slate-600 transition-colors text-left"
              >
                <span className="text-lg shrink-0">⚡</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-200 truncate">{skill.name}</p>
                  {skill.description && (
                    <p className="mt-0.5 text-xs text-slate-500 line-clamp-1">{skill.description}</p>
                  )}
                </div>
                {skill.decay_score != null && (
                  <div className="shrink-0 w-12">
                    <div className="h-1.5 rounded-full bg-slate-700 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-brand-500"
                        style={{ width: `${Math.round((skill.decay_score ?? 1) * 100)}%` }}
                      />
                    </div>
                  </div>
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Empty state */}
      {cards.length === 0 && topics.length === 0 && (
        <div className="text-center py-16 text-slate-500 space-y-2">
          <p className="text-sm">{t('memory.noData', 'No memory data yet')}</p>
          <p className="text-xs">{t('memory.noData.hint', 'Start a conversation to begin building your knowledge base')}</p>
        </div>
      )}
    </div>
  );
}

/* ── Sub-components ──────────────────────────────────── */

function StatCard({ label, value, icon }: { label: string; value: number; icon: ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-700/40 bg-slate-800/30 backdrop-blur-sm p-4 shadow-sm">
      <div className="flex items-center gap-2 text-slate-500 mb-1.5">
        {icon}
        <span className="text-[11px] uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-xl font-semibold text-slate-100">{value}</p>
    </div>
  );
}

function CardRow({
  card,
  onSelect,
}: {
  card: KnowledgeCard;
  onSelect: (item: WikiSelectedItem) => void;
}) {
  const display = getCategoryDisplay(card.category);
  const CategoryIcon = display.icon;
  const growthIcon = card.growth_stage === 'evergreen' ? '🌳' : card.growth_stage === 'budding' ? '🌿' : '🌱';

  return (
    <button
      type="button"
      onClick={() => onSelect({ type: 'card', id: card.id })}
      className="flex w-full items-start gap-3 p-3 text-left hover:bg-slate-800/40 transition-all duration-150 rounded-xl"
    >
      <span className="text-sm shrink-0 mt-0.5">{growthIcon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <CategoryIcon size={12} className={display.color} />
          <p className="text-sm font-medium text-slate-200 leading-snug truncate">{card.title}</p>
        </div>
        {card.summary && (
          <p className="mt-0.5 text-xs text-slate-500 line-clamp-2">{card.summary}</p>
        )}
      </div>
      {card.created_at && (
        <span className="text-[10px] text-slate-600 shrink-0">
          {new Date(card.created_at).toLocaleDateString()}
        </span>
      )}
    </button>
  );
}
