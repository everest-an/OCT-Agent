import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { GlobalScanStatusBar } from '../components/GlobalScanStatusBar';

// Mock the i18n hook used by the component.
vi.mock('../lib/i18n', () => ({
  useI18n: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    locale: 'en',
  }),
}));

function mockFetchOnce(body: unknown, ok = true) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('GlobalScanStatusBar', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders nothing when daemon is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const { container } = render(<GlobalScanStatusBar />);
    // Let microtasks settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when daemon returns empty status (never scanned)', async () => {
    mockFetchOnce(null);
    const { container } = render(<GlobalScanStatusBar />);
    await Promise.resolve();
    await Promise.resolve();
    expect(container.firstChild).toBeNull();
  });

  it('shows progress bar + counts during an active scan', async () => {
    mockFetchOnce({
      status: 'scanning',
      phase: 'indexing code files',
      percent: 42,
      total_files: 1284,
      processed_files: 540,
    });
    render(<GlobalScanStatusBar />);
    await waitFor(() => {
      expect(screen.getByText('indexing code files')).toBeInTheDocument();
    });
    expect(screen.getByText('540 / 1,284')).toBeInTheDocument();
  });

  it('shows synced state with file count when idle', async () => {
    mockFetchOnce({
      status: 'idle',
      total_files: 1284,
      processed_files: 1284,
      percent: 100,
    });
    render(<GlobalScanStatusBar />);
    await waitFor(() => {
      expect(screen.getByText('scanBar.synced')).toBeInTheDocument();
    });
    expect(screen.getByText(/1,284/)).toBeInTheDocument();
  });

  it('shows embedding progress when idle but embedding is running', async () => {
    mockFetchOnce({
      status: 'idle',
      total_files: 500,
      processed_files: 500,
      percent: 100,
      embed_total: 500,
      embed_done: 120,
    });
    render(<GlobalScanStatusBar />);
    await waitFor(() => {
      expect(screen.getByText(/scanBar.embedding/)).toBeInTheDocument();
    });
    expect(screen.getByText(/120\/500/)).toBeInTheDocument();
  });
});
