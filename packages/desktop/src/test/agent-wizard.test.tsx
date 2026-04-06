import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AgentWizard from '../components/AgentWizard';

describe('AgentWizard', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
    vi.restoreAllMocks();
  });

  it('renders with name input and emoji picker', async () => {
    await act(async () => { render(<AgentWizard onComplete={vi.fn()} onCancel={vi.fn()} />); });
    expect(screen.getByText('Name your agent')).toBeTruthy();
    expect(screen.getByPlaceholderText(/Research/i)).toBeTruthy();
  });

  it('navigates to channel binding step', async () => {
    await act(async () => { render(<AgentWizard onComplete={vi.fn()} onCancel={vi.fn()} />); });
    const nameInput = screen.getByPlaceholderText(/Research/i);
    await act(async () => { fireEvent.change(nameInput, { target: { value: 'Test' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /next/i })); });
    expect(screen.getByText('Bind channels')).toBeTruthy();
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const onCancel = vi.fn();
    await act(async () => { render(<AgentWizard onComplete={vi.fn()} onCancel={onCancel} />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /cancel/i })); });
    expect(onCancel).toHaveBeenCalled();
  });

  it('creates agent and returns agentId for chat navigation', async () => {
    const api = window.electronAPI as any;
    api.agentsAdd = vi.fn().mockResolvedValue({ success: true, agentId: 'researcher' });
    api.agentsSetIdentity = vi.fn().mockResolvedValue({ success: true });
    api.agentsWriteFile = vi.fn().mockResolvedValue({ success: true });

    const onComplete = vi.fn();
    await act(async () => { render(<AgentWizard onComplete={onComplete} onCancel={vi.fn()} />); });

    // Step 0: name
    await act(async () => { fireEvent.change(screen.getByPlaceholderText(/Research/i), { target: { value: 'Researcher' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /next/i })); });

    // Step 1: skip channels, create
    await act(async () => { fireEvent.click(screen.getByTestId('agent-create-btn')); });

    await waitFor(() => {
      expect(api.agentsAdd).toHaveBeenCalledWith('Researcher', undefined, undefined);
      expect(api.agentsWriteFile).toHaveBeenCalledWith(
        'researcher',
        'IDENTITY.md',
        expect.not.stringContaining('default'),
      );
      expect(onComplete).toHaveBeenCalledWith('researcher');
    });
  });

  it('shows error when creation fails', async () => {
    const api = window.electronAPI as any;
    api.agentsAdd = vi.fn().mockResolvedValue({ success: false, error: 'Permission denied' });

    await act(async () => { render(<AgentWizard onComplete={vi.fn()} onCancel={vi.fn()} />); });
    await act(async () => { fireEvent.change(screen.getByPlaceholderText(/Research/i), { target: { value: 'test' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /next/i })); });
    await act(async () => { fireEvent.click(screen.getByTestId('agent-create-btn')); });

    await waitFor(() => { expect(screen.getByText(/permission denied/i)).toBeTruthy(); });
  });

  it('continues when agent already exists', async () => {
    const onComplete = vi.fn();
    const api = window.electronAPI as any;
    api.agentsAdd = vi.fn().mockResolvedValue({ success: false, error: 'already exists' });
    api.agentsSetIdentity = vi.fn().mockResolvedValue({ success: true });
    api.agentsWriteFile = vi.fn().mockResolvedValue({ success: true });

    await act(async () => { render(<AgentWizard onComplete={onComplete} onCancel={vi.fn()} />); });
    await act(async () => { fireEvent.change(screen.getByPlaceholderText(/Research/i), { target: { value: 'test' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /next/i })); });
    await act(async () => { fireEvent.click(screen.getByTestId('agent-create-btn')); });

    await waitFor(() => { expect(onComplete).toHaveBeenCalled(); });
  });

  it('shows bootstrap hint', async () => {
    await act(async () => { render(<AgentWizard onComplete={vi.fn()} onCancel={vi.fn()} />); });
    expect(screen.getByText(/start a conversation/i)).toBeTruthy();
  });
});
