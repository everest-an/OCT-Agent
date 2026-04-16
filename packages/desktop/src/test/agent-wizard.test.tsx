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
    expect(screen.getByText(/pick an icon/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: '🧠' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '🤖' }).className).toContain('ring-brand-500');
  });

  it('has no channel binding step (removed 2026-04-08 — routing managed on Channels page)', async () => {
    await act(async () => { render(<AgentWizard onComplete={vi.fn()} onCancel={vi.fn()} />); });
    // The wizard is now single-step: no Next button, no "Bind channels" step.
    expect(screen.queryByText(/Bind channels/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /next/i })).toBeNull();
    // The Create button is always visible on step 0.
    expect(screen.getByTestId('agent-create-btn')).toBeTruthy();
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const onCancel = vi.fn();
    await act(async () => { render(<AgentWizard onComplete={vi.fn()} onCancel={onCancel} />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /cancel/i })); });
    expect(onCancel).toHaveBeenCalled();
  });

  it('creates agent with selected emoji and returns agentId for chat navigation (single-step)', async () => {
    const api = window.electronAPI as any;
    api.agentsAdd = vi.fn().mockResolvedValue({ success: true, agentId: 'researcher' });
    api.agentsSetIdentity = vi.fn().mockResolvedValue({ success: true });
    api.agentsWriteFile = vi.fn().mockResolvedValue({ success: true });

    const onComplete = vi.fn();
    await act(async () => { render(<AgentWizard onComplete={onComplete} onCancel={vi.fn()} />); });

    // Single step: fill name then click Create directly.
    await act(async () => { fireEvent.change(screen.getByPlaceholderText(/Research/i), { target: { value: 'Researcher' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '🧠' })); });
    await act(async () => { fireEvent.click(screen.getByTestId('agent-create-btn')); });

    await waitFor(() => {
      expect(api.agentsAdd).toHaveBeenCalledWith('Researcher', undefined, undefined);
      expect(api.agentsSetIdentity).toHaveBeenCalledWith('researcher', 'Researcher', '🧠');
      expect(api.agentsWriteFile).toHaveBeenCalledWith(
        'researcher',
        'IDENTITY.md',
        expect.stringContaining('- **Emoji:** 🧠'),
      );
      expect(onComplete).toHaveBeenCalledWith('researcher');
    });
    // agentsBind must NOT be called — new agents don't touch bindings anymore.
    // (setup.ts mock defines api.agentsBind as a vi.fn that resolves { success: true })
    if (typeof api.agentsBind?.mock?.calls !== 'undefined') {
      expect(api.agentsBind.mock.calls.length).toBe(0);
    }
  });

  it('creates agent with default emoji when user does not pick one', async () => {
    const api = window.electronAPI as any;
    api.agentsAdd = vi.fn().mockResolvedValue({ success: true, agentId: 'researcher' });
    api.agentsSetIdentity = vi.fn().mockResolvedValue({ success: true });
    api.agentsWriteFile = vi.fn().mockResolvedValue({ success: true });

    const onComplete = vi.fn();
    await act(async () => { render(<AgentWizard onComplete={onComplete} onCancel={vi.fn()} />); });

    await act(async () => { fireEvent.change(screen.getByPlaceholderText(/Research/i), { target: { value: 'Researcher' } }); });
    await act(async () => { fireEvent.click(screen.getByTestId('agent-create-btn')); });

    await waitFor(() => {
      expect(api.agentsSetIdentity).toHaveBeenCalledWith('researcher', 'Researcher', '🤖');
      expect(api.agentsWriteFile).toHaveBeenCalledWith(
        'researcher',
        'IDENTITY.md',
        expect.stringContaining('- **Emoji:** 🤖'),
      );
      expect(onComplete).toHaveBeenCalledWith('researcher');
    });
  });

  it('shows error when creation fails (single-step)', async () => {
    const api = window.electronAPI as any;
    api.agentsAdd = vi.fn().mockResolvedValue({ success: false, error: 'Permission denied' });

    await act(async () => { render(<AgentWizard onComplete={vi.fn()} onCancel={vi.fn()} />); });
    await act(async () => { fireEvent.change(screen.getByPlaceholderText(/Research/i), { target: { value: 'test' } }); });
    await act(async () => { fireEvent.click(screen.getByTestId('agent-create-btn')); });

    await waitFor(() => { expect(screen.getByText(/permission denied/i)).toBeTruthy(); });
  });

  it('rejects id-like name pattern oc-<digits> in wizard', async () => {
    const api = window.electronAPI as any;
    api.agentsAdd = vi.fn().mockResolvedValue({ success: true, agentId: 'unexpected' });

    await act(async () => { render(<AgentWizard onComplete={vi.fn()} onCancel={vi.fn()} />); });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/Research/i), { target: { value: 'oc-1775820266907' } });
    });
    await act(async () => { fireEvent.click(screen.getByTestId('agent-create-btn')); });

    await waitFor(() => {
      expect(screen.getByText(/system\/reserved id/i)).toBeInTheDocument();
    });
    expect(api.agentsAdd).not.toHaveBeenCalled();
  });

  it('continues when agent already exists (single-step)', async () => {
    const onComplete = vi.fn();
    const api = window.electronAPI as any;
    api.agentsAdd = vi.fn().mockResolvedValue({ success: false, error: 'already exists' });
    api.agentsSetIdentity = vi.fn().mockResolvedValue({ success: true });
    api.agentsWriteFile = vi.fn().mockResolvedValue({ success: true });

    await act(async () => { render(<AgentWizard onComplete={onComplete} onCancel={vi.fn()} />); });
    await act(async () => { fireEvent.change(screen.getByPlaceholderText(/Research/i), { target: { value: 'test' } }); });
    await act(async () => { fireEvent.click(screen.getByTestId('agent-create-btn')); });

    await waitFor(() => { expect(onComplete).toHaveBeenCalled(); });
  });

  it('shows bootstrap hint', async () => {
    await act(async () => { render(<AgentWizard onComplete={vi.fn()} onCancel={vi.fn()} />); });
    expect(screen.getByText(/start a conversation/i)).toBeTruthy();
  });

  // 空名称时 Create 按钮应被禁用
  it('disables Create button when name is empty', async () => {
    await act(async () => { render(<AgentWizard onComplete={vi.fn()} onCancel={vi.fn()} />); });
    const createBtn = screen.getByTestId('agent-create-btn');
    expect(createBtn).toBeDisabled();
  });

  // 超长名称（>64字符）应显示错误
  it('shows error when name exceeds 64 characters', async () => {
    await act(async () => { render(<AgentWizard onComplete={vi.fn()} onCancel={vi.fn()} />); });
    const longName = 'A'.repeat(65);
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/Research/i), { target: { value: longName } });
    });
    await act(async () => { fireEvent.click(screen.getByTestId('agent-create-btn')); });

    await waitFor(() => {
      expect(screen.getByText(/max 64 characters/i)).toBeInTheDocument();
    });
  });

  // Enter 键提交（当名称有效时）
  it('submits on Enter key when name is valid', async () => {
    const api = window.electronAPI as any;
    api.agentsAdd = vi.fn().mockResolvedValue({ success: true, agentId: 'my-agent' });
    api.agentsSetIdentity = vi.fn().mockResolvedValue({ success: true });
    api.agentsWriteFile = vi.fn().mockResolvedValue({ success: true });

    const onComplete = vi.fn();
    await act(async () => { render(<AgentWizard onComplete={onComplete} onCancel={vi.fn()} />); });

    const input = screen.getByPlaceholderText(/Research/i);
    await act(async () => { fireEvent.change(input, { target: { value: 'MyAgent' } }); });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });

    await waitFor(() => {
      expect(api.agentsAdd).toHaveBeenCalledWith('MyAgent', undefined, undefined);
      expect(onComplete).toHaveBeenCalledWith('my-agent');
    });
  });
});
