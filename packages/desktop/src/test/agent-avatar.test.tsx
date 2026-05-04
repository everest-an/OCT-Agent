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

  it('does not render non-emoji unicode tokens as avatar emoji', () => {
    const { container } = render(<AgentAvatar name="Gavis" emoji="[禹]" size={20} />);
    expect(screen.queryByText('[禹]')).not.toBeInTheDocument();
    expect(container.querySelector('.lucide-bot')).toBeTruthy();
  });

  // "default" 字符串应 fallback 到 logo 图片
  it('treats "default" string as fallback and renders logo image', () => {
    render(<AgentAvatar name="Agent" emoji="default" size={20} />);
    expect(screen.getByAltText('Agent logo')).toBeInTheDocument();
    expect(screen.queryByText('default')).not.toBeInTheDocument();
  });

  // 不同 size 参数应渲染不同尺寸的 frame class
  it('renders different frame sizes based on the size prop', () => {
    const { container: small } = render(<AgentAvatar name="A" emoji="🎯" size={12} />);
    expect(small.querySelector('.w-3')).toBeTruthy();

    const { container: medium } = render(<AgentAvatar name="B" emoji="🎯" size={20} />);
    expect(medium.querySelector('.w-5')).toBeTruthy();

    const { container: large } = render(<AgentAvatar name="C" emoji="🎯" size={24} />);
    expect(large.querySelector('.w-6')).toBeTruthy();
  });
});