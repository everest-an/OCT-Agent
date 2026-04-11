import { useState, useCallback } from 'react';
import { parseMemoryContextResponse } from '../lib/memory-context';
import type { KnowledgeCard, MemoryEvent } from '../components/memory/memory-helpers';
import { parseMcpResponse } from '../components/memory/memory-helpers';
import type { PerceptionSignal } from '../components/memory/memory-helpers';

export interface MemoryDataState {
  cards: KnowledgeCard[];
  events: MemoryEvent[];
  fullEvents: MemoryEvent[];
  eventsTotal: number;
  eventsOffset: number;
  tasks: Array<{ id: string; title: string; description?: string; priority: string; status: string; created_at?: string }>;
  signals: PerceptionSignal[];
  dailySummary: { recentCards: KnowledgeCard[]; openTasks: number } | null;
  loading: boolean;
  error: string | null;
}

export interface MemoryDataActions {
  setCards: React.Dispatch<React.SetStateAction<KnowledgeCard[]>>;
  setEvents: React.Dispatch<React.SetStateAction<MemoryEvent[]>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setEventsOffset: React.Dispatch<React.SetStateAction<number>>;
  setEventsTotal: React.Dispatch<React.SetStateAction<number>>;
  loadCards: () => Promise<void>;
  loadEvents: (offset?: number, append?: boolean, currentSourceView?: 'chat' | 'dev' | 'all') => Promise<void>;
  loadContext: () => Promise<boolean>;
  loadPerception: () => Promise<void>;
  loadDailySummary: () => Promise<void>;
  loadTasks: () => Promise<void>;
  reloadMemoryData: () => Promise<void>;
}

export type UseMemoryDataReturn = MemoryDataState & MemoryDataActions;

/**
 * Manages all memory data loading (cards, events, tasks, perception, daily summary).
 * Extracted from Memory.tsx to reduce file size.
 */
export function useMemoryData(
  api: any,
  t: (key: string, fallback?: string) => string,
  sourceView: 'chat' | 'dev' | 'all',
  loadLearningStatus: () => Promise<void>,
  loadPromotionProposals: () => Promise<void>,
): UseMemoryDataReturn {
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [events, setEvents] = useState<MemoryEvent[]>([]);
  const [fullEvents, setFullEvents] = useState<MemoryEvent[]>([]);
  const [eventsTotal, setEventsTotal] = useState(0);
  const [eventsOffset, setEventsOffset] = useState(0);
  const [tasks, setTasks] = useState<Array<{ id: string; title: string; description?: string; priority: string; status: string; created_at?: string }>>([]);
  const [signals, setSignals] = useState<PerceptionSignal[]>([]);
  const [dailySummary, setDailySummary] = useState<{ recentCards: KnowledgeCard[]; openTasks: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCards = useCallback(async () => {
    if (!api) return;
    try {
      const result = await api.memoryGetCards();
      const parsed = parseMcpResponse(result);
      if (parsed.errorKey) {
        setError(t(parsed.errorKey));
        setCards([]);
      } else {
        setCards(parsed.cards);
        setError(null);
      }
    } catch {
      setError(t('memory.cannotConnect', 'Cannot connect to Local Daemon.'));
      setCards([]);
    }
  }, [api, t]);

  const loadTasks = useCallback(async () => {
    if (!api?.memoryGetTasks) return;
    try {
      const result = await api.memoryGetTasks();
      const text = result?.content?.[0]?.text || result?.result?.content?.[0]?.text || '[]';
      const parsed = typeof text === 'string' ? JSON.parse(text) : text;
      setTasks(Array.isArray(parsed) ? parsed : []);
    } catch {
      // tasks are optional
    }
  }, [api]);

  const loadContext = useCallback(async () => {
    if (!api) return false;
    try {
      const result = await api.memoryGetContext();
      const parsed = parseMemoryContextResponse(result);
      if (!parsed.hasStructuredContext) {
        return false;
      }
      setCards(parsed.cards);
      setDailySummary(
        parsed.cards.length > 0 || parsed.openTasks > 0
          ? { recentCards: parsed.cards.slice(0, 5), openTasks: parsed.openTasks }
          : null,
      );
      setError(null);
      return true;
    } catch {
      return false;
    }
  }, [api]);

  const loadEvents = useCallback(async (offset = 0, append = false, currentSourceView?: 'chat' | 'dev' | 'all') => {
    if (!api) return;
    try {
      const view = currentSourceView ?? sourceView;
      const opts: Record<string, unknown> = { limit: 50, offset };
      if (view === 'chat') opts.source_exclude = 'mcp';
      else if (view === 'dev') opts.source = 'mcp';
      const result = await api.memoryGetEvents(opts);
      if (result?.error) return;
      const items = result?.items || [];
      setEvents(prev => append ? [...prev, ...items] : items);
      if (!append) {
        setFullEvents(items);
      } else {
        setFullEvents(prev => [...prev, ...items]);
      }
      setEventsTotal(result?.total || 0);
      setEventsOffset(offset + items.length);
    } catch {
      setLoading(false);
    }
  }, [api, sourceView]);

  const loadPerception = useCallback(async () => {
    if (!api) return;
    try {
      const result = await api.memoryGetPerception();
      const text = result?.result?.content?.[0]?.text;
      if (text) {
        const parsed = JSON.parse(text);
        setSignals(parsed.signals || []);
      }
    } catch { /* no perception data */ }
  }, [api]);

  const loadDailySummary = useCallback(async () => {
    if (!api) return;
    try {
      const result = await api.memoryGetDailySummary();
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
      } else {
        setDailySummary(null);
      }
    } catch { /* daemon not running */ }
  }, [api]);

  const reloadMemoryData = useCallback(async () => {
    const contextLoaded = await loadContext();
    await Promise.all([
      contextLoaded ? Promise.resolve() : loadCards(),
      loadEvents(0),
      loadPerception(),
      contextLoaded ? Promise.resolve() : loadDailySummary(),
      loadLearningStatus(),
      loadPromotionProposals(),
      loadTasks(),
    ]);
  }, [
    loadContext,
    loadCards,
    loadEvents,
    loadPerception,
    loadDailySummary,
    loadLearningStatus,
    loadPromotionProposals,
    loadTasks,
  ]);

  return {
    cards,
    events,
    fullEvents,
    eventsTotal,
    eventsOffset,
    tasks,
    signals,
    dailySummary,
    loading,
    error,
    setCards,
    setEvents,
    setLoading,
    setError,
    setEventsOffset,
    setEventsTotal,
    loadCards,
    loadEvents,
    loadContext,
    loadPerception,
    loadDailySummary,
    loadTasks,
    reloadMemoryData,
  };
}
