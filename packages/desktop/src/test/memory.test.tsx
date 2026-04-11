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
    // Mock global fetch for useWikiData daemon REST API calls
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ topics: [], skills: [], items: [], days: [] }),
    }));
  });

  it('renders memory page header', async () => {
    await act(async () => { render(<Memory />); });
    const headers = screen.getAllByText(/Memory/);
    expect(headers.length).toBeGreaterThan(0);
  });

  it('renders search input on overview tab', async () => {
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

  it('renders 5 tabs: Overview, Wiki, Graph, Sync, Settings', async () => {
    mockDaemonConnected();
    await act(async () => { render(<Memory />); });
    await waitFor(() => {
      expect(screen.getByText('Overview')).toBeInTheDocument();
      expect(screen.getByText('Wiki')).toBeInTheDocument();
      expect(screen.getByText('Graph')).toBeInTheDocument();
      expect(screen.getByText('Sync')).toBeInTheDocument();
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });
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

  it('switches to Wiki tab and shows sidebar', async () => {
    mockDaemonConnected();
    await act(async () => { render(<Memory />); });
    await waitFor(() => expect(screen.getByText('Wiki')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('Wiki')); });
    // Wiki sidebar should render with filter input and at least one section
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Filter/i)).toBeInTheDocument();
    });
  });
});
