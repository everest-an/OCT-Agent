/**
 * MissionComposer — the "big goal input box" at the top of the Dashboard.
 *
 * Principles:
 *   - Huge textarea so non-technical users feel safe typing a paragraph
 *   - One primary "Let's go ✨" button — no jargon, no advanced toggles
 *   - Enter key submits; Shift+Enter inserts newline
 *   - Busy state disables the form and shows spinner
 *
 * The composer is intentionally unaware of IPC, mission IDs, or agents — the
 * parent handler wires `onSubmit` to `useMissionFlow.create`.
 */

import { type FormEvent, type KeyboardEvent, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import type { TranslateFunc } from '../../lib/i18n';

export interface MissionComposerProps {
  readonly busy?: boolean;
  readonly onSubmit: (goal: string) => void | Promise<void>;
  readonly t?: TranslateFunc;
  readonly placeholder?: string;
  readonly defaultValue?: string;
}

export default function MissionComposer({
  busy,
  onSubmit,
  t,
  placeholder,
  defaultValue,
}: MissionComposerProps) {
  const tr = t ?? ((_k: string, fallback?: string) => fallback ?? _k);
  const [goal, setGoal] = useState(defaultValue ?? '');
  const [localError, setLocalError] = useState<string | null>(null);

  const canSubmit = goal.trim().length >= 3 && !busy;

  const submit = async () => {
    const g = goal.trim();
    if (g.length < 3) {
      setLocalError(
        tr(
          'missionFlow.composer.tooShort',
          'Tell your team a bit more — at least 3 characters.',
        ),
      );
      return;
    }
    setLocalError(null);
    await Promise.resolve(onSubmit(g));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSubmit) void submit();
    }
  };

  const handleForm = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  return (
    <form
      data-testid="mission-composer"
      onSubmit={handleForm}
      className="rounded-2xl border border-slate-700/50 bg-slate-900/40 p-4 space-y-3"
    >
      <header className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-sky-500/10 flex items-center justify-center">
          <Sparkles size={16} className="text-sky-300" />
        </div>
        <div className="flex-1">
          <h2 className="text-base font-semibold text-slate-100">
            {tr('missionFlow.composer.title', 'What would you like your team to do today?')}
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            {tr(
              'missionFlow.composer.subtitle',
              'Describe it in your own words — your team will plan the steps.',
            )}
          </p>
        </div>
      </header>

      <textarea
        data-testid="mission-composer-input"
        aria-label={tr('missionFlow.composer.inputLabel', 'Describe your goal')}
        value={goal}
        onChange={(e) => {
          setGoal(e.target.value);
          if (localError) setLocalError(null);
        }}
        onKeyDown={handleKeyDown}
        placeholder={
          placeholder ??
          tr(
            'missionFlow.composer.placeholder',
            'e.g. Build a simple TODO list app with React and save tasks to local storage.',
          )
        }
        rows={4}
        disabled={busy}
        className="w-full rounded-lg bg-slate-950/60 border border-slate-700/40 p-3 text-sm text-slate-100 placeholder:text-slate-500 resize-none focus:outline-none focus:ring-1 focus:ring-sky-500 disabled:opacity-60"
      />

      {localError && (
        <p data-testid="mission-composer-error" className="text-xs text-amber-300">
          {localError}
        </p>
      )}

      <div className="flex items-center justify-between">
        <p className="text-[11px] text-slate-500">
          {tr('missionFlow.composer.hint', 'Press Enter to submit · Shift+Enter for newline')}
        </p>
        <button
          type="submit"
          data-testid="mission-composer-submit"
          disabled={!canSubmit}
          className="px-5 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium text-white inline-flex items-center gap-2"
        >
          {busy
            ? <Loader2 size={16} className="animate-spin" />
            : <Sparkles size={16} />}
          {busy
            ? tr('missionFlow.composer.starting', 'Starting…')
            : tr('missionFlow.composer.submit', "Let's go ✨")}
        </button>
      </div>
    </form>
  );
}
