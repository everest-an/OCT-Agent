import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import Dashboard from '../pages/Dashboard';

describe('Dashboard (Chat)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders chat page with empty state', async () => {
    await act(async () => { render(<Dashboard />); });
    expect(screen.getByText(/AI 助手/)).toBeInTheDocument();
  });

  it('renders suggested prompts', async () => {
    await act(async () => { render(<Dashboard />); });
    expect(screen.getByText(/学习计划/)).toBeInTheDocument();
  });

  it('renders AwarenessClaw in header', async () => {
    await act(async () => { render(<Dashboard />); });
    expect(screen.getByText('AwarenessClaw')).toBeInTheDocument();
  });

  it('renders input area', async () => {
    await act(async () => { render(<Dashboard />); });
    expect(screen.getByPlaceholderText(/输入消息/)).toBeInTheDocument();
  });

  it('clicking suggested prompt fills input', async () => {
    await act(async () => { render(<Dashboard />); });
    fireEvent.click(screen.getByText(/学习计划/));
    const textarea = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
    expect(textarea.value).toContain('学习计划');
  });

  it('persists sessions to localStorage after send', async () => {
    await act(async () => { render(<Dashboard />); });

    const textarea = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'test msg' } });
    });

    // Find and click send button (the last button with Send icon)
    const buttons = screen.getAllByRole('button');
    const sendBtn = buttons[buttons.length - 1];
    await act(async () => { fireEvent.click(sendBtn); });

    await waitFor(() => {
      const sessions = JSON.parse(localStorage.getItem('awareness-claw-sessions') || '[]');
      expect(sessions.length).toBeGreaterThan(0);
    });
  });
});
