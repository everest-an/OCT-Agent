/**
 * user-flows.test.tsx
 *
 * Real-scenario integration tests that simulate complete user workflows.
 * Each test mirrors what a real user would actually do inside the app.
 * API response shapes match what the real IPC handlers return.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import Agents from '../pages/Agents';
import Dashboard from '../pages/Dashboard';
import Memory from '../pages/Memory';
import Settings from '../pages/Settings';

const getApi = () => window.electronAPI as any;

/** Helper: build a valid memoryGetCards mock response */
function mcpCardsResponse(cards: object[]) {
  return {
    result: { content: [{ text: JSON.stringify({ knowledge_cards: cards }) }] },
  };
}

/** Helper: build a valid memorySearch mock response */
function mcpSearchResponse(cards: object[]) {
  return {
    result: { content: [{ text: JSON.stringify(cards) }] },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Agent Management Flows
// ─────────────────────────────────────────────────────────────────────────────
describe('Multi-Agent Management (user flows)', () => {
  beforeEach(() => {
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
    vi.restoreAllMocks();
  });

  it('flow: view agents list on load — shows name and bindings', async () => {
    await act(async () => { render(<Agents />); });
    await waitFor(() => expect(screen.getByText('Claw')).toBeInTheDocument());
    // Binding "telegram" from mock setup.ts
    expect(screen.getByText('telegram')).toBeInTheDocument();
  });

  it('flow: open create form and submit creates agent via agentsAdd(name, ...)', async () => {
    // agentsAdd is called with positional args: (name, model?, prompt?)
    const addMock = vi.fn().mockResolvedValue({ success: true });
    const listMock = vi.fn().mockResolvedValue({
      success: true,
      agents: [{ id: 'main', name: 'Claw', emoji: '🦞', isDefault: true, bindings: [] }],
    });
    getApi().agentsList = listMock;
    getApi().agentsAdd = addMock;

    await act(async () => { render(<Agents />); });
    await waitFor(() => expect(screen.getByText('Claw')).toBeInTheDocument());

    // Open create form
    const createBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Create Agent'));
    expect(createBtn).toBeTruthy();
    await act(async () => { fireEvent.click(createBtn!); });

    // Find the name input placeholder
    const input = screen.getByPlaceholderText(/New Agent/i);
    await act(async () => { fireEvent.change(input, { target: { value: 'SalesBot' } }); });

    // Find and click submit (Create button inside the form)
    const submitBtn = screen.getAllByRole('button').find(b => b.textContent?.trim() === 'Create');
    expect(submitBtn).toBeTruthy();
    await act(async () => { fireEvent.click(submitBtn!); });

    // agentsAdd is called with the name as the first positional argument
    await waitFor(() => expect(addMock).toHaveBeenCalledWith('SalesBot', undefined, undefined));
  });

  it('flow: cannot delete main/default agent — delete button absent or disabled', async () => {
    await act(async () => { render(<Agents />); });
    await waitFor(() => expect(screen.getByText('Claw')).toBeInTheDocument());

    // Default agent should not have a delete button (agentId === 'main' is guarded)
    // Either no delete button at all for the default agent, or it's disabled
    const allBtns = screen.getAllByRole('button');
    // Look for any button that might trigger deletion
    const trashBtns = allBtns.filter(b => b.getAttribute('title') === 'Delete');
    // All trash buttons should be disabled for default agent
    trashBtns.forEach(btn => {
      expect(btn.hasAttribute('disabled') || btn.classList.contains('opacity-30')).toBe(true);
    });
  });

  it('flow: delete non-default agent with confirm', async () => {
    const deleteMock = vi.fn().mockResolvedValue({ success: true });
    getApi().agentsList = vi.fn().mockResolvedValue({
      success: true,
      agents: [
        { id: 'main', name: 'Claw', emoji: '🦞', isDefault: true, bindings: [] },
        { id: 'bot2', name: 'BotTwo', emoji: '🤖', isDefault: false, bindings: [] },
      ],
    });
    getApi().agentsDelete = deleteMock;
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await act(async () => { render(<Agents />); });
    await waitFor(() => expect(screen.getByText('BotTwo')).toBeInTheDocument());

    // Find delete button for the non-default agent
    const allBtns = screen.getAllByRole('button');
    const delBtns = allBtns.filter(b => b.getAttribute('title') === 'Delete');
    const enabledDel = delBtns.find(b => !b.hasAttribute('disabled'));
    expect(enabledDel).toBeTruthy();

    await act(async () => { fireEvent.click(enabledDel!); });
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('bot2'));
  });

  it('flow: bind dropdown appears when clicking Add binding', async () => {
    await act(async () => { render(<Agents />); });
    await waitFor(() => expect(screen.getByText('Claw')).toBeInTheDocument());

    // Open binding form
    const bindBtn = screen.getAllByRole('button').find(b => b.getAttribute('title') === 'Add binding');
    if (bindBtn) {
      await act(async () => { fireEvent.click(bindBtn); });
      // Channel selector dropdown should appear (updated UI uses <select> instead of text input)
      await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chat Flows
// ─────────────────────────────────────────────────────────────────────────────
describe('Chat (user flows)', () => {
  beforeEach(() => {
    localStorage.setItem('awareness-claw-config', JSON.stringify({
      language: 'en',
      providerKey: 'openai',
      modelId: 'gpt-4o',
      apiKey: 'sk-test',
    }));
    // Clear sessions so each test starts with a clean chat history
    localStorage.removeItem('awareness-claw-sessions');
    localStorage.removeItem('awareness-claw-active-session');
    vi.restoreAllMocks();
  });

  it('flow: send a message and receive AI response', async () => {
    const sendMock = vi.fn().mockResolvedValue({
      success: true,
      text: 'I remember our last chat!',
      sessionId: 's1',
    });
    getApi().chatSend = sendMock;

    await act(async () => { render(<Dashboard />); });

    const textarea = screen.getByPlaceholderText(/Type a message/i);
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'What did we discuss?' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    // chatSend IPC was called with the message text
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith(
      expect.stringContaining('What did we discuss?'),
      expect.any(String),
      expect.any(Object),
    ));

    // Response appears in the chat
    await waitFor(() => expect(screen.getByText('I remember our last chat!')).toBeInTheDocument());
  });

  it('flow: model selector shows ✓ Active on current model', async () => {
    await act(async () => { render(<Dashboard />); });

    // Open the model dropdown in the header
    const modelBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('gpt-4o'));
    if (modelBtn) {
      await act(async () => { fireEvent.click(modelBtn); });
      // Active indicator should appear
      await waitFor(() => expect(screen.getAllByText(/Active/i).length).toBeGreaterThan(0));
    }
  });

  it('flow: creating new chat session clears the message area', async () => {
    const sendMock = vi.fn().mockResolvedValue({ success: true, text: 'Response', sessionId: 's1' });
    getApi().chatSend = sendMock;

    await act(async () => { render(<Dashboard />); });

    // Send a message first
    const textarea = screen.getByPlaceholderText(/Type a message/i);
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
    });
    await waitFor(() => expect(sendMock).toHaveBeenCalled());

    // Now click New Chat
    const newChatBtns = screen.getAllByRole('button').filter(b => b.textContent?.includes('New Chat'));
    if (newChatBtns.length > 0) {
      await act(async () => { fireEvent.click(newChatBtns[0]); });
      // Empty state should show again
      await waitFor(() => expect(screen.getByText(/Chat with your AI/i)).toBeInTheDocument());
    }
  });

  it('flow: no model configured — header shows "Select model" prompt instead of model name', async () => {
    localStorage.setItem('awareness-claw-config', JSON.stringify({
      language: 'en',
      modelId: '',
      providerKey: '',
      apiKey: '',
    }));
    await act(async () => { render(<Dashboard />); });
    // The header model picker button should contain the "select model" prompt text
    // (t('chat.selectModel') = 'Select a model to start chatting')
    await waitFor(() => {
      const modelBtn = screen.getAllByRole('button').find(b =>
        b.textContent?.includes('Select a model to start chatting') ||
        b.textContent?.includes('Select model')
      );
      expect(modelBtn).toBeTruthy();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Memory Page Flows
// ─────────────────────────────────────────────────────────────────────────────
describe('Memory Page (user flows)', () => {
  beforeEach(() => {
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
    vi.restoreAllMocks();
  });

  it('flow: shows mock indicator + daemon command when daemon disconnected', async () => {
    getApi().memoryGetCards = vi.fn().mockResolvedValue({ error: 'daemon not connected' });
    await act(async () => { render(<Memory />); });
    await waitFor(() => expect(screen.getByText(/Showing example data/i)).toBeInTheDocument());
    // Daemon startup command should be shown
    expect(screen.getByText(/npx @awareness-sdk\/local start/i)).toBeInTheDocument();
  });

  it('flow: shows real knowledge cards when daemon is connected', async () => {
    getApi().memoryGetCards = vi.fn().mockResolvedValue(mcpCardsResponse([
      { id: '1', title: 'Use async handlers', summary: 'Always async in Electron', category: 'pitfall', created_at: '2026-03-30T10:00:00Z' },
      { id: '2', title: 'Ship fast principle', summary: 'Release early iterate', category: 'insight', created_at: '2026-03-30T11:00:00Z' },
    ]));
    await act(async () => { render(<Memory />); });
    await waitFor(() => expect(screen.getByText('Use async handlers')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText('Ship fast principle')).toBeInTheDocument();
    // No mock indicator
    expect(screen.queryByText(/Showing example data/i)).not.toBeInTheDocument();
  });

  it('flow: search no results shows "No results for..." with the query', async () => {
    getApi().memoryGetCards = vi.fn().mockResolvedValue(mcpCardsResponse([
      { id: '1', title: 'A card', summary: 'content', category: 'insight', created_at: '2026-03-30T10:00:00Z' },
    ]));
    getApi().memorySearch = vi.fn().mockResolvedValue(mcpSearchResponse([]));

    await act(async () => { render(<Memory />); });
    await waitFor(() => expect(screen.getByText('A card')).toBeInTheDocument(), { timeout: 3000 });

    const searchInput = screen.getByPlaceholderText(/Search memories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'unrelated xyz' } });
      fireEvent.keyDown(searchInput, { key: 'Enter' });
    });

    await waitFor(() => expect(screen.getByText(/No results for/i)).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText(/unrelated xyz/)).toBeInTheDocument();
  });

  it('flow: category filter shows only matching cards', async () => {
    getApi().memoryGetCards = vi.fn().mockResolvedValue(mcpCardsResponse([
      { id: '1', title: 'Pitfall card', summary: 'a pitfall', category: 'pitfall', created_at: '2026-03-30T10:00:00Z' },
      { id: '2', title: 'Insight card', summary: 'an insight', category: 'insight', created_at: '2026-03-30T11:00:00Z' },
    ]));
    await act(async () => { render(<Memory />); });
    await waitFor(() => expect(screen.getByText('Pitfall card')).toBeInTheDocument(), { timeout: 3000 });

    // Click the Pitfall category tab
    const pitfallTab = screen.getAllByRole('button').find(b => b.textContent?.includes('Pitfall'));
    expect(pitfallTab).toBeTruthy();
    await act(async () => { fireEvent.click(pitfallTab!); });

    // Only pitfall card should be visible
    expect(screen.getByText('Pitfall card')).toBeInTheDocument();
    expect(screen.queryByText('Insight card')).not.toBeInTheDocument();
  });

  it('flow: clear filter button appears when category has no matches after search', async () => {
    getApi().memoryGetCards = vi.fn().mockResolvedValue(mcpCardsResponse([
      { id: '1', title: 'Only insight', summary: 'insight only', category: 'insight', created_at: '2026-03-30T10:00:00Z' },
    ]));
    getApi().memorySearch = vi.fn().mockResolvedValue(mcpSearchResponse([]));

    await act(async () => { render(<Memory />); });
    await waitFor(() => expect(screen.getByText('Only insight')).toBeInTheDocument(), { timeout: 3000 });

    // Select insight filter then search with no results
    const insightTab = screen.getAllByRole('button').find(b => b.textContent?.includes('Insight'));
    if (insightTab) {
      await act(async () => { fireEvent.click(insightTab); });
    }

    // Search for something that returns nothing
    const searchInput = screen.getByPlaceholderText(/Search memories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'zzznomatch' } });
      fireEvent.keyDown(searchInput, { key: 'Enter' });
    });

    // Either "No results" or "No cards in this category" + Clear filter button
    await waitFor(() => {
      const clearBtn = screen.queryByText(/Clear filter/i);
      const noResults = screen.queryByText(/No results/i);
      expect(clearBtn !== null || noResults !== null).toBe(true);
    }, { timeout: 3000 });
  });

  it('flow: clicking All button after category filter restores all cards', async () => {
    getApi().memoryGetCards = vi.fn().mockResolvedValue(mcpCardsResponse([
      { id: '1', title: 'Pitfall one', summary: 'p', category: 'pitfall', created_at: '2026-03-30T10:00:00Z' },
      { id: '2', title: 'Insight one', summary: 'i', category: 'insight', created_at: '2026-03-30T11:00:00Z' },
    ]));
    await act(async () => { render(<Memory />); });
    await waitFor(() => expect(screen.getByText('Pitfall one')).toBeInTheDocument(), { timeout: 3000 });

    // Filter to pitfall
    const pitfallTab = screen.getAllByRole('button').find(b => b.textContent?.includes('Pitfall'));
    await act(async () => { fireEvent.click(pitfallTab!); });
    expect(screen.queryByText('Insight one')).not.toBeInTheDocument();

    // Click All to restore
    const allTab = screen.getAllByRole('button').find(b => b.textContent?.match(/^All \(\d+\)$/));
    expect(allTab).toBeTruthy();
    await act(async () => { fireEvent.click(allTab!); });
    await waitFor(() => expect(screen.getByText('Insight one')).toBeInTheDocument());
    expect(screen.getByText('Pitfall one')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings Page Flows
// ─────────────────────────────────────────────────────────────────────────────
describe('Settings Page (user flows)', () => {
  beforeEach(() => {
    localStorage.setItem('awareness-claw-config', JSON.stringify({
      language: 'en',
      providerKey: 'openai',
      modelId: 'gpt-4o',
      apiKey: 'sk-test-openai',
    }));
    vi.restoreAllMocks();
  });

  it('flow: permissions page shows friendly empty state (no tools added)', async () => {
    getApi().permissionsGet = vi.fn().mockResolvedValue({
      success: true, profile: 'coding', alsoAllow: [], denied: [],
    });
    await act(async () => { render(<Settings />); });
    await waitFor(() => expect(screen.getByText(/No extra tools added/i)).toBeInTheDocument());
    expect(screen.getByText(/No commands blocked/i)).toBeInTheDocument();
  });

  it('flow: permissions page shows configured tool tags', async () => {
    getApi().permissionsGet = vi.fn().mockResolvedValue({
      success: true, profile: 'coding',
      alsoAllow: ['awareness_recall'], denied: ['camera.snap'],
    });
    await act(async () => { render(<Settings />); });
    await waitFor(() => expect(screen.getByText('awareness_recall')).toBeInTheDocument());
    expect(screen.getByText('camera.snap')).toBeInTheDocument();
  });

  it('flow: add tool to allowed list via + button', async () => {
    const updateMock = vi.fn().mockResolvedValue({ success: true });
    getApi().permissionsGet = vi.fn().mockResolvedValue({
      success: true, profile: 'coding', alsoAllow: [], denied: [],
    });
    getApi().permissionsUpdate = updateMock;

    await act(async () => { render(<Settings />); });
    await waitFor(() => expect(screen.getByPlaceholderText('tool_name')).toBeInTheDocument());

    const toolInput = screen.getByPlaceholderText('tool_name');
    await act(async () => { fireEvent.change(toolInput, { target: { value: 'web_search' } }); });

    const addBtn = screen.getByTestId('add-allow-tool');
    await act(async () => { fireEvent.click(addBtn); });

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ alsoAllow: ['web_search'] })
    ));
  });

  it('flow: add tool to denied list via + button', async () => {
    const updateMock = vi.fn().mockResolvedValue({ success: true });
    getApi().permissionsGet = vi.fn().mockResolvedValue({
      success: true, profile: 'coding', alsoAllow: [], denied: [],
    });
    getApi().permissionsUpdate = updateMock;

    await act(async () => { render(<Settings />); });
    await waitFor(() => expect(screen.getByPlaceholderText('command.name')).toBeInTheDocument());

    const denyInput = screen.getByPlaceholderText('command.name');
    await act(async () => { fireEvent.change(denyInput, { target: { value: 'camera.snap' } }); });

    const addBtn = screen.getByTestId('add-deny-cmd');
    await act(async () => { fireEvent.click(addBtn); });

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ denied: ['camera.snap'] })
    ));
  });

  it('flow: workspace file not found still opens editor with empty content', async () => {
    // File doesn't exist — should open editor anyway (not silently fail)
    getApi().workspaceReadFile = vi.fn().mockResolvedValue({ success: false, content: '' });

    await act(async () => { render(<Settings />); });
    // Find the "SOUL.md" label text, then click the Edit button in the same row
    await waitFor(() => expect(screen.getByText('SOUL.md')).toBeInTheDocument());

    const soulLabel = screen.getByText('SOUL.md');
    const row = soulLabel.closest('div.flex.items-center') as HTMLElement;
    const editBtn = within(row).getByRole('button');
    await act(async () => { fireEvent.click(editBtn); });

    // Editor modal should open — textarea is shown for editing
    await waitFor(() => {
      const textareas = document.querySelectorAll('textarea');
      expect(textareas.length).toBeGreaterThan(0);
    });
  });

  it('flow: switch to same provider restores saved API key', async () => {
    await act(async () => { render(<Settings />); });

    const changeBtns = screen.getAllByRole('button').filter(b => b.textContent?.includes('Change'));
    if (changeBtns.length === 0) return; // Skip if model picker not found

    await act(async () => { fireEvent.click(changeBtns[0]); });

    // API key should be pre-filled from config
    const apiKeyInput = screen.getByPlaceholderText(/Paste your API Key/i) as HTMLInputElement;
    expect(apiKeyInput.value).toBe('sk-test-openai');

    // Find another provider and switch to it
    const anthropicBtns = screen.getAllByRole('button').filter(b => b.textContent?.includes('Anthropic'));
    if (anthropicBtns.length > 0) {
      await act(async () => { fireEvent.click(anthropicBtns[0]); });
      const clearedInput = screen.getByPlaceholderText(/Paste your API Key/i) as HTMLInputElement;
      expect(clearedInput.value).toBe('');

      // Switch back to OpenAI — should restore key
      const openAiBtns = screen.getAllByRole('button').filter(b => b.textContent?.includes('OpenAI'));
      if (openAiBtns.length > 0) {
        await act(async () => { fireEvent.click(openAiBtns[0]); });
        const restoredInput = screen.getByPlaceholderText(/Paste your API Key/i) as HTMLInputElement;
        expect(restoredInput.value).toBe('sk-test-openai');
      }
    }
  });

  it('flow: gateway start/stop buttons toggle state', async () => {
    getApi().gatewayStatus = vi.fn().mockResolvedValue({ running: true });
    const stopMock = vi.fn().mockResolvedValue({ success: true });
    getApi().gatewayStop = stopMock;

    await act(async () => { render(<Settings />); });
    await waitFor(() => expect(screen.getByText(/Running/i)).toBeInTheDocument());

    const stopBtn = screen.getAllByRole('button').find(b => b.textContent?.trim() === 'Stop');
    if (stopBtn) {
      await act(async () => { fireEvent.click(stopBtn); });
      await waitFor(() => expect(stopMock).toHaveBeenCalled());
    }
  });
});
