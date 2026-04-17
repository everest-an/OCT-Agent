/**
 * L2 tests for useMissionFlow — state machine + IPC subscription wiring.
 *
 * We inject fake IPC event handlers by installing them on window.electronAPI
 * BEFORE renderHook, then invoke them to simulate main-process events.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMissionFlow } from '../components/mission-flow/useMissionFlow';

type Cb = (data: any) => void;

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

function installFakeApi() {
  const listeners: Record<string, Cb[]> = {};
  const registerable = (event: string) => (cb: Cb) => {
    (listeners[event] = listeners[event] || []).push(cb);
    return () => {
      listeners[event] = (listeners[event] || []).filter((x) => x !== cb);
    };
  };
  const api: any = (window as any).electronAPI ?? {};
  api.onMissionPlanning = registerable('planning');
  api.onMissionPlannerDelta = registerable('planner-delta');
  api.onMissionPlanReady = registerable('plan-ready');
  api.onMissionStepStarted = registerable('step-started');
  api.onMissionStepDelta = registerable('step-delta');
  api.onMissionStepEnded = registerable('step-ended');
  api.onMissionStepFailed = registerable('step-failed');
  api.onMissionDone = registerable('done');
  api.onMissionFailed = registerable('failed');
  api.missionCreateFromGoal = vi.fn(async (goal: string) => ({ missionId: `m-${goal.slice(0, 4)}` }));
  api.missionApproveAndRun = vi.fn(async () => ({ ok: true }));
  api.missionCancelFlow = vi.fn(async () => ({ ok: true }));

  function fire(event: string, data: any) {
    for (const cb of listeners[event] || []) cb(data);
  }

  return { api, fire };
}

beforeEach(() => {
  const api: any = (window as any).electronAPI;
  if (api) {
    for (const key of MISSION_KEYS) delete api[key];
  }
});

describe('useMissionFlow — state machine', () => {
  it('starts in idle with no mission', () => {
    installFakeApi();
    const { result } = renderHook(() => useMissionFlow());
    expect(result.current.state.stage).toBe('idle');
    expect(result.current.state.missionId).toBeNull();
    expect(result.current.state.mission).toBeNull();
  });

  it('create() transitions to planning and stores missionId', async () => {
    const { api } = installFakeApi();
    const { result } = renderHook(() => useMissionFlow());
    await act(async () => {
      await result.current.actions.create('build a website');
    });
    expect(api.missionCreateFromGoal).toHaveBeenCalledWith('build a website', undefined);
    expect(result.current.state.stage).toBe('planning');
    expect(result.current.state.missionId).toBe('m-buil');
  });

  it('planner-delta events accumulate planner stream text', async () => {
    const { fire } = installFakeApi();
    const { result } = renderHook(() => useMissionFlow());
    await act(async () => {
      await result.current.actions.create('x');
    });
    act(() => {
      fire('planner-delta', { missionId: 'm-x', chunk: '{"summary' });
      fire('planner-delta', { missionId: 'm-x', chunk: '":"Plan"}' });
    });
    expect(result.current.state.plannerStream).toBe('{"summary":"Plan"}');
  });

  it('plan-ready with paused_awaiting_human → preview stage', async () => {
    const { fire } = installFakeApi();
    const { result } = renderHook(() => useMissionFlow());
    await act(async () => {
      await result.current.actions.create('x');
    });
    act(() => {
      fire('plan-ready', {
        missionId: 'm-x',
        mission: { id: 'm-x', status: 'paused_awaiting_human', steps: [], goal: 'x' },
      });
    });
    expect(result.current.state.stage).toBe('preview');
    expect(result.current.state.mission?.id).toBe('m-x');
  });

  it('step-started sets step status to running and transitions to running', async () => {
    const { fire } = installFakeApi();
    const { result } = renderHook(() => useMissionFlow());
    await act(async () => {
      await result.current.actions.create('x');
    });
    act(() => {
      fire('plan-ready', {
        missionId: 'm-x',
        mission: {
          id: 'm-x',
          status: 'paused_awaiting_human',
          goal: 'x',
          steps: [
            { id: 'T1', agentId: 'main', role: 'L', title: 'A', deliverable: 'd', depends_on: [], status: 'waiting', attempts: 0 },
          ],
        },
      });
      fire('step-started', {
        missionId: 'm-x',
        stepId: 'T1',
        sessionKey: 'sk',
        runId: 'rid',
      });
    });
    expect(result.current.state.stage).toBe('running');
    const step = result.current.state.mission!.steps.find((s) => s.id === 'T1')!;
    expect(step.status).toBe('running');
  });

  it('step-delta appends to the per-step buffer', async () => {
    const { fire } = installFakeApi();
    const { result } = renderHook(() => useMissionFlow());
    await act(async () => {
      await result.current.actions.create('x');
    });
    act(() => {
      fire('plan-ready', {
        missionId: 'm-x',
        mission: {
          id: 'm-x',
          status: 'paused_awaiting_human',
          goal: 'x',
          steps: [
            { id: 'T1', agentId: 'main', role: 'L', title: 'A', deliverable: 'd', depends_on: [], status: 'waiting', attempts: 0 },
          ],
        },
      });
      fire('step-started', { missionId: 'm-x', stepId: 'T1', sessionKey: 'sk', runId: 'r' });
      fire('step-delta', { missionId: 'm-x', stepId: 'T1', chunk: 'hello ' });
      fire('step-delta', { missionId: 'm-x', stepId: 'T1', chunk: 'world' });
    });
    expect(result.current.state.stepStream['T1']).toBe('hello world');
  });

  it('step-ended marks step done + preserves artifactPath', async () => {
    const { fire } = installFakeApi();
    const { result } = renderHook(() => useMissionFlow());
    await act(async () => { await result.current.actions.create('x'); });
    act(() => {
      fire('plan-ready', {
        missionId: 'm-x',
        mission: {
          id: 'm-x', status: 'paused_awaiting_human', goal: 'x',
          steps: [{ id: 'T1', agentId: 'main', role: 'L', title: 'A', deliverable: 'd', depends_on: [], status: 'running', attempts: 0 }],
        },
      });
      fire('step-ended', { missionId: 'm-x', stepId: 'T1', artifactPath: 'artifacts/T1.md' });
    });
    const step = result.current.state.mission!.steps.find((s) => s.id === 'T1')!;
    expect(step.status).toBe('done');
    expect(step.artifactPath).toBe('artifacts/T1.md');
  });

  it('step-failed records error code + message', async () => {
    const { fire } = installFakeApi();
    const { result } = renderHook(() => useMissionFlow());
    await act(async () => { await result.current.actions.create('x'); });
    act(() => {
      fire('plan-ready', {
        missionId: 'm-x',
        mission: {
          id: 'm-x', status: 'paused_awaiting_human', goal: 'x',
          steps: [{ id: 'T1', agentId: 'main', role: 'L', title: 'A', deliverable: 'd', depends_on: [], status: 'running', attempts: 0 }],
        },
      });
      fire('step-failed', { missionId: 'm-x', stepId: 'T1', errorCode: 'timeout', message: 'idle 15m' });
    });
    const step = result.current.state.mission!.steps.find((s) => s.id === 'T1')!;
    expect(step.status).toBe('failed');
    expect(step.errorMessage).toBe('idle 15m');
  });

  it('mission:failed transitions to failed + stores reason', async () => {
    const { fire } = installFakeApi();
    const { result } = renderHook(() => useMissionFlow());
    await act(async () => { await result.current.actions.create('x'); });
    act(() => {
      fire('failed', {
        missionId: 'm-x',
        mission: { id: 'm-x', status: 'failed', goal: 'x', steps: [] },
        reason: 'planner failed',
      });
    });
    expect(result.current.state.stage).toBe('failed');
    expect(result.current.state.error).toBe('planner failed');
  });

  it('mission:done transitions to done', async () => {
    const { fire } = installFakeApi();
    const { result } = renderHook(() => useMissionFlow());
    await act(async () => { await result.current.actions.create('x'); });
    act(() => {
      fire('done', {
        missionId: 'm-x',
        mission: { id: 'm-x', status: 'done', goal: 'x', steps: [] },
      });
    });
    expect(result.current.state.stage).toBe('done');
  });

  it('events for other missionIds are ignored', async () => {
    const { fire } = installFakeApi();
    const { result } = renderHook(() => useMissionFlow());
    await act(async () => { await result.current.actions.create('x'); });
    act(() => {
      fire('planner-delta', { missionId: 'OTHER', chunk: 'noise' });
    });
    expect(result.current.state.plannerStream).toBe('');
  });

  it('approve() calls IPC and sets stage to running', async () => {
    const { api } = installFakeApi();
    const { result } = renderHook(() => useMissionFlow());
    await act(async () => { await result.current.actions.create('x'); });
    await act(async () => {
      await result.current.actions.approve();
    });
    expect(api.missionApproveAndRun).toHaveBeenCalledWith('m-x');
    expect(result.current.state.stage).toBe('running');
  });

  it('approve() throws when IPC returns ok:false', async () => {
    const { api } = installFakeApi();
    (api.missionApproveAndRun as any).mockResolvedValueOnce({ ok: false, error: 'boom' });
    const { result } = renderHook(() => useMissionFlow());
    await act(async () => { await result.current.actions.create('x'); });
    await expect(result.current.actions.approve()).rejects.toThrow(/boom/);
  });

  it('cancel() calls IPC', async () => {
    const { api } = installFakeApi();
    const { result } = renderHook(() => useMissionFlow());
    await act(async () => { await result.current.actions.create('x'); });
    await act(async () => {
      await result.current.actions.cancel();
    });
    expect(api.missionCancelFlow).toHaveBeenCalledWith('m-x');
  });

  it('reset() clears everything back to idle', async () => {
    installFakeApi();
    const { result } = renderHook(() => useMissionFlow());
    await act(async () => { await result.current.actions.create('x'); });
    act(() => { result.current.actions.reset(); });
    expect(result.current.state.stage).toBe('idle');
    expect(result.current.state.missionId).toBeNull();
    expect(result.current.state.plannerStream).toBe('');
  });

  it('create() throws when electronAPI is missing', async () => {
    // no installFakeApi here
    const { result } = renderHook(() => useMissionFlow());
    await expect(result.current.actions.create('x')).rejects.toThrow(/IPC/i);
  });
});
