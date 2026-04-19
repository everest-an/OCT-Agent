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
  | { type: 'skills' }
  | { type: 'workspace_overview' }
  | { type: 'workspace_file'; id: string; title: string }
  | { type: 'workspace_doc'; id: string; title: string }
  | { type: 'wiki_page'; id: string; title: string }
  | { type: 'workspace_code_list' }
  | { type: 'workspace_docs_list' }
  | { type: 'workspace_wiki_list' };

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
  /** F-059 — skill growth lifecycle stage (seedling → budding → evergreen). */
  growth_stage?: 'seedling' | 'budding' | 'evergreen';
  /** F-059 — common pitfalls / anti-patterns associated with this skill. */
  pitfalls?: string[];
  /** F-059 — verification steps / assertions that prove the skill worked. */
  verification?: string[];
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

/* ── Workspace Scanner types ─────────────────────────── */

export interface WorkspaceFileItem {
  id: string;
  title: string;
  category?: string;
  relativePath?: string;
  size?: number;
  content_hash?: string;
  salience_score?: number;
  recall_count?: number;
  status?: string;
  updated_at?: string;
}

export interface WorkspaceFileDetail {
  id: string;
  title: string;
  node_type?: string;
  content?: string;
  content_hash?: string;
  metadata?: Record<string, unknown>;
  salience_score?: number;
  recall_count?: number;
  status?: string;
  created_at?: string;
  updated_at?: string;
  edges?: Array<{
    from: string;
    to: string;
    type: string;
    weight?: number;
    metadata?: Record<string, unknown>;
  }>;
}

export interface WikiPageItem {
  id: string;
  title: string;
  node_type?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  updated_at?: string;
}

export interface ScanStatus {
  status: 'idle' | 'scanning' | 'indexing';
  phase?: string;
  total_files?: number;
  processed_files?: number;
  percent?: number;
  embed_total?: number;
  embed_done?: number;
}

export interface WorkspaceStats {
  totalFiles: number;
  totalSymbols: number;
  totalImports: number;
  totalDocs: number;
  totalWikiPages: number;
  totalDocRefs: number;
}
