import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import Memory from '../pages/Memory';

describe('Memory Page', () => {
  it('renders memory page header', async () => {
    await act(async () => { render(<Memory />); });
    expect(screen.getByText(/AI 记忆/)).toBeInTheDocument();
  });

  it('renders search input', async () => {
    await act(async () => { render(<Memory />); });
    expect(screen.getByPlaceholderText(/搜索记忆/)).toBeInTheDocument();
  });

  it('renders category filter', async () => {
    await act(async () => { render(<Memory />); });
    expect(screen.getByText(/全部/)).toBeInTheDocument();
  });

  it('renders refresh button', async () => {
    await act(async () => { render(<Memory />); });
    expect(screen.getByText('刷新')).toBeInTheDocument();
  });

  it('shows fallback cards', async () => {
    await act(async () => { render(<Memory />); });
    // Wait for async load to complete and show mock cards
    const cards = await screen.findAllByText(/PostgreSQL/, {}, { timeout: 3000 });
    expect(cards.length).toBeGreaterThan(0);
  });
});
