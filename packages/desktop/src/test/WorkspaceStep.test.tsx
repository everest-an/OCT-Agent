import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { act } from 'react';
import WorkspaceStep from '../components/setup/WorkspaceStep';

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
    workspaceGetActive: vi.fn().mockResolvedValue({ success: true, path: null }),
    workspaceSetActive: vi.fn().mockResolvedValue({ success: true }),
    selectDirectory: vi.fn().mockResolvedValue({ directoryPath: null }),
    ...overrides,
  };
}

describe('WorkspaceStep', () => {
  const onNext = vi.fn();
  const onBack = vi.fn();
  const onSkip = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders title and skip button', async () => {
    Object.defineProperty(window, 'electronAPI', { value: makeApi(), writable: true });
    render(<WorkspaceStep onNext={onNext} onBack={onBack} onSkip={onSkip} />);
    // Title should appear (fallback text used)
    expect(screen.getByText(/choose your default project folder/i)).toBeInTheDocument();
    // Skip button present
    expect(screen.getByText(/skip/i)).toBeInTheDocument();
  });

  it('loads existing workspace on mount', async () => {
    const api = makeApi({
      workspaceGetActive: vi.fn().mockResolvedValue({ success: true, path: '/Users/alice/projects' }),
    });
    Object.defineProperty(window, 'electronAPI', { value: api, writable: true });
    render(<WorkspaceStep onNext={onNext} onBack={onBack} onSkip={onSkip} />);
    await waitFor(() => {
      expect(screen.getByText('/Users/alice/projects')).toBeInTheDocument();
    });
  });

  it('calls selectDirectory on Change button click', async () => {
    const mockPath = '/Users/alice/newProject';
    const api = makeApi({
      workspaceGetActive: vi.fn().mockResolvedValue({ success: true, path: '/Users/alice/old' }),
      selectDirectory: vi.fn().mockResolvedValue({ directoryPath: mockPath }),
    });
    Object.defineProperty(window, 'electronAPI', { value: api, writable: true });
    render(<WorkspaceStep onNext={onNext} onBack={onBack} onSkip={onSkip} />);
    const changeBtn = screen.getByText(/change/i);
    await act(async () => { fireEvent.click(changeBtn); });
    await waitFor(() => {
      expect(api.selectDirectory).toHaveBeenCalled();
      expect(screen.getByText(mockPath)).toBeInTheDocument();
    });
  });

  it('calls workspaceSetActive and onNext when Use this folder is clicked', async () => {
    const api = makeApi({
      workspaceGetActive: vi.fn().mockResolvedValue({ success: true, path: '/Users/alice/workspace' }),
      workspaceSetActive: vi.fn().mockResolvedValue({ success: true }),
    });
    Object.defineProperty(window, 'electronAPI', { value: api, writable: true });
    render(<WorkspaceStep onNext={onNext} onBack={onBack} onSkip={onSkip} />);
    await waitFor(() => screen.getByText('/Users/alice/workspace'));
    const confirmBtn = screen.getByText(/use this folder/i);
    await act(async () => { fireEvent.click(confirmBtn); });
    expect(api.workspaceSetActive).toHaveBeenCalledWith('/Users/alice/workspace');
    expect(onNext).toHaveBeenCalledWith('/Users/alice/workspace');
  });

  it('calls onSkip when skip button is clicked', () => {
    Object.defineProperty(window, 'electronAPI', { value: makeApi(), writable: true });
    render(<WorkspaceStep onNext={onNext} onBack={onBack} onSkip={onSkip} />);
    fireEvent.click(screen.getByText(/skip/i));
    expect(onSkip).toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });

  it('calls onBack when Back button is clicked', () => {
    Object.defineProperty(window, 'electronAPI', { value: makeApi(), writable: true });
    render(<WorkspaceStep onNext={onNext} onBack={onBack} onSkip={onSkip} />);
    // Use exact button role to avoid matching 'background' in tip text
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(onBack).toHaveBeenCalled();
  });

  it('falls back to ~ if no path selected when confirming', async () => {
    const api = makeApi({
      workspaceGetActive: vi.fn().mockResolvedValue({ success: false, path: null }),
      workspaceSetActive: vi.fn().mockResolvedValue({ success: true }),
    });
    Object.defineProperty(window, 'electronAPI', { value: api, writable: true });
    render(<WorkspaceStep onNext={onNext} onBack={onBack} onSkip={onSkip} />);
    const confirmBtn = screen.getByText(/use this folder/i);
    await act(async () => { fireEvent.click(confirmBtn); });
    expect(onNext).toHaveBeenCalledWith('~');
  });
});
