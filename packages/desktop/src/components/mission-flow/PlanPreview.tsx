/**
 * PlanPreview — shows the Planner's live output and the resulting plan so the
 * user can approve / edit / cancel before worker execution begins.
 *
 * States handled:
 *   - no mission yet         → render nothing
 *   - planning (streaming)   → live <pre> buffer with shimmering cursor
 *   - preview (plan ready)   → subtasks table + Approve / Edit / Cancel
 *   - running / done / failed → compact summary (Kanban below takes over)
 *
 * Kept presentational: parent owns the useMissionFlow hook and passes props.
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, Loader2, Pencil, XCircle, PlayCircle } from 'lucide-react';
import AgentAvatar from '../AgentAvatar';
import type { MissionSnapshot } from '../../types/electron';
import type { MissionFlowStage } from './useMissionFlow';
import type { TranslateFunc } from '../../lib/i18n';

interface PlanPreviewProps {
  readonly stage: MissionFlowStage;
  readonly plannerStream: string;
  readonly mission: MissionSnapshot | null;
  readonly error?: string | null;
  readonly busy?: boolean;
  readonly onApprove: () => void;
  readonly onCancel: () => void;
  readonly onEditPlan?: (editedJson: string) => void;
  readonly t?: TranslateFunc;
}

export default function PlanPreview({
  stage,
  plannerStream,
  mission,
  error,
  busy,
  onApprove,
  onCancel,
  onEditPlan,
  t,
}: PlanPreviewProps) {
  const tr = t ?? ((_k: string, fallback?: string) => fallback ?? _k);
  const showPlanner = stage === 'planning';
  const showPreview = stage === 'preview' && mission != null;
  const showSummary = (stage === 'running' || stage === 'done' || stage === 'failed') && mission != null;

  if (!showPlanner && !showPreview && !showSummary) return null;

  return (
    <section
      aria-label="Mission plan preview"
      className="rounded-xl border border-slate-700/50 bg-slate-900/40 p-4 space-y-4"
    >
      {showPlanner && (
        <PlannerStreamPanel
          plannerStream={plannerStream}
          busy={busy}
          onCancel={onCancel}
          t={tr}
        />
      )}

      {showPreview && mission && (
        <PlanReadyPanel
          mission={mission}
          busy={busy}
          onApprove={onApprove}
          onCancel={onCancel}
          onEditPlan={onEditPlan}
          t={tr}
        />
      )}

      {showSummary && mission && (
        <PlanSummaryPanel mission={mission} stage={stage} t={tr} />
      )}

      {error && (
        <div
          data-testid="mission-error"
          className="rounded-lg border border-red-600/40 bg-red-900/20 p-3 text-sm text-red-200"
        >
          {tr('missionFlow.error', 'Something went wrong.')} {error}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sub-panels
// ---------------------------------------------------------------------------

function PlannerStreamPanel({
  plannerStream,
  busy,
  onCancel,
  t,
}: {
  plannerStream: string;
  busy?: boolean;
  onCancel: () => void;
  t: TranslateFunc;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [plannerStream]);

  return (
    <div data-testid="plan-preview-planning" className="space-y-2">
      <header className="flex items-center gap-2 text-sm text-slate-200">
        <Loader2 size={16} className="animate-spin text-amber-400" />
        <span className="flex-1">{t('missionFlow.planner.streaming', 'Planner is drafting your plan…')}</span>
        <button
          type="button"
          data-testid="planner-cancel"
          onClick={onCancel}
          disabled={busy}
          aria-label={t('missionFlow.planner.cancel', 'Cancel planning')}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700/60 disabled:opacity-50"
        >
          <ArrowLeft size={12} />
          {t('missionFlow.planner.cancel', 'Cancel')}
        </button>
      </header>
      <pre
        ref={preRef}
        data-testid="planner-stream-buffer"
        className="max-h-56 overflow-auto rounded-md bg-slate-950/70 p-3 text-[13px] leading-5 text-slate-300 whitespace-pre-wrap font-mono"
      >
        {plannerStream || t('missionFlow.planner.waiting', 'Thinking…')}
        <span aria-hidden className="inline-block w-1.5 h-4 ml-0.5 align-middle bg-amber-300 animate-pulse" />
      </pre>
    </div>
  );
}

function PlanReadyPanel({
  mission,
  busy,
  onApprove,
  onCancel,
  onEditPlan,
  t,
}: {
  mission: MissionSnapshot;
  busy?: boolean;
  onApprove: () => void;
  onCancel: () => void;
  onEditPlan?: (json: string) => void;
  t: TranslateFunc;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(
    { summary: 'Plan', subtasks: mission.steps.map(stepToSubtask) },
    null,
    2,
  ));

  return (
    <div data-testid="plan-preview-ready" className="space-y-3">
      <header className="flex items-start gap-3">
        <div className="mt-1 w-8 h-8 rounded-full bg-emerald-500/10 flex items-center justify-center">
          <CheckCircle2 size={18} className="text-emerald-400" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold text-slate-100">
            {t('missionFlow.preview.title', "Here's the plan. Ready to run?")}
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            {t(
              'missionFlow.preview.subtitle',
              'Review each step below. Click "Let\'s go" to start, or adjust the plan first.',
            )}
          </p>
        </div>
      </header>

      {editing ? (
        <div className="space-y-2">
          <textarea
            data-testid="plan-edit-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={12}
            className="w-full rounded-md bg-slate-950 border border-slate-700/50 p-2 text-xs font-mono text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
          />
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              className="px-3 py-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-xs text-slate-100"
              onClick={() => setEditing(false)}
            >
              {t('missionFlow.edit.cancel', 'Cancel edit')}
            </button>
            <button
              type="button"
              className="px-3 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-xs text-white"
              onClick={() => {
                onEditPlan?.(draft);
                setEditing(false);
              }}
            >
              {t('missionFlow.edit.save', 'Save edits')}
            </button>
          </div>
        </div>
      ) : (
        <ol data-testid="plan-step-list" className="space-y-2 text-sm">
          {mission.steps.map((step, i) => (
            <li
              key={step.id}
              className="flex items-start gap-3 rounded-lg border border-slate-700/40 bg-slate-800/40 p-3"
            >
              <span className="text-xs font-mono text-slate-500 mt-1 w-6 flex-shrink-0">
                {i + 1}.
              </span>
              <AgentAvatar
                emoji={(step as any).agentEmoji || ''}
                name={step.agentName || step.agentId}
                size={24}
                className="flex-shrink-0"
              />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-slate-100 leading-tight">{step.title}</p>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  <span className="font-medium text-slate-300">{step.agentName || step.agentId}</span>
                  {' · '}
                  {step.role}
                  {typeof step.expectedDurationMinutes === 'number'
                    ? ` · ~${step.expectedDurationMinutes} min`
                    : ''}
                </p>
                <p className="text-[11px] text-slate-500 mt-1 line-clamp-2">{step.deliverable}</p>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          aria-label={t('missionFlow.preview.cancel', 'Cancel')}
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-2 rounded-md bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-sm text-slate-100 inline-flex items-center gap-1.5"
        >
          <XCircle size={16} /> {t('missionFlow.preview.cancel', 'Cancel')}
        </button>
        {onEditPlan && !editing && (
          <button
            type="button"
            aria-label={t('missionFlow.preview.edit', 'Edit plan')}
            onClick={() => setEditing(true)}
            className="px-4 py-2 rounded-md bg-slate-700 hover:bg-slate-600 text-sm text-slate-100 inline-flex items-center gap-1.5"
          >
            <Pencil size={16} /> {t('missionFlow.preview.edit', 'Edit plan')}
          </button>
        )}
        <button
          type="button"
          aria-label={t('missionFlow.preview.approve', "Let's go")}
          onClick={onApprove}
          disabled={busy}
          className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-medium text-white inline-flex items-center gap-1.5"
        >
          {busy
            ? <Loader2 size={16} className="animate-spin" />
            : <PlayCircle size={16} />}
          {t('missionFlow.preview.approve', "Let's go ✨")}
        </button>
      </div>
    </div>
  );
}

function PlanSummaryPanel({
  mission,
  stage,
  t,
}: {
  mission: MissionSnapshot;
  stage: MissionFlowStage;
  t: TranslateFunc;
}) {
  const totalSteps = mission.steps.length;
  const done = mission.steps.filter((s) => s.status === 'done').length;
  const failed = mission.steps.filter((s) => s.status === 'failed').length;
  const label =
    stage === 'done' ? t('missionFlow.summary.done', 'Mission complete')
    : stage === 'failed' ? t('missionFlow.summary.failed', 'Mission failed')
    : t('missionFlow.summary.running', 'Mission in progress');

  const icon =
    stage === 'done' ? <CheckCircle2 size={18} className="text-emerald-400" />
    : stage === 'failed' ? <XCircle size={18} className="text-red-400" />
    : <Loader2 size={18} className="animate-spin text-sky-400" />;

  return (
    <div data-testid="plan-summary" className="flex items-center gap-3 text-sm">
      {icon}
      <div className="flex-1">
        <p className="text-slate-100 font-medium">{label}</p>
        <p className="text-xs text-slate-400">
          {done}/{totalSteps} {t('missionFlow.summary.stepsDone', 'steps done')}
          {failed > 0 ? ` · ${failed} ${t('missionFlow.summary.stepsFailed', 'failed')}` : ''}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers (kept inline to avoid an extra file)
// ---------------------------------------------------------------------------

function stepToSubtask(s: MissionSnapshot['steps'][number]) {
  return {
    id: s.id,
    agentId: s.agentId,
    role: s.role,
    title: s.title,
    deliverable: s.deliverable,
    expectedDurationMinutes: s.expectedDurationMinutes,
    model: s.model,
    depends_on: s.depends_on,
  };
}
