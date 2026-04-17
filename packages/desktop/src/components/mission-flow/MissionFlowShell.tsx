/**
 * MissionFlowShell — the complete Mission Flow surface.
 *
 * Layout (top → bottom):
 *   [MissionComposer]  workDir picker + team preview + big goal box
 *   [PlanPreview]      planning stream / preview / running/done/failed summary
 *   [Kanban cards]     one KanbanCardStream per mission step (during/after run)
 *   [History list]     all persisted missions from ~/.awarenessclaw/missions/
 *
 * Each block is controlled by `useMissionFlow.state.stage`:
 *   idle                 → composer visible, history visible
 *   planning / preview   → composer hidden, preview panel live
 *   running / done / ...→ preview shows summary, kanban expanded
 *
 * Tab-remount resilience: `useMissionFlow` restores `activeMissionId` from
 * localStorage on mount, so the kanban re-appears after the user switches
 * sidebar tabs and returns.
 */

import { useCallback, useEffect, useState } from 'react';
import { Square } from 'lucide-react';
import PlanPreview from './PlanPreview';
import KanbanCardStream from './KanbanCardStream';
import MissionComposer, { type MissionComposerAgent } from './MissionComposer';
import MissionHistoryList from './MissionHistoryList';
import { useMissionFlow } from './useMissionFlow';
import { friendlyErrorMessage } from './friendly-errors';
import type { TranslateFunc } from '../../lib/i18n';

export interface MissionFlowShellProps {
  readonly t?: TranslateFunc;
  /**
   * Initial work directory (e.g. from localStorage). Parent handles the
   * native folder picker and feeds the updated path back via onWorkDirChange.
   */
  readonly workDir?: string;
  readonly onPickWorkDir?: () => void | Promise<void>;
  readonly onClearWorkDir?: () => void;
  readonly agents?: readonly MissionComposerAgent[];
  readonly onManageAgents?: () => void;
  readonly onReadArtifact?: (missionId: string, stepId: string) => void;
  readonly defaultModel?: string | null;
}

export default function MissionFlowShell({
  t,
  workDir,
  onPickWorkDir,
  onClearWorkDir,
  agents,
  onManageAgents,
  onReadArtifact,
  defaultModel,
}: MissionFlowShellProps) {
  const tr = t ?? ((_k: string, fallback?: string) => fallback ?? _k);
  const { state, actions } = useMissionFlow();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [historyRefresh, setHistoryRefresh] = useState(0);

  // Auto-expand the running step so the user sees live streaming.
  useEffect(() => {
    if (!state.mission) return;
    const running = state.mission.steps.find((s) => s.status === 'running');
    if (running) {
      setExpanded((prev) => prev[running.id] ? prev : { ...prev, [running.id]: true });
    }
  }, [state.mission]);

  // Refresh history list whenever a mission finishes or is cleared.
  useEffect(() => {
    if (state.stage === 'done' || state.stage === 'failed' || state.stage === 'idle') {
      setHistoryRefresh((n) => n + 1);
    }
  }, [state.stage]);

  const handleCreate = useCallback(async (goal: string) => {
    setBusy(true);
    try {
      await actions.create(goal, {
        workDir: workDir || undefined,
        agents: agents?.map((a) => ({ id: a.id, name: a.name, role: a.role, emoji: a.emoji })),
      });
      setHistoryRefresh((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }, [actions, workDir, agents]);

  const handleApprove = useCallback(async () => {
    setBusy(true);
    try {
      await actions.approve();
    } finally {
      setBusy(false);
    }
  }, [actions]);

  const handleCancel = useCallback(async () => {
    setBusy(true);
    try {
      await actions.cancel();
      actions.reset();
      setHistoryRefresh((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }, [actions]);

  const handleReset = useCallback(() => {
    actions.reset();
    setHistoryRefresh((n) => n + 1);
  }, [actions]);

  const handleReopen = useCallback(async (id: string) => {
    try {
      await actions.reopen(id);
    } catch {
      // swallow — user can hit again or check logs
    }
  }, [actions]);

  const handleDelete = useCallback(async (id: string) => {
    const api: any = typeof window !== 'undefined' ? (window as any).electronAPI : null;
    if (!api?.missionDelete) return;
    try {
      await api.missionDelete(id);
      if (state.missionId === id) actions.reset();
      setHistoryRefresh((n) => n + 1);
    } catch { /* ignore */ }
  }, [actions, state.missionId]);

  const toggle = (stepId: string) => {
    setExpanded((m) => ({ ...m, [stepId]: !m[stepId] }));
  };

  const composerVisible = state.stage === 'idle';
  const kanbanVisible =
    (state.stage === 'running' || state.stage === 'done' || state.stage === 'failed') &&
    state.mission != null;
  const historyVisible = state.stage === 'idle';

  const friendlyError = state.error
    ? friendlyErrorMessage({ raw: state.error }, tr)
    : null;

  return (
    <div data-testid="mission-flow-shell" className="space-y-4">
      {composerVisible && (
        <MissionComposer
          busy={busy}
          onSubmit={handleCreate}
          t={tr}
          workDir={workDir}
          onPickWorkDir={onPickWorkDir}
          onClearWorkDir={onClearWorkDir}
          agents={agents}
          onManageAgents={onManageAgents}
          defaultModel={defaultModel}
        />
      )}

      <PlanPreview
        stage={state.stage}
        plannerStream={state.plannerStream}
        mission={state.mission}
        error={friendlyError}
        busy={busy}
        onApprove={handleApprove}
        onCancel={handleCancel}
        t={tr}
      />

      {kanbanVisible && state.mission && (
        <section
          data-testid="mission-kanban"
          aria-label={tr('missionFlow.kanban.title', 'Team Kanban')}
          className="space-y-2"
        >
          <header className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-slate-200">
              {tr('missionFlow.kanban.title', 'Team Kanban')}
            </h3>
            <div className="flex items-center gap-2">
              {state.stage === 'running' && (
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={busy}
                  data-testid="mission-flow-stop"
                  aria-label={tr('missionFlow.kanban.stop', 'Stop mission')}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-red-200 bg-red-900/30 hover:bg-red-900/50 border border-red-700/40 disabled:opacity-50"
                >
                  <Square size={12} fill="currentColor" />
                  {tr('missionFlow.kanban.stop', 'Stop')}
                </button>
              )}
              <button
                type="button"
                onClick={handleReset}
                data-testid="mission-flow-reset"
                className="text-xs text-slate-400 hover:text-slate-200 underline-offset-2 hover:underline"
              >
                {tr('missionFlow.kanban.newMission', 'New mission')}
              </button>
            </div>
          </header>
          <div className="space-y-2">
            {state.mission.steps.map((step) => (
              <KanbanCardStream
                key={step.id}
                step={step}
                streamText={state.stepStream[step.id] ?? ''}
                expanded={!!expanded[step.id]}
                onToggleExpand={() => toggle(step.id)}
                onReadArtifact={
                  onReadArtifact && step.artifactPath
                    ? () => onReadArtifact(state.mission!.id, step.id)
                    : undefined
                }
                t={tr}
              />
            ))}
          </div>
        </section>
      )}

      {historyVisible && (
        <MissionHistoryList
          t={tr}
          refreshKey={historyRefresh}
          onReopen={handleReopen}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
