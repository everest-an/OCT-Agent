import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Skills from '../pages/Skills';

describe('Skills Page', () => {
  it('renders skills header', () => {
    render(<Skills />);
    expect(screen.getByText('Skills')).toBeInTheDocument();
  });

  it('renders search input', () => {
    render(<Skills />);
    expect(screen.getByPlaceholderText(/Search skills/)).toBeInTheDocument();
  });

  it('renders filter tabs', () => {
    render(<Skills />);
    expect(screen.getByText('Explore')).toBeInTheDocument();
    expect(screen.getByText('Installed')).toBeInTheDocument();
  });

  it('shows loading state initially', () => {
    render(<Skills />);
    expect(screen.getByText(/Loading skills/)).toBeInTheDocument();
  });
});
