import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import App from '../App';

describe('App navigation', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('awareness-claw-setup-done', 'true');
    localStorage.setItem('awareness-claw-config', JSON.stringify({
      language: 'en',
      providerKey: 'openai',
      modelId: 'gpt-4o',
      providerProfiles: {
        openai: {
          apiKey: 'sk-openai',
          baseUrl: 'https://api.openai.com/v1',
          models: [{ id: 'gpt-4o', label: 'GPT-4o' }],
        },
      },
    }));
  });

  it('exposes the Models tab in sidebar navigation', async () => {
    await act(async () => { render(<App />); });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Models/i })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Models/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Models/i })).toBeInTheDocument();
    });
  });

  it('still runs startup runtime checks immediately after setup completes', async () => {
    const startupEnsureRuntime = vi.fn().mockResolvedValue({ ok: true, fixed: [], warnings: [] });
    Object.assign(window.electronAPI || {}, { startupEnsureRuntime });
    localStorage.setItem('awareness-claw-setup-completed-at', String(Date.now()));

    await act(async () => { render(<App />); });

    await waitFor(() => {
      expect(startupEnsureRuntime).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Chat/i })).toBeInTheDocument();
    });
  });
});