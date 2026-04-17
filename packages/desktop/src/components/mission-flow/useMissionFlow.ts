/**
 * useMissionFlow — single source of truth for the Mission Flow UI state.
 *
 * Manages the end-to-end lifecycle in one hook so individual components stay
 * dumb/presentational:
 *   idle → planning (streaming) → preview (paused_awaiting_human)
 *        → running (streaming steps) → done | failed
 *
 * Subscribes to every `mission:*` IPC event and exposes:
 *   - the current mission snapshot (if any)
 *   - planner streaming buffer
 *   - per-step streaming buffer (stepId → chunks)
 *   - create/approve/cancel/delete action handlers
 *
 * Fail-safe: if window.electronAPI is not available (e.g. running in Vitest
 * without the preload bridge) the hook returns a no-op shell so components
 * render without crashing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { MissionSnapshot } from '../../types/electron';

export type MissionFlowStage =
  | 'idle'
  | 'planning'
  | 'preview'
  | 'running'
  | 'done'
  | 'failed';

export interface MissionFlowState {
  readonly stage: MissionFlowStage;
  readonly missionId: string | null;
  readonly mission: MissionSnapshot | null;
  readonly plannerStream: string;
  readonly stepStream: Readonly<Record<string, string>>;
  readonly error: string | null;
}

export interface MissionFlowActions {
  create(goal: string, opts?: {
    workDir?: string;
    agents?: Array<{ id: string; name?: string; role?: string; emoji?: string }>;
  }): Promise<string>;
  approve(missionId?: string): Promise<void>;
  cancel(missionId?: string): Promise<void>;
  clear(): void;
  reset(): void;
}

export function useMissionFlow(): { state: MissionFlowState; actions: MissionFlowActions } {
  const [stage, setStage] = useState<MissionFlowStage>('idle');
  const [missionId, setMissionId] = useState<string | null>(null);
  const [mission, setMission] = useState<MissionSnapshot | null>(null);
  const [plannerStream, setPlannerStream] = useState<string>('');
  const [stepStream, setStepStream] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const activeIdRef = useRef<string | null>(null);

  // Keep a ref in sync so event handlers can filter without re-subscribing.
  useEffect(() => { activeIdRef.current = missionId; }, [missionId]);

  const resetStreams = useCallback(() => {
    setPlannerStream('');
    setStepStream({});
    setError(null);
  }, []);

  const reset = useCallback(() => {
    setStage('idle');
    setMissionId(null);
    setMission(null);
    resetStreams();
  }, [resetStreams]);

  const clear = useCallback(() => {
    setError(null);
  }, []);

  // -------------------------------------------------------------------------
  // IPC event subscriptions. Every callback ignores events from other missions.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const api: any = typeof window !== 'undefined' ? (window as any).electronAPI : null;
    if (!api) return;

    const offs: Array<() => void> = [];
    const safeOn = (fn: any, handler: any): void => {
      if (typeof fn !== 'function') return;
      const off = fn(handler);
      if (typeof off === 'function') offs.push(off);
    };

    const isCurrent = (id: string) => activeIdRef.current != null && id === activeIdRef.current;

    safeOn(api.onMissionPlanning, (data: { missionId: string }) => {
      if (!isCurrent(data.missionId)) return;
      setStage('planning');
    });

    safeOn(api.onMissionPlannerDelta, (data: { missionId: string; chunk: string }) => {
      if (!isCurrent(data.missionId)) return;
      setPlannerStream((prev) => prev + (data.chunk || ''));
    });

    safeOn(api.onMissionPlanReady, (data: { missionId: string; mission: MissionSnapshot }) => {
      if (!isCurrent(data.missionId)) return;
      setMission(data.mission);
      setStage(data.mission.status === 'paused_awaiting_human' ? 'preview' : 'running');
    });

    safeOn(api.onMissionStepStarted, (data: {
      missionId: string; stepId: string; sessionKey: string; runId: string;
    }) => {
      if (!isCurrent(data.missionId)) return;
      setMission((prev) => prev ? patchStep(prev, data.stepId, {
        status: 'running',
        sessionKey: data.sessionKey,
        runId: data.runId,
      }) : prev);
      setStepStream((prev) => ({ ...prev, [data.stepId]: prev[data.stepId] ?? '' }));
      setStage((s) => (s === 'preview' ? 'running' : s));
    });

    safeOn(api.onMissionStepDelta, (data: {
      missionId: string; stepId: string; chunk: string;
    }) => {
      if (!isCurrent(data.missionId)) return;
      setStepStream((prev) => ({
        ...prev,
        [data.stepId]: (prev[data.stepId] ?? '') + (data.chunk || ''),
      }));
    });

    safeOn(api.onMissionStepEnded, (data: {
      missionId: string; stepId: string; artifactPath: string;
    }) => {
      if (!isCurrent(data.missionId)) return;
      setMission((prev) => prev ? patchStep(prev, data.stepId, {
        status: 'done',
        artifactPath: data.artifactPath,
      }) : prev);
    });

    safeOn(api.onMissionStepFailed, (data: {
      missionId: string; stepId: string; errorCode: string; message: string;
    }) => {
      if (!isCurrent(data.missionId)) return;
      setMission((prev) => prev ? patchStep(prev, data.stepId, {
        status: 'failed',
        errorCode: data.errorCode,
        errorMessage: data.message,
      }) : prev);
    });

    safeOn(api.onMissionDone, (data: { missionId: string; mission: MissionSnapshot }) => {
      if (!isCurrent(data.missionId)) return;
      setMission(data.mission);
      setStage('done');
    });

    safeOn(api.onMissionFailed, (data: { missionId: string; mission: MissionSnapshot; reason: string }) => {
      if (!isCurrent(data.missionId)) return;
      setMission(data.mission);
      setStage('failed');
      setError(data.reason || 'Mission failed');
    });

    return () => {
      for (const off of offs) {
        try { off(); } catch { /* ignore */ }
      }
    };
  }, []);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  const create = useCallback<MissionFlowActions['create']>(async (goal, opts) => {
    const api: any = (window as any).electronAPI;
    if (!api?.missionCreateFromGoal) {
      throw new Error('Mission Flow IPC not available in this build');
    }
    resetStreams();
    setMission(null);
    setStage('planning');
    const result = await api.missionCreateFromGoal(goal, opts);
    const id: string = result?.missionId;
    if (!id) throw new Error('missionCreateFromGoal returned no id');
    setMissionId(id);
    return id;
  }, [resetStreams]);

  const approve = useCallback<MissionFlowActions['approve']>(async (id) => {
    const api: any = (window as any).electronAPI;
    const target = id ?? missionId;
    if (!api?.missionApproveAndRun) throw new Error('IPC not available');
    if (!target) throw new Error('No active mission');
    const res = await api.missionApproveAndRun(target);
    if (!res?.ok) throw new Error(res?.error || 'approve failed');
    setStage('running');
  }, [missionId]);

  const cancel = useCallback<MissionFlowActions['cancel']>(async (id) => {
    const api: any = (window as any).electronAPI;
    const target = id ?? missionId;
    if (!api?.missionCancelFlow) throw new Error('IPC not available');
    if (!target) return;
    await api.missionCancelFlow(target);
  }, [missionId]);

  return {
    state: { stage, missionId, mission, plannerStream, stepStream, error },
    actions: { create, approve, cancel, clear, reset },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function patchStep(
  mission: MissionSnapshot,
  stepId: string,
  patch: Partial<MissionSnapshot['steps'][number]>,
): MissionSnapshot {
  const steps = mission.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s));
  return { ...mission, steps };
}
