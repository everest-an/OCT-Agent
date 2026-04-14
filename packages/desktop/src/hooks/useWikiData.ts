import { useState, useCallback, useRef } from 'react';
import { DAEMON_API_BASE } from '../components/memory/wiki-types';
import type {
  TopicItem, SkillItem, TimelineDayItem,
  WorkspaceFileItem, WikiPageItem, ScanStatus, WorkspaceStats,
} from '../components/memory/wiki-types';

export interface WikiDataState {
  topics: TopicItem[];
  skills: SkillItem[];
  timelineDays: TimelineDayItem[];
  wikiLoading: boolean;
  wikiError: string | null;
  // Workspace scanner data
  workspaceFiles: WorkspaceFileItem[];
  workspaceDocs: WorkspaceFileItem[];
  wikiPages: WikiPageItem[];
  scanStatus: ScanStatus | null;
  workspaceStats: WorkspaceStats | null;
}

export interface WikiDataActions {
  loadTopics: () => Promise<void>;
  loadSkills: () => Promise<void>;
  loadTimelineDays: () => Promise<void>;
  loadWorkspaceData: () => Promise<void>;
  loadScanStatus: () => Promise<void>;
  triggerScan: (mode?: 'full' | 'incremental') => Promise<void>;
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
 * - Workspace files/docs/wiki via GET /scan/*
 */
export function useWikiData(): UseWikiDataReturn {
  const [topics, setTopics] = useState<TopicItem[]>([]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [timelineDays, setTimelineDays] = useState<TimelineDayItem[]>([]);
  const [wikiLoading, setWikiLoading] = useState(false);
  const [wikiError, setWikiError] = useState<string | null>(null);

  // Workspace scanner state
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileItem[]>([]);
  const [workspaceDocs, setWorkspaceDocs] = useState<WorkspaceFileItem[]>([]);
  const [wikiPages, setWikiPages] = useState<WikiPageItem[]>([]);
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [workspaceStats, setWorkspaceStats] = useState<WorkspaceStats | null>(null);
  const scanPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    const data = await fetchJson<{
      by_day?: TimelineDayItem[];
      days?: TimelineDayItem[];
      items?: TimelineDayItem[];
    }>(`${DAEMON_API_BASE}/timeline?days=30&limit=500`);
    if (data) {
      setTimelineDays(data.by_day ?? data.days ?? data.items ?? []);
    }
  }, []);

  const loadScanStatus = useCallback(async () => {
    const data = await fetchJson<ScanStatus>(`${DAEMON_API_BASE}/scan/status`);
    if (data) {
      setScanStatus(data);
    }
  }, []);

  const loadWorkspaceData = useCallback(async () => {
    // Fetch code files, doc files, and wiki pages in parallel
    const [filesData, docsData, wikiData] = await Promise.all([
      fetchJson<{ files?: WorkspaceFileItem[]; total?: number }>(
        `${DAEMON_API_BASE}/scan/files?category=code&limit=500`,
      ),
      fetchJson<{ files?: WorkspaceFileItem[]; total?: number }>(
        `${DAEMON_API_BASE}/scan/files?category=docs&limit=200`,
      ),
      fetchJson<{ files?: WikiPageItem[]; total?: number }>(
        `${DAEMON_API_BASE}/scan/files?q=&category=wiki&limit=100`,
      ),
    ]);

    const files = filesData?.files ?? [];
    const docs = docsData?.files ?? [];
    const wikis = wikiData?.files ?? [];

    setWorkspaceFiles(files);
    setWorkspaceDocs(docs);
    setWikiPages(wikis as WikiPageItem[]);

    // Compute stats from what we have
    const totalSymbols = files.reduce((n, f) => {
      const sym = (f as unknown as Record<string, unknown>).symbol_count;
      return n + (typeof sym === 'number' ? sym : 0);
    }, 0);

    setWorkspaceStats({
      totalFiles: (filesData?.total ?? files.length) + (docsData?.total ?? docs.length),
      totalSymbols,
      totalImports: 0, // will be enriched by file detail calls
      totalDocs: docsData?.total ?? docs.length,
      totalWikiPages: wikiData?.total ?? wikis.length,
      totalDocRefs: 0,
    });
  }, []);

  const triggerScan = useCallback(async (mode: 'full' | 'incremental' = 'incremental') => {
    try {
      await fetch(`${DAEMON_API_BASE}/scan/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      // Start polling scan status
      if (scanPollRef.current) clearInterval(scanPollRef.current);
      scanPollRef.current = setInterval(async () => {
        const data = await fetchJson<ScanStatus>(`${DAEMON_API_BASE}/scan/status`);
        if (data) {
          setScanStatus(data);
          if (data.status === 'idle') {
            // Scan finished — stop polling, reload workspace data
            if (scanPollRef.current) {
              clearInterval(scanPollRef.current);
              scanPollRef.current = null;
            }
            await loadWorkspaceData();
          }
        }
      }, 2000);
    } catch {
      // Daemon not running — ignore
    }
  }, [loadWorkspaceData]);

  const loadAllWikiData = useCallback(async () => {
    setWikiLoading(true);
    setWikiError(null);
    try {
      await Promise.all([
        loadTopics(),
        loadSkills(),
        loadTimelineDays(),
        loadWorkspaceData(),
        loadScanStatus(),
      ]);
    } catch (err) {
      setWikiError(err instanceof Error ? err.message : 'Failed to load wiki data');
    } finally {
      setWikiLoading(false);
    }
  }, [loadTopics, loadSkills, loadTimelineDays, loadWorkspaceData, loadScanStatus]);

  return {
    topics,
    skills,
    timelineDays,
    wikiLoading,
    wikiError,
    workspaceFiles,
    workspaceDocs,
    wikiPages,
    scanStatus,
    workspaceStats,
    loadTopics,
    loadSkills,
    loadTimelineDays,
    loadWorkspaceData,
    loadScanStatus,
    triggerScan,
    loadAllWikiData,
  };
}
