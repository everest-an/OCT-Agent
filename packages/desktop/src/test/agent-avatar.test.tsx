import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import AgentAvatar from '../components/AgentAvatar';

describe('AgentAvatar', () => {
  it('renders emoji when value looks like a real emoji', () => {
    render(<AgentAvatar name="Coder" emoji="💻" size={20} />);
    expect(screen.getByText('💻')).toBeInTheDocument();
  });

  it('falls back to logo instead of rendering leaked Avatar markdown text', () => {
    render(<AgentAvatar name="Gavis" emoji="**Avatar:**" fallback="logo" size={20} />);
    expect(screen.getByAltText('Gavis logo')).toBeInTheDocument();
    expect(screen.queryByText(/\*\*Avatar:\*\*/i)).not.toBeInTheDocument();
  });

  it('falls back to bot icon when emoji is invalid and logo fallback is not requested', () => {
    const { container } = render(<AgentAvatar name="Gavis" emoji="**Avatar:**" size={20} />);
    expect(container.querySelector('.lucide-bot')).toBeTruthy();
  });
});