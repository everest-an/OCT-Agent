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
import { AlertTriangle, FolderOpen, Loader2, Sparkles, X } from 'lucide-react';
import AgentAvatar from '../AgentAvatar';
import type { TranslateFunc } from '../../lib/i18n';

function workDirShortName(abs: string): string {
  if (!abs) return '';
  const segs = abs.split(/[\\/]/).filter(Boolean);
  return segs.length === 0 ? abs : segs[segs.length - 1];
}

export interface MissionComposerAgent {
  readonly id: string;
  readonly name?: string;
  readonly emoji?: string;
  readonly role?: string;
  readonly model?: string | null;
}

export interface MissionComposerProps {
  readonly busy?: boolean;
  readonly onSubmit: (goal: string) => void | Promise<void>;
  readonly t?: TranslateFunc;
  readonly placeholder?: string;
  readonly defaultValue?: string;
  /** Currently-selected working directory (optional). */
  readonly workDir?: string;
  /** Callback when user clicks "pick workspace" — parent opens native dialog. */
  readonly onPickWorkDir?: () => void;
  /** Callback when user clicks the × on the workspace chip. */
  readonly onClearWorkDir?: () => void;
  /** Agents available to the Planner. When < 2, a yellow warning is shown. */
  readonly agents?: readonly MissionComposerAgent[];
  /** Callback for the "Manage agents" link when agents.length < 2. */
  readonly onManageAgents?: () => void;
  /**
   * Default model used by the Planner (read from openclaw.json /
   * main agent's `model` config). Shown in the meta row so users see
   * which model the team will run on. Not user-editable here — model
   * selection is global Settings.
   */
  readonly defaultModel?: string | null;
}

export default function MissionComposer({
  busy,
  onSubmit,
  t,
  placeholder,
  defaultValue,
  workDir,
  onPickWorkDir,
  onClearWorkDir,
  agents,
  onManageAgents,
  defaultModel,
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

      {/* Workspace + team rows (optional; hidden when parent doesn't wire them) */}
      {(onPickWorkDir || (agents && agents.length > 0) || defaultModel) && (
        <div data-testid="mission-composer-meta" className="space-y-2">
          {onPickWorkDir && (
            <div className="flex items-center gap-2 text-[12px] text-slate-400">
              <span className="text-slate-500">
                {tr('missionFlow.composer.workDirLabel', '📁 Work dir:')}
              </span>
              <button
                type="button"
                data-testid="mission-composer-pick-workdir"
                onClick={onPickWorkDir}
                disabled={busy}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-800/80 hover:bg-slate-700 border border-slate-700/60 text-slate-200 disabled:opacity-50"
              >
                <FolderOpen size={12} />
                {workDir ? workDirShortName(workDir) : tr('missionFlow.composer.pickWorkDir', 'Choose folder')}
              </button>
              {workDir && onClearWorkDir && (
                <button
                  type="button"
                  data-testid="mission-composer-clear-workdir"
                  onClick={onClearWorkDir}
                  aria-label={tr('missionFlow.composer.clearWorkDir', 'Clear workspace')}
                  className="text-slate-500 hover:text-slate-300"
                >
                  <X size={12} />
                </button>
              )}
              {!workDir && (
                <span className="text-[11px] text-slate-500 italic">
                  {tr('missionFlow.composer.noWorkDir', '(optional — agents will ask if they need one)')}
                </span>
              )}
            </div>
          )}

          {agents && agents.length > 0 && (
            <div className="flex items-center gap-2 text-[12px] text-slate-400 flex-wrap">
              <span className="text-slate-500">
                {tr('missionFlow.composer.teamLabel', '👥 Team:')}
              </span>
              <ul data-testid="mission-composer-team" className="flex items-center gap-1.5 flex-wrap">
                {agents.map((a) => (
                  <li
                    key={a.id}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-slate-800/80 border border-slate-700/50"
                    title={a.role ? `${a.name || a.id} · ${a.role}` : (a.name || a.id)}
                  >
                    <AgentAvatar
                      name={a.name || a.id}
                      emoji={a.emoji || ''}
                      size={14}
                    />
                    <span className="text-[11px] text-slate-300">{a.name || a.id}</span>
                  </li>
                ))}
              </ul>
              <span className="text-[11px] text-slate-500">
                {tr('missionFlow.composer.teamCount', 'total')} {agents.length}
              </span>
            </div>
          )}

          {defaultModel && (
            <div
              data-testid="mission-composer-model"
              className="flex items-center gap-2 text-[12px] text-slate-400"
            >
              <span className="text-slate-500">
                {tr('missionFlow.composer.modelLabel', '🤖 Model:')}
              </span>
              <span
                className="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-800/80 border border-slate-700/50 text-slate-200 font-mono text-[11px]"
                title={defaultModel}
              >
                {defaultModel}
              </span>
              <span className="text-[11px] text-slate-500 italic">
                {tr('missionFlow.composer.modelHint', '(shared with Chat — change in Settings)')}
              </span>
            </div>
          )}

          {agents && agents.length < 2 && onManageAgents && (
            <div
              data-testid="mission-composer-agent-warn"
              className="flex items-start gap-2 rounded-md border border-amber-600/30 bg-amber-900/15 px-2.5 py-1.5 text-[12px] text-amber-200"
            >
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-amber-400" />
              <div className="flex-1">
                <p>{tr(
                  'missionFlow.composer.soloAgentWarning',
                  'Only one agent on your team — the plan will still run, but it works better with more team members.',
                )}</p>
                <button
                  type="button"
                  onClick={onManageAgents}
                  className="mt-1 inline-flex items-center gap-1 text-amber-300 hover:text-amber-100 underline-offset-2 hover:underline"
                >
                  {tr('missionFlow.composer.addAgent', '➕ Add a teammate')}
                </button>
              </div>
            </div>
          )}
        </div>
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
