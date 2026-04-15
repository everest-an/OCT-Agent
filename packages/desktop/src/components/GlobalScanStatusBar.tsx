import { useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { DAEMON_API_BASE } from './memory/wiki-types';
import type { ScanStatus } from './memory/wiki-types';

/**
 * Global footer bar — Cursor-style. Shows scan state across all tabs when
 * the daemon is reachable AND has scanned at least once. Hidden entirely
 * otherwise (no empty-state noise for first-run users).
 *
 * Data source: GET /api/v1/scan/status. Polls every 2s while scanning,
 * every 30s when idle. Stops polling on network error (daemon offline).
 */

const BUSY_POLL_MS = 2000;
const IDLE_POLL_MS = 30_000;

export function GlobalScanStatusBar() {
  const { t } = useI18n();
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [reachable, setReachable] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    async function tick() {
      try {
        const res = await fetch(`${DAEMON_API_BASE}/scan/status`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ScanStatus | null;
        if (cancelledRef.current) return;
        setReachable(true);
        setStatus(data);
        const busy = Boolean(data && data.status && data.status !== 'idle');
        timerRef.current = setTimeout(tick, busy ? BUSY_POLL_MS : IDLE_POLL_MS);
      } catch {
        if (cancelledRef.current) return;
        setReachable(false);
        // Back off: retry at idle cadence.
        timerRef.current = setTimeout(tick, IDLE_POLL_MS);
      }
    }
    tick();
    return () => {
      cancelledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Hide entirely if daemon unreachable OR has never scanned. First-run users
  // should not see a mysterious footer bar.
  if (!reachable) return null;
  if (!status) return null;
  const neverScanned = !status.status && !status.percent && !status.phase;
  if (neverScanned) return null;

  const busy = status.status && status.status !== 'idle';

  const icon = busy
    ? <Loader2 size={12} className="animate-spin text-sky-400" />
    : <CheckCircle2 size={12} className="text-emerald-400" />;

  const percent = typeof status.percent === 'number' ? Math.min(100, Math.max(0, status.percent)) : null;
  const total = typeof status.total_files === 'number' ? status.total_files : null;
  const current = typeof status.processed_files === 'number' ? status.processed_files : null;
  const embedTotal = typeof status.embed_total === 'number' ? status.embed_total : null;
  const embedDone = typeof status.embed_done === 'number' ? status.embed_done : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 h-7 px-3 border-t border-slate-800 bg-slate-950/90 text-[11px] text-slate-400 select-none"
    >
      {icon}
      {busy ? (
        <>
          <span className="font-medium text-slate-200">
            {status.phase || t('scanBar.scanning')}
          </span>
          {percent !== null && (
            <div className="flex-1 max-w-xs h-1 rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-sky-500/80 transition-all duration-500 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
          {current !== null && total !== null && (
            <span className="text-slate-500 font-mono">
              {current.toLocaleString()} / {total.toLocaleString()}
            </span>
          )}
        </>
      ) : (
        <>
          <span className="text-slate-300">
            {t('scanBar.synced')}
          </span>
          {total !== null && total > 0 && (
            <span className="text-slate-500 font-mono">
              {total.toLocaleString()} {t('scanBar.files')}
            </span>
          )}
          {embedTotal !== null && embedDone !== null && embedTotal > 0 && embedDone < embedTotal && (
            <span className="text-slate-500 font-mono">
              {t('scanBar.embedding')} {embedDone}/{embedTotal}
            </span>
          )}
          <span className="flex-1" />
        </>
      )}
    </div>
  );
}
