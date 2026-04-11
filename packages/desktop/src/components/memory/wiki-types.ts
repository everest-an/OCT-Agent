/**
 * Shared types for the desktop wiki sidebar navigation system.
 * Mirrors the cloud frontend wiki-types.ts for three-surface alignment.
 */

/** Local daemon REST API base URL — single source of truth */
export const DAEMON_API_BASE = 'http://127.0.0.1:37800/api/v1';

export type WikiSelectedItem =
  | { type: 'overview' }
  | { type: 'topic'; id: string; title: string }
  | { type: 'card'; id: string }
  | { type: 'task'; id: string }
  | { type: 'risk'; id: string }
  | { type: 'timeline_day'; date: string }
  | { type: 'skills' };

export interface TopicItem {
  id: string;
  title: string | null;
  card_count: number;
  summary?: string | null;
  last_updated_at?: string | null;
  /** MOC tags returned by daemon (>= 0.5.17) — used for client-side member resolution */
  tags?: string[] | null;
}

export interface SkillItem {
  id: string;
  name: string;
  description?: string;
  confidence?: number;
  use_count?: number;
  last_used_at?: string | null;
  created_at?: string;
  decay_score?: number;
  pinned?: boolean;
}

export interface TimelineEventItem {
  id: string;
  title?: string | null;
  type?: string | null;
  source?: string | null;
  created_at?: string | null;
  tags?: string | null;
}

export interface TimelineDayItem {
  date: string;
  count: number;
  events?: TimelineEventItem[];
}
