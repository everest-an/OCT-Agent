import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import Skills from '../pages/Skills';

describe('Skills E2E', () => {
  beforeEach(() => {
    // Override skillExplore to return a skill list
    const api = window.electronAPI as any;
    api.skillExplore = vi.fn().mockResolvedValue({
      success: true,
      skills: [
        { slug: 'test-skill', name: 'Test Skill', description: 'A test', version: '1.0.0' },
      ],
    });
    api.skillListInstalled = vi.fn().mockResolvedValue({ success: true, skills: {} });
    api.skillSearch = vi.fn().mockResolvedValue({ success: true, results: [] });
  });

  it('displays skill name after loading completes', async () => {
    await act(async () => { render(<Skills />); });

    await waitFor(() => {
      expect(screen.queryByText(/Loading skills/)).not.toBeInTheDocument();
    });

    expect(screen.getByText('Test Skill')).toBeInTheDocument();
  });

  it('calls skillSearch when user types and presses Enter', async () => {
    const api = window.electronAPI as any;
    api.skillSearch.mockResolvedValue({
      success: true,
      results: [{ slug: 'found-skill', name: 'Found Skill', description: 'Found', version: '2.0.0' }],
    });

    await act(async () => { render(<Skills />); });

    // Wait for initial load to finish
    await waitFor(() => {
      expect(screen.queryByText(/Loading skills/)).not.toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/Search skills/);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'found' } });
    });
    await act(async () => {
      fireEvent.keyDown(searchInput, { key: 'Enter', code: 'Enter' });
    });

    await waitFor(() => {
      expect(api.skillSearch).toHaveBeenCalledWith('found');
    });

    await waitFor(() => {
      expect(screen.getByText('Found Skill')).toBeInTheDocument();
    });
  });
});
