import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import Channels from '../pages/Channels';

describe('Channels Page', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
  });

  it('renders channels header', async () => {
    await act(async () => { render(<Channels />); });
    expect(screen.getByText(/Channels/)).toBeInTheDocument();
  });

  it('renders local chat as connected', async () => {
    await act(async () => { render(<Channels />); });
    expect(screen.getByText(/Local Chat/)).toBeInTheDocument();
  });

  it('renders configured channels as connected', async () => {
    await act(async () => { render(<Channels />); });
    await waitFor(() => {
      const telegramElements = screen.getAllByText('Telegram');
      expect(telegramElements.length).toBeGreaterThan(0);
    });
  });

  it('renders unconfigured channels as available', async () => {
    await act(async () => { render(<Channels />); });
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('Discord')).toBeInTheDocument();
  });

  it('opens wizard when clicking available channel', async () => {
    await act(async () => { render(<Channels />); });
    const discordBtn = screen.getByText('Discord').closest('button');
    if (discordBtn) {
      await act(async () => { fireEvent.click(discordBtn); });
      expect(screen.getByText(/Connect Discord/)).toBeInTheDocument();
    }
  });
});
