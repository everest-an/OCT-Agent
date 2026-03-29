import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import Settings from '../pages/Settings';

describe('Settings Page', () => {
  it('renders settings header', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByText(/设置/)).toBeInTheDocument();
  });

  it('renders model section', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByText(/当前模型/)).toBeInTheDocument();
  });

  it('renders memory settings', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByText(/自动记忆/)).toBeInTheDocument();
    expect(screen.getByText(/自动回忆/)).toBeInTheDocument();
  });

  it('renders gateway management', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByText(/OpenClaw Gateway/)).toBeInTheDocument();
  });

  it('renders diagnostics button', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByText(/系统诊断/)).toBeInTheDocument();
  });

  it('renders reset button', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByText('重置')).toBeInTheDocument();
  });
});
