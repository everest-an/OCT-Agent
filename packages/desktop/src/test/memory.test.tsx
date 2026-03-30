import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import Memory from '../pages/Memory';

describe('Memory Page', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
  });

  it('renders memory page header', async () => {
    await act(async () => { render(<Memory />); });
    const headers = screen.getAllByText(/Memory/);
    expect(headers.length).toBeGreaterThan(0);
  });

  it('renders search input', async () => {
    await act(async () => { render(<Memory />); });
    expect(screen.getByPlaceholderText(/Search|search/)).toBeInTheDocument();
  });

  it('renders category filter', async () => {
    await act(async () => { render(<Memory />); });
    expect(screen.getByText(/All/)).toBeInTheDocument();
  });

  it('renders refresh button', async () => {
    await act(async () => { render(<Memory />); });
    expect(screen.getByText(/Refresh/)).toBeInTheDocument();
  });

  it('shows fallback cards', async () => {
    await act(async () => { render(<Memory />); });
    const cards = await screen.findAllByText(/PostgreSQL/, {}, { timeout: 3000 });
    expect(cards.length).toBeGreaterThan(0);
  });

  it('renders Memory Architecture info toggle', async () => {
    await act(async () => { render(<Memory />); });
    expect(screen.getByText('Memory Architecture')).toBeInTheDocument();
  });

  it('expands Memory Architecture details on click', async () => {
    await act(async () => { render(<Memory />); });
    const toggle = screen.getByText('Memory Architecture');
    await act(async () => { fireEvent.click(toggle); });
    expect(screen.getByText('Awareness Memory')).toBeInTheDocument();
    expect(screen.getByText('OpenClaw Local')).toBeInTheDocument();
  });
});
