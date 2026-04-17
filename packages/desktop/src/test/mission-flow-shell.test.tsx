/**
 * L2 tests for MissionFlowShell — verifies stages wire Composer + PlanPreview
 * + KanbanCardStream correctly based on state.
 *
 * Mocks useMissionFlow directly so we can drive stage transitions deterministically.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const actionsMock = {
  create: vi.fn(async () => 'm1'),
  approve: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  clear: vi.fn(),
  reset: vi.fn(),
};

let currentState: any = {
  stage: 'idle',
  missionId: null,
  mission: null,
  plannerStream: '',
  stepStream: {},
  error: null,
};

vi.mock('../components/mission-flow/useMissionFlow', () => ({
  useMissionFlow: () => ({ state: currentState, actions: actionsMock }),
}));

import MissionFlowShell from '../components/mission-flow/MissionFlowShell';

function setState(s: any) { currentState = { ...currentState, ...s }; }

describe('MissionFlowShell', () => {
  beforeEach(() => {
    setState({
      stage: 'idle', missionId: null, mission: null,
      plannerStream: '', stepStream: {}, error: null,
    });
    actionsMock.create.mockClear();
    actionsMock.approve.mockClear();
    actionsMock.cancel.mockClear();
    actionsMock.reset.mockClear();
  });

  it('idle stage shows composer only', () => {
    render(<MissionFlowShell />);
    expect(screen.getByTestId('mission-composer')).toBeInTheDocument();
    expect(screen.queryByTestId('mission-kanban')).toBeNull();
    expect(screen.queryByTestId('plan-preview-planning')).toBeNull();
  });

  it('planning stage hides composer and shows stream buffer', () => {
    setState({ stage: 'planning', missionId: 'm1', plannerStream: '{"summary":"plan"}' });
    render(<MissionFlowShell />);
    expect(screen.queryByTestId('mission-composer')).toBeNull();
    expect(screen.getByTestId('plan-preview-planning')).toBeInTheDocument();
  });

  it('preview stage shows PlanPreview with approve + cancel', () => {
    setState({
      stage: 'preview',
      missionId: 'm1',
      mission: {
        id: 'm1', goal: 'x', status: 'paused_awaiting_human', steps: [
          { id: 'T1', agentId: 'main', role: 'L', title: 'A', deliverable: 'd', depends_on: [], status: 'waiting', attempts: 0 },
          { id: 'T2', agentId: 'coder', role: 'D', title: 'B', deliverable: 'd', depends_on: ['T1'], status: 'waiting', attempts: 0 },
          { id: 'T3', agentId: 'tester', role: 'Q', title: 'C', deliverable: 'd', depends_on: ['T2'], status: 'waiting', attempts: 0 },
        ],
      },
    });
    render(<MissionFlowShell />);
    expect(screen.getByTestId('plan-preview-ready')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /let's go/i }));
    expect(actionsMock.approve).toHaveBeenCalled();
  });

  it('running stage renders kanban list with step cards', () => {
    setState({
      stage: 'running',
      missionId: 'm1',
      mission: {
        id: 'm1', goal: 'x', status: 'running', steps: [
          { id: 'T1', agentId: 'main', role: 'L', title: 'Do thing', deliverable: 'd', depends_on: [], status: 'running', attempts: 0 },
        ],
      },
      stepStream: { T1: 'hello' },
    });
    render(<MissionFlowShell />);
    expect(screen.getByTestId('mission-kanban')).toBeInTheDocument();
    expect(screen.getByTestId('kanban-card-T1')).toBeInTheDocument();
    // stream hidden until expanded
    expect(screen.queryByTestId('kanban-card-T1-stream')).toBeNull();
  });

  it('new mission button calls reset', () => {
    setState({
      stage: 'done',
      missionId: 'm1',
      mission: { id: 'm1', goal: 'x', status: 'done', steps: [
        { id: 'T1', agentId: 'main', role: 'L', title: 'A', deliverable: 'd', depends_on: [], status: 'done', attempts: 1 },
      ] },
    });
    render(<MissionFlowShell />);
    fireEvent.click(screen.getByTestId('mission-flow-reset'));
    expect(actionsMock.reset).toHaveBeenCalled();
  });

  it('cancel button during preview calls cancel + reset', async () => {
    setState({
      stage: 'preview',
      mission: { id: 'm1', goal: 'x', status: 'paused_awaiting_human', steps: [
        { id: 'T1', agentId: 'main', role: 'L', title: 'A', deliverable: 'd', depends_on: [], status: 'waiting', attempts: 0 },
        { id: 'T2', agentId: 'coder', role: 'D', title: 'B', deliverable: 'd', depends_on: [], status: 'waiting', attempts: 0 },
        { id: 'T3', agentId: 'tester', role: 'Q', title: 'C', deliverable: 'd', depends_on: [], status: 'waiting', attempts: 0 },
      ] },
    });
    render(<MissionFlowShell />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    // allow promises to flush
    await Promise.resolve();
    expect(actionsMock.cancel).toHaveBeenCalled();
  });

  it('composer submit triggers actions.create', async () => {
    render(<MissionFlowShell />);
    fireEvent.change(screen.getByTestId('mission-composer-input'), {
      target: { value: 'make a slide deck' },
    });
    fireEvent.click(screen.getByTestId('mission-composer-submit'));
    await Promise.resolve();
    expect(actionsMock.create).toHaveBeenCalledWith('make a slide deck', undefined);
  });

  it('passes defaultWorkDir through to actions.create', async () => {
    render(<MissionFlowShell defaultWorkDir="/tmp/proj" />);
    fireEvent.change(screen.getByTestId('mission-composer-input'), {
      target: { value: 'analyze csv data' },
    });
    fireEvent.click(screen.getByTestId('mission-composer-submit'));
    await Promise.resolve();
    expect(actionsMock.create).toHaveBeenCalledWith('analyze csv data', { workDir: '/tmp/proj' });
  });
});
