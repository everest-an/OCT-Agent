import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useAppConfig } from '../lib/store';

// Component A: button that switches language to 'zh'
function LangSwitcher() {
  const { updateConfig } = useAppConfig();
  return (
    <button onClick={() => updateConfig({ language: 'zh' })}>
      Switch to Chinese
    </button>
  );
}

// Component B: displays current language
function LangDisplay() {
  const { config } = useAppConfig();
  return <span data-testid="current-lang">{config.language}</span>;
}

describe('Language switch cross-component sync via CustomEvent', () => {
  beforeEach(() => {
    // Start with English
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
  });

  it('Component B reflects language change triggered by Component A', async () => {
    await act(async () => {
      render(
        <div>
          <LangSwitcher />
          <LangDisplay />
        </div>
      );
    });

    // Initial state: language = en
    expect(screen.getByTestId('current-lang').textContent).toBe('en');

    // Click the switch button
    await act(async () => {
      fireEvent.click(screen.getByText('Switch to Chinese'));
    });

    // After click: language should be zh
    expect(screen.getByTestId('current-lang').textContent).toBe('zh');
  });
});
