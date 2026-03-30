import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import Settings from '../pages/Settings';

describe('Settings Page — Permissions Panel', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
  });

  it('renders the Permissions section after loading', async () => {
    await act(async () => { render(<Settings />); });
    await waitFor(() => {
      expect(screen.getByText(/Permissions/)).toBeInTheDocument();
    });
  });

  it('displays the tools profile value "coding"', async () => {
    await act(async () => { render(<Settings />); });
    await waitFor(() => {
      expect(screen.getByText('Tools Profile')).toBeInTheDocument();
      expect(screen.getByText('coding')).toBeInTheDocument();
    });
  });

  it('calls permissionsUpdate when removing a denied command', async () => {
    // Override permissionsGet to return a denied command so we can remove it
    const api = window.electronAPI as any;
    const origGet = api.permissionsGet;
    const origUpdate = api.permissionsUpdate;
    const updateSpy = vi.fn(() => Promise.resolve({ success: true }));

    api.permissionsGet = () => Promise.resolve({
      success: true,
      profile: 'coding',
      alsoAllow: ['awareness_recall'],
      denied: ['camera.snap'],
    });
    api.permissionsUpdate = updateSpy;

    await act(async () => { render(<Settings />); });

    // Wait for permissions to load and the denied command tag to appear
    await waitFor(() => {
      expect(screen.getByText('camera.snap')).toBeInTheDocument();
    });

    // The "x" remove button is inside the tag next to the command text
    const tag = screen.getByText('camera.snap');
    const removeBtn = tag.parentElement?.querySelector('button');
    expect(removeBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(removeBtn!);
    });

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalled();
    });

    // Should be called with the denied array minus the removed command
    expect(updateSpy).toHaveBeenCalledWith({ denied: [] });

    // Restore
    api.permissionsGet = origGet;
    api.permissionsUpdate = origUpdate;
  });
});
