/**
 * MissionHistoryList — shows persisted missions from ~/.awarenessclaw/missions/
 * so users can revisit their team-task kanbans after tab-switching or app-restart.
 *
 * Data source: `window.electronAPI.missionList()` (IPC → file-layout.listMissions).
 *
 * Interactions:
 *   - Click a card → calls `onReopen(missionId)`; parent flips Mission Flow
 *     stage based on mission.status (preview / running / done / failed).
 *   - Delete button → confirms then calls `onDelete(missionId)`.
 *
 * Fail-safe: if electronAPI is unavailable (e.g. unit-test without preload),
 * renders nothing — components in the tree keep rendering.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  Clock,
  Loader2,
  Trash2,
  XCircle,
} from 'lucide-react';
import AgentAvatar from '../AgentAvatar';
import type { MissionSnapshot, MissionSnapshotStatus } from '../../types/electron';
import type { TranslateFunc } from '../../lib/i18n';

export interface MissionHistoryListProps {
  readonly t?: TranslateFunc;
  readonly refreshKey?: number;
  readonly onReopen?: (missionId: string) => void;
  readonly onDelete?: (missionId: string) => void | Promise<void>;
}

const STATUS_META: Record<MissionSnapshotStatus, { label: string; cls: string; Icon: any }> = {
  planning: { label: 'Planning',  cls: 'text-amber-300', Icon: Loader2 },
  running:  { label: 'Running',   cls: 'text-sky-300',   Icon: Loader2 },
  paused:   { label: 'Paused',    cls: 'text-slate-300', Icon: Clock },
  paused_awaiting_human: { label: 'Awaiting approval', cls: 'text-amber-300', Icon: Clock },
  done:     { label: 'Done',      cls: 'text-emerald-300', Icon: CheckCircle2 },
  failed:   { label: 'Failed',    cls: 'text-red-300',   Icon: XCircle },
};

export default function MissionHistoryList({
  t,
  refreshKey,
  onReopen,
  onDelete,
}: MissionHistoryListProps) {
  const tr = t ?? ((_k: string, fallback?: string) => fallback ?? _k);
  const [list, setList] = useState<MissionSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api: any = typeof window !== 'undefined' ? (window as any).electronAPI : null;
    if (!api?.missionList) {
      setList([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const res = await api.missionList();
      // Sort newest first (already sorted by IPC handler but belt-and-suspenders).
      const sorted = Array.isArray(res)
        ? [...res].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        : [];
      setList(sorted);
      setFetchError(null);
    } catch (err: any) {
      setFetchError(err?.message || String(err));
      setList([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  const handleDelete = useCallback(async (id: string) => {
    if (!onDelete) return;
    if (typeof window !== 'undefined'
      && typeof (window as any).confirm === 'function'
      && !(window as any).confirm(tr('missionFlow.history.confirmDelete', 'Delete this mission? Artifacts will be removed.'))) {
      return;
    }
    await onDelete(id);
    await refresh();
  }, [onDelete, refresh, tr]);

  if (loading && list.length === 0) return null;
  if (!loading && list.length === 0 && !fetchError) return null;

  return (
    <section
      data-testid="mission-history-list"
      aria-label={tr('missionFlow.history.title', 'Past missions')}
      className="space-y-2"
    >
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-200">
          📜 {tr('missionFlow.history.title', 'Past missions')}
        </h3>
        <span className="text-[11px] text-slate-500">
          {tr('missionFlow.history.count', 'items')}: {list.length}
        </span>
      </header>

      {fetchError && (
        <p data-testid="mission-history-error" className="text-xs text-red-300">
          {tr('missionFlow.history.loadError', 'Could not load history.')} {fetchError}
        </p>
      )}

      <ul className="space-y-1.5">
        {list.map((m) => {
          const meta = STATUS_META[m.status] ?? STATUS_META.done;
          const Icon = meta.Icon;
          const animate = (m.status === 'running' || m.status === 'planning') ? 'animate-spin' : '';
          const doneSteps = m.steps.filter((s) => s.status === 'done').length;
          const totalSteps = m.steps.length;
          const duration = computeDuration(m);
          return (
            <li key={m.id}>
              <div
                data-testid={`mission-history-${m.id}`}
                className="group relative flex items-start gap-3 rounded-lg border border-slate-700/40 bg-slate-800/30 hover:bg-slate-800/60 p-3 cursor-pointer"
                onClick={() => onReopen?.(m.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') onReopen?.(m.id); }}
                role="button"
                tabIndex={0}
              >
                <Icon size={16} className={`mt-0.5 ${meta.cls} ${animate}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-100 font-medium truncate">{m.goal}</p>
                  <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-400">
                    <span className={meta.cls}>
                      {tr(`missionFlow.status.${m.status}`, meta.label)}
                    </span>
                    {totalSteps > 0 && (
                      <span className="text-slate-500">·</span>
                    )}
                    {totalSteps > 0 && (
                      <span>{doneSteps}/{totalSteps} {tr('missionFlow.history.steps', 'steps')}</span>
                    )}
                    {duration && (
                      <>
                        <span className="text-slate-500">·</span>
                        <span>{duration}</span>
                      </>
                    )}
                  </div>
                  {/* Agent avatar row */}
                  {m.steps.length > 0 && (
                    <ul className="flex items-center gap-1 mt-1.5">
                      {uniqueAgents(m).slice(0, 6).map((a) => (
                        <li key={a.id}>
                          <AgentAvatar
                            name={a.name || a.id}
                            emoji={a.emoji || ''}
                            size={16}
                          />
                        </li>
                      ))}
                      {uniqueAgents(m).length > 6 && (
                        <li className="text-[10px] text-slate-500">+{uniqueAgents(m).length - 6}</li>
                      )}
                    </ul>
                  )}
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {onDelete && (
                    <button
                      type="button"
                      data-testid={`mission-history-${m.id}-delete`}
                      onClick={(e) => { e.stopPropagation(); void handleDelete(m.id); }}
                      aria-label={tr('missionFlow.history.delete', 'Delete')}
                      className="p-1 rounded-md hover:bg-red-900/30 text-slate-400 hover:text-red-300"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                  <ChevronRight size={16} className="text-slate-500" />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AgentLite { id: string; name?: string; emoji?: string; }

function uniqueAgents(m: MissionSnapshot): AgentLite[] {
  const seen = new Set<string>();
  const out: AgentLite[] = [];
  for (const s of m.steps) {
    if (!s?.agentId || seen.has(s.agentId)) continue;
    seen.add(s.agentId);
    out.push({ id: s.agentId, name: s.agentName, emoji: (s as any).agentEmoji });
  }
  return out;
}

function computeDuration(m: MissionSnapshot): string | null {
  if (!m.startedAt) return null;
  const end = m.completedAt ? Date.parse(m.completedAt) : Date.now();
  const start = Date.parse(m.startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const ms = Math.max(0, end - start);
  const totalSec = Math.floor(ms / 1000);
  const m_ = Math.floor(totalSec / 60);
  const s_ = totalSec % 60;
  return m_ > 0 ? `${m_}m ${s_}s` : `${s_}s`;
}
