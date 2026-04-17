/**
 * L2 tests for MissionHistoryList — fetches persisted missions and lets the
 * user re-open or delete them.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MissionHistoryList from '../components/mission-flow/MissionHistoryList';
import type { MissionSnapshot } from '../types/electron';

function fakeMission(overrides: Partial<MissionSnapshot>): MissionSnapshot {
  return {
    id: 'm1',
    version: 1,
    goal: 'Draft a digest',
    status: 'done',
    createdAt: '2026-04-17T10:00:00Z',
    startedAt: '2026-04-17T10:00:00Z',
    completedAt: '2026-04-17T10:05:00Z',
    plannerAgentId: 'main',
    steps: [
      { id: 'T1', agentId: 'main', agentName: 'Main', role: 'L', title: 'Draft', deliverable: 'd', depends_on: [], status: 'done', attempts: 1 },
      { id: 'T2', agentId: 'coder', agentName: 'Coder', role: 'D', title: 'Impl', deliverable: 'd', depends_on: ['T1'], status: 'done', attempts: 1 },
    ] as any,
    ...overrides,
  };
}

const api: any = (window as any).electronAPI;

beforeEach(() => {
  delete api.missionList;
  delete api.missionDelete;
});

describe('MissionHistoryList', () => {
  it('renders nothing when the list is empty', async () => {
    api.missionList = vi.fn(async () => []);
    const { container } = render(<MissionHistoryList />);
    await new Promise((r) => setImmediate(r));
    // Empty → component returns null, nothing rendered
    expect(container.firstChild).toBeNull();
  });

  it('lists missions returned by IPC', async () => {
    api.missionList = vi.fn(async () => [
      fakeMission({ id: 'm1', goal: 'Build a landing page' }),
      fakeMission({ id: 'm2', goal: 'Fix login bug', status: 'failed' }),
    ]);
    render(<MissionHistoryList />);
    await waitFor(() => expect(screen.getByTestId('mission-history-list')).toBeInTheDocument());
    expect(screen.getByText('Build a landing page')).toBeInTheDocument();
    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
  });

  it('sorts newest first', async () => {
    api.missionList = vi.fn(async () => [
      fakeMission({ id: 'm-old', goal: 'Old goal', createdAt: '2025-01-01T00:00:00Z' }),
      fakeMission({ id: 'm-new', goal: 'New goal', createdAt: '2026-04-17T10:00:00Z' }),
    ]);
    render(<MissionHistoryList />);
    await waitFor(() => expect(screen.getByTestId('mission-history-list')).toBeInTheDocument());
    const items = screen.getAllByRole('button');
    // First rendered item (item 0) should be "New goal"
    expect(items[0]).toHaveTextContent('New goal');
  });

  it('click triggers onReopen with missionId', async () => {
    api.missionList = vi.fn(async () => [fakeMission({ id: 'mX' })]);
    const onReopen = vi.fn();
    render(<MissionHistoryList onReopen={onReopen} />);
    await waitFor(() => expect(screen.getByTestId('mission-history-mX')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('mission-history-mX'));
    expect(onReopen).toHaveBeenCalledWith('mX');
  });

  it('delete button fires onDelete after confirm', async () => {
    (window as any).confirm = vi.fn(() => true);
    api.missionList = vi.fn(async () => [fakeMission({ id: 'mD' })]);
    const onDelete = vi.fn(async () => undefined);
    render(<MissionHistoryList onDelete={onDelete} />);
    await waitFor(() => expect(screen.getByTestId('mission-history-mD-delete')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('mission-history-mD-delete'));
    await Promise.resolve();
    expect(onDelete).toHaveBeenCalledWith('mD');
  });

  it('delete button is cancelled when user hits no in confirm', async () => {
    (window as any).confirm = vi.fn(() => false);
    api.missionList = vi.fn(async () => [fakeMission({ id: 'mC' })]);
    const onDelete = vi.fn();
    render(<MissionHistoryList onDelete={onDelete} />);
    await waitFor(() => expect(screen.getByTestId('mission-history-mC-delete')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('mission-history-mC-delete'));
    await Promise.resolve();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('shows a non-fatal error message when IPC throws', async () => {
    api.missionList = vi.fn(async () => { throw new Error('daemon offline'); });
    render(<MissionHistoryList />);
    await waitFor(() => expect(screen.getByTestId('mission-history-error')).toBeInTheDocument());
    expect(screen.getByTestId('mission-history-error')).toHaveTextContent(/daemon offline/);
  });

  it('renders nothing when electronAPI.missionList is absent (unit-test harness)', async () => {
    // api.missionList already deleted in beforeEach
    const { container } = render(<MissionHistoryList />);
    await new Promise((r) => setImmediate(r));
    expect(container.firstChild).toBeNull();
  });

  it('re-fetches when refreshKey changes', async () => {
    const fn = vi.fn(async () => [fakeMission({ id: 'm-r' })]);
    api.missionList = fn;
    const { rerender } = render(<MissionHistoryList refreshKey={0} />);
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    rerender(<MissionHistoryList refreshKey={1} />);
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
  });
});
