import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import CloudAuthStep from '../components/setup/CloudAuthStep';

// Mock i18n
vi.mock('../lib/i18n', () => ({
  useI18n: () => ({
    t: (key: string, fallback?: string) => fallback || key,
    locale: 'en',
    setLocale: vi.fn(),
  }),
}));

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    invoke: vi.fn(),
    ...overrides,
  };
}

describe('CloudAuthStep', () => {
  const onNext = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Initializing state on mount', async () => {
    const mockApi = makeApi({
      // Simulate a slow start so we can catch 'starting' phase
      invoke: vi.fn().mockImplementation(async (channel: string) => {
        if (channel === 'cloud:auth-start') {
          return new Promise(() => {}); // never resolves
        }
        return null;
      }),
    });
    Object.defineProperty(window, 'electronAPI', { value: mockApi, writable: true });

    render(<CloudAuthStep onNext={onNext} onCancel={onCancel} />);
    // Should show initializing state
    expect(screen.getByText(/initializing/i)).toBeInTheDocument();
  });

  it('shows device code when auth-start succeeds', async () => {
    const mockApi = makeApi({
      invoke: vi.fn().mockImplementation(async (channel: string) => {
        if (channel === 'cloud:auth-start') {
          return {
            success: true,
            user_code: 'ABCD-1234',
            verification_uri: 'https://awareness.market/activate',
            verification_url: 'https://awareness.market/activate?code=ABCD-1234',
            device_code: 'device_token_xyz',
            interval: 5,
            is_headless: true,
          };
        }
        // Poll never returns a token (keeps pending)
        return null;
      }),
    });
    Object.defineProperty(window, 'electronAPI', { value: mockApi, writable: true });

    render(<CloudAuthStep onNext={onNext} onCancel={onCancel} />);

    await waitFor(() => {
      expect(screen.getByText('ABCD-1234')).toBeInTheDocument();
    });
  });

  it('XSS guard: non-http verification_uri is replaced with about:blank', async () => {
    const mockApi = makeApi({
      invoke: vi.fn().mockImplementation(async (channel: string) => {
        if (channel === 'cloud:auth-start') {
          return {
            success: true,
            user_code: 'SAFE-0000',
            // Malicious URL injection attempt
            verification_uri: 'javascript:alert(1)',
            device_code: 'dev_xyz',
            interval: 5,
            is_headless: true,
          };
        }
        return null;
      }),
    });
    Object.defineProperty(window, 'electronAPI', { value: mockApi, writable: true });

    render(<CloudAuthStep onNext={onNext} onCancel={onCancel} />);

    await waitFor(() => {
      expect(screen.getByText('SAFE-0000')).toBeInTheDocument();
    });

    // Ensure no javascript: link is rendered in the DOM
    const links = document.querySelectorAll('a[href]');
    for (const link of links) {
      const href = (link as HTMLAnchorElement).href;
      expect(href).not.toMatch(/^javascript:/i);
    }
  });

  it('shows cancel button which calls onCancel', async () => {
    const mockApi = makeApi({
      invoke: vi.fn().mockImplementation(async (channel: string) => {
        if (channel === 'cloud:auth-start') {
          return {
            success: true,
            user_code: 'WXYZ-5678',
            verification_uri: 'https://awareness.market/activate',
            device_code: 'dev_abc',
            interval: 100, // Long interval so polling doesn't kick in during test
            is_headless: true,
          };
        }
        return null;
      }),
    });
    Object.defineProperty(window, 'electronAPI', { value: mockApi, writable: true });

    render(<CloudAuthStep onNext={onNext} onCancel={onCancel} />);

    await waitFor(() => screen.getByText('WXYZ-5678'));
    const cancelBtn = screen.getByText(/cancel.*local/i);
    act(() => { cancelBtn.click(); });
    expect(onCancel).toHaveBeenCalled();
  });

  it('shows error state and retry button when auth-start fails', async () => {
    const mockApi = makeApi({
      invoke: vi.fn().mockImplementation(async (channel: string) => {
        if (channel === 'cloud:auth-start') {
          return { success: false, error: 'Network timeout' };
        }
        return null;
      }),
    });
    Object.defineProperty(window, 'electronAPI', { value: mockApi, writable: true });

    render(<CloudAuthStep onNext={onNext} onCancel={onCancel} />);

    await waitFor(() => {
      expect(screen.getByText(/network timeout/i)).toBeInTheDocument();
      expect(screen.getByText(/retry/i)).toBeInTheDocument();
    });
  });

  it('transitions to memory selection when poll returns api_key', async () => {
    let pollCalled = 0;
    const mockApi = makeApi({
      invoke: vi.fn().mockImplementation(async (channel: string) => {
        if (channel === 'cloud:auth-start') {
          return {
            success: true,
            user_code: 'POLL-TEST',
            verification_uri: 'https://awareness.market/activate',
            verification_url: 'https://awareness.market/activate?code=POLL-TEST',
            device_code: 'dev_poll',
            interval: 0.01, // Near-instant for test
            is_headless: true,
          };
        }
        if (channel === 'cloud:auth-poll') {
          pollCalled++;
          if (pollCalled >= 2) return { api_key: 'test-api-key-abc123' };
          return null;
        }
        if (channel === 'cloud:get-profile') {
          return { success: true, email: 'test@example.com' };
        }
        if (channel === 'cloud:list-memories') {
          return {
            memories: [
              { id: 'mem-1', name: 'My Memory', card_count: 42 },
            ],
          };
        }
        return null;
      }),
    });
    Object.defineProperty(window, 'electronAPI', { value: mockApi, writable: true });

    render(<CloudAuthStep onNext={onNext} onCancel={onCancel} />);

    await waitFor(
      () => {
        expect(screen.getByText('My Memory')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('uses verification_url when reopening browser and returns email on confirm', async () => {
    let pollCalled = 0;
    const mockApi = makeApi({
      invoke: vi.fn().mockImplementation(async (channel: string, ...args: unknown[]) => {
        if (channel === 'cloud:auth-start') {
          return {
            success: true,
            user_code: 'MAIL-TEST',
            verification_uri: 'https://awareness.market/activate',
            verification_url: 'https://awareness.market/activate?code=MAIL-TEST',
            device_code: 'dev_mail',
            interval: 0.01,
            is_headless: true,
          };
        }
        if (channel === 'cloud:auth-poll') {
          pollCalled++;
          if (pollCalled >= 2) return { api_key: 'api-key-123' };
          return null;
        }
        if (channel === 'cloud:get-profile') {
          return { success: true, email: 'person@example.com' };
        }
        if (channel === 'cloud:list-memories') {
          return { memories: [{ id: 'mem-9', name: 'Personal Memory', card_count: 1 }] };
        }
        if (channel === 'shell:openExternal') {
          return { success: true, opened: args[0] };
        }
        if (channel === 'cloud:connect') {
          return { success: true };
        }
        return null;
      }),
    });
    Object.defineProperty(window, 'electronAPI', { value: mockApi, writable: true });

    render(<CloudAuthStep onNext={onNext} onCancel={onCancel} />);

    await waitFor(() => {
      expect(screen.getByText('Personal Memory')).toBeInTheDocument();
    }, { timeout: 3000 });

    await act(async () => {
      screen.getByRole('button', { name: /confirm.*sync/i }).click();
    });

    expect(onNext).toHaveBeenCalledWith({
      email: 'person@example.com',
      memoryId: 'mem-9',
      memoryName: 'Personal Memory',
    });
  });

  it('stays on the auth step and shows an error when cloud connect fails', async () => {
    let pollCalled = 0;
    const mockApi = makeApi({
      invoke: vi.fn().mockImplementation(async (channel: string) => {
        if (channel === 'cloud:auth-start') {
          return {
            success: true,
            user_code: 'FAIL-TEST',
            verification_uri: 'https://awareness.market/activate',
            verification_url: 'https://awareness.market/activate?code=FAIL-TEST',
            device_code: 'dev_fail',
            interval: 0.01,
            is_headless: true,
          };
        }
        if (channel === 'cloud:auth-poll') {
          pollCalled++;
          if (pollCalled >= 2) return { api_key: 'api-key-fail' };
          return null;
        }
        if (channel === 'cloud:get-profile') {
          return { success: true, email: 'person@example.com' };
        }
        if (channel === 'cloud:list-memories') {
          return { memories: [{ id: 'mem-fail', name: 'Broken Memory', card_count: 1 }] };
        }
        if (channel === 'cloud:connect') {
          return { success: false, error: 'Connect rejected' };
        }
        return null;
      }),
    });
    Object.defineProperty(window, 'electronAPI', { value: mockApi, writable: true });

    render(<CloudAuthStep onNext={onNext} onCancel={onCancel} />);

    await waitFor(() => {
      expect(screen.getByText('Broken Memory')).toBeInTheDocument();
    }, { timeout: 3000 });

    await act(async () => {
      screen.getByRole('button', { name: /confirm.*sync/i }).click();
    });

    await waitFor(() => {
      expect(screen.getByText(/connect rejected/i)).toBeInTheDocument();
    });
    expect(onNext).not.toHaveBeenCalled();
  });
});
