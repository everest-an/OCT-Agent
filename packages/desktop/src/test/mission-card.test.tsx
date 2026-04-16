import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MissionCard from '../components/task-center/MissionCard';
import type { Mission, MissionStep } from '../lib/mission-store';

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
      makeStep({ id: 's1', status: 'done' }),
      makeStep({ id: 's2', status: 'running', role: 'Tester', agentEmoji: '🧪' }),
    ],
    createdAt: '2026-04-10T10:00:00.000Z',
    startedAt: '2026-04-10T10:00:01.000Z',
    currentStepIndex: 1,
    ...overrides,
  };
}

describe('MissionCard', () => {
  // 渲染 mission 目标名称
  it('renders mission goal', () => {
    render(<MissionCard mission={makeMission()} onClick={vi.fn()} t={t} />);
    expect(screen.getByText('Build a snake game')).toBeTruthy();
  });

  // 显示进度百分比
  it('shows progress percentage', () => {
    // 2 steps, 1 done = 50%
    render(<MissionCard mission={makeMission()} onClick={vi.fn()} t={t} />);
    expect(screen.getByText('50%')).toBeTruthy();
  });

  // 完成的 mission 显示 100%
  it('shows 100% for completed mission', () => {
    const mission = makeMission({
      status: 'done',
      steps: [
        makeStep({ id: 's1', status: 'done' }),
        makeStep({ id: 's2', status: 'done' }),
      ],
      completedAt: '2026-04-10T10:05:00.000Z',
    });
    render(<MissionCard mission={mission} onClick={vi.fn()} t={t} />);
    expect(screen.getByText('100%')).toBeTruthy();
  });

  // 点击卡片触发 onClick 回调
  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<MissionCard mission={makeMission()} onClick={onClick} t={t} />);
    const btn = screen.getByText('Build a snake game').closest('button')!;
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // 失败的 mission 显示失败提示文本
  it('shows failed text for failed mission', () => {
    const mission = makeMission({
      status: 'failed',
      currentStepIndex: -1,
      steps: [makeStep({ id: 's1', status: 'failed' })],
    });
    render(<MissionCard mission={mission} onClick={vi.fn()} t={t} />);
    expect(screen.getByText('A step failed')).toBeTruthy();
  });

  // 完成的 mission 显示 "All agents finished"
  it('shows all done text for completed mission', () => {
    const mission = makeMission({
      status: 'done',
      currentStepIndex: -1,
      steps: [makeStep({ id: 's1', status: 'done' })],
      completedAt: '2026-04-10T10:05:00.000Z',
    });
    render(<MissionCard mission={mission} onClick={vi.fn()} t={t} />);
    expect(screen.getByText('All agents finished')).toBeTruthy();
  });

  // 运行中 step 显示 working 文本
  it('shows working text for running step', () => {
    render(<MissionCard mission={makeMission()} onClick={vi.fn()} t={t} />);
    expect(screen.getByText(/Tester.*working/)).toBeTruthy();
  });

  // 渲染 agent 头像 emoji
  it('renders agent emojis', () => {
    render(<MissionCard mission={makeMission()} onClick={vi.fn()} t={t} />);
    expect(screen.getByText('💻')).toBeTruthy();
    expect(screen.getByText('🧪')).toBeTruthy();
  });
});
