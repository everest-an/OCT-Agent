/**
 * KanbanCardStream — an expandable card showing a single mission step plus
 * the live agent delta stream when expanded.
 *
 * Visual:
 *   [agent avatar] [title]                       [status pill] [▼/▲ chevron]
 *   [optional tool chips row when expanded]
 *   [<pre> live stdout stream, auto-scrolling]
 *
 * Streaming:
 *   - The parent pumps the latest chunk into `streamText` on every render.
 *   - If the user scrolls up, we pause auto-scroll until they reach the bottom
 *     again — prevents "pulled away" frustration during long outputs.
 *   - If the step is done/failed, we stop auto-scrolling and let the user
 *     read the final artifact path.
 *
 * Presentational only — parent owns expansion state and IPC plumbing.
 */

import { useEffect, useRef, useState } from 'react';

function formatElapsedSec(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '';
  if (sec < 60) return `${Math.floor(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m ${s}s`;
}
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Loader2,
  XCircle,
} from 'lucide-react';
import AgentAvatar from '../AgentAvatar';
import type { MissionSnapshotStep, MissionSnapshotStepStatus } from '../../types/electron';
import type { TranslateFunc } from '../../lib/i18n';

export interface KanbanCardStreamProps {
  readonly step: MissionSnapshotStep;
  readonly streamText?: string;
  readonly toolEvents?: ReadonlyArray<{ toolName: string; status: string }>;
  readonly expanded?: boolean;
  readonly onToggleExpand?: () => void;
  readonly onReadArtifact?: () => void;
  readonly t?: TranslateFunc;
}

const STATUS_PILL: Record<MissionSnapshotStepStatus, { label: string; cls: string; Icon: any }> = {
  waiting: { label: 'Waiting',  cls: 'bg-slate-700/50 text-slate-300', Icon: Clock },
  running: { label: 'Running',  cls: 'bg-sky-600/20 text-sky-300',     Icon: Loader2 },
  retrying:{ label: 'Retrying', cls: 'bg-amber-600/20 text-amber-300', Icon: Loader2 },
  done:    { label: 'Done',     cls: 'bg-emerald-600/20 text-emerald-300', Icon: CheckCircle2 },
  failed:  { label: 'Failed',   cls: 'bg-red-600/20 text-red-300',     Icon: XCircle },
  skipped: { label: 'Skipped',  cls: 'bg-slate-600/20 text-slate-400', Icon: Clock },
};

export default function KanbanCardStream({
  step,
  streamText,
  toolEvents,
  expanded,
  onToggleExpand,
  onReadArtifact,
  t,
}: KanbanCardStreamProps) {
  const tr = t ?? ((_k: string, fallback?: string) => fallback ?? _k);
  const pillInfo = STATUS_PILL[step.status] ?? STATUS_PILL.waiting;
  const Icon = pillInfo.Icon;

  const preRef = useRef<HTMLPreElement>(null);
  const [autoStick, setAutoStick] = useState(true);

  // Elapsed-time ticker for running/retrying steps with no stream yet, so the
  // user can see the wait is progressing (not dead).
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (step.status !== 'running' && step.status !== 'retrying') {
      setElapsedSec(0);
      return;
    }
    const startedAt = step.startedAt ? Date.parse(step.startedAt) : Date.now();
    const tick = () => setElapsedSec((Date.now() - startedAt) / 1000);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [step.status, step.startedAt]);

  // Keep the stream pinned to the bottom unless the user scrolled up.
  useEffect(() => {
    const el = preRef.current;
    if (!el || !expanded) return;
    if (autoStick && step.status === 'running') {
      el.scrollTop = el.scrollHeight;
    }
  }, [streamText, expanded, step.status, autoStick]);

  // Watch user scroll to detect "pulled away" state.
  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    setAutoStick(pinned);
  };

  return (
    <article
      data-testid={`kanban-card-${step.id}`}
      data-status={step.status}
      className="rounded-lg border border-slate-700/40 bg-slate-800/40 overflow-hidden"
    >
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={!!expanded}
        aria-label={expanded ? tr('missionFlow.kanban.collapse', 'Collapse step') : tr('missionFlow.kanban.expand', 'Expand step')}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-800/80 transition-colors"
      >
        <AgentAvatar
          emoji={(step as any).agentEmoji || ''}
          name={step.agentName || step.agentId}
          size={22}
          className="flex-shrink-0"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-slate-100 font-medium truncate">{step.title}</p>
          <p className="text-[11px] text-slate-400 truncate">
            {step.agentName || step.agentId} · {step.role}
          </p>
        </div>

        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${pillInfo.cls}`}
          data-testid={`kanban-card-${step.id}-status`}
        >
          <Icon size={11} className={step.status === 'running' || step.status === 'retrying' ? 'animate-spin' : ''} />
          {tr(`missionFlow.status.${step.status}`, pillInfo.label)}
          {(step.status === 'running' || step.status === 'retrying') && elapsedSec > 3 && (
            <span className="ml-0.5 text-slate-400 font-normal">· {formatElapsedSec(elapsedSec)}</span>
          )}
        </span>

        {expanded ? (
          <ChevronUp size={16} className="text-slate-400" />
        ) : (
          <ChevronDown size={16} className="text-slate-400" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-slate-700/40">
          {toolEvents && toolEvents.length > 0 && (
            <ul
              data-testid={`kanban-card-${step.id}-tools`}
              className="flex flex-wrap gap-1.5 px-3 py-2 border-b border-slate-700/30 bg-slate-900/40"
            >
              {toolEvents.map((e, i) => (
                <li
                  key={`${e.toolName}-${i}`}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-slate-700/60 text-slate-200"
                >
                  <span>{toolIcon(e.toolName)}</span>
                  <span>{e.toolName}</span>
                  <span className="text-slate-400">· {e.status}</span>
                </li>
              ))}
            </ul>
          )}

          <pre
            ref={preRef}
            onScroll={onScroll}
            data-testid={`kanban-card-${step.id}-stream`}
            className="max-h-64 overflow-auto px-3 py-2 text-[12px] leading-5 text-slate-300 bg-slate-950/70 whitespace-pre-wrap font-mono"
          >
            {streamText && streamText.length > 0
              ? streamText
              : placeholderFor(step.status, tr, elapsedSec)}
            {step.status === 'running' && (
              <span aria-hidden className="inline-block w-1.5 h-3 ml-0.5 align-middle bg-sky-300 animate-pulse" />
            )}
          </pre>

          {step.status === 'running' && !streamText && elapsedSec > 10 && (
            <div
              data-testid={`kanban-card-${step.id}-wait`}
              className="px-3 py-1.5 border-t border-slate-700/30 bg-slate-900/40 text-[11px] text-slate-400"
            >
              {elapsedSec > 60
                ? tr(
                    'missionFlow.kanban.waitLong',
                    `⏳ Agent still thinking · ${formatElapsedSec(elapsedSec)} elapsed · large tasks may take a few minutes`,
                  ).replace('{elapsed}', formatElapsedSec(elapsedSec))
                : tr(
                    'missionFlow.kanban.waitShort',
                    `⏳ Agent is warming up · ${formatElapsedSec(elapsedSec)} elapsed`,
                  ).replace('{elapsed}', formatElapsedSec(elapsedSec))}
            </div>
          )}

          {step.status === 'failed' && step.errorMessage && (
            <div
              data-testid={`kanban-card-${step.id}-error`}
              className="px-3 py-2 border-t border-red-800/30 bg-red-900/10 text-[12px] text-red-200"
            >
              <strong className="font-semibold">
                {tr('missionFlow.kanban.errorLabel', 'Error')}:
              </strong>{' '}
              {step.errorMessage}
              {step.errorCode ? ` (${step.errorCode})` : ''}
            </div>
          )}

          {step.status === 'done' && step.artifactPath && onReadArtifact && (
            <div className="flex items-center justify-between px-3 py-2 border-t border-slate-700/40 bg-slate-900/40">
              <span className="text-[11px] text-slate-400 truncate">
                {step.artifactPath}
              </span>
              <button
                type="button"
                onClick={onReadArtifact}
                className="px-2 py-1 rounded-md bg-slate-700 hover:bg-slate-600 text-[11px] text-slate-100"
              >
                {tr('missionFlow.kanban.viewArtifact', 'View artifact')}
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function placeholderFor(status: MissionSnapshotStepStatus, t: TranslateFunc, elapsedSec = 0): string {
  if (status === 'waiting') return t('missionFlow.kanban.waiting', 'Waiting for previous step…');
  if (status === 'running') {
    if (elapsedSec > 10) {
      // Once we've waited >10s without a token, show a more reassuring message.
      return t('missionFlow.kanban.warming', 'Agent is working on it — first tokens will appear here…');
    }
    return t('missionFlow.kanban.starting', 'Starting…');
  }
  if (status === 'done') return t('missionFlow.kanban.noOutput', '(No output captured)');
  if (status === 'failed') return '';
  if (status === 'retrying') return t('missionFlow.kanban.retrying', 'Retrying…');
  return '';
}

function toolIcon(name: string): string {
  if (!name) return '🔧';
  if (/read|open|view/i.test(name)) return '📖';
  if (/write|create/i.test(name)) return '📝';
  if (/edit|patch|modify/i.test(name)) return '✏️';
  if (/bash|shell|exec|run/i.test(name)) return '💻';
  if (/search|find|grep/i.test(name)) return '🔍';
  if (/mcp|awareness|memory/i.test(name)) return '🧠';
  return '🔧';
}
