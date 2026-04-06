import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import Automation from '../pages/Automation';

describe('Automation - heartbeat persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
  });

  it('heartbeat defaults to off (not enabled)', async () => {
    await act(async () => { render(<Automation />); });
    // After clearing localStorage, heartbeat should be false
    const stored = localStorage.getItem('awareness-claw-heartbeat-enabled');
    expect(stored).toBe('false');
  });

  it('persists heartbeat enabled state to localStorage', async () => {
    await act(async () => { render(<Automation />); });

    // Find the heartbeat toggle
    const heartbeatSection = screen.getByText('Heartbeat Check');
    expect(heartbeatSection).toBeInTheDocument();

    // Toggle is in the same row as "Heartbeat Check"
    const toggles = screen.getAllByRole('button');
    const heartbeatToggle = toggles.find(btn => {
      const parent = btn.closest('.flex.items-center.justify-between');
      return parent?.textContent?.includes('Heartbeat Check');
    });

    if (heartbeatToggle) {
      await act(async () => { fireEvent.click(heartbeatToggle); });
      const stored = localStorage.getItem('awareness-claw-heartbeat-enabled');
      expect(stored).toBe('true');
    }
  });

  it('restores heartbeat state from localStorage', async () => {
    localStorage.setItem('awareness-claw-heartbeat-enabled', 'true');
    localStorage.setItem('awareness-claw-heartbeat-interval', '45');

    await act(async () => { render(<Automation />); });

    // Heartbeat should be enabled and interval should be 45
    const intervalText = screen.getByText('45 min');
    expect(intervalText).toBeInTheDocument();
  });

  it('creates a managed main-session heartbeat cron job', async () => {
    const cronAddFn = vi.fn(() => Promise.resolve({ success: true }));
    const origApi = (window as any).electronAPI;
    (window as any).electronAPI = {
      ...origApi,
      cronAdd: cronAddFn,
      cronList: vi.fn(() => Promise.resolve({ jobs: [] })),
    };

    await act(async () => { render(<Automation />); });

    const toggles = screen.getAllByRole('button');
    const heartbeatToggle = toggles.find((btn) => {
      const parent = btn.closest('.flex.items-center.justify-between');
      return parent?.textContent?.includes('Heartbeat Check');
    });

    if (heartbeatToggle) {
      await act(async () => { fireEvent.click(heartbeatToggle); });
    }

    await waitFor(() => {
      expect(cronAddFn).toHaveBeenCalledWith(expect.objectContaining({
        name: 'AwarenessClaw Heartbeat',
        cron: '*/30 * * * *',
        systemEvent: 'AwarenessClaw heartbeat check',
        sessionTarget: 'main',
        wakeMode: 'now',
      }));
    });

    (window as any).electronAPI = origApi;
  });
});
