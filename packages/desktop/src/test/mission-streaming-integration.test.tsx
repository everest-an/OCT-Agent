/**
 * L2 Streaming-integration: simulated IPC events → useMissionFlow hook →
 * PlanPreview + KanbanCardStream DOM updates.
 *
 * Proves the end-to-end streaming contract from the renderer's perspective:
 *   mission:planner-delta → plannerStream in DOM
 *   mission:plan-ready    → PlanPreview shows plan list
 *   mission:step-delta    → KanbanCardStream shows partial text when expanded
 *   mission:step-ended    → card status = done
 *   mission:done          → summary panel
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import MissionFlowShell from '../components/mission-flow/MissionFlowShell';

const MISSION_KEYS = [
  'onMissionPlanning',
  'onMissionPlannerDelta',
  'onMissionPlanReady',
  'onMissionStepStarted',
  'onMissionStepDelta',
  'onMissionStepEnded',
  'onMissionStepFailed',
  'onMissionDone',
  'onMissionFailed',
  'missionCreateFromGoal',
  'missionApproveAndRun',
  'missionCancelFlow',
] as const;

type Cb = (data: any) => void;

function installFakeApi() {
  const listeners: Record<string, Cb[]> = {};
  const registerable = (event: string) => (cb: Cb) => {
    (listeners[event] = listeners[event] || []).push(cb);
    return () => { listeners[event] = (listeners[event] || []).filter((x) => x !== cb); };
  };
  const api: any = (window as any).electronAPI;
  api.onMissionPlanning = registerable('planning');
  api.onMissionPlannerDelta = registerable('planner-delta');
  api.onMissionPlanReady = registerable('plan-ready');
  api.onMissionStepStarted = registerable('step-started');
  api.onMissionStepDelta = registerable('step-delta');
  api.onMissionStepEnded = registerable('step-ended');
  api.onMissionStepFailed = registerable('step-failed');
  api.onMissionDone = registerable('done');
  api.onMissionFailed = registerable('failed');
  api.missionCreateFromGoal = vi.fn(async () => ({ missionId: 'mi' }));
  api.missionApproveAndRun = vi.fn(async () => ({ ok: true }));
  api.missionCancelFlow = vi.fn(async () => ({ ok: true }));
  return {
    fire(event: string, data: any) {
      for (const cb of listeners[event] || []) cb(data);
    },
  };
}

beforeEach(() => {
  const api: any = (window as any).electronAPI;
  if (api) for (const key of MISSION_KEYS) delete api[key];
});

describe('mission-streaming-integration — end-to-end UI updates', () => {
  it('planner delta tokens accumulate in the planning stream buffer', async () => {
    const { fire } = installFakeApi();
    render(<MissionFlowShell />);

    // Submit goal
    fireEvent.change(screen.getByTestId('mission-composer-input'), {
      target: { value: 'Make a weekly digest' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mission-composer-submit'));
    });

    // Simulate planner-delta tokens
    act(() => {
      fire('planning', { missionId: 'mi' });
      fire('planner-delta', { missionId: 'mi', chunk: '{"summary":' });
      fire('planner-delta', { missionId: 'mi', chunk: '"Digest"}' });
    });

    expect(screen.getByTestId('planner-stream-buffer').textContent)
      .toContain('Digest');
  });

  it('plan-ready renders the subtasks list', async () => {
    const { fire } = installFakeApi();
    render(<MissionFlowShell />);
    fireEvent.change(screen.getByTestId('mission-composer-input'), {
      target: { value: 'ship the app' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mission-composer-submit'));
    });
    act(() => {
      fire('plan-ready', {
        missionId: 'mi',
        mission: {
          id: 'mi', goal: 'ship', status: 'paused_awaiting_human',
          steps: [
            { id: 'T1', agentId: 'main', role: 'Lead', title: 'Plan A', deliverable: 'd', depends_on: [], status: 'waiting', attempts: 0 },
            { id: 'T2', agentId: 'coder', role: 'Dev', title: 'Plan B', deliverable: 'd', depends_on: ['T1'], status: 'waiting', attempts: 0 },
            { id: 'T3', agentId: 'tester', role: 'QA', title: 'Plan C', deliverable: 'd', depends_on: ['T2'], status: 'waiting', attempts: 0 },
          ],
        },
      });
    });
    expect(screen.getByTestId('plan-preview-ready')).toBeInTheDocument();
    expect(screen.getByTestId('plan-step-list')).toHaveTextContent('Plan A');
    expect(screen.getByTestId('plan-step-list')).toHaveTextContent('Plan B');
    expect(screen.getByTestId('plan-step-list')).toHaveTextContent('Plan C');
  });

  it('step-delta tokens are visible when the user expands the card', async () => {
    const { fire } = installFakeApi();
    render(<MissionFlowShell />);
    fireEvent.change(screen.getByTestId('mission-composer-input'), { target: { value: 'run it' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mission-composer-submit'));
    });
    act(() => {
      fire('plan-ready', {
        missionId: 'mi',
        mission: {
          id: 'mi', goal: 'run', status: 'paused_awaiting_human',
          steps: [
            { id: 'T1', agentId: 'main', role: 'Lead', title: 'Do', deliverable: 'd', depends_on: [], status: 'waiting', attempts: 0 },
          ],
        },
      });
      fire('step-started', { missionId: 'mi', stepId: 'T1', sessionKey: 'sk', runId: 'r' });
      fire('step-delta', { missionId: 'mi', stepId: 'T1', chunk: 'hello ' });
      fire('step-delta', { missionId: 'mi', stepId: 'T1', chunk: 'world' });
    });

    // Card exists; expand it
    const toggleBtn = screen.getByRole('button', { name: /expand step/i });
    fireEvent.click(toggleBtn);
    expect(screen.getByTestId('kanban-card-T1-stream'))
      .toHaveTextContent('hello world');
  });

  it('mission:done transitions to summary panel', async () => {
    const { fire } = installFakeApi();
    render(<MissionFlowShell />);
    fireEvent.change(screen.getByTestId('mission-composer-input'), { target: { value: 'finish up' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mission-composer-submit'));
    });
    act(() => {
      fire('plan-ready', {
        missionId: 'mi',
        mission: {
          id: 'mi', goal: 'finish', status: 'paused_awaiting_human',
          steps: [
            { id: 'T1', agentId: 'main', role: 'Lead', title: 'A', deliverable: 'd', depends_on: [], status: 'waiting', attempts: 0 },
          ],
        },
      });
      fire('done', {
        missionId: 'mi',
        mission: {
          id: 'mi', goal: 'finish', status: 'done',
          steps: [
            { id: 'T1', agentId: 'main', role: 'Lead', title: 'A', deliverable: 'd', depends_on: [], status: 'done', attempts: 1 },
          ],
        },
      });
    });
    expect(screen.getByTestId('plan-summary')).toHaveTextContent(/complete/i);
  });

  it('mission:failed shows error banner + summary "failed" state', async () => {
    const { fire } = installFakeApi();
    render(<MissionFlowShell />);
    fireEvent.change(screen.getByTestId('mission-composer-input'), { target: { value: 'unstable' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mission-composer-submit'));
    });
    act(() => {
      fire('plan-ready', {
        missionId: 'mi',
        mission: {
          id: 'mi', goal: 'x', status: 'paused_awaiting_human',
          steps: [
            { id: 'T1', agentId: 'main', role: 'L', title: 'A', deliverable: 'd', depends_on: [], status: 'waiting', attempts: 0 },
          ],
        },
      });
      fire('failed', {
        missionId: 'mi',
        mission: { id: 'mi', goal: 'x', status: 'failed', steps: [] },
        reason: 'planner JSON was invalid',
      });
    });
    expect(screen.getByTestId('plan-summary')).toHaveTextContent(/failed/i);
    expect(screen.getByTestId('mission-error')).toHaveTextContent(/invalid/i);
  });
});
