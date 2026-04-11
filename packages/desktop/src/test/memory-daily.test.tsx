import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import Memory from '../pages/Memory';

/** Helper: create a connected daemon mock with custom overrides */
function connectedDaemonApi(overrides: Record<string, any> = {}) {
  const origAPI = (window as any).electronAPI;
  return {
    ...origAPI,
    memoryCheckHealth: () => Promise.resolve({
      status: 'ok', version: '0.4.1', search_mode: 'hybrid',
      stats: { totalMemories: 5, totalKnowledge: 1, totalTasks: 0, totalSessions: 2 },
    }),
    memoryGetEvents: () => Promise.resolve({ items: [], total: 0 }),
    ...overrides,
  };
}

describe('Memory Page — Wiki Overview shows cards', () => {
  let origAPI: any;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
    origAPI = (window as any).electronAPI;
    // Mock global fetch for useWikiData daemon REST API calls
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ topics: [], skills: [], items: [], days: [] }),
    }) as any;
  });

  afterEach(() => {
    (window as any).electronAPI = origAPI;
  });

  it('shows cards in Wiki overview when context returns data', async () => {
    (window as any).electronAPI = connectedDaemonApi({
      memoryGetContext: () => Promise.resolve({
        result: { content: [{ text: JSON.stringify({
          knowledge_cards: [
            { id: 'k1', category: 'decision', title: 'Test decision', summary: 'Test' },
          ],
          open_tasks: [{ id: 't1', title: 'Task 1' }],
        }) }] },
      }),
      memoryGetCards: () => Promise.resolve({
        result: { content: [{ text: JSON.stringify({ knowledge_cards: [
          { id: 'k1', category: 'decision', title: 'Test decision', summary: 'Test' },
        ] }) }] },
      }),
    });

    await act(async () => { render(<Memory />); });
    // Switch to Wiki tab
    await waitFor(() => expect(screen.getByText('Wiki')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('Wiki')); });

    // Overview should show the card in the "Recently Added" section
    await waitFor(() => {
      expect(screen.getAllByText('Test decision').length).toBeGreaterThan(0);
    });
  });

  it('uses memoryGetContext as the primary source for cards', async () => {
    (window as any).electronAPI = connectedDaemonApi({
      memoryGetContext: () => Promise.resolve({
        result: { content: [{ text: JSON.stringify({
          knowledge_cards: [
            { id: 'ctx-1', category: 'workflow', title: 'Context-first card', summary: 'Loaded from awareness_init.' },
          ],
          open_tasks: [{ id: 'ctx-task-1', title: 'Context task' }],
        }) }] },
      }),
      memoryGetCards: () => Promise.resolve({ error: 'should not be needed' }),
    });

    await act(async () => { render(<Memory />); });
    await waitFor(() => expect(screen.getByText('Wiki')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('Wiki')); });

    await waitFor(() => {
      expect(screen.getAllByText('Context-first card').length).toBeGreaterThan(0);
    });
  });

  it('shows empty state in Wiki when no cards exist', async () => {
    (window as any).electronAPI = connectedDaemonApi({
      memoryGetContext: () => Promise.resolve({
        result: { content: [{ text: JSON.stringify({ knowledge_cards: [], open_tasks: [] }) }] },
      }),
      memoryGetCards: () => Promise.resolve({
        result: { content: [{ text: JSON.stringify({ knowledge_cards: [] }) }] },
      }),
    });

    await act(async () => { render(<Memory />); });
    await waitFor(() => expect(screen.getByText('Wiki')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('Wiki')); });

    await waitFor(() => {
      expect(screen.getByText(/No memory data yet/i)).toBeInTheDocument();
    });
  });

  it('does not show Wiki content when daemon is offline', async () => {
    // Default mock: daemon not connected → shows Start Daemon
    await act(async () => { render(<Memory />); });
    await waitFor(() => {
      expect(screen.getByText('Start Daemon')).toBeInTheDocument();
    });
  });
});
