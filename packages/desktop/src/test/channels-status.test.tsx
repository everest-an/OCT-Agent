import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import Channels from '../pages/Channels';

describe('Channels status from openclaw.json', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
  });

  it('shows configured channels as connected', async () => {
    const origApi = (window as any).electronAPI;
    (window as any).electronAPI = {
      ...origApi,
      channelListConfigured: () => Promise.resolve({ success: true, configured: ['telegram'] }),
    };

    await act(async () => { render(<Channels />); });
    await waitFor(() => {
      const telegramElements = screen.getAllByText('Telegram');
      expect(telegramElements.length).toBeGreaterThan(0);
    });

    (window as any).electronAPI = origApi;
  });

  it('shows unconfigured channels as available', async () => {
    const origApi = (window as any).electronAPI;
    (window as any).electronAPI = {
      ...origApi,
      channelListConfigured: () => Promise.resolve({ success: true, configured: [] }),
    };

    await act(async () => { render(<Channels />); });
    await waitFor(() => {
      expect(screen.getByText('Telegram')).toBeInTheDocument();
      expect(screen.getByText('WhatsApp')).toBeInTheDocument();
    });

    (window as any).electronAPI = origApi;
  });
});
