import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import App from '../App';

describe('Theme switching', () => {
  beforeEach(() => {
    localStorage.clear();
    // Mark setup as done
    localStorage.setItem('awareness-claw-setup-done', 'true');
    document.documentElement.className = '';
  });

  it('applies dark theme by default', async () => {
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en', theme: 'dark' }));
    await act(async () => { render(<App />); });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });

  it('applies light theme when configured', async () => {
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en', theme: 'light' }));
    await act(async () => { render(<App />); });
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('applies system theme using matchMedia', async () => {
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en', theme: 'system' }));
    // jsdom defaults to no dark preference, so it should be light
    await act(async () => { render(<App />); });
    // System default in jsdom is light (matchMedia returns false)
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });
});
