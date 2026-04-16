import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import KanbanBoard from '../components/task-center/KanbanBoard';
import type { Task, TaskStatus } from '../lib/task-store';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
});

// i18n 模拟
const i18nMap: Record<string, string> = {
  'kanban.backlog': 'Backlog',
  'kanban.queued': 'Queued',
  'kanban.running': 'Running',
  'kanban.done': 'Done',
  'kanban.failed': 'Failed',
  'kanban.clearCompleted': 'Clear completed',
  'kanban.dropHint': 'Drop tasks here to run',
};
const t = (key: string, fallback?: string) => i18nMap[key] || fallback || key;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test task',
    agentId: 'coder',
    agentEmoji: '💻',
    agentName: 'Coder',
    status: 'backlog',
    priority: 'medium',
    createdAt: '2026-04-04T10:00:00.000Z',
    ...overrides,
  };
}

const defaultProps = () => ({
  tasks: [] as Task[],
  t,
  onMoveTask: vi.fn(),
  onRetryTask: vi.fn(),
  onCancelTask: vi.fn(),
  onViewDetail: vi.fn(),
  onDeleteTask: vi.fn(),
  onClearCompleted: vi.fn(),
});

describe('KanbanBoard', () => {
  // 渲染所有 5 列标题
  it('renders all column headers', () => {
    render(<KanbanBoard {...defaultProps()} />);
    expect(screen.getByText('Backlog')).toBeTruthy();
    expect(screen.getByText('Queued')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  // 任务按状态正确分组到对应列
  it('groups tasks into correct columns', () => {
    const tasks = [
      makeTask({ id: 't1', title: 'Backlog task', status: 'backlog' }),
      makeTask({ id: 't2', title: 'Running task', status: 'running' }),
      makeTask({ id: 't3', title: 'Done task', status: 'done' }),
    ];
    render(<KanbanBoard {...defaultProps()} tasks={tasks} />);
    expect(screen.getByText('Backlog task')).toBeTruthy();
    expect(screen.getByText('Running task')).toBeTruthy();
    expect(screen.getByText('Done task')).toBeTruthy();
  });

  // 有已完成/失败任务时显示 Clear Completed 按钮
  it('shows clear completed button when done/failed tasks exist', () => {
    const props = defaultProps();
    const tasks = [
      makeTask({ id: 't1', status: 'done' }),
      makeTask({ id: 't2', status: 'failed' }),
    ];
    render(<KanbanBoard {...props} tasks={tasks} />);
    const btn = screen.getByText(/Clear completed/);
    expect(btn).toBeTruthy();
    // 按钮文本包含数量
    expect(btn.textContent).toContain('2');
  });

  // 点击 Clear Completed 按钮触发回调
  it('calls onClearCompleted when button is clicked', () => {
    const props = defaultProps();
    const tasks = [makeTask({ id: 't1', status: 'done' })];
    render(<KanbanBoard {...props} tasks={tasks} />);
    const btn = screen.getByText(/Clear completed/).closest('button')!;
    fireEvent.click(btn);
    expect(props.onClearCompleted).toHaveBeenCalledTimes(1);
  });

  // 没有已完成任务时不显示 Clear Completed 按钮
  it('hides clear completed button when no done/failed tasks', () => {
    const tasks = [makeTask({ id: 't1', status: 'backlog' })];
    render(<KanbanBoard {...defaultProps()} tasks={tasks} />);
    expect(screen.queryByText(/Clear completed/)).toBeNull();
  });

  // 空列在 queued 列显示 drop hint
  it('shows drop hint in empty queued column', () => {
    render(<KanbanBoard {...defaultProps()} />);
    expect(screen.getByText('Drop tasks here to run')).toBeTruthy();
  });

  // 列头显示任务数量徽标
  it('shows task count badge on non-empty columns', () => {
    const tasks = [
      makeTask({ id: 't1', status: 'backlog' }),
      makeTask({ id: 't2', status: 'backlog' }),
    ];
    const { container } = render(<KanbanBoard {...defaultProps()} tasks={tasks} />);
    // Backlog 列应显示 "2"
    const badges = container.querySelectorAll('.bg-slate-800.rounded-full');
    const backlogBadge = Array.from(badges).find(el => el.textContent === '2');
    expect(backlogBadge).toBeTruthy();
  });
});
