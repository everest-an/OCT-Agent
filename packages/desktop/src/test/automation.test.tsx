import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Automation from '../pages/Automation';

describe('Automation Page', () => {
  it('renders automation header', () => {
    render(<Automation />);
    expect(screen.getByText('Automation')).toBeInTheDocument();
  });

  it('renders heartbeat section', () => {
    render(<Automation />);
    expect(screen.getByText('Heartbeat / Long Task Frequency')).toBeInTheDocument();
  });

  it('renders add task button', () => {
    render(<Automation />);
    expect(screen.getByText(/Add Task/)).toBeInTheDocument();
  });

  it('shows add form when clicking add task', () => {
    render(<Automation />);
    fireEvent.click(screen.getByText(/Add Task/));
    expect(screen.getByText(/New Scheduled Task/)).toBeInTheDocument();
  });

  it('shows preset templates', () => {
    render(<Automation />);
    fireEvent.click(screen.getByText(/Add Task/));
    const presets = screen.getAllByText(/Daily 9 AM/);
    expect(presets.length).toBeGreaterThan(0);
  });

  it('shows empty state when no jobs', async () => {
    const { container } = render(<Automation />);
    await new Promise(r => setTimeout(r, 100));
    expect(container.textContent).toContain('No scheduled tasks');
  });

  it('shows frequency selector in add form', () => {
    render(<Automation />);
    fireEvent.click(screen.getByText(/Add Task/));
    expect(screen.getByText('Daily')).toBeInTheDocument();
    expect(screen.getByText('Hourly')).toBeInTheDocument();
    expect(screen.getByText('Weekly')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });
});
