import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Automation from '../pages/Automation';

describe('Automation Page', () => {
  it('renders automation header', () => {
    render(<Automation />);
    expect(screen.getByText(/自动化/)).toBeInTheDocument();
  });

  it('renders heartbeat section', () => {
    render(<Automation />);
    expect(screen.getByText('Heartbeat')).toBeInTheDocument();
  });

  it('renders add task button', () => {
    render(<Automation />);
    expect(screen.getByText(/添加任务/)).toBeInTheDocument();
  });

  it('shows add form when clicking add task', () => {
    render(<Automation />);
    fireEvent.click(screen.getByText(/添加任务/));
    expect(screen.getByText(/添加定时任务/)).toBeInTheDocument();
  });

  it('shows preset templates', () => {
    render(<Automation />);
    fireEvent.click(screen.getByText(/添加任务/));
    const presets = screen.getAllByText(/每天早上/);
    expect(presets.length).toBeGreaterThan(0);
  });

  it('shows empty state when no jobs', async () => {
    const { container } = render(<Automation />);
    // Wait for async loadJobs to complete
    await new Promise(r => setTimeout(r, 100));
    expect(container.textContent).toContain('暂无定时任务');
  });
});
