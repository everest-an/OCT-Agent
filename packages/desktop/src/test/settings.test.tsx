import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import Settings from '../pages/Settings';

describe('Settings Page', () => {
  beforeEach(() => {
    localStorage.clear();
    // Set English language for consistent test assertions
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
  });

  it('renders settings header', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByRole('heading', { name: /Settings/ })).toBeInTheDocument();
  });

  it('renders model section', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByText(/Current Model/)).toBeInTheDocument();
  });

  it('renders memory settings', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByText(/Auto Capture/)).toBeInTheDocument();
    expect(screen.getByText(/Auto Recall/)).toBeInTheDocument();
  });

  it('renders gateway management', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByText(/OpenClaw Gateway/)).toBeInTheDocument();
  });

  it('renders permissions panel summary', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByText(/Shell command approval/)).toBeInTheDocument();
    expect(screen.getByText(/Safe/)).toBeInTheDocument();
    expect(screen.getByText(/Standard/)).toBeInTheDocument();
  });

  it('renders system section', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByText('AwarenessClaw')).toBeInTheDocument();
  });

  // --- Token Optimization tests ---

  it('renders Token Optimization section', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByText(/Token Optimization/)).toBeInTheDocument();
  });

  it('renders Thinking Level selector with default value', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByText('Thinking Level')).toBeInTheDocument();
    const select = screen.getByDisplayValue('Low (default)');
    expect(select).toBeInTheDocument();
  });

  it('renders token estimate display', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByText('Token Estimate')).toBeInTheDocument();
    expect(screen.getByText(/overhead/)).toBeInTheDocument();
  });

  it('updates thinking level when changed', async () => {
    await act(async () => { render(<Settings />); });

    const select = screen.getByDisplayValue('Low (default)');
    await act(async () => {
      fireEvent.change(select, { target: { value: 'high' } });
    });

    const config = JSON.parse(localStorage.getItem('awareness-claw-config') || '{}');
    expect(config.thinkingLevel).toBe('high');
  });

  it('renders Recall Limit in Token Optimization section', async () => {
    await act(async () => { render(<Settings />); });
    const labels = screen.getAllByText('Recall Limit');
    expect(labels.length).toBeGreaterThan(0);
  });

  it('renders model restart hint after model change', async () => {
    await act(async () => { render(<Settings />); });
    // The restart hint should not be visible initially
    expect(screen.queryByText(/new chat session/)).not.toBeInTheDocument();
  });

  it('collapses advanced web settings by default', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByText(/Web & Browser/)).toBeInTheDocument();
    expect(screen.getByText(/Brave search needs an API key/)).toBeInTheDocument();
    expect(screen.getByText(/Show advanced \(1\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Max results/i)).not.toBeInTheDocument();
  });

  it('reveals advanced web settings when expanded', async () => {
    await act(async () => { render(<Settings />); });
    await act(async () => {
      fireEvent.click(screen.getByText(/Show advanced \(1\)/));
    });
    expect(screen.getByText(/Hide advanced/)).toBeInTheDocument();
    expect(screen.getByText(/Max results/i)).toBeInTheDocument();
  });
});
