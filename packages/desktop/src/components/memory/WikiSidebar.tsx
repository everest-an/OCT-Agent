import { useState, useMemo } from 'react';
import type { ReactNode } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Search,
  BookOpen,
  BookMarked,
  TreePine,
  Brain,
  CheckSquare,
  AlertTriangle,
  Clock,
  Zap,
} from 'lucide-react';
import { useI18n } from '../../lib/i18n';
import type { KnowledgeCard } from './memory-helpers';
import type { WikiSelectedItem, TopicItem, SkillItem, TimelineDayItem } from './wiki-types';

/* ── Category grouping ──────────────────────────────── */
const ENGINEERING_CATS = ['problem_solution', 'decision', 'workflow', 'key_point', 'pitfall', 'insight'];
const PERSONAL_CATS = ['personal_preference', 'important_detail', 'plan_intention', 'activity_preference', 'health_info', 'career_info', 'custom_misc'];

const PRIORITY_ICON: Record<string, string> = { high: '🔴', medium: '🟡', low: '🟢' };
const CAT_DOT: Record<string, string> = {
  decision: 'bg-amber-400',
  problem_solution: 'bg-emerald-400',
  workflow: 'bg-blue-400',
  key_point: 'bg-cyan-400',
  pitfall: 'bg-red-400',
  insight: 'bg-purple-400',
  personal_preference: 'bg-pink-400',
  important_detail: 'bg-orange-400',
};

const GROWTH_ICON: Record<string, string> = {
  evergreen: '🌳',
  budding: '🌿',
  seedling: '🌱',
};

const GROWTH_ORDER: Record<string, number> = { evergreen: 0, budding: 1, seedling: 2 };

interface WikiSidebarProps {
  cards: KnowledgeCard[];
  topics: TopicItem[];
  skills: SkillItem[];
  timelineDays: TimelineDayItem[];
  tasks: Array<{ id: string; title: string; priority: string; status: string }>;
  selectedItem: WikiSelectedItem;
  onSelect: (item: WikiSelectedItem) => void;
}

export function WikiSidebar({
  cards,
  topics,
  skills,
  timelineDays,
  tasks,
  selectedItem,
  onSelect,
}: WikiSidebarProps) {
  const { t } = useI18n();
  const [localFilter, setLocalFilter] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    topics: true,
    cards_engineering: false,
    cards_personal: false,
    tasks: true,
    risks: false,
    timeline: true,
  });

  const toggleGroup = (key: string) =>
    setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));

  /* ── Filtering ──────────────────────────────────────── */
  const q = localFilter.toLowerCase().trim();

  const filteredTopics = useMemo(
    () => topics.filter((tp) => !q || (tp.title ?? '').toLowerCase().includes(q)),
    [topics, q],
  );

  const engCards = useMemo(
    () => cards.filter((c) => ENGINEERING_CATS.includes(c.category) && (!q || c.title.toLowerCase().includes(q))),
    [cards, q],
  );

  const perCards = useMemo(
    () => cards.filter((c) => PERSONAL_CATS.includes(c.category) && (!q || c.title.toLowerCase().includes(q))),
    [cards, q],
  );

  const filteredTasks = useMemo(
    () => tasks.filter((a) => !q || a.title.toLowerCase().includes(q)),
    [tasks, q],
  );

  const filteredDays = useMemo(
    () => timelineDays.filter((d) => !q || d.date?.includes(q)),
    [timelineDays, q],
  );

  /* ── Selection helpers ──────────────────────────────── */
  const isSelected = (item: WikiSelectedItem): boolean => {
    if (item.type !== selectedItem.type) return false;
    if (item.type === 'topic' && selectedItem.type === 'topic') return item.id === selectedItem.id;
    if (item.type === 'card' && selectedItem.type === 'card') return item.id === selectedItem.id;
    if (item.type === 'task' && selectedItem.type === 'task') return item.id === selectedItem.id;
    if (item.type === 'risk' && selectedItem.type === 'risk') return item.id === selectedItem.id;
    if (item.type === 'timeline_day' && selectedItem.type === 'timeline_day') return item.date === selectedItem.date;
    return true;
  };

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-slate-700/60 bg-slate-900/80">
      {/* Search filter */}
      <div className="p-2 border-b border-slate-700/40">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={localFilter}
            onChange={(e) => setLocalFilter(e.target.value)}
            placeholder={t('memory.wiki.searchSidebar', 'Filter...')}
            className="w-full rounded-lg border border-slate-700/60 bg-slate-950/50 pl-8 pr-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500/50"
          />
        </div>
      </div>

      {/* Scrollable directory */}
      <nav className="flex-1 overflow-y-auto py-1 text-sm">
        {/* Overview link */}
        <SidebarItem
          label={t('memory.wiki.overview', 'Overview')}
          icon={<BookOpen size={14} />}
          selected={isSelected({ type: 'overview' })}
          onClick={() => onSelect({ type: 'overview' })}
        />

        {/* Topics */}
        <SidebarGroup
          label={t('memory.wiki.topics', 'Topics')}
          count={filteredTopics.length}
          icon={<BookMarked size={14} />}
          expanded={expandedGroups.topics}
          onToggle={() => toggleGroup('topics')}
        >
          {filteredTopics.length === 0 ? (
            <SidebarEmpty label={t('memory.wiki.noTopics', 'No topics yet')} />
          ) : (
            filteredTopics.map((topic) => (
              <SidebarItem
                key={topic.id}
                label={topic.title ?? 'Untitled'}
                badge={String(topic.card_count)}
                selected={isSelected({ type: 'topic', id: topic.id, title: topic.title ?? '' })}
                onClick={() => onSelect({ type: 'topic', id: topic.id, title: topic.title ?? '' })}
                indent
              />
            ))
          )}
        </SidebarGroup>

        {/* Engineering Cards */}
        {engCards.length > 0 && (
          <SidebarGroup
            label={t('memory.wiki.engineeringCards', 'Engineering')}
            count={engCards.length}
            icon={<TreePine size={14} />}
            expanded={expandedGroups.cards_engineering}
            onToggle={() => toggleGroup('cards_engineering')}
          >
            <CardCategoryList
              cards={engCards}
              selectedItem={selectedItem}
              onSelect={onSelect}
              isSelected={isSelected}
            />
          </SidebarGroup>
        )}

        {/* Personal Cards */}
        {perCards.length > 0 && (
          <SidebarGroup
            label={t('memory.wiki.personalCards', 'Personal')}
            count={perCards.length}
            icon={<Brain size={14} />}
            expanded={expandedGroups.cards_personal}
            onToggle={() => toggleGroup('cards_personal')}
          >
            <CardCategoryList
              cards={perCards}
              selectedItem={selectedItem}
              onSelect={onSelect}
              isSelected={isSelected}
            />
          </SidebarGroup>
        )}

        {/* Skills */}
        <SidebarItem
          label={t('memory.wiki.skills', 'Skills')}
          icon={<Zap size={14} />}
          badge={skills.length > 0 ? String(skills.length) : undefined}
          selected={isSelected({ type: 'skills' })}
          onClick={() => onSelect({ type: 'skills' })}
        />

        {/* Tasks */}
        <SidebarGroup
          label={t('memory.wiki.tasks', 'Tasks')}
          count={filteredTasks.length}
          icon={<CheckSquare size={14} />}
          expanded={expandedGroups.tasks}
          onToggle={() => toggleGroup('tasks')}
        >
          {filteredTasks.length === 0 ? (
            <SidebarEmpty label={t('memory.wiki.noTasks', 'No open tasks')} />
          ) : (
            filteredTasks.slice(0, 12).map((task) => (
              <SidebarItem
                key={task.id}
                label={task.title}
                icon={PRIORITY_ICON[task.priority] ?? '⬜'}
                selected={isSelected({ type: 'task', id: task.id })}
                onClick={() => onSelect({ type: 'task', id: task.id })}
                indent
              />
            ))
          )}
        </SidebarGroup>

        {/* Timeline */}
        <SidebarGroup
          label={t('memory.wiki.timeline', 'Timeline')}
          count={filteredDays.length}
          icon={<Clock size={14} />}
          expanded={expandedGroups.timeline}
          onToggle={() => toggleGroup('timeline')}
        >
          {filteredDays.length === 0 ? (
            <SidebarEmpty label={t('memory.wiki.noTimeline', 'No timeline data')} />
          ) : (
            filteredDays.slice(0, 14).map((day) => (
              <SidebarItem
                key={day.date}
                label={formatDate(day.date)}
                badge={String(day.count)}
                selected={isSelected({ type: 'timeline_day', date: day.date })}
                onClick={() => onSelect({ type: 'timeline_day', date: day.date })}
                indent
              />
            ))
          )}
        </SidebarGroup>
      </nav>

      {/* Stats footer */}
      <div className="border-t border-slate-700/40 px-3 py-2 text-[10px] text-slate-500">
        {cards.length} cards · {topics.length} topics · {skills.length} skills
      </div>
    </aside>
  );
}

/* ── Sub-components ──────────────────────────────────── */

function SidebarGroup({
  label,
  count,
  icon,
  expanded,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  icon: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-slate-800/60 transition-colors"
      >
        <span className="shrink-0 text-slate-500">{icon}</span>
        <span className="flex-1 text-sm text-slate-400 truncate">{label}</span>
        {count > 0 && (
          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500">
            {count}
          </span>
        )}
        {expanded ? (
          <ChevronDown size={12} className="text-slate-600 shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-slate-600 shrink-0" />
        )}
      </button>
      {expanded && <div className="pb-1">{children}</div>}
    </div>
  );
}

function SidebarItem({
  label,
  icon,
  badge,
  selected,
  onClick,
  indent = false,
}: {
  label: string;
  icon?: string | ReactNode;
  badge?: string;
  selected: boolean;
  onClick: () => void;
  indent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-1.5 py-1.5 text-left transition-colors ${
        indent ? 'pl-7 pr-2.5' : 'px-2.5'
      } ${
        selected
          ? 'border-l-2 border-brand-500 bg-brand-500/10 font-medium text-brand-300'
          : 'border-l-2 border-transparent text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
      }`}
    >
      {icon && (
        typeof icon === 'string'
          ? <span className="text-sm leading-none shrink-0">{icon}</span>
          : <span className="shrink-0 text-slate-500">{icon}</span>
      )}
      <span className={`flex-1 truncate text-sm ${!indent ? 'font-medium' : ''}`}>{label}</span>
      {badge && (
        <span className="rounded bg-slate-800 px-1 py-0.5 text-[10px] text-slate-500 shrink-0">
          {badge}
        </span>
      )}
    </button>
  );
}

function SidebarEmpty({ label }: { label: string }) {
  return (
    <p className="pl-7 pr-2.5 py-1.5 text-slate-600 italic text-xs">{label}</p>
  );
}

/* ── CardCategoryList — cards grouped by category ────── */
function CardCategoryList({
  cards,
  selectedItem,
  onSelect,
  isSelected,
}: {
  cards: KnowledgeCard[];
  selectedItem: WikiSelectedItem;
  onSelect: (item: WikiSelectedItem) => void;
  isSelected: (item: WikiSelectedItem) => boolean;
}) {
  const [expandedCats, setExpandedCats] = useState<Record<string, boolean>>({});
  const toggleCat = (cat: string) =>
    setExpandedCats((prev) => ({ ...prev, [cat]: !prev[cat] }));

  const grouped = useMemo(() => {
    const map = new Map<string, KnowledgeCard[]>();
    for (const c of cards) {
      const arr = map.get(c.category) ?? [];
      arr.push(c);
      map.set(c.category, arr);
    }
    return map;
  }, [cards]);

  return (
    <>
      {[...grouped.entries()].map(([cat, catCards]) => {
        const sortedCards = [...catCards].sort(
          (a, b) => (GROWTH_ORDER[a.growth_stage ?? 'seedling'] ?? 2) - (GROWTH_ORDER[b.growth_stage ?? 'seedling'] ?? 2),
        );
        const catExpanded = expandedCats[cat] ?? false;
        const catLabel = cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        const dotColor = CAT_DOT[cat] ?? 'bg-slate-400';

        return (
          <div key={cat}>
            <button
              type="button"
              onClick={() => toggleCat(cat)}
              className="flex w-full items-center gap-1.5 pl-5 pr-2.5 py-1 text-left hover:bg-slate-800/50 transition-colors"
            >
              <span className={`h-2 w-2 rounded-full shrink-0 ${dotColor}`} />
              <span className="flex-1 truncate text-slate-400 text-xs">{catLabel}</span>
              <span className="rounded bg-slate-800 px-1 py-0.5 text-[10px] text-slate-500">
                {catCards.length}
              </span>
              {catExpanded ? (
                <ChevronDown size={11} className="text-slate-600 shrink-0" />
              ) : (
                <ChevronRight size={11} className="text-slate-600 shrink-0" />
              )}
            </button>
            {catExpanded &&
              sortedCards.slice(0, 20).map((card) => (
                <button
                  key={card.id}
                  type="button"
                  onClick={() => onSelect({ type: 'card', id: card.id })}
                  className={`flex w-full items-center gap-1 pl-9 pr-2.5 py-1 text-left transition-colors text-xs ${
                    isSelected({ type: 'card', id: card.id })
                      ? 'border-l-2 border-brand-500 bg-brand-500/10 font-medium text-brand-300'
                      : 'border-l-2 border-transparent text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                  }`}
                >
                  <span className="text-xs leading-none shrink-0">
                    {GROWTH_ICON[card.growth_stage ?? 'seedling'] ?? '🌱'}
                  </span>
                  <span className="flex-1 truncate">{card.title}</span>
                </button>
              ))}
          </div>
        );
      })}
    </>
  );
}

/* ── Utilities ────────────────────────────────────────── */
function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}
