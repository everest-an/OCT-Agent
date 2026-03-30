import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import Memory from '../pages/Memory';

describe('Memory Page — Daily Summary', () => {
  let origAPI: any;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
    origAPI = (window as any).electronAPI;
  });

  afterEach(() => {
    (window as any).electronAPI = origAPI;
  });

  it('shows Daily Summary when memoryGetDailySummary returns data', async () => {
    (window as any).electronAPI = {
      ...origAPI,
      // Return real cards so the page doesn't fall back to mock data
      memoryGetCards: () => Promise.resolve({
        result: {
          content: [{
            text: JSON.stringify({
              knowledge_cards: [
                { id: 'k1', category: 'decision', title: 'Use PostgreSQL', summary: 'Chose PG for pgvector' },
              ],
            }),
          }],
        },
      }),
      memoryGetDailySummary: () => Promise.resolve({
        cards: {
          result: {
            content: [{
              text: JSON.stringify({
                knowledge_cards: [
                  { category: 'decision', title: 'Test decision', summary: 'Test' },
                ],
              }),
            }],
          },
        },
        tasks: {
          result: {
            content: [{
              text: JSON.stringify({
                action_items: [{ title: 'Task 1' }],
              }),
            }],
          },
        },
      }),
    };

    await act(async () => { render(<Memory />); });

    await waitFor(() => {
      expect(screen.getByText('Daily Summary')).toBeInTheDocument();
    });

    // Verify the card title is rendered inside the summary
    expect(screen.getByText('Test decision')).toBeInTheDocument();

    // Verify open tasks count is shown (use the specific span text)
    expect(screen.getByText(/open tasks/)).toBeInTheDocument();
  });

  it('does not show Daily Summary when memoryGetDailySummary returns empty data', async () => {
    (window as any).electronAPI = {
      ...origAPI,
      memoryGetCards: () => Promise.resolve({
        result: {
          content: [{
            text: JSON.stringify({
              knowledge_cards: [
                { id: 'k1', category: 'insight', title: 'Some insight', summary: 'Detail' },
              ],
            }),
          }],
        },
      }),
      memoryGetDailySummary: () => Promise.resolve({
        cards: { result: { content: [{ text: JSON.stringify({ knowledge_cards: [] }) }] } },
        tasks: { result: { content: [{ text: JSON.stringify({ action_items: [] }) }] } },
      }),
    };

    await act(async () => { render(<Memory />); });

    // Wait for loading to finish (cards should appear)
    await waitFor(() => {
      expect(screen.getByText('Some insight')).toBeInTheDocument();
    });

    // Daily Summary should NOT be rendered
    expect(screen.queryByText('Daily Summary')).not.toBeInTheDocument();
  });

  it('does not show Daily Summary when memoryGetDailySummary is not defined', async () => {
    // Ensure the default mock has no memoryGetDailySummary
    const { memoryGetDailySummary, ...apiWithout } = origAPI || {};
    (window as any).electronAPI = { ...apiWithout };

    await act(async () => { render(<Memory />); });

    // Wait for loading to finish — falls back to mock data
    await waitFor(() => {
      expect(screen.getAllByText(/PostgreSQL/).length).toBeGreaterThan(0);
    });

    // Daily Summary should NOT be rendered (mock data sets isMockData=true which hides it)
    expect(screen.queryByText('Daily Summary')).not.toBeInTheDocument();
  });
});
