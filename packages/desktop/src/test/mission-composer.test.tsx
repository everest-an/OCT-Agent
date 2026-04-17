/**
 * L2 tests for MissionComposer.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MissionComposer from '../components/mission-flow/MissionComposer';

describe('MissionComposer', () => {
  it('renders title, textarea, and disabled submit until user types', () => {
    render(<MissionComposer onSubmit={vi.fn()} />);
    expect(screen.getByTestId('mission-composer-input')).toBeInTheDocument();
    const submit = screen.getByTestId('mission-composer-submit');
    expect(submit).toBeDisabled();
  });

  it('enables submit once input is 3+ chars', () => {
    render(<MissionComposer onSubmit={vi.fn()} />);
    const ta = screen.getByTestId('mission-composer-input') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'ok' } });
    expect(screen.getByTestId('mission-composer-submit')).toBeDisabled();
    fireEvent.change(ta, { target: { value: 'build me a chat app' } });
    expect(screen.getByTestId('mission-composer-submit')).toBeEnabled();
  });

  it('submits goal via button click', async () => {
    const onSubmit = vi.fn();
    render(<MissionComposer onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId('mission-composer-input'), {
      target: { value: 'Ship a weekly digest' },
    });
    fireEvent.click(screen.getByTestId('mission-composer-submit'));
    expect(onSubmit).toHaveBeenCalledWith('Ship a weekly digest');
  });

  it('submits on Enter, inserts newline on Shift+Enter', () => {
    const onSubmit = vi.fn();
    render(<MissionComposer onSubmit={onSubmit} />);
    const ta = screen.getByTestId('mission-composer-input');
    fireEvent.change(ta, { target: { value: 'draft outline' } });

    // Shift+Enter should NOT submit
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();

    // Plain Enter should submit
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('draft outline');
  });

  it('shows local error when goal is too short', () => {
    render(<MissionComposer onSubmit={vi.fn()} />);
    const ta = screen.getByTestId('mission-composer-input') as HTMLTextAreaElement;
    // Directly force-trigger submit with short value by bypassing disabled check
    fireEvent.change(ta, { target: { value: 'ab' } });
    // Button is disabled for short inputs, so simulate form submit
    fireEvent.submit(ta.closest('form')!);
    expect(screen.getByTestId('mission-composer-error')).toHaveTextContent(/3 characters/i);
  });

  it('disables submit + textarea while busy', () => {
    render(<MissionComposer onSubmit={vi.fn()} busy />);
    const ta = screen.getByTestId('mission-composer-input') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'anything goes' } });
    expect(ta).toBeDisabled();
    expect(screen.getByTestId('mission-composer-submit')).toBeDisabled();
  });

  it('accepts defaultValue and placeholder overrides', () => {
    render(
      <MissionComposer
        onSubmit={vi.fn()}
        defaultValue="prefilled goal"
        placeholder="custom placeholder"
      />,
    );
    const ta = screen.getByTestId('mission-composer-input') as HTMLTextAreaElement;
    expect(ta.value).toBe('prefilled goal');
    expect(ta.placeholder).toBe('custom placeholder');
  });
});
