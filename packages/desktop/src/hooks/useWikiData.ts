import { useState, useCallback } from 'react';
import { DAEMON_API_BASE } from '../components/memory/wiki-types';
import type { TopicItem, SkillItem, TimelineDayItem } from '../components/memory/wiki-types';

export interface WikiDataState {
  topics: TopicItem[];
  skills: SkillItem[];
  timelineDays: TimelineDayItem[];
  wikiLoading: boolean;
  wikiError: string | null;
}

export interface WikiDataActions {
  loadTopics: () => Promise<void>;
  loadSkills: () => Promise<void>;
  loadTimelineDays: () => Promise<void>;
  loadAllWikiData: () => Promise<void>;
}

export type UseWikiDataReturn = WikiDataState & WikiDataActions;

async function fetchJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  return (await res.json()) as T;
}

/**
 * Fetches wiki-specific data from the local daemon REST API:
 * - Topics (MOC cards) via GET /topics
 * - Skills via GET /skills
 * - Timeline days via GET /timeline
 */
export function useWikiData(): UseWikiDataReturn {
  const [topics, setTopics] = useState<TopicItem[]>([]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [timelineDays, setTimelineDays] = useState<TimelineDayItem[]>([]);
  const [wikiLoading, setWikiLoading] = useState(false);
  const [wikiError, setWikiError] = useState<string | null>(null);

  const loadTopics = useCallback(async () => {
    const data = await fetchJson<{ topics?: TopicItem[]; items?: TopicItem[] }>(`${DAEMON_API_BASE}/topics`);
    if (data) {
      setTopics(data.topics ?? data.items ?? []);
    }
  }, []);

  const loadSkills = useCallback(async () => {
    const data = await fetchJson<{ skills?: SkillItem[]; items?: SkillItem[] }>(`${DAEMON_API_BASE}/skills`);
    if (data) {
      setSkills(data.skills ?? data.items ?? []);
    }
  }, []);

  const loadTimelineDays = useCallback(async () => {
    // Daemon returns: { by_day: [{ date, events: [...], count }], total }
    // Older/alternate shapes (days / items) are tolerated for back-compat.
    const data = await fetchJson<{
      by_day?: TimelineDayItem[];
      days?: TimelineDayItem[];
      items?: TimelineDayItem[];
    }>(`${DAEMON_API_BASE}/timeline?days=30&limit=500`);
    if (data) {
      setTimelineDays(data.by_day ?? data.days ?? data.items ?? []);
    }
  }, []);

  const loadAllWikiData = useCallback(async () => {
    setWikiLoading(true);
    setWikiError(null);
    try {
      await Promise.all([loadTopics(), loadSkills(), loadTimelineDays()]);
    } catch (err) {
      setWikiError(err instanceof Error ? err.message : 'Failed to load wiki data');
    } finally {
      setWikiLoading(false);
    }
  }, [loadTopics, loadSkills, loadTimelineDays]);

  return {
    topics,
    skills,
    timelineDays,
    wikiLoading,
    wikiError,
    loadTopics,
    loadSkills,
    loadTimelineDays,
    loadAllWikiData,
  };
}
