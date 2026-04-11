import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';

/**
 * SyncConflictPanel — Shows unresolved cloud sync conflicts for a memory
 * and lets the user resolve each one (adopt local / adopt cloud / merge).
 *
 * F-031 Phase 0.2 — when a local client pushes a card with a stale version,
 * the backend returns 409 and records a row in sync_conflicts. This panel
 * polls that endpoint and lets a human operator resolve blocking rows.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConflictResolution = 'adopt_local' | 'adopt_cloud' | 'manual';

export interface SyncConflict {
  conflict_id: string;
  card_id: string | null;
  conflict_type: string;
  created_at: string;
  device_id: string | null;
  resolved: boolean;
  local_version_json: Record<string, unknown> | null;
  cloud_version_json: Record<string, unknown> | null;
}

export interface SyncConflictPanelProps {
  memoryId: string;
  /** Daemon REST proxy base, e.g. http://127.0.0.1:37800 */
  daemonUrl?: string;
  /** Optional direct cloud API base (falls back to daemon proxy) */
  cloudApiBase?: string;
  /** Optional cloud API key for direct mode */
  cloudApiKey?: string;
  /** Poll interval in ms (default 30_000) */
  pollIntervalMs?: number;
}

interface ResolutionPayload {
  conflict_id: string;
  resolution: ConflictResolution;
  resolved_by: string;
  merged_content?: string;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_DAEMON_URL = 'http://127.0.0.1:37800';

function buildListUrl(props: SyncConflictPanelProps): string {
  const { memoryId, daemonUrl, cloudApiBase } = props;
  const base = cloudApiBase
    ? `${cloudApiBase.replace(/\/+$/, '')}/memories/${encodeURIComponent(memoryId)}/sync-conflicts`
    : `${(daemonUrl || DEFAULT_DAEMON_URL).replace(/\/+$/, '')}/api/proxy/memories/${encodeURIComponent(memoryId)}/sync-conflicts`;
  return `${base}?resolved=false`;
}

function buildResolveUrl(props: SyncConflictPanelProps): string {
  const { memoryId, daemonUrl, cloudApiBase } = props;
  return cloudApiBase
    ? `${cloudApiBase.replace(/\/+$/, '')}/memories/${encodeURIComponent(memoryId)}/sync-conflicts/resolve`
    : `${(daemonUrl || DEFAULT_DAEMON_URL).replace(/\/+$/, '')}/api/proxy/memories/${encodeURIComponent(memoryId)}/sync-conflicts/resolve`;
}

function buildHeaders(props: SyncConflictPanelProps): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (props.cloudApiKey) {
    headers['X-Awareness-Api-Key'] = props.cloudApiKey;
    headers['Authorization'] = `Bearer ${props.cloudApiKey}`;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Diff rendering
// ---------------------------------------------------------------------------

function formatJson(value: unknown): string {
  if (value == null) return '(none)';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface DiffColumnProps {
  label: string;
  payload: Record<string, unknown> | null;
  tone: 'local' | 'cloud';
}

function DiffColumn({ label, payload, tone }: DiffColumnProps) {
  const toneClass =
    tone === 'local'
      ? 'border-emerald-500/40 bg-emerald-900/10'
      : 'border-sky-500/40 bg-sky-900/10';
  return (
    <div className={`flex-1 min-w-0 rounded-xl border ${toneClass} p-3`}>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        {label}
      </div>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-200">
        {formatJson(payload)}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conflict card
// ---------------------------------------------------------------------------

interface ConflictCardProps {
  conflict: SyncConflict;
  resolving: boolean;
  onResolve: (conflictId: string, resolution: ConflictResolution, mergedContent?: string) => void;
}

function ConflictCard({ conflict, resolving, onResolve }: ConflictCardProps) {
  const [showMerge, setShowMerge] = useState(false);
  const [mergeText, setMergeText] = useState<string>(() =>
    formatJson(conflict.local_version_json),
  );

  const handleAdoptLocal = useCallback(() => {
    onResolve(conflict.conflict_id, 'adopt_local');
  }, [conflict.conflict_id, onResolve]);

  const handleAdoptCloud = useCallback(() => {
    onResolve(conflict.conflict_id, 'adopt_cloud');
  }, [conflict.conflict_id, onResolve]);

  const handleManual = useCallback(() => {
    if (!showMerge) {
      setShowMerge(true);
      return;
    }
    onResolve(conflict.conflict_id, 'manual', mergeText);
  }, [conflict.conflict_id, mergeText, onResolve, showMerge]);

  const createdLabel = useMemo(() => {
    try {
      return new Date(conflict.created_at).toLocaleString();
    } catch {
      return conflict.created_at;
    }
  }, [conflict.created_at]);

  return (
    <div className="rounded-2xl border border-slate-700/60 bg-slate-900/55 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-amber-400" />
          <span className="text-sm font-semibold text-slate-100">
            {conflict.conflict_type}
          </span>
          {conflict.card_id && (
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-400">
              {conflict.card_id}
            </span>
          )}
        </div>
        <div className="text-[11px] text-slate-500">
          {createdLabel}
          {conflict.device_id ? ` · ${conflict.device_id}` : ''}
        </div>
      </div>

      <div className="flex flex-col gap-2 md:flex-row">
        <DiffColumn label="Local version" payload={conflict.local_version_json} tone="local" />
        <DiffColumn label="Cloud version" payload={conflict.cloud_version_json} tone="cloud" />
      </div>

      {showMerge && (
        <div className="mt-3">
          <label className="mb-1 block text-[11px] uppercase tracking-[0.18em] text-slate-500">
            Manual merge payload (JSON)
          </label>
          <textarea
            value={mergeText}
            onChange={(event) => setMergeText(event.target.value)}
            rows={8}
            className="w-full resize-y rounded-xl border border-slate-700 bg-slate-950/70 p-2 font-mono text-[11px] text-slate-200 focus:border-brand-500 focus:outline-none"
            spellCheck={false}
          />
        </div>
      )}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={handleAdoptLocal}
          disabled={resolving}
          className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/50 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
        >
          Adopt Local
        </button>
        <button
          type="button"
          onClick={handleAdoptCloud}
          disabled={resolving}
          className="inline-flex items-center gap-1.5 rounded-xl border border-sky-500/50 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-200 transition-colors hover:bg-sky-500/20 disabled:opacity-50"
        >
          Adopt Cloud
        </button>
        <button
          type="button"
          onClick={handleManual}
          disabled={resolving}
          className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
        >
          {showMerge ? 'Submit Merge' : 'Manual Merge'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function SyncConflictPanel(props: SyncConflictPanelProps) {
  const { memoryId, pollIntervalMs = DEFAULT_POLL_MS } = props;
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const loadConflicts = useCallback(async (): Promise<void> => {
    if (!memoryId) return;
    try {
      const res = await fetch(buildListUrl(props), {
        method: 'GET',
        headers: buildHeaders(props),
      });
      if (!res.ok) {
        setError(`Failed to load conflicts: HTTP ${res.status}`);
        setConflicts([]);
        return;
      }
      const payload: unknown = await res.json();
      const rawList: unknown[] = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as { items?: unknown[] })?.items)
          ? ((payload as { items?: unknown[] }).items as unknown[])
          : [];
      const parsed: SyncConflict[] = rawList
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item != null)
        .map((item): SyncConflict => ({
          conflict_id: String(item.conflict_id ?? item.id ?? ''),
          card_id: (item.card_id as string | null) ?? null,
          conflict_type: String(item.conflict_type ?? 'unknown'),
          created_at: String(item.created_at ?? ''),
          device_id: (item.device_id as string | null) ?? null,
          resolved: Boolean(item.resolved ?? false),
          local_version_json: (item.local_version_json as Record<string, unknown> | null) ?? null,
          cloud_version_json: (item.cloud_version_json as Record<string, unknown> | null) ?? null,
        }))
        .filter((c) => c.conflict_id && !c.resolved);
      setConflicts(parsed);
      setError(null);
      setLastRefreshed(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load conflicts');
      setConflicts([]);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryId, props.daemonUrl, props.cloudApiBase, props.cloudApiKey]);

  useEffect(() => {
    void loadConflicts();
    if (pollIntervalMs <= 0) return undefined;
    const timer = setInterval(() => {
      void loadConflicts();
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [loadConflicts, pollIntervalMs]);

  const handleResolve = useCallback(
    async (conflictId: string, resolution: ConflictResolution, mergedContent?: string): Promise<void> => {
      setResolvingId(conflictId);
      try {
        const body: ResolutionPayload = {
          conflict_id: conflictId,
          resolution,
          resolved_by: 'user',
        };
        if (resolution === 'manual' && mergedContent != null) {
          body.merged_content = mergedContent;
        }
        const res = await fetch(buildResolveUrl(props), {
          method: 'POST',
          headers: buildHeaders(props),
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          setError(`Resolve failed: HTTP ${res.status}`);
          return;
        }
        setConflicts((prev) => prev.filter((c) => c.conflict_id !== conflictId));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Resolve failed');
      } finally {
        setResolvingId(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.daemonUrl, props.cloudApiBase, props.cloudApiKey, props.memoryId],
  );

  const unresolvedCount = conflicts.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-slate-700/60 bg-slate-900/55 p-5">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Sync Conflicts</div>
          <h2 className="mt-2 flex items-center gap-2 text-lg font-semibold text-slate-100">
            {unresolvedCount > 0 ? (
              <>
                <AlertTriangle size={18} className="text-amber-400" />
                <span>{unresolvedCount} unresolved conflict{unresolvedCount === 1 ? '' : 's'}</span>
              </>
            ) : (
              <>
                <CheckCircle2 size={18} className="text-emerald-400" />
                <span>All synced</span>
              </>
            )}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            {lastRefreshed
              ? `Last checked ${lastRefreshed.toLocaleTimeString()}`
              : 'Checking for conflicts…'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadConflicts()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700 disabled:opacity-50"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/40 bg-red-900/20 p-3 text-xs text-red-200">
          {error}
        </div>
      )}

      {unresolvedCount === 0 && !loading && !error && (
        <div className="rounded-2xl border border-slate-700/60 bg-slate-900/40 p-6 text-center text-sm text-slate-400">
          Nothing to resolve. Cloud and local are in sync.
        </div>
      )}

      {conflicts.map((conflict) => (
        <ConflictCard
          key={conflict.conflict_id}
          conflict={conflict}
          resolving={resolvingId === conflict.conflict_id}
          onResolve={(id, resolution, merged) => void handleResolve(id, resolution, merged)}
        />
      ))}
    </div>
  );
}

export default SyncConflictPanel;
