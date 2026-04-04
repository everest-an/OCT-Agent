import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import Memory from '../pages/Memory';

/** Helper: make memoryCheckHealth return daemon-connected */
function mockDaemonConnected(overrides: Record<string, unknown> = {}) {
  (window as any).electronAPI = {
    ...(window as any).electronAPI,
    memoryCheckHealth: () => Promise.resolve({
      status: 'ok', version: '0.4.1', search_mode: 'hybrid',
      stats: { totalMemories: 10, totalKnowledge: 3, totalTasks: 0, totalSessions: 5 },
    }),
    memoryGetContext: () => Promise.resolve({
      result: { content: [{ text: JSON.stringify({
        knowledge_cards: [
          { id: '1', category: 'decision', title: 'Use PostgreSQL', summary: 'Chose PostgreSQL for pgvector.' },
        ],
        open_tasks: [],
      }) }] },
    }),
    memoryGetCards: () => Promise.resolve({
      result: { content: [{ text: JSON.stringify({ knowledge_cards: [
        { id: '1', category: 'decision', title: 'Use PostgreSQL', summary: 'Chose PostgreSQL for pgvector.' },
      ] }) }] },
    }),
    memoryGetEvents: () => Promise.resolve({
      items: [{ id: 'mem1', type: 'turn_summary', title: 'Event one', source: 'claude-code', created_at: '2026-03-30T10:00:00Z' }],
      total: 1, limit: 50, offset: 0,
    }),
    ...overrides,
  };
}

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

  it('shows Start Daemon button when daemon is offline', async () => {
    await act(async () => { render(<Memory />); });
    await waitFor(() => expect(screen.getByText('Start Daemon')).toBeInTheDocument());
  });

  it('renders refresh button', async () => {
    await act(async () => { render(<Memory />); });
    expect(screen.getByText(/Refresh/)).toBeInTheDocument();
  });

  it('shows category filter on knowledge tab when connected', async () => {
    mockDaemonConnected();
    await act(async () => { render(<Memory />); });
    // Switch to knowledge tab
    await waitFor(() => expect(screen.getByText('Knowledge Cards')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('Knowledge Cards')); });
    expect(screen.getByRole('button', { name: /^All/ })).toBeInTheDocument();
  });

  it('renders moved memory settings on dedicated settings tab when connected', async () => {
    mockDaemonConnected();
    await act(async () => { render(<Memory />); });
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expect(screen.queryByText('Capture & Recall')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByText('Settings')); });
    await waitFor(() => expect(screen.getByText('Capture & Recall')).toBeInTheDocument());
    expect(screen.getAllByText('Auto Capture').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Auto Recall').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Recall Count').length).toBeGreaterThan(0);
  });

  it('renders Memory Architecture info toggle when connected', async () => {
    mockDaemonConnected();
    await act(async () => { render(<Memory />); });
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('Settings')); });
    await waitFor(() => expect(screen.getAllByText('Memory Architecture').length).toBeGreaterThan(0));
  });

  it('expands Memory Architecture details on click', async () => {
    mockDaemonConnected();
    await act(async () => { render(<Memory />); });
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('Settings')); });
    await waitFor(() => expect(screen.getAllByText('Memory Architecture').length).toBeGreaterThan(0));
    const toggle = screen.getByRole('button', { name: /Memory Architecture/i });
    await act(async () => { fireEvent.click(toggle); });
    expect(screen.getByText('Awareness Memory')).toBeInTheDocument();
    expect(screen.getByText('OpenClaw Local')).toBeInTheDocument();
  });

  it('renders self improvement panel and saves a learning entry from settings', async () => {
    const memoryLogLearning = vi.fn(() => Promise.resolve({
      success: true,
      id: 'LRN-20260405-001',
      filePath: '/Users/test/.openclaw/workspace/.learnings/LEARNINGS.md',
      promotion: { generatedCount: 1, proposalIds: ['PROMO-20260405-001'] },
    }));

    mockDaemonConnected({
      memoryLearningStatus: () => Promise.resolve({
        success: true,
        rootDir: '/Users/test/.openclaw/workspace',
        learningsDir: '/Users/test/.openclaw/workspace/.learnings',
        pendingCount: 2,
        highPriorityPendingCount: 1,
        promotionProposalCount: 1,
        readyForPromotionCount: 1,
      }),
      memoryPromotionList: () => Promise.resolve({
        success: true,
        items: [{
          id: 'PROMO-20260405-001',
          status: 'proposed',
          target: 'TOOLS.md',
          patternKey: 'TOOLS.md|learning|docs|verify openclaw cli flags',
          summary: 'Verify OpenClaw CLI flags before changing chat command arguments',
          ruleText: 'Before running chat workflow changes, verify CLI flags first.',
          evidenceCount: 3,
          evidenceIds: ['LRN-20260405-001'],
          createdAt: '2026-04-05T00:00:00.000Z',
        }],
      }),
      memoryLogLearning,
    });

    await act(async () => { render(<Memory />); });
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('Settings')); });
    await waitFor(() => expect(screen.getByText('Self Improvement')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('One-line description of what happened'), {
      target: { value: 'Verify CLI flags before updating desktop chat flow' },
    });
    fireEvent.change(screen.getByPlaceholderText('Include context, what was wrong, and what changed.'), {
      target: { value: 'The CLI failed silently until the flag list was checked against --help output.' },
    });
    fireEvent.change(screen.getByPlaceholderText('What should we do differently next time?'), {
      target: { value: 'Verify supported flags before shipping chat command changes.' },
    });

    await act(async () => { fireEvent.click(screen.getByText('Save Entry')); });

    await waitFor(() => expect(memoryLogLearning).toHaveBeenCalledTimes(1));
    expect(memoryLogLearning).toHaveBeenCalledWith(expect.objectContaining({
      type: 'learning',
      summary: 'Verify CLI flags before updating desktop chat flow',
      area: 'docs',
      priority: 'medium',
      category: 'insight',
      agentId: 'main',
    }));
    expect(screen.getByText(/Generated promotion proposals:/)).toBeInTheDocument();
    expect(screen.getByText('Promotion Queue')).toBeInTheDocument();
  });
});
