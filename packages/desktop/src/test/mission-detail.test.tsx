import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MissionDetail from '../components/task-center/MissionDetail';
import type { Mission, MissionStep } from '../lib/mission-store';

// Mock react-markdown (不支持 jsdom 环境)
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <span>{children}</span>,
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
});

const t = (key: string, fallback?: string) => fallback || key;

function makeStep(overrides: Partial<MissionStep> = {}): MissionStep {
  return {
    id: 'step-1',
    agentId: 'coder',
    agentName: 'Coder',
    agentEmoji: '💻',
    role: 'Developer',
    instruction: 'Write code',
    status: 'waiting',
    ...overrides,
  };
}

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-1',
    goal: 'Build a snake game',
    status: 'running',
    steps: [
      makeStep({ id: 's1', status: 'done', role: 'Planner', result: 'Plan completed' }),
      makeStep({ id: 's2', status: 'running', role: 'Developer' }),
    ],
    createdAt: '2026-04-10T10:00:00.000Z',
    startedAt: '2026-04-10T10:00:01.000Z',
    currentStepIndex: 1,
    ...overrides,
  };
}

const defaultProps = () => ({
  mission: makeMission(),
  onBack: vi.fn(),
  onOpenChat: vi.fn(),
  onRetry: vi.fn(),
  onDelete: vi.fn(),
  t,
});

describe('MissionDetail', () => {
  // 渲染 mission 目标标题
  it('renders mission goal in header', () => {
    render(<MissionDetail {...defaultProps()} />);
    expect(screen.getByText('Build a snake game')).toBeTruthy();
  });

  // 渲染步骤时间线 — 显示每个 step 的 role
  it('renders step roles in timeline', () => {
    render(<MissionDetail {...defaultProps()} />);
    expect(screen.getByText('Planner')).toBeTruthy();
    expect(screen.getByText('Developer')).toBeTruthy();
  });

  // 显示 agent 数量
  it('shows agent count', () => {
    render(<MissionDetail {...defaultProps()} />);
    expect(screen.getByText(/2.*agents/)).toBeTruthy();
  });

  // 运行中 step 显示 "Working" 状态徽标
  it('shows Working badge for running step', () => {
    render(<MissionDetail {...defaultProps()} />);
    expect(screen.getByText('Working')).toBeTruthy();
  });

  // 已完成 step 显示 "Done" 状态徽标
  it('shows Done badge for completed step', () => {
    render(<MissionDetail {...defaultProps()} />);
    expect(screen.getByText('Done')).toBeTruthy();
  });

  // 运行中 mission 显示 streaming 文本
  it('renders streaming text for planning/running mission', () => {
    render(<MissionDetail {...defaultProps()} streamingText="Thinking about architecture..." />);
    expect(screen.getByText('Thinking about architecture...')).toBeTruthy();
  });

  // 完成的 mission 显示 Summary 结果
  it('renders mission result summary for done mission', () => {
    const mission = makeMission({
      status: 'done',
      result: 'Snake game built successfully!',
      steps: [makeStep({ id: 's1', status: 'done' })],
      completedAt: '2026-04-10T10:05:00.000Z',
    });
    render(<MissionDetail {...defaultProps()} mission={mission} />);
    expect(screen.getByText('Summary')).toBeTruthy();
    expect(screen.getByText('Snake game built successfully!')).toBeTruthy();
  });

  // 失败的 mission 显示错误信息
  it('renders error for failed mission', () => {
    const mission = makeMission({
      status: 'failed',
      error: 'Agent crashed unexpectedly',
      steps: [makeStep({ id: 's1', status: 'failed' })],
    });
    render(<MissionDetail {...defaultProps()} mission={mission} />);
    expect(screen.getByText('Agent crashed unexpectedly')).toBeTruthy();
  });

  // 点击返回按钮触发 onBack
  it('calls onBack when back button clicked', () => {
    const props = defaultProps();
    render(<MissionDetail {...props} />);
    // ArrowLeft 按钮是第一个 button
    // Find all buttons, the back button is the one with just an SVG (ArrowLeft)
    const allBtns = screen.getAllByRole('button');
    const backBtn = allBtns.find(btn => btn.querySelector('svg') && btn.textContent?.trim() === '');
    expect(backBtn).toBeTruthy();
    fireEvent.click(backBtn!);
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  // 删除按钮触发 onDelete
  it('calls onDelete when delete button clicked', () => {
    const props = defaultProps();
    render(<MissionDetail {...props} />);
    const deleteBtn = screen.getByText('Delete');
    fireEvent.click(deleteBtn);
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  // 失败 mission 显示 Retry 按钮
  it('shows retry button for failed mission', () => {
    const props = defaultProps();
    const mission = makeMission({ status: 'failed', error: 'timeout' });
    render(<MissionDetail {...props} mission={mission} />);
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  // 步骤有输出时可以展开查看详情
  it('can expand step output', () => {
    render(<MissionDetail {...defaultProps()} />);
    // Planner step has result='Plan completed', should show truncated preview
    expect(screen.getByText('Plan completed')).toBeTruthy();
  });
});
