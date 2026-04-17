/**
 * MissionFlowShell — the complete Mission Flow surface (input + preview +
 * kanban) glued together via the useMissionFlow hook. Designed to be embedded
 * into the Dashboard or TaskCenter without further state management.
 *
 * Stages:
 *   idle                → MissionComposer visible, rest hidden
 *   planning            → composer hidden, PlanPreview shows streaming tokens
 *   preview             → composer hidden, PlanPreview shows approve/cancel
 *   running/done/failed → composer hidden, PlanPreview shows summary,
 *                         KanbanCardStream list shows each step
 *
 * The "New mission" button resets the state so the user can start another.
 */

import { useCallback, useState } from 'react';
import PlanPreview from './PlanPreview';
import KanbanCardStream from './KanbanCardStream';
import MissionComposer from './MissionComposer';
import { useMissionFlow } from './useMissionFlow';
import type { TranslateFunc } from '../../lib/i18n';

export interface MissionFlowShellProps {
  readonly t?: TranslateFunc;
  readonly defaultWorkDir?: string;
  readonly onReadArtifact?: (missionId: string, stepId: string) => void;
}

export default function MissionFlowShell({
  t,
  defaultWorkDir,
  onReadArtifact,
}: MissionFlowShellProps) {
  const tr = t ?? ((_k: string, fallback?: string) => fallback ?? _k);
  const { state, actions } = useMissionFlow();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const handleCreate = useCallback(async (goal: string) => {
    setBusy(true);
    try {
      await actions.create(goal, defaultWorkDir ? { workDir: defaultWorkDir } : undefined);
    } finally {
      setBusy(false);
    }
  }, [actions, defaultWorkDir]);

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
    } finally {
      setBusy(false);
    }
  }, [actions]);

  const toggle = (stepId: string) => {
    setExpanded((m) => ({ ...m, [stepId]: !m[stepId] }));
  };

  const composerVisible = state.stage === 'idle';
  const kanbanVisible = (state.stage === 'running' || state.stage === 'done' || state.stage === 'failed') && state.mission != null;

  return (
    <div data-testid="mission-flow-shell" className="space-y-4">
      {composerVisible && (
        <MissionComposer
          busy={busy}
          onSubmit={handleCreate}
          t={tr}
        />
      )}

      <PlanPreview
        stage={state.stage}
        plannerStream={state.plannerStream}
        mission={state.mission}
        error={state.error}
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
          <header className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-slate-200">
              {tr('missionFlow.kanban.title', 'Team Kanban')}
            </h3>
            <button
              type="button"
              onClick={actions.reset}
              data-testid="mission-flow-reset"
              className="text-xs text-slate-400 hover:text-slate-200 underline-offset-2 hover:underline"
            >
              {tr('missionFlow.kanban.newMission', 'New mission')}
            </button>
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
    </div>
  );
}
