/**
 * Tests for the TaskCenter page after the F-Team-Tasks Phase 4 refactor.
 *
 * The page now delegates its entire primary surface to MissionFlowShell
 * (composer + plan preview + kanban + history). These tests verify:
 *   - MissionFlowShell mounts inside the page
 *   - The new MissionComposer big-input box is visible by default
 *   - The legacy `goalInput` textarea / workspace chip / MissionCard list
 *     are gone (anti-regression)
 *   - Passing onNavigate still works (used by "Add a teammate" link)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import TaskCenter from '../pages/TaskCenter';

const MISSION_KEYS_TO_PATCH = [
  'agentsList',
  'workflowConfig',
  'workflowEnableCollaboration',
  'missionStart',
  'missionCancel',
  'missionListActive',
  'missionList',
  'missionGet',
  'missionDelete',
  'missionCancelFlow',
  'missionCreateFromGoal',
  'missionApproveAndRun',
  'missionReadArtifact',
  'onMissionProgress',
  'onMissionPlanning',
  'onMissionPlannerDelta',
  'onMissionPlanReady',
  'onMissionStepStarted',
  'onMissionStepDelta',
  'onMissionStepEnded',
  'onMissionStepFailed',
  'onMissionDone',
  'onMissionFailed',
  'onTaskStatusUpdate',
  'onTaskSubagentLinked',
];

beforeEach(() => {
  try { window.localStorage.removeItem('awareness-mission-active-id'); } catch { /* ignore */ }
  const api: any = (window as any).electronAPI;
  if (!api) return;
  for (const key of MISSION_KEYS_TO_PATCH) delete api[key];
  api.agentsList = vi.fn().mockResolvedValue({
    success: true,
    agents: [
      { id: 'main', name: 'Main', emoji: '🤖', isDefault: true },
      { id: 'coder', name: 'Coder', emoji: '💻' },
    ],
  });
  api.workflowConfig = vi.fn().mockResolvedValue({
    maxSpawnDepth: 2,
    agentToAgentEnabled: true,
  });
  api.workflowEnableCollaboration = vi.fn().mockResolvedValue({
    success: true,
    config: { maxSpawnDepth: 2, agentToAgentEnabled: true },
  });
  api.missionListActive = vi.fn().mockResolvedValue({ missionIds: [] });
  api.missionList = vi.fn().mockResolvedValue([]);
  api.missionGet = vi.fn().mockResolvedValue(null);
  api.onMissionProgress = vi.fn().mockReturnValue(() => {});
  api.onMissionPlanning = () => () => {};
  api.onMissionPlannerDelta = () => () => {};
  api.onMissionPlanReady = () => () => {};
  api.onMissionStepStarted = () => () => {};
  api.onMissionStepDelta = () => () => {};
  api.onMissionStepEnded = () => () => {};
  api.onMissionStepFailed = () => () => {};
  api.onMissionDone = () => () => {};
  api.onMissionFailed = () => () => {};
  api.onTaskStatusUpdate = () => () => {};
  api.onTaskSubagentLinked = () => () => {};
});

describe('TaskCenter (post Phase 4 refactor)', () => {
  it('renders the page header', () => {
    render(<TaskCenter />);
    expect(screen.getByText('Team Tasks')).toBeInTheDocument();
  });

  it('mounts MissionFlowShell', () => {
    render(<TaskCenter />);
    expect(screen.getByTestId('mission-flow-shell')).toBeInTheDocument();
  });

  it('renders the MissionComposer big goal box', () => {
    render(<TaskCenter />);
    expect(screen.getByTestId('mission-composer')).toBeInTheDocument();
    expect(screen.getByTestId('mission-composer-input')).toBeInTheDocument();
  });

  it('does NOT render the legacy goal textarea placeholder', () => {
    render(<TaskCenter />);
    expect(screen.queryByPlaceholderText(/what do you want your team to do/i))
      .toBeNull();
  });

  it('does NOT render legacy workspace selector chip', () => {
    render(<TaskCenter />);
    expect(screen.queryByText(/Select workspace/)).toBeNull();
  });

  it('does NOT render legacy MissionCard "Active" or "Completed" section headers', () => {
    render(<TaskCenter />);
    const activeHdr = screen.queryAllByText(/^Active$/);
    const completedHdr = screen.queryAllByText(/^Completed$/);
    expect(activeHdr.length + completedHdr.length).toBe(0);
  });

  it('passes onNavigate through without error', () => {
    const onNavigate = vi.fn();
    render(<TaskCenter onNavigate={onNavigate} />);
    expect(screen.getByTestId('mission-composer')).toBeInTheDocument();
  });
});
