import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TaskCreateModal from '../components/task-center/TaskCreateModal';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const t = (key: string, fallback?: string) => fallback || key;

const defaultProps = () => ({
  t,
  agents: [{ id: 'main', name: 'Claw', emoji: '🦞' }] as const,
  onClose: vi.fn(),
  onCreate: vi.fn().mockResolvedValue(undefined),
});

describe('TaskCreateModal', () => {
  // 渲染所有 6 个场景卡片
  it('renders all scenario cards in step 1', () => {
    render(<TaskCreateModal {...defaultProps()} />);
    expect(screen.getByText('Build a Project')).toBeTruthy();
    expect(screen.getByText('Review Code')).toBeTruthy();
    expect(screen.getByText('Fix a Bug')).toBeTruthy();
    expect(screen.getByText('Write Docs')).toBeTruthy();
    expect(screen.getByText('Write Tests')).toBeTruthy();
    expect(screen.getByText('Something Else')).toBeTruthy();
  });

  // 显示第一步标题
  it('shows step 1 title', () => {
    render(<TaskCreateModal {...defaultProps()} />);
    expect(screen.getByText('What do you want AI to do?')).toBeTruthy();
  });

  // 点击场景后进入第二步
  it('transitions to step 2 after picking a scenario', () => {
    render(<TaskCreateModal {...defaultProps()} />);
    fireEvent.click(screen.getByText('Fix a Bug'));
    // 第二步标题
    expect(screen.getByText('A few more details')).toBeTruthy();
    // 场景徽标
    expect(screen.getByText('Fix a Bug')).toBeTruthy();
  });

  // 第二步显示描述输入框
  it('shows description textarea in step 2', () => {
    render(<TaskCreateModal {...defaultProps()} />);
    fireEvent.click(screen.getByText('Build a Project'));
    expect(screen.getByText('Describe what you need')).toBeTruthy();
  });

  // 第二步项目场景显示 tech chips
  it('shows tech stack chips for project scenario', () => {
    render(<TaskCreateModal {...defaultProps()} />);
    fireEvent.click(screen.getByText('Build a Project'));
    expect(screen.getByText('React')).toBeTruthy();
    expect(screen.getByText('Python')).toBeTruthy();
    expect(screen.getByText('Let AI decide')).toBeTruthy();
  });

  // 关闭按钮触发 onClose
  it('calls onClose when close button clicked', () => {
    const props = defaultProps();
    render(<TaskCreateModal {...props} />);
    const closeBtn = screen.getByLabelText('Close');
    fireEvent.click(closeBtn);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  // 输入描述后点击 Start 提交任务
  it('calls onCreate with correct params on submit', async () => {
    vi.useRealTimers(); // need real timers for async
    const props = defaultProps();
    render(<TaskCreateModal {...props} />);

    // 选择 bugfix 场景
    fireEvent.click(screen.getByText('Fix a Bug'));

    // 输入描述
    const textarea = screen.getByPlaceholderText('Describe the bug...');
    fireEvent.change(textarea, { target: { value: 'Login page crashes' } });

    // 点击 Start 按钮
    const startBtn = screen.getByText('Start');
    fireEvent.click(startBtn);

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalledTimes(1);
    });

    const callArgs = props.onCreate.mock.calls[0][0];
    expect(callArgs.title).toContain('Login page crashes');
    expect(callArgs.priority).toBe('high'); // bugfix = high priority
    expect(callArgs.agentId).toBe('main');
  });

  // 描述为空时 Start 按钮被禁用
  it('disables start button when description is empty', () => {
    render(<TaskCreateModal {...defaultProps()} />);
    fireEvent.click(screen.getByText('Fix a Bug'));
    const startBtn = screen.getByText('Start');
    expect(startBtn.closest('button')?.disabled).toBe(true);
  });

  // 自由文本输入 — 输入后出现 Next 按钮
  it('shows Next button when free text is entered', () => {
    render(<TaskCreateModal {...defaultProps()} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Do something cool' } });
    expect(screen.getByText('Next →')).toBeTruthy();
  });

  // 第二步可以点返回回到第一步
  it('can go back to step 1 from step 2', () => {
    render(<TaskCreateModal {...defaultProps()} />);
    fireEvent.click(screen.getByText('Fix a Bug'));
    expect(screen.getByText('A few more details')).toBeTruthy();

    // 找到返回按钮（ArrowLeft）
    const backBtns = screen.getAllByRole('button');
    const backBtn = backBtns.find(btn => btn.querySelector('svg') && btn.textContent === '');
    if (backBtn) fireEvent.click(backBtn);
    // 回到第一步
    expect(screen.getByText('What do you want AI to do?')).toBeTruthy();
  });
});
