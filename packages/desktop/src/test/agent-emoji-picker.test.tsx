import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import AgentEmojiPicker, { AGENT_EMOJIS, DEFAULT_AGENT_EMOJI } from '../components/AgentEmojiPicker';

describe('AgentEmojiPicker', () => {
  it('renders every preset emoji as an aria-pressed button', () => {
    render(<AgentEmojiPicker value={DEFAULT_AGENT_EMOJI} onChange={() => {}} />);
    for (const emoji of AGENT_EMOJIS) {
      expect(screen.getByRole('button', { name: emoji })).toBeInTheDocument();
    }
    // Selected preset is aria-pressed=true.
    const selected = screen.getByRole('button', { name: DEFAULT_AGENT_EMOJI, pressed: true });
    expect(selected).toBeTruthy();
  });

  it('fires onChange with the clicked emoji', async () => {
    const onChange = vi.fn();
    render(<AgentEmojiPicker value="" onChange={onChange} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '🧠' }));
    });
    expect(onChange).toHaveBeenCalledWith('🧠');
  });

  it('does not highlight any preset when value is empty or custom', () => {
    const { rerender } = render(<AgentEmojiPicker value="" onChange={() => {}} />);
    expect(screen.queryByRole('button', { pressed: true })).toBeNull();

    // Custom emoji not in the grid → nothing pressed.
    rerender(<AgentEmojiPicker value="🦸" onChange={() => {}} />);
    expect(screen.queryByRole('button', { pressed: true })).toBeNull();
  });
});
