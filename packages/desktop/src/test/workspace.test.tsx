import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import Settings from '../pages/Settings';

describe('Settings – Workspace file editor', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
  });

  it('renders Workspace section', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByRole('heading', { name: /Workspace/ })).toBeInTheDocument();
  });

  it('shows workspace file buttons (SOUL.md, USER.md, IDENTITY.md, TOOLS.md, AGENTS.md)', async () => {
    await act(async () => { render(<Settings />); });
    expect(screen.getByText('SOUL.md')).toBeInTheDocument();
    expect(screen.getByText('USER.md')).toBeInTheDocument();
    expect(screen.getByText('IDENTITY.md')).toBeInTheDocument();
    expect(screen.getByText('TOOLS.md')).toBeInTheDocument();
    expect(screen.getByText('AGENTS.md')).toBeInTheDocument();
  });

  it('calls workspaceReadFile when a file button is clicked', async () => {
    const readSpy = vi.fn(() => Promise.resolve({ success: true, content: '# Hello', exists: true }));
    (window.electronAPI as any).workspaceReadFile = readSpy;

    await act(async () => { render(<Settings />); });

    // The SOUL.md label is in a Row; the clickable element is the "Edit" button next to it.
    // Find the SOUL.md label, then locate its sibling Edit button.
    const soulLabel = screen.getByText('SOUL.md');
    const row = soulLabel.closest('[class*="flex items-center"]') || soulLabel.parentElement?.parentElement;
    const editBtn = row?.querySelector('button');

    expect(editBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(editBtn!);
    });

    await waitFor(() => {
      expect(readSpy).toHaveBeenCalledWith('SOUL.md');
    });
  });
});
