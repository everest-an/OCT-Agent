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

  it('workDir picker button fires onPickWorkDir', () => {
    const onPickWorkDir = vi.fn();
    render(<MissionComposer onSubmit={vi.fn()} onPickWorkDir={onPickWorkDir} />);
    const btn = screen.getByTestId('mission-composer-pick-workdir');
    fireEvent.click(btn);
    expect(onPickWorkDir).toHaveBeenCalledTimes(1);
  });

  it('workDir chip shows the folder basename + clear button', () => {
    const onClearWorkDir = vi.fn();
    render(
      <MissionComposer
        onSubmit={vi.fn()}
        workDir="/Users/me/Projects/todo-app"
        onPickWorkDir={vi.fn()}
        onClearWorkDir={onClearWorkDir}
      />,
    );
    expect(screen.getByTestId('mission-composer-pick-workdir')).toHaveTextContent('todo-app');
    fireEvent.click(screen.getByTestId('mission-composer-clear-workdir'));
    expect(onClearWorkDir).toHaveBeenCalled();
  });

  it('team preview renders agent chips', () => {
    render(
      <MissionComposer
        onSubmit={vi.fn()}
        agents={[
          { id: 'main', name: 'Main', emoji: '🧠' },
          { id: 'coder', name: 'Coder', emoji: '💻' },
          { id: 'tester', name: 'Tester', emoji: '🧪' },
        ]}
      />,
    );
    const team = screen.getByTestId('mission-composer-team');
    expect(team.querySelectorAll('li').length).toBe(3);
    expect(team).toHaveTextContent('Main');
    expect(team).toHaveTextContent('Coder');
    expect(team).toHaveTextContent('Tester');
  });

  it('agent<2 warning appears + triggers onManageAgents', () => {
    const onManageAgents = vi.fn();
    render(
      <MissionComposer
        onSubmit={vi.fn()}
        agents={[{ id: 'main', name: 'Main' }]}
        onManageAgents={onManageAgents}
      />,
    );
    expect(screen.getByTestId('mission-composer-agent-warn')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add a teammate/i }));
    expect(onManageAgents).toHaveBeenCalled();
  });

  it('agent<2 warning hidden when 2+ agents', () => {
    render(
      <MissionComposer
        onSubmit={vi.fn()}
        agents={[{ id: 'main' }, { id: 'coder' }]}
        onManageAgents={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('mission-composer-agent-warn')).toBeNull();
  });

  it('meta row hidden when no workDir picker and no agents', () => {
    render(<MissionComposer onSubmit={vi.fn()} />);
    expect(screen.queryByTestId('mission-composer-meta')).toBeNull();
  });
});
