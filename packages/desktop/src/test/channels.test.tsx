import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import Channels from '../pages/Channels';

describe('Channels Page', () => {
  it('renders channels header', async () => {
    await act(async () => { render(<Channels />); });
    expect(screen.getByText(/消息通道/)).toBeInTheDocument();
  });

  it('renders local chat as connected', async () => {
    await act(async () => { render(<Channels />); });
    expect(screen.getByText(/本地聊天/)).toBeInTheDocument();
  });

  it('renders available channels', async () => {
    await act(async () => { render(<Channels />); });
    expect(screen.getByText('Telegram')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('Discord')).toBeInTheDocument();
  });

  it('opens wizard when clicking channel', async () => {
    await act(async () => { render(<Channels />); });
    const buttons = screen.getAllByText('Telegram');
    await act(async () => { fireEvent.click(buttons[0].closest('button')!); });
    expect(screen.getByText(/连接 Telegram/)).toBeInTheDocument();
  });
});
