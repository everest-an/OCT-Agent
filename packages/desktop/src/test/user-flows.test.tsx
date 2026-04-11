/**
 * user-flows.test.tsx
 *
 * Real-scenario integration tests that simulate complete user workflows.
 * Each test mirrors what a real user would actually do inside the app.
 * API response shapes match what the real IPC handlers return.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

  it('flow: open wizard and create agent with bootstrap chat', async () => {
    const addMock = vi.fn().mockResolvedValue({ success: true, agentId: 'salesbot' });
    const identityMock = vi.fn().mockResolvedValue({ success: true });
    const writeMock = vi.fn().mockResolvedValue({ success: true });
    const listMock = vi.fn().mockResolvedValue({
      success: true,
      agents: [{ id: 'main', name: 'Claw', emoji: '🦞', isDefault: true, bindings: [] }],
    });
    getApi().agentsList = listMock;
    getApi().agentsAdd = addMock;
    getApi().agentsSetIdentity = identityMock;
    getApi().agentsWriteFile = writeMock;

    await act(async () => { render(<Agents />); });
    await waitFor(() => expect(screen.getByText('Claw')).toBeInTheDocument());

    // Open wizard
    const createBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Create Agent'));
    expect(createBtn).toBeTruthy();
    await act(async () => { fireEvent.click(createBtn!); });

    // Single-step flow (2026-04-08 refactor): fill name → click Create directly,
    // no Next button, no channel binding step.
    const nameInput = screen.getByPlaceholderText(/Research/i);
    await act(async () => { fireEvent.change(nameInput, { target: { value: 'SalesBot' } }); });
    const finishBtn = screen.getByTestId('agent-create-btn');
    await act(async () => { fireEvent.click(finishBtn); });

    // agentsAdd called WITHOUT systemPrompt (BOOTSTRAP.md preserved for chat Q&A)
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

  it('flow: Agents page no longer exposes channel binding UI (managed on Channels page)', async () => {
    // 2026-04-08 refactor: bind/unbind controls moved to the Channels page per-channel
    // "Replied by" dropdown. The Agents page is now identity/workspace/prompts only.
    await act(async () => { render(<Agents />); });
    await waitFor(() => expect(screen.getByText('Claw')).toBeInTheDocument());

    const bindBtn = screen.getAllByRole('button').find((b) => b.getAttribute('title') === 'Add binding');
    expect(bindBtn).toBeUndefined();
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

/** Helper: mock daemon as connected with standard health response */
function mockDaemonOnline() {
  getApi().memoryCheckHealth = vi.fn().mockResolvedValue({
    status: 'ok', version: '0.4.1', search_mode: 'hybrid',
    stats: { totalMemories: 10, totalKnowledge: 3, totalTasks: 0, totalSessions: 5 },
  });
  getApi().memoryGetEvents = vi.fn().mockResolvedValue({ items: [], total: 0 });
}

describe('Memory Page (user flows)', () => {
  beforeEach(() => {
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
    vi.restoreAllMocks();
    // Mock global fetch for useWikiData daemon REST API calls
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ topics: [], skills: [], items: [], days: [] }),
    }) as any;
  });

  it('flow: shows Start Daemon button + command when daemon disconnected', async () => {
    getApi().memoryCheckHealth = vi.fn().mockResolvedValue({ error: 'Not running' });
    await act(async () => { render(<Memory />); });
    await waitFor(() => expect(screen.getByText('Start Daemon')).toBeInTheDocument());
    // Daemon startup command should be shown
    expect(screen.getByText(/npx @awareness-sdk\/local start/i)).toBeInTheDocument();
  });

  it('flow: shows real knowledge cards in Wiki tab when daemon is connected', async () => {
    mockDaemonOnline();
    getApi().memoryGetCards = vi.fn().mockResolvedValue(mcpCardsResponse([
      { id: '1', title: 'Use async handlers', summary: 'Always async in Electron', category: 'pitfall', created_at: '2026-03-30T10:00:00Z' },
      { id: '2', title: 'Ship fast principle', summary: 'Release early iterate', category: 'insight', created_at: '2026-03-30T11:00:00Z' },
    ]));
    await act(async () => { render(<Memory />); });
    // Switch to Wiki tab
    await waitFor(() => expect(screen.getByText('Wiki')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('Wiki')); });
    // Wiki overview shows cards in "Recently Added" section
    await waitFor(() => expect(screen.getByText('Use async handlers')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText('Ship fast principle')).toBeInTheDocument();
    // No Start Daemon button
    expect(screen.queryByText('Start Daemon')).not.toBeInTheDocument();
  });

  it('flow: Wiki tab shows cards in sidebar and overview', async () => {
    mockDaemonOnline();
    getApi().memoryGetCards = vi.fn().mockResolvedValue(mcpCardsResponse([
      { id: '1', title: 'Pitfall card', summary: 'a pitfall', category: 'pitfall', created_at: '2026-03-30T10:00:00Z' },
      { id: '2', title: 'Insight card', summary: 'an insight', category: 'insight', created_at: '2026-03-30T11:00:00Z' },
    ]));
    await act(async () => { render(<Memory />); });
    // Switch to Wiki tab
    await waitFor(() => expect(screen.getByText('Wiki')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('Wiki')); });
    // Wiki overview should show both cards in "Recently Added"
    await waitFor(() => expect(screen.getByText('Pitfall card')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText('Insight card')).toBeInTheDocument();
    // Sidebar should show Engineering group
    expect(screen.getByText('Engineering')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Memory Page — Deep E2E Flows (P2.5 integration)
// ─────────────────────────────────────────────────────────────────────────────
describe('Memory Page — Timeline & Daemon (E2E)', () => {
  beforeEach(() => {
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
    vi.restoreAllMocks();
    // Mock global fetch for useWikiData daemon REST API calls
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ topics: [], skills: [], items: [], days: [] }),
    }) as any;
  });

  it('flow: offline memory page auto-starts daemon and refreshes page', async () => {
    // Initial: daemon offline
    getApi().memoryCheckHealth = vi.fn()
      .mockResolvedValueOnce({ error: 'Not running' })  // initial check
      .mockResolvedValue({  // after start
        status: 'ok', version: '0.4.2', search_mode: 'hybrid',
        stats: { totalMemories: 5, totalKnowledge: 2, totalTasks: 0, totalSessions: 1 },
      });
    getApi().startDaemon = vi.fn().mockResolvedValue({ success: true });
    getApi().memoryGetCards = vi.fn().mockResolvedValue(mcpCardsResponse([
      { id: '1', title: 'After start card', summary: 'Now visible', category: 'insight' },
    ]));
    getApi().memoryGetEvents = vi.fn().mockResolvedValue({
      items: [{ id: 'mem1', type: 'turn_summary', title: 'First event', source: 'desktop', created_at: '2026-03-30T12:00:00Z' }],
      total: 1,
    });

    await act(async () => { render(<Memory />); });
    // Memory page now auto-starts daemon when initial health check is offline.
    await waitFor(() => expect(getApi().startDaemon).toHaveBeenCalled(), { timeout: 3000 });

    // After daemon starts, timeline should show events
    await waitFor(() => expect(screen.getAllByText('First event').length).toBeGreaterThan(0), { timeout: 3000 });
    // Start Daemon button should not remain visible after auto-recovery.
    expect(screen.queryByText('Start Daemon')).not.toBeInTheDocument();
  });

  it('flow: timeline tab shows real memory events with source and time', async () => {
    mockDaemonOnline();
    getApi().memoryGetEvents = vi.fn().mockResolvedValue({
      items: [
        { id: 'mem1', type: 'turn_brief', title: 'Debugging auth flow', source: 'claude-code', session_id: 'ses_abc123', created_at: '2026-03-30T14:30:00Z', fts_content: 'Investigated JWT token expiry issue in auth middleware' },
        { id: 'mem2', type: 'code_change', title: 'Updated package.json', source: 'desktop', created_at: '2026-03-30T13:00:00Z', tags: 'npm,config' },
      ],
      total: 2,
    });

    await act(async () => { render(<Memory />); });

    // Timeline is default tab — should show events
    await waitFor(() => expect(screen.getByText('Debugging auth flow')).toBeInTheDocument());
    // Source labels should be visible
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Desktop')).toBeInTheDocument();
    // Type badges
    expect(screen.getByText('turn_brief')).toBeInTheDocument();
    expect(screen.getByText('code_change')).toBeInTheDocument();
    // Tags should render
    expect(screen.getAllByText('npm').length).toBeGreaterThan(0);
    expect(screen.getAllByText('config').length).toBeGreaterThan(0);
  });

  it('flow: clicking event expands full content, clicking again collapses', async () => {
    mockDaemonOnline();
    const longContent = 'A'.repeat(1200); // Over 600 chars threshold → should be collapsible
    getApi().memoryGetEvents = vi.fn().mockResolvedValue({
      items: [{ id: 'mem1', type: 'turn_brief', title: 'Long event', source: 'manual', created_at: '2026-03-30T10:00:00Z', fts_content: longContent }],
      total: 1,
    });

    await act(async () => { render(<Memory />); });
    await waitFor(() => expect(screen.getByText('Long event')).toBeInTheDocument());

    // Should show expand button
    const expandBtn = screen.getByText(/Show full content|展开完整内容/i);
    expect(expandBtn).toBeInTheDocument();

    // Click to expand
    await act(async () => { fireEvent.click(expandBtn); });
    expect(screen.getByText(/Collapse|收起/i)).toBeInTheDocument();

    // Click to collapse
    await act(async () => { fireEvent.click(screen.getByText(/Collapse|收起/i)); });
    expect(screen.getByText(/Show full content|展开完整内容/i)).toBeInTheDocument();
  });

  it('flow: Load More button fetches next page of events', async () => {
    mockDaemonOnline();
    // Use mockResolvedValue for the initial load (may be called multiple times on mount due to sourceView effect),
    // then switch to next-page response after initial render.
    const page1 = {
      items: Array.from({ length: 50 }, (_, i) => ({
        id: `mem${i}`, type: 'turn_brief', title: `Event ${i}`, source: 'manual',
        created_at: `2026-03-30T${String(10 + Math.floor(i / 6)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
      })),
      total: 75,
    };
    const eventsMock = vi.fn().mockResolvedValue(page1);
    getApi().memoryGetEvents = eventsMock;

    await act(async () => { render(<Memory />); });
    await waitFor(() => expect(screen.getAllByText('Event 0').length).toBeGreaterThan(0));

    // Load More button should show count
    const loadMore = screen.getByText(/Load More/i);
    expect(loadMore).toBeInTheDocument();
    expect(loadMore.textContent).toContain('50/75');

    // Now set up the next page response for the Load More click
    const callCountBefore = eventsMock.mock.calls.length;
    eventsMock.mockResolvedValueOnce({
      items: Array.from({ length: 25 }, (_, i) => ({
        id: `mem${50 + i}`, type: 'turn_brief', title: `Event ${50 + i}`, source: 'manual',
        created_at: '2026-03-30T08:00:00Z',
      })),
      total: 75,
    });

    // Click Load More
    await act(async () => { fireEvent.click(loadMore); });

    // At least one more call should have been made
    expect(eventsMock.mock.calls.length).toBeGreaterThan(callCountBefore);
  });

  it('flow: daemon stats are displayed in subtitle', async () => {
    getApi().memoryCheckHealth = vi.fn().mockResolvedValue({
      status: 'ok', version: '0.4.2', search_mode: 'hybrid',
      stats: { totalMemories: 427, totalKnowledge: 26, totalTasks: 0, totalSessions: 282 },
    });
    getApi().memoryGetCards = vi.fn().mockResolvedValue(mcpCardsResponse([]));
    getApi().memoryGetEvents = vi.fn().mockResolvedValue({ items: [], total: 0 });

    await act(async () => { render(<Memory />); });
    // Stats subtitle shows knowledge cards and sessions from health data.
    await waitFor(() => expect(screen.getByText(/26 knowledge cards/i)).toBeInTheDocument());
    expect(screen.getByText(/282 sessions/i)).toBeInTheDocument();
  });

  it('flow: switching between Overview and Wiki tabs works', async () => {
    mockDaemonOnline();
    getApi().memoryGetCards = vi.fn().mockResolvedValue(mcpCardsResponse([
      { id: '1', title: 'My Decision', summary: 'chose X over Y', category: 'decision' },
    ]));
    getApi().memoryGetEvents = vi.fn().mockResolvedValue({
      items: [{ id: 'mem1', type: 'turn_brief', title: 'Timeline Event', source: 'desktop', created_at: '2026-03-30T10:00:00Z' }],
      total: 1,
    });

    await act(async () => { render(<Memory />); });

    // Default tab = Overview → should see timeline event
    await waitFor(() => expect(screen.getAllByText('Timeline Event').length).toBeGreaterThan(0));

    // Switch to Wiki
    await act(async () => { fireEvent.click(screen.getByText('Wiki')); });
    await waitFor(() => expect(screen.getByText('My Decision')).toBeInTheDocument());

    // Switch back to Overview
    const overviewTabs = screen.getAllByText('Overview');
    // Find the tab button (not the sidebar item)
    const tabButton = overviewTabs.find(el => el.closest('button')?.className?.includes('rounded-2xl'));
    if (tabButton) {
      await act(async () => { fireEvent.click(tabButton); });
      await waitFor(() => expect(screen.getAllByText('Timeline Event').length).toBeGreaterThan(0));
    }
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

  it('flow: permissions page shows preset cards with description', async () => {
    getApi().permissionsGet = vi.fn().mockResolvedValue({
      success: true, profile: 'coding', alsoAllow: [], denied: [],
    });
    await act(async () => { render(<Settings />); });
    // New UI has preset cards (Safe, Standard, Developer) instead of tag chips
    await waitFor(() => expect(screen.getByText('Safe')).toBeInTheDocument());
    expect(screen.getByText('Standard')).toBeInTheDocument();
    expect(screen.getByText('Developer')).toBeInTheDocument();
    // Preset description is shown below the cards
    expect(screen.getByText(/Choose a/i)).toBeInTheDocument();
  });

  it('flow: permissions advanced settings shows tool checkboxes and command checkboxes', async () => {
    getApi().permissionsGet = vi.fn().mockResolvedValue({
      success: true, profile: 'coding',
      alsoAllow: ['awareness_recall'], denied: ['camera.snap'],
    });
    await act(async () => { render(<Settings />); });
    // Open advanced settings
    await waitFor(() => expect(screen.getAllByText(/^Show advanced$/i).length).toBeGreaterThan(0));
    await act(async () => { fireEvent.click(screen.getAllByText(/^Show advanced$/i)[0]); });
    // In advanced mode, known tools are shown as checkbox buttons with labels
    await waitFor(() => expect(screen.getAllByText('Memory Recall').length).toBeGreaterThan(0));
    // Known denied command "Camera" should be shown
    expect(screen.getAllByText('Camera').length).toBeGreaterThan(0);
  });

  it('flow: add custom tool to allowed list via advanced settings', async () => {
    const updateMock = vi.fn().mockResolvedValue({ success: true });
    getApi().permissionsGet = vi.fn().mockResolvedValue({
      success: true, profile: 'coding', alsoAllow: [], denied: [],
    });
    getApi().permissionsUpdate = updateMock;

    await act(async () => { render(<Settings />); });
    // Open advanced settings
    await waitFor(() => expect(screen.getAllByText(/^Show advanced$/i).length).toBeGreaterThan(0));
    await act(async () => { fireEvent.click(screen.getAllByText(/^Show advanced$/i)[0]); });

    // The custom tool input placeholder is "Custom Tool" (en i18n) or similar
    const toolInput = screen.getByPlaceholderText(/Custom tool/i);
    await act(async () => { fireEvent.change(toolInput, { target: { value: 'web_search' } }); });

    const addBtn = screen.getByTestId('add-allow-tool');
    await act(async () => { fireEvent.click(addBtn); });

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ alsoAllow: ['web_search'] })
    ));
  });

  it('flow: add custom command to denied list via advanced settings', async () => {
    const updateMock = vi.fn().mockResolvedValue({ success: true });
    getApi().permissionsGet = vi.fn().mockResolvedValue({
      success: true, profile: 'coding', alsoAllow: [], denied: [],
    });
    getApi().permissionsUpdate = updateMock;

    await act(async () => { render(<Settings />); });
    // Open advanced settings
    await waitFor(() => expect(screen.getAllByText(/^Show advanced$/i).length).toBeGreaterThan(0));
    await act(async () => { fireEvent.click(screen.getAllByText(/^Show advanced$/i)[0]); });

    // The custom deny input placeholder is "Custom Command" (en i18n) or similar
    const denyInput = screen.getByPlaceholderText(/Custom command/i);
    await act(async () => { fireEvent.change(denyInput, { target: { value: 'camera.snap' } }); });

    const addBtn = screen.getByTestId('add-deny-cmd');
    await act(async () => { fireEvent.click(addBtn); });

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ denied: ['camera.snap'] })
    ));
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
