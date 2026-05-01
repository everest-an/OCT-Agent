import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import Agents from '../pages/Agents';

describe('Agents page', () => {
  beforeEach(() => {
    // Ensure English locale
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
  });

  it('renders agent name "Claw" and emoji "🦞"', async () => {
    await act(async () => { render(<Agents />); });
    await waitFor(() => {
      expect(screen.getByText('Claw')).toBeInTheDocument();
      expect(screen.getByText('🦞')).toBeInTheDocument();
    });
  });

  it('shows "Default" badge for default agent', async () => {
    await act(async () => { render(<Agents />); });
    await waitFor(() => {
      expect(screen.getByText('Default')).toBeInTheDocument();
    });
  });

  it('shows binding "telegram"', async () => {
    await act(async () => { render(<Agents />); });
    await waitFor(() => {
      expect(screen.getByText('telegram')).toBeInTheDocument();
    });
  });

  it('opens wizard after clicking Create Agent', async () => {
    await act(async () => { render(<Agents />); });
    await waitFor(() => expect(screen.getByText(/Create Agent/i)).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText(/Create Agent/i)); });
    // Wizard should show step 1 with name input
    await waitFor(() => {
      expect(screen.getByText('Name your agent')).toBeInTheDocument();
    });
  });

  it('default agent does not have a delete button', async () => {
    await act(async () => { render(<Agents />); });
    await waitFor(() => {
      expect(screen.getByText('Claw')).toBeInTheDocument();
    });
    // Trash2 icon buttons have title or are inside agent cards.
    // The default agent (isDefault=true) should NOT render the Trash2 button.
    // There is only one agent in the mock, and it is default, so there should be no Trash2 at all.
    const allButtons = screen.getAllByRole('button');
    // Check none of the buttons is a delete button (Trash2 rendered with lucide-react)
    const deleteButtons = allButtons.filter(btn => {
      // The delete button has no title but contains an svg with class lucide-trash-2
      const svg = btn.querySelector('.lucide-trash-2');
      return svg !== null;
    });
    expect(deleteButtons).toHaveLength(0);
  });

  it('shows AGENTS.md in the agent file editor', async () => {
    await act(async () => { render(<Agents />); });
    await waitFor(() => {
      expect(screen.getByText('Claw')).toBeInTheDocument();
    });

    const editDefinitionButton = screen.getAllByRole('button').find((button) => button.getAttribute('title') === 'Edit Definition');
    expect(editDefinitionButton).toBeTruthy();

    await act(async () => {
      fireEvent.click(editDefinitionButton!);
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'AGENTS.md' })).toBeInTheDocument();
    });
  });

  it('uses official logo fallback instead of rendering the literal default placeholder', async () => {
    const api = window.electronAPI as any;
    api.agentsList = vi.fn().mockResolvedValue({
      success: true,
      agents: [{ id: 'oc-1', name: 'Research', emoji: 'default', isDefault: false, bindings: [] }],
    });

    await act(async () => { render(<Agents />); });

    await waitFor(() => {
      expect(screen.getByAltText('Research logo')).toBeInTheDocument();
    });
    expect(screen.queryByText(/^default$/i)).not.toBeInTheDocument();
  });

  // 删除非默认 agent：confirm 对话框确认后调用 agentsDelete
  it('deletes a non-default agent after confirm dialog', async () => {
    const api = window.electronAPI as any;
    api.agentsList = vi.fn().mockResolvedValue({
      success: true,
      agents: [
        { id: 'main', name: 'Claw', emoji: '🦞', isDefault: true, bindings: [] },
        { id: 'research', name: 'Research', emoji: '🧠', isDefault: false, bindings: [] },
      ],
    });
    api.agentsDelete = vi.fn().mockResolvedValue({ success: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await act(async () => { render(<Agents />); });
    await waitFor(() => expect(screen.getByText('Research')).toBeInTheDocument());

    // The delete button has title="Delete"
    const deleteButton = screen.getByTitle('Delete');
    expect(deleteButton).toBeTruthy();

    await act(async () => { fireEvent.click(deleteButton); });

    expect(window.confirm).toHaveBeenCalled();
    expect(api.agentsDelete).toHaveBeenCalledWith('research');
  });

  // 空 agent 列表显示空状态文案
  it('shows empty state when agent list is empty', async () => {
    const api = window.electronAPI as any;
    api.agentsList = vi.fn().mockResolvedValue({ success: true, agents: [] });

    await act(async () => { render(<Agents />); });
    await waitFor(() => {
      expect(screen.getByText(/No agents configured/i)).toBeInTheDocument();
    });
  });

  // 加载失败显示错误信息
  it('shows error when loading agents fails', async () => {
    const api = window.electronAPI as any;
    api.agentsList = vi.fn().mockResolvedValue({ success: false, error: 'Connection refused' });

    await act(async () => { render(<Agents />); });
    await waitFor(() => {
      expect(screen.getByText('Connection refused')).toBeInTheDocument();
    });
  });

  // 编辑 identity 时暴露 emoji grid（之前只有手敲 input，用户换 emoji 很困难）
  it('shows AgentEmojiPicker grid when editing an agent identity', async () => {
    const api = window.electronAPI as any;
    api.agentsList = vi.fn().mockResolvedValue({
      success: true,
      agents: [
        { id: 'main', name: 'Claw', emoji: '🦞', isDefault: true, bindings: [] },
      ],
    });

    await act(async () => { render(<Agents />); });
    await waitFor(() => expect(screen.getByText('Claw')).toBeInTheDocument());

    const editBtn = screen.getByTitle('Edit identity');
    await act(async () => { fireEvent.click(editBtn); });

    // Grid should expose every preset emoji as a clickable button (🧠, 🚀, 🦞 etc.).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '🧠' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '🚀' })).toBeInTheDocument();
    });

    // Current emoji (🦞) should be aria-pressed=true inside the grid.
    const lobster = screen.getByRole('button', { name: '🦞', pressed: true });
    expect(lobster).toBeTruthy();
  });

  it('syncs edit-identity state when user clicks a grid emoji', async () => {
    const api = window.electronAPI as any;
    api.agentsList = vi.fn().mockResolvedValue({
      success: true,
      agents: [
        { id: 'main', name: 'Claw', emoji: '🦞', isDefault: true, bindings: [] },
      ],
    });
    api.agentsSetIdentity = vi.fn().mockResolvedValue({ success: true });

    await act(async () => { render(<Agents />); });
    await waitFor(() => expect(screen.getByText('Claw')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTitle('Edit identity')); });

    // Click the brain emoji in the grid → parent state updates → Save calls IPC with 🧠.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '🧠' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle('Save'));
    });

    expect(api.agentsSetIdentity).toHaveBeenCalledWith(
      'main',
      expect.any(String), // name — unchanged Claw (editName was primed from agent.name)
      '🧠',
      expect.any(String), // avatar
      expect.any(String), // theme
    );
  });
});
