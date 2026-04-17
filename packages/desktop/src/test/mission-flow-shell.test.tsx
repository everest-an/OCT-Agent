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
          { id: 'T1', agentId: 'main', role: 'L', title: 'Do thing', deliverable: 'd', depends_on: [], status: 'waiting', attempts: 0 },
        ],
      },
      stepStream: { T1: 'hello' },
    });
    render(<MissionFlowShell />);
    expect(screen.getByTestId('mission-kanban')).toBeInTheDocument();
    expect(screen.getByTestId('kanban-card-T1')).toBeInTheDocument();
    // waiting step is not auto-expanded
    expect(screen.queryByTestId('kanban-card-T1-stream')).toBeNull();
  });

  it('running step is auto-expanded so streaming is visible without a click', () => {
    setState({
      stage: 'running',
      missionId: 'm1',
      mission: {
        id: 'm1', goal: 'x', status: 'running', steps: [
          { id: 'T1', agentId: 'main', role: 'L', title: 'Live', deliverable: 'd', depends_on: [], status: 'running', attempts: 0 },
        ],
      },
      stepStream: { T1: 'live stream chunk' },
    });
    render(<MissionFlowShell />);
    expect(screen.getByTestId('kanban-card-T1-stream')).toHaveTextContent('live stream chunk');
  });

  it('running stage has a Stop button that cancels + resets', async () => {
    setState({
      stage: 'running',
      missionId: 'm1',
      mission: {
        id: 'm1', goal: 'x', status: 'running', steps: [
          { id: 'T1', agentId: 'main', role: 'L', title: 'A', deliverable: 'd', depends_on: [], status: 'running', attempts: 0 },
        ],
      },
      stepStream: { T1: 'running...' },
    });
    render(<MissionFlowShell />);
    const stopBtn = screen.getByTestId('mission-flow-stop');
    expect(stopBtn).toBeInTheDocument();
    fireEvent.click(stopBtn);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(actionsMock.cancel).toHaveBeenCalled();
    expect(actionsMock.reset).toHaveBeenCalled();
  });

  it('done stage does NOT show Stop button', () => {
    setState({
      stage: 'done',
      missionId: 'm1',
      mission: {
        id: 'm1', goal: 'x', status: 'done', steps: [
          { id: 'T1', agentId: 'main', role: 'L', title: 'A', deliverable: 'd', depends_on: [], status: 'done', attempts: 1 },
        ],
      },
    });
    render(<MissionFlowShell />);
    expect(screen.queryByTestId('mission-flow-stop')).toBeNull();
  });

  it('failed stage does NOT show Stop button', () => {
    setState({
      stage: 'failed',
      missionId: 'm1',
      mission: {
        id: 'm1', goal: 'x', status: 'failed', steps: [
          { id: 'T1', agentId: 'main', role: 'L', title: 'A', deliverable: 'd', depends_on: [], status: 'failed', attempts: 1 },
        ],
      },
      error: 'planner crash',
    });
    render(<MissionFlowShell />);
    expect(screen.queryByTestId('mission-flow-stop')).toBeNull();
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
    expect(actionsMock.create).toHaveBeenCalledWith(
      'make a slide deck',
      expect.objectContaining({ workDir: undefined }),
    );
  });

  it('done step without live stream auto-backfills artifact body via mission:read-artifact', async () => {
    // Mock electronAPI.missionReadArtifact to return a markdown body
    const api: any = (window as any).electronAPI;
    const readArtifact = (api.missionReadArtifact = vi.fn(async (_mid: string, stepId: string) => ({
      ok: true,
      body: `---\nstepId: ${stepId}\nagentId: main\n---\n\n# Real artifact body\n\nHello from disk.`,
    })));

    setState({
      stage: 'done',
      missionId: 'm-a',
      mission: {
        id: 'm-a', goal: 'x', status: 'done', steps: [
          { id: 'T1', agentId: 'main', role: 'L', title: 'A', deliverable: 'd',
            depends_on: [], status: 'done', attempts: 1, artifactPath: 'artifacts/T1-a.md' },
        ],
      },
      stepStream: {}, // no live stream
    });

    render(<MissionFlowShell />);

    // Wait for the effect to fire the IPC call
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(readArtifact).toHaveBeenCalledWith('m-a', 'T1');

    // Delete the mock so next tests don't see a lingering method
    delete api.missionReadArtifact;
  });

  it('passes workDir + agents through to actions.create', async () => {
    render(
      <MissionFlowShell
        workDir="/tmp/proj"
        agents={[{ id: 'main', name: 'Main' }, { id: 'coder', name: 'Coder' }]}
      />,
    );
    fireEvent.change(screen.getByTestId('mission-composer-input'), {
      target: { value: 'analyze csv data' },
    });
    fireEvent.click(screen.getByTestId('mission-composer-submit'));
    await Promise.resolve();
    expect(actionsMock.create).toHaveBeenCalledWith(
      'analyze csv data',
      expect.objectContaining({
        workDir: '/tmp/proj',
        agents: expect.arrayContaining([
          expect.objectContaining({ id: 'main' }),
          expect.objectContaining({ id: 'coder' }),
        ]),
      }),
    );
  });
});
