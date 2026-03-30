import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import Memory from '../pages/Memory';

describe('Memory page mock data indicator', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
  });

  it('shows mock data warning when daemon is not connected', async () => {
    await act(async () => { render(<Memory />); });
    await waitFor(() => {
      expect(screen.getByText(/example data|示例数据/)).toBeInTheDocument();
    });
  });

  it('shows real cards without mock warning when daemon returns data', async () => {
    const origApi = (window as any).electronAPI;
    (window as any).electronAPI = {
      ...origApi,
      memoryGetCards: () => Promise.resolve({
        result: {
          content: [{
            text: JSON.stringify({
              knowledge_cards: [
                { id: '1', category: 'decision', title: 'Real card', summary: 'Real data' },
              ],
            }),
          }],
        },
      }),
    };

    await act(async () => { render(<Memory />); });
    await waitFor(() => {
      expect(screen.getByText('Real card')).toBeInTheDocument();
      expect(screen.queryByText(/example data|示例数据/)).not.toBeInTheDocument();
    });

    (window as any).electronAPI = origApi;
  });
});
