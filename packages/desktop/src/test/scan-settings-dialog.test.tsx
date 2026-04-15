import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ScanSettingsDialog, type ScanConfig } from '../components/memory/ScanSettingsDialog';

// Plain identity translator. The dialog resolves labels via t() — for tests we
// just echo keys so assertions can target known-stable strings.
const t = (key: string, fallback?: string) => fallback ?? key;

interface MockOptions {
  loadConfig?: Partial<ScanConfig>;
  loadStatus?: number;
  saveStatus?: number;
}

function makeFetchMock(opts: MockOptions = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const loadConfig: Partial<ScanConfig> = opts.loadConfig ?? {
    enabled: true,
    watch_enabled: true,
    scan_code: true,
    scan_docs: true,
    scan_config: false,
    scan_convertible: true,
    max_file_size_kb: 500,
    max_total_files: 10000,
    max_depth: 15,
    exclude: ['vendor/'],
  };
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const method = init?.method ?? 'GET';
    if (url.endsWith('/scan/config') && method === 'GET') {
      return {
        ok: (opts.loadStatus ?? 200) < 400,
        status: opts.loadStatus ?? 200,
        json: async () => loadConfig,
      } as Response;
    }
    if (url.endsWith('/scan/config') && method === 'PUT') {
      const body = init?.body ? JSON.parse(init.body as string) as ScanConfig : null;
      return {
        ok: (opts.saveStatus ?? 200) < 400,
        status: opts.saveStatus ?? 200,
        json: async () => body ?? loadConfig,
      } as Response;
    }
    if (url.endsWith('/scan/trigger')) {
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  return { fetchMock: mock as unknown as typeof fetch, calls };
}

function renderOpen(fetchImpl: typeof fetch, onSaved?: (c: ScanConfig, r: boolean) => void) {
  const onClose = vi.fn();
  const utils = render(
    <ScanSettingsDialog
      open
      onClose={onClose}
      workspacePath="/tmp/ws"
      t={t}
      fetchImpl={fetchImpl}
      onSaved={onSaved}
    />
  );
  return { ...utils, onClose };
}

describe('ScanSettingsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads config from daemon when opened and renders values', async () => {
    const { fetchMock, calls } = makeFetchMock({
      loadConfig: {
        enabled: true,
        watch_enabled: false,
        scan_code: false,
        scan_docs: true,
        scan_config: true,
        scan_convertible: true,
        max_file_size_kb: 750,
        max_total_files: 5000,
        max_depth: 10,
        exclude: ['build/', 'dist/'],
      },
    });
    renderOpen(fetchMock);

    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/scan/config') && (c.init?.method ?? 'GET') === 'GET')).toBe(true);
    });

    // File size input reflects loaded value.
    await waitFor(() => {
      expect(screen.getByDisplayValue('750')).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('5000')).toBeInTheDocument();
    expect(screen.getByDisplayValue('10')).toBeInTheDocument();

    // Exclude textarea joined with newlines.
    const textarea = screen.getByLabelText('scanSettings.exclude') as HTMLTextAreaElement;
    expect(textarea.value).toBe('build/\ndist/');
  });

  it('renders default workspace path in header', async () => {
    const { fetchMock } = makeFetchMock();
    renderOpen(fetchMock);
    await waitFor(() => expect(screen.getByText('/tmp/ws')).toBeInTheDocument());
  });

  it('disables Save buttons when validation fails', async () => {
    const { fetchMock } = makeFetchMock();
    renderOpen(fetchMock);

    await waitFor(() => expect(screen.getByDisplayValue('500')).toBeInTheDocument());

    const fileSize = screen.getByDisplayValue('500') as HTMLInputElement;
    fireEvent.change(fileSize, { target: { value: '5' } });

    const saveBtn = screen.getByText('scanSettings.saveOnly').closest('button')!;
    const rescanBtn = screen.getByText('scanSettings.saveRescan').closest('button')!;
    expect(saveBtn).toBeDisabled();
    expect(rescanBtn).toBeDisabled();
    expect(screen.getByText('scanSettings.err.fileSize')).toBeInTheDocument();
  });

  it('Save & Rescan PUTs config then fires trigger and calls onSaved with rescan=true', async () => {
    const { fetchMock, calls } = makeFetchMock();
    const onSaved = vi.fn();
    const { onClose } = renderOpen(fetchMock, onSaved);

    await waitFor(() => expect(screen.getByDisplayValue('500')).toBeInTheDocument());

    // Modify exclude list.
    const textarea = screen.getByLabelText('scanSettings.exclude') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'build/\nnode_modules/\n\n  ' } });

    const rescanBtn = screen.getByText('scanSettings.saveRescan').closest('button')!;
    await act(async () => { fireEvent.click(rescanBtn); });

    await waitFor(() => {
      const putCall = calls.find((c) => c.url.endsWith('/scan/config') && c.init?.method === 'PUT');
      expect(putCall).toBeDefined();
      const payload = JSON.parse(putCall!.init!.body as string) as ScanConfig;
      expect(payload.exclude).toEqual(['build/', 'node_modules/']);
    });
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/scan/trigger') && c.init?.method === 'POST')).toBe(true);
    });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ exclude: ['build/', 'node_modules/'] }), true);
    expect(onClose).toHaveBeenCalled();
  });

  it('Save (without rescan) does not fire trigger', async () => {
    const { fetchMock, calls } = makeFetchMock();
    const onSaved = vi.fn();
    renderOpen(fetchMock, onSaved);

    await waitFor(() => expect(screen.getByDisplayValue('500')).toBeInTheDocument());

    const saveBtn = screen.getByText('scanSettings.saveOnly').closest('button')!;
    await act(async () => { fireEvent.click(saveBtn); });

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.anything(), false));
    expect(calls.some((c) => c.url.endsWith('/scan/trigger'))).toBe(false);
  });

  it('Reset restores defaults without saving', async () => {
    const { fetchMock, calls } = makeFetchMock({
      loadConfig: {
        scan_config: true, // non-default
        max_file_size_kb: 999,
        max_total_files: 200,
        max_depth: 5,
        exclude: ['custom/'],
      },
    });
    renderOpen(fetchMock);

    await waitFor(() => expect(screen.getByDisplayValue('999')).toBeInTheDocument());

    const resetBtn = screen.getByText('scanSettings.reset').closest('button')!;
    fireEvent.click(resetBtn);

    // Defaults re-applied in the form.
    expect(screen.getByDisplayValue('500')).toBeInTheDocument();
    expect(screen.getByDisplayValue('10000')).toBeInTheDocument();
    expect(screen.getByDisplayValue('15')).toBeInTheDocument();
    const textarea = screen.getByLabelText('scanSettings.exclude') as HTMLTextAreaElement;
    expect(textarea.value).toBe('');

    // No PUT issued by Reset alone.
    expect(calls.some((c) => c.url.endsWith('/scan/config') && c.init?.method === 'PUT')).toBe(false);
  });

  it('shows save error when PUT fails', async () => {
    const { fetchMock } = makeFetchMock({ saveStatus: 500 });
    renderOpen(fetchMock);

    await waitFor(() => expect(screen.getByDisplayValue('500')).toBeInTheDocument());

    const saveBtn = screen.getByText('scanSettings.saveOnly').closest('button')!;
    await act(async () => { fireEvent.click(saveBtn); });

    await waitFor(() => {
      expect(screen.getByText(/scanSettings.saveError/)).toBeInTheDocument();
    });
  });

  it('returns null when closed', () => {
    const { fetchMock } = makeFetchMock();
    const { container } = render(
      <ScanSettingsDialog
        open={false}
        onClose={() => {}}
        t={t}
        fetchImpl={fetchMock}
      />
    );
    expect(container.firstChild).toBeNull();
  });
});
