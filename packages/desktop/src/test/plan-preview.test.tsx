/**
 * L2 integration tests for PlanPreview (src/components/mission-flow/PlanPreview.tsx).
 *
 * Scope:
 *   - stage=idle / planning / preview / running / done / failed render correctly
 *   - planner streaming text shows up in the live buffer
 *   - approve / cancel buttons wire to callbacks
 *   - edit flow opens textarea + saves edited JSON via onEditPlan
 *   - error banner renders when error prop is set
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PlanPreview from '../components/mission-flow/PlanPreview';
import type { MissionSnapshot } from '../types/electron';

function buildMission(steps: Partial<MissionSnapshot['steps'][number]>[] = []): MissionSnapshot {
  return {
    id: 'mission-x',
    version: 1,
    goal: 'demo goal',
    status: 'paused_awaiting_human',
    createdAt: '2026-04-17T10:00:00Z',
    plannerAgentId: 'main',
    steps: steps.map((s, i) => ({
      id: `T${i + 1}`,
      agentId: 'main',
      agentName: 'Main Agent',
      role: 'Lead',
      title: `Step ${i + 1}`,
      deliverable: 'output',
      depends_on: [],
      status: 'waiting',
      attempts: 0,
      ...s,
    })) as any,
  };
}

describe('PlanPreview — rendering', () => {
  it('renders nothing at stage=idle', () => {
    const { container } = render(
      <PlanPreview
        stage="idle"
        plannerStream=""
        mission={null}
        onApprove={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the planning stream buffer at stage=planning', () => {
    render(
      <PlanPreview
        stage="planning"
        plannerStream='{"summary":"Draft plan"'
        mission={null}
        onApprove={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('plan-preview-planning')).toBeInTheDocument();
    expect(screen.getByTestId('planner-stream-buffer')).toHaveTextContent('Draft plan');
  });

  it('shows "Thinking…" placeholder when planner stream is empty', () => {
    render(
      <PlanPreview
        stage="planning"
        plannerStream=""
        mission={null}
        onApprove={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('planner-stream-buffer')).toHaveTextContent(/Thinking/);
  });

  it('renders plan-ready panel with subtask list at stage=preview', () => {
    const mission = buildMission([
      { title: 'Draft intro' },
      { title: 'Write outline' },
      { title: 'Polish copy' },
    ]);
    render(
      <PlanPreview
        stage="preview"
        plannerStream=""
        mission={mission}
        onApprove={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('plan-preview-ready')).toBeInTheDocument();
    const list = screen.getByTestId('plan-step-list');
    expect(list.querySelectorAll('li').length).toBe(3);
    expect(list).toHaveTextContent('Draft intro');
    expect(list).toHaveTextContent('Write outline');
    expect(list).toHaveTextContent('Polish copy');
  });

  it('renders summary panel at stage=done', () => {
    const mission = buildMission([{ status: 'done' }, { status: 'done' }, { status: 'done' }]);
    render(
      <PlanPreview
        stage="done"
        plannerStream=""
        mission={mission}
        onApprove={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('plan-summary')).toBeInTheDocument();
    expect(screen.getByTestId('plan-summary')).toHaveTextContent(/complete/i);
    expect(screen.getByTestId('plan-summary')).toHaveTextContent(/3\/3/);
  });

  it('renders summary panel with failed count at stage=failed', () => {
    const mission = buildMission([{ status: 'done' }, { status: 'failed' }, { status: 'waiting' }]);
    render(
      <PlanPreview
        stage="failed"
        plannerStream=""
        mission={mission}
        onApprove={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('plan-summary')).toHaveTextContent(/failed/i);
    expect(screen.getByTestId('plan-summary')).toHaveTextContent(/1/);
  });

  it('renders running panel at stage=running', () => {
    const mission = buildMission([{ status: 'running' }, { status: 'waiting' }, { status: 'waiting' }]);
    render(
      <PlanPreview
        stage="running"
        plannerStream=""
        mission={mission}
        onApprove={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('plan-summary')).toBeInTheDocument();
    expect(screen.getByTestId('plan-summary')).toHaveTextContent(/progress/i);
  });

  it('renders error banner when error prop is present', () => {
    render(
      <PlanPreview
        stage="failed"
        plannerStream=""
        mission={buildMission([{ status: 'failed' }, { status: 'waiting' }, { status: 'waiting' }])}
        error="planner returned invalid JSON"
        onApprove={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('mission-error')).toHaveTextContent(/invalid JSON/i);
  });
});

describe('PlanPreview — actions', () => {
  it('approve button fires onApprove', () => {
    const onApprove = vi.fn();
    render(
      <PlanPreview
        stage="preview"
        plannerStream=""
        mission={buildMission([{}, {}, {}])}
        onApprove={onApprove}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /let's go/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('cancel button fires onCancel', () => {
    const onCancel = vi.fn();
    render(
      <PlanPreview
        stage="preview"
        plannerStream=""
        mission={buildMission([{}, {}, {}])}
        onApprove={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('approve + cancel buttons are disabled while busy', () => {
    render(
      <PlanPreview
        stage="preview"
        plannerStream=""
        mission={buildMission([{}, {}, {}])}
        busy
        onApprove={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /let's go/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
  });

  it('edit flow opens textarea and saves via onEditPlan', () => {
    const onEditPlan = vi.fn();
    render(
      <PlanPreview
        stage="preview"
        plannerStream=""
        mission={buildMission([{ title: 'A' }, { title: 'B' }, { title: 'C' }])}
        onApprove={vi.fn()}
        onCancel={vi.fn()}
        onEditPlan={onEditPlan}
      />,
    );
    // Textarea hidden initially
    expect(screen.queryByTestId('plan-edit-textarea')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /edit plan/i }));
    const ta = screen.getByTestId('plan-edit-textarea') as HTMLTextAreaElement;
    expect(ta.value).toContain('subtasks');

    fireEvent.change(ta, { target: { value: '{"summary":"edited","subtasks":[]}' } });
    fireEvent.click(screen.getByRole('button', { name: /save edits/i }));
    expect(onEditPlan).toHaveBeenCalledWith('{"summary":"edited","subtasks":[]}');
  });

  it('planning stage shows a Cancel/return button that fires onCancel', () => {
    const onCancel = vi.fn();
    render(
      <PlanPreview
        stage="planning"
        plannerStream="thinking tokens..."
        mission={null}
        onApprove={vi.fn()}
        onCancel={onCancel}
      />,
    );
    const btn = screen.getByTestId('planner-cancel');
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('planning Cancel button is disabled while busy', () => {
    render(
      <PlanPreview
        stage="planning"
        plannerStream=""
        mission={null}
        busy
        onApprove={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('planner-cancel')).toBeDisabled();
  });

  it('edit flow cancel edit does not emit onEditPlan', () => {
    const onEditPlan = vi.fn();
    render(
      <PlanPreview
        stage="preview"
        plannerStream=""
        mission={buildMission([{}, {}, {}])}
        onApprove={vi.fn()}
        onCancel={vi.fn()}
        onEditPlan={onEditPlan}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /edit plan/i }));
    expect(screen.getByTestId('plan-edit-textarea')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /cancel edit/i }));
    expect(screen.queryByTestId('plan-edit-textarea')).toBeNull();
    expect(onEditPlan).not.toHaveBeenCalled();
  });

  it('omitting onEditPlan hides the Edit plan button', () => {
    render(
      <PlanPreview
        stage="preview"
        plannerStream=""
        mission={buildMission([{}, {}, {}])}
        onApprove={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /edit plan/i })).toBeNull();
  });
});
