import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Skills from '../pages/Skills';

describe('Skills Page', () => {
  it('renders skills header', () => {
    render(<Skills />);
    expect(screen.getByText(/技能市场/)).toBeInTheDocument();
  });

  it('renders search input', () => {
    render(<Skills />);
    expect(screen.getByPlaceholderText(/搜索技能/)).toBeInTheDocument();
  });

  it('shows awareness memory skill', () => {
    render(<Skills />);
    expect(screen.getByText('Awareness Memory')).toBeInTheDocument();
  });

  it('renders filter tabs', () => {
    render(<Skills />);
    const allBtns = screen.getAllByText(/全部/);
    expect(allBtns.length).toBeGreaterThan(0);
    // "已安装" appears in both filter tab and skill badges
    const installed = screen.getAllByText(/已安装/);
    expect(installed.length).toBeGreaterThan(0);
  });
});
