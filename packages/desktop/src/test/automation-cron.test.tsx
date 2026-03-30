import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Automation from '../pages/Automation';

describe('Automation cron visual selector', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
  });

  it('renders frequency selector with Daily, Hourly, Weekly, Custom after clicking Add Task', () => {
    render(<Automation />);
    fireEvent.click(screen.getByText(/Add Task/));

    expect(screen.getByText('Daily')).toBeInTheDocument();
    expect(screen.getByText('Hourly')).toBeInTheDocument();
    expect(screen.getByText('Weekly')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });

  it('defaults to Daily frequency with time picker visible', () => {
    render(<Automation />);
    fireEvent.click(screen.getByText(/Add Task/));

    // Daily button should have active styling (bg-brand-600)
    const dailyBtn = screen.getByText('Daily');
    expect(dailyBtn.className).toContain('bg-brand-600');

    // Time picker label should be visible
    expect(screen.getByText('Time')).toBeInTheDocument();
  });

  it('switching to Hourly shows minute picker', () => {
    render(<Automation />);
    fireEvent.click(screen.getByText(/Add Task/));
    fireEvent.click(screen.getByText('Hourly'));

    expect(screen.getByText('At minute')).toBeInTheDocument();
  });

  it('switching to Weekly shows weekday buttons', () => {
    render(<Automation />);
    fireEvent.click(screen.getByText(/Add Task/));
    fireEvent.click(screen.getByText('Weekly'));

    // Weekday buttons should appear
    expect(screen.getByText('Mon')).toBeInTheDocument();
    expect(screen.getByText('Tue')).toBeInTheDocument();
    expect(screen.getByText('Wed')).toBeInTheDocument();
    expect(screen.getByText('Thu')).toBeInTheDocument();
    expect(screen.getByText('Fri')).toBeInTheDocument();
    expect(screen.getByText('Sat')).toBeInTheDocument();
    expect(screen.getByText('Sun')).toBeInTheDocument();
  });

  it('switching to Custom shows cron expression input', () => {
    render(<Automation />);
    fireEvent.click(screen.getByText(/Add Task/));
    fireEvent.click(screen.getByText('Custom'));

    expect(screen.getByText('Cron expression')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/daily at 9 AM/)).toBeInTheDocument();
  });

  it('preset buttons fill in schedule and command', () => {
    render(<Automation />);
    fireEvent.click(screen.getByText(/Add Task/));

    // Click the "Daily 9 AM" preset
    fireEvent.click(screen.getByText('Daily 9 AM'));

    // Command textarea should be filled with the preset command
    const textarea = screen.getByPlaceholderText(/to-do list/) as HTMLTextAreaElement;
    expect(textarea.value).toContain('to-do');
  });

  it('calls cronList on mount to load existing jobs', async () => {
    const cronListFn = vi.fn(() => Promise.resolve({ jobs: [] }));
    const origApi = (window as any).electronAPI;
    (window as any).electronAPI = { ...origApi, cronList: cronListFn };

    render(<Automation />);

    await waitFor(() => {
      expect(cronListFn).toHaveBeenCalled();
    });

    (window as any).electronAPI = origApi;
  });

  it('displays existing cron jobs returned by cronList', async () => {
    const origApi = (window as any).electronAPI;
    (window as any).electronAPI = {
      ...origApi,
      cronList: vi.fn(() => Promise.resolve({
        jobs: [
          { id: '1', expression: '0 9 * * *', command: 'Check todos' },
          { id: '2', expression: '30 22 * * *', command: 'Daily summary' },
        ],
      })),
    };

    render(<Automation />);

    await waitFor(() => {
      expect(screen.getByText('Check todos')).toBeInTheDocument();
      expect(screen.getByText('Daily summary')).toBeInTheDocument();
    });

    // Cron expressions should also be visible
    expect(screen.getByText('0 9 * * *')).toBeInTheDocument();
    expect(screen.getByText('30 22 * * *')).toBeInTheDocument();

    (window as any).electronAPI = origApi;
  });

  it('shows empty state when cronList returns no jobs', async () => {
    render(<Automation />);

    await waitFor(() => {
      expect(screen.getByText(/No scheduled tasks/)).toBeInTheDocument();
    });
  });
});
