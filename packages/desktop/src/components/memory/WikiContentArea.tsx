import { useState, useCallback, useEffect, useMemo } from 'react';
import { ArrowLeft, Loader2, FileText } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../../lib/i18n';
import { getCategoryDisplay, memoryMarkdownComponents, getSourceDisplay } from './memory-helpers';
import type { KnowledgeCard } from './memory-helpers';
import type { WikiSelectedItem, TopicItem, SkillItem, TimelineDayItem, TimelineEventItem, ScanStatus, WorkspaceStats, WorkspaceFileItem, WikiPageItem } from './wiki-types';
import { DAEMON_API_BASE } from './wiki-types';
import { WikiOverviewView } from './WikiOverviewView';
import { WikiArticleView } from './WikiArticleView';
import { WorkspaceOverviewView, WorkspaceFileView, WorkspaceDocView, WikiPageView, WorkspaceListView } from './WorkspaceViews';

const PRIORITY_ICON: Record<string, string> = { high: '🔴', medium: '🟡', low: '🟢' };

interface WikiContentAreaProps {
  selectedItem: WikiSelectedItem;
  onSelect: (item: WikiSelectedItem) => void;
  cards: KnowledgeCard[];
  topics: TopicItem[];
  skills: SkillItem[];
  timelineDays: TimelineDayItem[];
  tasks: Array<{ id: string; title: string; description?: string; priority: string; status: string; created_at?: string }>;
  // Workspace scanner data
  scanStatus?: ScanStatus | null;
  workspaceStats?: WorkspaceStats | null;
  onTriggerScan?: (mode?: 'full' | 'incremental') => Promise<void>;
  workspaceFiles?: WorkspaceFileItem[];
  workspaceDocs?: WorkspaceFileItem[];
  wikiPages?: WikiPageItem[];
}

export function WikiContentArea({
  selectedItem,
  onSelect,
  cards,
  topics,
  skills,
  timelineDays,
  tasks,
  scanStatus,
  workspaceStats,
  onTriggerScan,
  workspaceFiles = [],
  workspaceDocs = [],
  wikiPages = [],
}: WikiContentAreaProps) {
  const { t } = useI18n();

  /* ── Card navigation stack ──────────────────────────── */
  const [cardStack, setCardStack] = useState<string[]>([]);

  useEffect(() => {
    if (selectedItem.type === 'card') {
      setCardStack([selectedItem.id]);
    } else {
      setCardStack([]);
    }
  }, [selectedItem]);

  const handleNavigateToCard = useCallback((cardId: string) => {
    setCardStack((prev) => [...prev, cardId]);
    onSelect({ type: 'card', id: cardId });
  }, [onSelect]);

  const handleBack = useCallback(() => {
    // Compute next state synchronously, then apply state + side effect separately
    const current = cardStack;
    const next = current.slice(0, -1);
    setCardStack(next);
    if (next.length > 0) {
      onSelect({ type: 'card', id: next[next.length - 1] });
    } else {
      onSelect({ type: 'overview' });
    }
  }, [cardStack, onSelect]);

  /* ── Route by selected item type ────────────────────── */
  if (selectedItem.type === 'overview') {
    return (
      <div className="flex-1 overflow-y-auto">
        <WikiOverviewView
          cards={cards}
          topics={topics}
          skills={skills}
          timelineDays={timelineDays}
          tasks={tasks}
          onSelect={onSelect}
        />
      </div>
    );
  }

  if (selectedItem.type === 'topic') {
    return (
      <TopicView
        topicId={selectedItem.id}
        topicTitle={selectedItem.title}
        topics={topics}
        cards={cards}
        onSelect={onSelect}
      />
    );
  }

  if (selectedItem.type === 'card') {
    const activeCardId = cardStack.length > 0 ? cardStack[cardStack.length - 1] : selectedItem.id;
    return (
      <div className="flex-1 overflow-y-auto">
        <WikiArticleView
          cardId={activeCardId}
          preloadedCards={cards}
          onBack={handleBack}
          onNavigateToCard={handleNavigateToCard}
        />
      </div>
    );
  }

  if (selectedItem.type === 'task') {
    const task = tasks.find((a) => a.id === selectedItem.id);
    return (
      <div className="flex-1 overflow-y-auto p-6 max-w-3xl mx-auto">
        <BackButton onClick={() => onSelect({ type: 'overview' })} />
        {task ? <TaskDetailView task={task} /> : <EmptyMessage text={t('memory.wiki.taskNotFound', 'Task not found')} />}
      </div>
    );
  }

  if (selectedItem.type === 'risk') {
    return (
      <div className="flex-1 overflow-y-auto p-6 max-w-3xl mx-auto">
        <BackButton onClick={() => onSelect({ type: 'overview' })} />
        <EmptyMessage text={t('memory.wiki.riskNotFound', 'Risk not found')} />
      </div>
    );
  }

  if (selectedItem.type === 'timeline_day') {
    return (
      <TimelineDayView
        date={selectedItem.date}
        timelineDays={timelineDays}
        cards={cards}
        onSelect={onSelect}
      />
    );
  }

  if (selectedItem.type === 'skills') {
    return <SkillsView skills={skills} />;
  }

  /* ── Workspace views ───────────────────────────────── */
  if (selectedItem.type === 'workspace_overview') {
    return (
      <WorkspaceOverviewView
        stats={workspaceStats ?? null}
        scanStatus={scanStatus ?? null}
        onSelect={onSelect}
        onTriggerScan={onTriggerScan}
      />
    );
  }

  if (selectedItem.type === 'workspace_file') {
    return (
      <WorkspaceFileView
        fileId={selectedItem.id}
        fileTitle={selectedItem.title}
        cards={cards}
        onSelect={onSelect}
      />
    );
  }

  if (selectedItem.type === 'workspace_doc') {
    return (
      <WorkspaceDocView
        docId={selectedItem.id}
        docTitle={selectedItem.title}
        onSelect={onSelect}
      />
    );
  }

  if (selectedItem.type === 'wiki_page') {
    return (
      <WikiPageView
        pageId={selectedItem.id}
        pageTitle={selectedItem.title}
        cards={cards}
        onSelect={onSelect}
      />
    );
  }

  /* ── Workspace list views ─────────────────────────── */
  if (selectedItem.type === 'workspace_code_list') {
    return (
      <WorkspaceListView
        category="code"
        files={workspaceFiles}
        wikiPages={wikiPages}
        onSelect={onSelect}
      />
    );
  }

  if (selectedItem.type === 'workspace_docs_list') {
    return (
      <WorkspaceListView
        category="docs"
        files={workspaceDocs}
        wikiPages={wikiPages}
        onSelect={onSelect}
      />
    );
  }

  if (selectedItem.type === 'workspace_wiki_list') {
    return (
      <WorkspaceListView
        category="wiki"
        files={[]}
        wikiPages={wikiPages}
        onSelect={onSelect}
      />
    );
  }

  return null;
}

/* ── TopicView ───────────────────────────────────────── */
interface TopicMemberCard {
  id: string;
  title: string;
  summary?: string | null;
  category?: string | null;
  growth_stage?: string | null;
  confidence?: number | null;
  created_at?: string | null;
}

function TopicView({
  topicId,
  topicTitle,
  topics,
  cards,
  onSelect,
}: {
  topicId: string;
  topicTitle: string;
  topics: TopicItem[];
  cards: KnowledgeCard[];
  onSelect: (item: WikiSelectedItem) => void;
}) {
  const { t } = useI18n();
  const topic = topics.find((tp) => tp.id === topicId);
  const title = topic?.title ?? topicTitle;
  // Sidebar-authoritative count — comes from /topics which live-computes via
  // tag-match (since daemon 0.5.15), so it's trustworthy even when the single
  // /knowledge/:id call returns stale/empty members (e.g. daemon still warming
  // up indices after startup).
  const expectedCount = topic?.card_count ?? 0;

  const [members, setMembers] = useState<TopicMemberCard[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const MAX_RETRIES = 4;
  const RETRY_DELAY_MS = 800;

  // Special case: pseudo-topics from the tag-fallback path. Their ID is
  // `tag_<tagname>`, not a real knowledge_cards row, so we resolve members
  // client-side from pre-loaded `cards` by tag match.
  const isTagPseudoTopic = topicId.startsWith('tag_');

  // Reset all state whenever the topic itself changes. Must happen synchronously
  // with the topicId change so we don't render stale state from the previous
  // topic for even one frame.
  useEffect(() => {
    setMembers(null);
    setError(null);
    setLoading(true);
    setAttempt(0);
  }, [topicId]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const resolveResult = (resolved: TopicMemberCard[]) => {
      if (cancelled) return;
      // Critical safeguard: if the sidebar count says there ARE cards but we got
      // zero, the daemon tag index is probably still warming up after startup.
      // Retry up to MAX_RETRIES times before giving up.
      if (resolved.length === 0 && expectedCount > 0 && attempt < MAX_RETRIES - 1) {
        retryTimer = setTimeout(() => {
          if (cancelled) return;
          setAttempt((a) => a + 1);
        }, RETRY_DELAY_MS);
        return;
      }
      setMembers(resolved);
      setLoading(false);
    };

    /** Client-side tag match: given a list of MOC tags, find member cards from preloaded list */
    const clientSideMatch = (mocTags: string[]): TopicMemberCard[] | null => {
      if (cards.length === 0 || mocTags.length === 0) return null;
      const tagSet = new Set(mocTags.map((t) => t.trim().toLowerCase()).filter(Boolean));
      const seen = new Set<string>();
      const matched: TopicMemberCard[] = [];
      for (const card of cards) {
        if (card.card_type === 'moc' || card.id === topicId) continue;
        let cardTags: string[] = [];
        try {
          const parsed = typeof card.tags === 'string' ? JSON.parse(card.tags) : card.tags;
          if (Array.isArray(parsed)) cardTags = parsed.map((tg: string) => String(tg).trim().toLowerCase());
        } catch { /* ignore */ }
        if (cardTags.some((tg) => tagSet.has(tg)) && !seen.has(card.id)) {
          seen.add(card.id);
          matched.push(card as unknown as TopicMemberCard);
        }
      }
      return matched.length > 0 ? matched : null;
    };

    if (isTagPseudoTopic) {
      if (cards.length === 0) { setLoading(true); return; }
      const tag = topicId.slice(4).toLowerCase();
      const matched = cards.filter((c) => {
        if (!c.tags) return false;
        let parsed: unknown;
        try { parsed = typeof c.tags === 'string' ? JSON.parse(c.tags) : c.tags; } catch { return false; }
        if (!Array.isArray(parsed)) return false;
        return parsed.some((tagValue) => String(tagValue).trim().toLowerCase() === tag);
      });
      resolveResult(matched as unknown as TopicMemberCard[]);
      return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
    }

    // --- FAST PATH 1: use topic.tags from sidebar data (available since daemon 0.5.17)
    // This is the most reliable path: no need to find the MOC card in the preloaded
    // cards array (which is capped at 50 and may not include older MOC cards).
    const topicWithTags = topic?.tags;
    if (Array.isArray(topicWithTags) && topicWithTags.length > 0 && cards.length > 0) {
      const matched = clientSideMatch(topicWithTags);
      if (matched !== null) {
        resolveResult(matched);
        return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
      }
      // matched === null: 0 results from client-side → fall through to daemon fetch
    }

    // --- FAST PATH 2: MOC card in preloaded cards (older daemon without tags in topics)
    if (cards.length > 0) {
      const mocCard = cards.find((c) => c.id === topicId && c.card_type === 'moc');
      if (mocCard) {
        let mocTags: string[] = [];
        try {
          const parsed = typeof mocCard.tags === 'string' ? JSON.parse(mocCard.tags) : mocCard.tags;
          if (Array.isArray(parsed)) mocTags = parsed.map((tg: string) => String(tg).trim().toLowerCase()).filter(Boolean);
        } catch { /* ignore */ }
        const matched = clientSideMatch(mocTags);
        if (matched !== null) {
          resolveResult(matched);
          return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
        }
      }
    }

    // --- FALLBACK: fetch from daemon.
    // Reaches here when: cards not yet loaded, MOC not in preloaded list, OR
    // client-side tag match returned 0 (tag index may still be warming up).
    setLoading(true);
    fetch(`${DAEMON_API_BASE}/knowledge/${encodeURIComponent(topicId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: { members?: TopicMemberCard[] }) => {
        resolveResult(Array.isArray(data?.members) ? data.members : []);
      })
      .catch((err) => {
        if (cancelled) return;
        if (attempt < MAX_RETRIES - 1) {
          retryTimer = setTimeout(() => {
            if (cancelled) return;
            setAttempt((a) => a + 1);
          }, RETRY_DELAY_MS);
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load topic members');
        setLoading(false);
      });

    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [topicId, isTagPseudoTopic, topic, cards, attempt, expectedCount]);

  // While loading, show the sidebar count so the header doesn't flash "0 cards".
  const memberCount = loading || members === null
    ? expectedCount
    : members.length;

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-3xl mx-auto space-y-5">
      <BackButton onClick={() => onSelect({ type: 'overview' })} />
      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-slate-100">{title}</h2>
        {topic?.summary && (
          <p className="text-sm text-slate-400 leading-relaxed">{topic.summary}</p>
        )}
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="rounded bg-slate-800 px-2 py-0.5">{memberCount} cards</span>
          {topic?.last_updated_at && (
            <span>{new Date(topic.last_updated_at).toLocaleDateString()}</span>
          )}
        </div>
      </div>

      {(loading || members === null) && !error && (
        <div className="flex flex-col items-center justify-center py-12 gap-2">
          <Loader2 size={22} className="animate-spin text-brand-500" />
          <p className="text-xs text-slate-500">
            {t('memory.wiki.loadingTopicMembers', 'Loading {count} cards...').replace('{count}', String(expectedCount || ''))}
          </p>
          {attempt > 0 && (
            <p className="text-[10px] text-slate-600 text-center max-w-[220px]">
              {t('memory.wiki.indexWarming', 'Daemon is building the tag index, please wait...')}
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/5 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {!loading && members && members.length > 0 && (
        <div className="divide-y divide-slate-700/30 rounded-xl border border-slate-700/50">
          {members.map((card) => {
            const display = getCategoryDisplay(card.category ?? 'key_point');
            const CategoryIcon = display.icon;
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => onSelect({ type: 'card', id: card.id })}
                className="flex w-full items-start gap-3 p-3 text-left hover:bg-slate-800/50 transition-colors"
              >
                <span className="text-sm shrink-0 mt-0.5">
                  {card.growth_stage === 'evergreen' ? '🌳' : card.growth_stage === 'budding' ? '🌿' : '🌱'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <CategoryIcon size={12} className={display.color} />
                    <p className="text-sm font-medium text-slate-200 leading-snug">{card.title}</p>
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
          })}
        </div>
      )}

      {/* Empty state only when BOTH our fetch AND the sidebar count agree there
          are no cards. Otherwise treat as "still warming up" (spinner above). */}
      {!loading && members && members.length === 0 && expectedCount === 0 && !error && (
        <p className="text-sm text-slate-500 italic">
          {t('memory.wiki.noTopicMembers', 'No cards in this topic yet')}
        </p>
      )}
    </div>
  );
}

/* ── TimelineDayView ─────────────────────────────────── */
interface MemoryDetail {
  id: string;
  title?: string | null;
  type?: string | null;
  source?: string | null;
  created_at?: string | null;
  content?: string | null;
  fts_content?: string | null;
  tags?: string[];
  session_id?: string | null;
}

function TimelineDayView({
  date,
  timelineDays,
  cards,
  onSelect,
}: {
  date: string;
  timelineDays: TimelineDayItem[];
  cards: KnowledgeCard[];
  onSelect: (item: WikiSelectedItem) => void;
}) {
  const { t } = useI18n();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailById, setDetailById] = useState<Record<string, MemoryDetail>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  // Reset expansion state whenever the user switches to a different day so
  // stale cached details from another day don't leak across views.
  useEffect(() => {
    setExpandedId(null);
    setDetailById({});
    setErrorById({});
    setLoadingId(null);
  }, [date]);

  // Primary: use the events list that `/timeline` returned for this day.
  // These are rows from the `memories` table (sessions, turns, tool events),
  // NOT knowledge cards. Fall back to knowledge cards created on the same day
  // so users still see something useful if the timeline API has no events.
  const dayEvents: TimelineEventItem[] = useMemo(() => {
    const match = timelineDays.find((d) => d.date === date);
    return match?.events ?? [];
  }, [timelineDays, date]);

  const dayCards = useMemo(
    () => cards.filter((c) => (c.created_at || '').startsWith(date)),
    [cards, date],
  );

  const hasContent = dayEvents.length > 0 || dayCards.length > 0;

  // Toggle an event row open/closed. First open fetches full content from
  // daemon `/memories/:id`; subsequent opens on the same event reuse the
  // cached detail. Collapsing just clears expandedId.
  const handleToggleEvent = useCallback(async (eventId: string) => {
    if (expandedId === eventId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(eventId);

    // Already fetched — skip network.
    if (detailById[eventId]) return;

    setLoadingId(eventId);
    setErrorById((prev) => {
      const next = { ...prev };
      delete next[eventId];
      return next;
    });
    try {
      const res = await fetch(`${DAEMON_API_BASE}/memories/${encodeURIComponent(eventId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as MemoryDetail;
      setDetailById((prev) => ({ ...prev, [eventId]: data }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load event';
      setErrorById((prev) => ({ ...prev, [eventId]: msg }));
    } finally {
      setLoadingId((prev) => (prev === eventId ? null : prev));
    }
  }, [expandedId, detailById]);

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-3xl mx-auto space-y-4">
      <BackButton onClick={() => onSelect({ type: 'overview' })} />
      <h2 className="text-lg font-semibold text-slate-100">
        🕐 {formatDateFull(date)}
      </h2>

      {!hasContent && (
        <EmptyMessage text={t('memory.wiki.noDayEvents', 'No activity on this day')} />
      )}

      {dayEvents.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            {t('memory.wiki.dayEvents', 'Events')} · {dayEvents.length}
          </h3>
          <div className="divide-y divide-slate-700/30 rounded-xl border border-slate-700/50 overflow-hidden">
            {dayEvents.map((event) => {
              const src = getSourceDisplay(event.source || undefined);
              const SourceIcon = src.icon;
              const isExpanded = expandedId === event.id;
              const isLoading = loadingId === event.id;
              const detail = detailById[event.id];
              const loadError = errorById[event.id];
              const content = detail?.content || detail?.fts_content || '';

              return (
                <div key={event.id}>
                  <button
                    type="button"
                    onClick={() => void handleToggleEvent(event.id)}
                    className={`flex w-full items-start gap-3 p-3 text-left transition-colors ${
                      isExpanded ? 'bg-slate-800/50' : 'hover:bg-slate-800/40'
                    }`}
                  >
                    <SourceIcon size={14} className="text-slate-400 mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium text-slate-300">{src.label}</span>
                        {event.type && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-slate-800 rounded text-slate-500">
                            {event.type}
                          </span>
                        )}
                        {event.created_at && (
                          <span className="text-[10px] text-slate-600 ml-auto">
                            {new Date(event.created_at).toLocaleTimeString()}
                          </span>
                        )}
                      </div>
                      {event.title && (
                        <p className="mt-0.5 text-sm text-slate-200 line-clamp-2">{event.title}</p>
                      )}
                    </div>
                    {isLoading ? (
                      <Loader2 size={12} className="mt-1 animate-spin text-slate-500 shrink-0" />
                    ) : (
                      <span className="text-xs text-slate-600 shrink-0 mt-0.5">
                        {isExpanded ? '▾' : '▸'}
                      </span>
                    )}
                  </button>
                  {isExpanded && (
                    <div className="px-4 pb-4 pt-1 border-t border-slate-700/30 bg-slate-900/40">
                      {loadError && (
                        <p className="text-xs text-red-400">{loadError}</p>
                      )}
                      {!loadError && isLoading && (
                        <p className="text-xs text-slate-500 italic">
                          {t('memory.wiki.loadingEvent', 'Loading event content...')}
                        </p>
                      )}
                      {!loadError && !isLoading && detail && (
                        <div className="space-y-2 text-xs text-slate-300">
                          {detail.session_id && (
                            <p className="text-[10px] text-slate-600 font-mono">
                              session: {detail.session_id}
                            </p>
                          )}
                          {content ? (
                            <div className="prose prose-sm prose-invert max-w-none">
                              <ReactMarkdown remarkPlugins={[remarkGfm]} components={memoryMarkdownComponents}>
                                {content}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <p className="italic text-slate-500">
                              {t('memory.wiki.noEventContent', 'No content for this event')}
                            </p>
                          )}
                          {Array.isArray(detail.tags) && detail.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 pt-1">
                              {detail.tags.map((tag, i) => (
                                <span key={i} className="text-[10px] px-1.5 py-0.5 bg-slate-800 rounded text-slate-500">
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {dayCards.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            <FileText size={11} className="inline mr-1" />
            {t('memory.wiki.dayCards', 'Cards created')} · {dayCards.length}
          </h3>
          <div className="divide-y divide-slate-700/30 rounded-xl border border-slate-700/50">
            {dayCards.map((card) => {
              const display = getCategoryDisplay(card.category);
              const CategoryIcon = display.icon;
              return (
                <button
                  key={card.id}
                  type="button"
                  onClick={() => onSelect({ type: 'card', id: card.id })}
                  className="flex w-full items-start gap-3 p-3 text-left hover:bg-slate-800/50 transition-colors"
                >
                  <CategoryIcon size={14} className={display.color + ' mt-0.5'} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-200">{card.title}</p>
                    {card.summary && (
                      <p className="mt-0.5 text-xs text-slate-500 line-clamp-2">{card.summary}</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

/* ── SkillsView ──────────────────────────────────────── */
function SkillsView({ skills }: { skills: SkillItem[] }) {
  const { t } = useI18n();

  if (skills.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center py-20">
        <div className="text-center space-y-2">
          <p className="text-sm text-slate-500">{t('memory.wiki.noSkills', 'No skills extracted yet')}</p>
          <p className="text-xs text-slate-600">{t('memory.wiki.noSkillsHint', 'Skills are automatically extracted from repeated patterns')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-3xl mx-auto space-y-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
        ⚡ {t('memory.wiki.skills', 'Skills')}
        <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400">{skills.length}</span>
      </h2>

      <div className="space-y-2">
        {skills.map((skill) => (
          <div
            key={skill.id}
            className="p-4 rounded-xl border border-slate-700/50 bg-slate-800/40 space-y-2"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-slate-200">{skill.name}</h3>
                {skill.description && (
                  <p className="mt-1 text-xs text-slate-400 leading-relaxed">{skill.description}</p>
                )}
              </div>
              {skill.pinned && (
                <span className="text-xs text-amber-400">📌</span>
              )}
            </div>

            {/* Decay bar */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-1.5 rounded-full bg-slate-700 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    (skill.decay_score ?? 1) > 0.6
                      ? 'bg-emerald-500'
                      : (skill.decay_score ?? 1) > 0.3
                        ? 'bg-amber-500'
                        : 'bg-red-500'
                  }`}
                  style={{ width: `${Math.round((skill.decay_score ?? 1) * 100)}%` }}
                />
              </div>
              <span className="text-[10px] text-slate-500 shrink-0 w-8 text-right">
                {Math.round((skill.decay_score ?? 1) * 100)}%
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
              {skill.use_count != null && (
                <span>Used {skill.use_count}×</span>
              )}
              {skill.confidence != null && (
                <span>Confidence {Math.round(skill.confidence * 100)}%</span>
              )}
              {skill.last_used_at && (
                <span>Last used {new Date(skill.last_used_at).toLocaleDateString()}</span>
              )}
              {skill.created_at && (
                <span>Created {new Date(skill.created_at).toLocaleDateString()}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── TaskDetailView ──────────────────────────────────── */
function TaskDetailView({
  task,
}: {
  task: { id: string; title: string; description?: string; priority: string; status: string; created_at?: string };
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="text-2xl">{PRIORITY_ICON[task.priority] ?? '⬜'}</span>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            {task.priority.toUpperCase()} · Task
          </p>
          <h2 className="text-xl font-bold text-slate-100 mt-0.5">{task.title}</h2>
        </div>
      </div>
      {task.description && (
        <div className="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={memoryMarkdownComponents}>
            {task.description}
          </ReactMarkdown>
        </div>
      )}
      <div className="flex gap-2">
        <span className={`text-xs px-2 py-0.5 rounded ${
          task.priority === 'high' ? 'bg-red-500/20 text-red-300' : 'bg-slate-700 text-slate-400'
        }`}>
          {task.priority}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded ${
          task.status === 'open' ? 'bg-blue-500/20 text-blue-300' : 'bg-emerald-500/20 text-emerald-300'
        }`}>
          {task.status}
        </span>
      </div>
      {task.created_at && (
        <p className="text-[11px] text-slate-600">Created {new Date(task.created_at).toLocaleString()}</p>
      )}
    </div>
  );
}

/* ── Shared helpers ──────────────────────────────────── */
function BackButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-200 transition-colors mb-4"
    >
      <ArrowLeft size={16} />
      {t('memory.wiki.back', 'Back')}
    </button>
  );
}

function EmptyMessage({ text }: { text: string }) {
  return <p className="text-sm text-slate-500">{text}</p>;
}

function formatDateFull(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return dateStr;
  }
}
