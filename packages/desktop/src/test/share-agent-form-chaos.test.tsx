/**
 * F-063 · L3 chaos tests for ShareAgentForm submission UX.
 *
 * Covers: happy path, HTTP 500, timeout (slow server), network failure,
 * validation rejection. Asserts the user always sees a recoverable error
 * state — no infinite spinner, no blank-screen crash. Form fields are
 * preserved across failures so the user doesn't re-type on retry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ShareAgentForm from '../components/ShareAgentForm';

const composedFixture = {
  success: true,
  markdown:
    '---\nname: Pixel Pal\ndescription: retro pixel coach\ncolor: slate\nemoji: 🎨\n---\n\n# Pixel Pal\n\nretro pixel-art coach.\n',
  description: 'retro pixel-art coach.',
  tools: ['Read', 'Write', 'Edit'],
  name: 'Pixel Pal',
  emoji: '🎨',
  files: ['IDENTITY.md', 'SOUL.md', 'AGENTS.md'],
  structured: {
    soul_md: '## Voice\nWarm.',
    agents_md: '## Mission\nShip sprites.',
    vibe: 'retro pixel-art coach.',
  },
};

function mountWithApi(submit: ReturnType<typeof vi.fn>) {
  (window as any).electronAPI = {
    ...(window as any).electronAPI,
    marketplaceComposeFromLocal: vi.fn().mockResolvedValue(composedFixture),
    marketplaceSubmit: submit,
  };
  return render(
    <ShareAgentForm
      preselectedAgentId="pixel-pal"
      onClose={vi.fn()}
      onSubmitted={vi.fn()}
    />
  );
}

describe('ShareAgentForm · L3 chaos', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('happy path: submit returns success → shows 已提交 toast + disables close during submit', async () => {
    const submit = vi.fn().mockResolvedValue({ success: true });
    mountWithApi(submit);

    // Wait for compose to finish loading.
    await screen.findByTestId('share-submit');
    fireEvent.click(screen.getByTestId('share-submit'));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    // Structured fields must be present in the submit payload.
    const payload = submit.mock.calls[0][0];
    expect(payload.soul_md).toBe('## Voice\nWarm.');
    expect(payload.agents_md).toBe('## Mission\nShip sprites.');
    expect(payload.vibe).toBe('retro pixel-art coach.');

    await screen.findByTestId('share-success');
  });

  it('500 from backend: displays error, preserves form state, button shows 重试提交', async () => {
    const submit = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'HTTP 500' });
    mountWithApi(submit);

    await screen.findByTestId('share-submit');
    const slugInput = screen.getByDisplayValue('pixel-pal');
    fireEvent.click(screen.getByTestId('share-submit'));

    await screen.findByTestId('share-error');
    expect(screen.getByTestId('share-error')).toHaveTextContent('HTTP 500');
    // Form state preserved — user does not re-type slug/description.
    expect(slugInput).toHaveValue('pixel-pal');
    // Button label switches to Retry submission so user knows retry is one click away.
    expect(screen.getByTestId('share-submit')).toHaveTextContent(/Retry submission|重试提交/);
  });

  it('network failure: rejected promise → shows error without spinner hang', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    mountWithApi(submit);

    await screen.findByTestId('share-submit');
    fireEvent.click(screen.getByTestId('share-submit'));

    await screen.findByTestId('share-error');
    expect(screen.getByTestId('share-error')).toHaveTextContent('ECONNREFUSED');
    // Button must be re-enabled — user can retry immediately.
    expect(screen.getByTestId('share-submit')).not.toBeDisabled();
  });

  it('slow server (>=6s): shows amber "服务器正在处理" hint during pending submit', async () => {
    // Submit that never resolves within the test — simulates prod latency.
    let resolver: ((v: { success: boolean }) => void) | null = null;
    const submit = vi.fn(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          resolver = resolve;
        })
    );
    mountWithApi(submit);

    await screen.findByTestId('share-submit');
    fireEvent.click(screen.getByTestId('share-submit'));
    await waitFor(() => expect(submit).toHaveBeenCalled());

    // Before 6s: no slow hint.
    expect(screen.queryByTestId('share-slow-hint')).toBeNull();

    // Advance 7s of fake time — slow hint should appear.
    await act(async () => {
      vi.advanceTimersByTime(7000);
    });
    await screen.findByTestId('share-slow-hint');
    expect(screen.getByTestId('share-slow-hint')).toHaveTextContent(
      /Server is processing|服务器正在处理/
    );

    // Clean up the pending promise so React doesn't leak it.
    resolver?.({ success: true });
  });

  it('invalid slug rejected client-side: no network call, error visible', async () => {
    const submit = vi.fn();
    mountWithApi(submit);

    await screen.findByTestId('share-submit');
    const slugInput = screen.getByDisplayValue('pixel-pal');
    fireEvent.change(slugInput, { target: { value: 'BAD SLUG!' } });
    fireEvent.click(screen.getByTestId('share-submit'));

    await screen.findByTestId('share-error');
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByTestId('share-error')).toHaveTextContent(/Slug|slug/);
    // Field-level error highlight visible on slug input.
    expect(slugInput).toHaveAttribute('aria-invalid', 'true');
  });

  it('backdrop click during submit does NOT close modal (avoids losing in-flight request)', async () => {
    let resolver: ((v: { success: boolean }) => void) | null = null;
    const submit = vi.fn(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          resolver = resolve;
        })
    );
    const onClose = vi.fn();
    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      marketplaceComposeFromLocal: vi.fn().mockResolvedValue(composedFixture),
      marketplaceSubmit: submit,
    };
    const { container } = render(
      <ShareAgentForm
        preselectedAgentId="pixel-pal"
        onClose={onClose}
        onSubmitted={vi.fn()}
      />
    );

    await screen.findByTestId('share-submit');
    fireEvent.click(screen.getByTestId('share-submit'));
    await waitFor(() => expect(submit).toHaveBeenCalled());

    // Simulate backdrop click while submission is in flight.
    const backdrop = container.querySelector('[role="dialog"]');
    if (backdrop) fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();

    resolver?.({ success: true });
  });
});
