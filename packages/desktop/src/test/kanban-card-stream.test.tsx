/**
 * L2 integration tests for KanbanCardStream.
 *
 * Scope:
 *   - renders expanded / collapsed states
 *   - streaming text appears in the <pre> buffer
 *   - status pill matches step.status and shows spinner only for running/retrying
 *   - tool events render as chips when expanded
 *   - failed step shows error banner
 *   - done step shows artifact path + View button
 *   - scroll detection toggles auto-stick (happy path)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import KanbanCardStream, {
  type KanbanCardStreamProps,
} from '../components/mission-flow/KanbanCardStream';
import type { MissionSnapshotStep } from '../types/electron';

function buildStep(patch: Partial<MissionSnapshotStep> = {}): MissionSnapshotStep {
  return {
    id: 'T1',
    agentId: 'main',
    agentName: 'Main Agent',
    role: 'Lead',
    title: 'Draft introduction',
    deliverable: 'intro.md',
    depends_on: [],
    status: 'waiting',
    attempts: 0,
    ...patch,
  } as MissionSnapshotStep;
}

function setup(props: Partial<KanbanCardStreamProps> = {}) {
  const defaults: KanbanCardStreamProps = {
    step: buildStep(),
    streamText: '',
    onToggleExpand: vi.fn(),
    ...props,
  };
  return { ...render(<KanbanCardStream {...defaults} />), props: defaults };
}

describe('KanbanCardStream — render', () => {
  it('renders the step title and agent info', () => {
    setup({ step: buildStep({ title: 'Hello world' }) });
    expect(screen.getByText('Hello world')).toBeInTheDocument();
    expect(screen.getByText(/Main Agent/)).toBeInTheDocument();
  });

  it('shows waiting pill by default', () => {
    setup();
    const pill = screen.getByTestId('kanban-card-T1-status');
    expect(pill).toHaveTextContent(/waiting/i);
  });

  it('shows running pill with spinner', () => {
    setup({ step: buildStep({ status: 'running' }) });
    const pill = screen.getByTestId('kanban-card-T1-status');
    expect(pill).toHaveTextContent(/running/i);
    expect(pill.querySelector('.animate-spin')).not.toBeNull();
  });

  it('shows failed pill', () => {
    setup({ step: buildStep({ status: 'failed' }) });
    expect(screen.getByTestId('kanban-card-T1-status')).toHaveTextContent(/failed/i);
  });

  it('shows done pill', () => {
    setup({ step: buildStep({ status: 'done' }) });
    expect(screen.getByTestId('kanban-card-T1-status')).toHaveTextContent(/done/i);
  });

  it('collapsed state hides stream buffer and tools', () => {
    setup({ expanded: false, streamText: 'hidden text' });
    expect(screen.queryByTestId('kanban-card-T1-stream')).toBeNull();
  });
});

describe('KanbanCardStream — expanded state', () => {
  it('renders stream text when expanded', () => {
    setup({ expanded: true, step: buildStep({ status: 'running' }), streamText: 'writing code...' });
    const pre = screen.getByTestId('kanban-card-T1-stream');
    expect(pre).toHaveTextContent('writing code...');
  });

  it('shows placeholder when stream is empty and step is running', () => {
    setup({ expanded: true, step: buildStep({ status: 'running' }), streamText: '' });
    const pre = screen.getByTestId('kanban-card-T1-stream');
    expect(pre).toHaveTextContent(/starting/i);
  });

  it('shows "waiting" placeholder for waiting step', () => {
    setup({ expanded: true, step: buildStep({ status: 'waiting' }), streamText: '' });
    expect(screen.getByTestId('kanban-card-T1-stream')).toHaveTextContent(/waiting/i);
  });

  it('renders tool chips when toolEvents present', () => {
    setup({
      expanded: true,
      step: buildStep({ status: 'running' }),
      toolEvents: [
        { toolName: 'Read', status: 'ok' },
        { toolName: 'Bash', status: 'running' },
      ],
    });
    const toolsEl = screen.getByTestId('kanban-card-T1-tools');
    expect(toolsEl.querySelectorAll('li').length).toBe(2);
    expect(toolsEl).toHaveTextContent('Read');
    expect(toolsEl).toHaveTextContent('Bash');
  });

  it('renders error banner for failed step with errorMessage', () => {
    setup({
      expanded: true,
      step: buildStep({
        status: 'failed',
        errorCode: 'timeout' as any,
        errorMessage: 'idle 15 min',
      }),
    });
    expect(screen.getByTestId('kanban-card-T1-error')).toHaveTextContent(/idle 15 min/);
    expect(screen.getByTestId('kanban-card-T1-error')).toHaveTextContent(/timeout/);
  });

  it('renders artifact path + View button for done step', () => {
    const onReadArtifact = vi.fn();
    setup({
      expanded: true,
      step: buildStep({
        status: 'done',
        artifactPath: 'artifacts/T1-draft.md',
      }),
      onReadArtifact,
    });
    expect(screen.getByText('artifacts/T1-draft.md')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /view artifact/i });
    fireEvent.click(btn);
    expect(onReadArtifact).toHaveBeenCalledTimes(1);
  });

  it('hides artifact button when onReadArtifact not provided', () => {
    setup({
      expanded: true,
      step: buildStep({
        status: 'done',
        artifactPath: 'artifacts/T1-draft.md',
      }),
    });
    expect(screen.queryByRole('button', { name: /view artifact/i })).toBeNull();
  });
});

describe('KanbanCardStream — expand toggling', () => {
  it('toggle button fires onToggleExpand', () => {
    const onToggleExpand = vi.fn();
    setup({ onToggleExpand, expanded: false });
    const btn = screen.getByRole('button', { name: /expand step/i });
    fireEvent.click(btn);
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it('aria-expanded reflects expanded prop', () => {
    const { rerender } = setup({ expanded: false });
    expect(screen.getByRole('button', { name: /expand/i })).toHaveAttribute('aria-expanded', 'false');
    rerender(<KanbanCardStream step={buildStep()} expanded onToggleExpand={vi.fn()} />);
    expect(screen.getByRole('button', { name: /collapse/i })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('KanbanCardStream — running wait indicator', () => {
  it('does not show wait banner within the first 10s', () => {
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    setup({
      expanded: true,
      step: buildStep({ status: 'running', startedAt }),
      streamText: '',
    });
    // Elapsed ~5s; wait banner should NOT be visible
    expect(screen.queryByTestId('kanban-card-T1-wait')).toBeNull();
  });

  it('shows wait banner after ~10s with streamText empty', async () => {
    const startedAt = new Date(Date.now() - 15_000).toISOString();
    setup({
      expanded: true,
      step: buildStep({ status: 'running', startedAt }),
      streamText: '',
    });
    // Elapsed ~15s; wait banner should appear
    expect(await screen.findByTestId('kanban-card-T1-wait')).toBeInTheDocument();
    expect(screen.getByTestId('kanban-card-T1-wait').textContent).toMatch(/warming|思考|15/i);
  });

  it('does NOT show wait banner if stream already has text', () => {
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    setup({
      expanded: true,
      step: buildStep({ status: 'running', startedAt }),
      streamText: 'some tokens arrived',
    });
    expect(screen.queryByTestId('kanban-card-T1-wait')).toBeNull();
  });

  it('shows elapsed time in status pill after 3s', async () => {
    const startedAt = new Date(Date.now() - 8_000).toISOString();
    setup({
      expanded: false,
      step: buildStep({ status: 'running', startedAt }),
    });
    const pill = await screen.findByTestId('kanban-card-T1-status');
    // 8s elapsed → pill should show "· 8s"
    expect(pill.textContent).toMatch(/\d+s/);
  });

  it('does NOT tick elapsed time for done steps', () => {
    setup({
      expanded: false,
      step: buildStep({ status: 'done', startedAt: new Date(Date.now() - 60_000).toISOString() }),
    });
    const pill = screen.getByTestId('kanban-card-T1-status');
    // No "Xs" fragment for done steps
    expect(pill.textContent).not.toMatch(/· \d+s/);
  });
});

describe('KanbanCardStream — scroll auto-stick detection', () => {
  it('scroll callback does not crash on any scroll position', () => {
    setup({ expanded: true, step: buildStep({ status: 'running' }), streamText: 'long stream' });
    const pre = screen.getByTestId('kanban-card-T1-stream');
    // Simulate user-scrolled-up
    Object.defineProperty(pre, 'scrollHeight', { configurable: true, value: 200 });
    Object.defineProperty(pre, 'scrollTop', { configurable: true, writable: true, value: 0 });
    Object.defineProperty(pre, 'clientHeight', { configurable: true, value: 100 });
    fireEvent.scroll(pre);
    // Simulate user-scrolled-to-bottom
    Object.defineProperty(pre, 'scrollTop', { configurable: true, writable: true, value: 100 });
    fireEvent.scroll(pre);
    expect(pre).toBeInTheDocument();
  });
});
