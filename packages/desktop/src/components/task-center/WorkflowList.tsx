/**
 * WorkflowList — displays available workflow templates (builtin + custom).
 * Left side: list of workflows. Right side: selected workflow detail + run form.
 */

import { useState } from 'react';
import { Bug, ChevronRight, ClipboardList, FileText, Loader2, Lock, Rocket, Search, Workflow, Zap, type LucideIcon } from 'lucide-react';

interface WorkflowInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
  yamlPath: string;
  isBuiltin: boolean;
  args?: readonly { name: string; required: boolean; default?: string; description?: string }[];
  steps?: readonly { id: string; type: string; description?: string; approval?: boolean }[];
}

interface WorkflowListProps {
  t: (key: string, fallback?: string) => string;
  workflows: readonly WorkflowInfo[];
  onRun: (workflow: WorkflowInfo, args: Record<string, string>) => void;
  lobsterInstalled: boolean;
  onInstallLobster: () => void;
  lobsterInstalling: boolean;
}

// Builtin workflow metadata (i18n-friendly descriptions)
const BUILTIN_META: Record<string, { descKey: string; descFallback: string; icon: LucideIcon }> = {
  'code-review': {
    descKey: 'workflow.desc.codeReview',
    descFallback: 'Analyze → Review → Summarize. Structured code review with severity levels.',
    icon: Search,
  },
  'feature-dev': {
    descKey: 'workflow.desc.featureDev',
    descFallback: 'Plan → Implement → Test → Review. Full feature development pipeline.',
    icon: Rocket,
  },
  'bug-fix': {
    descKey: 'workflow.desc.bugFix',
    descFallback: 'Investigate → Fix → Verify. Root cause analysis and minimal fix.',
    icon: Bug,
  },
};

function getBuiltinKey(id: string): string {
  return id.replace(/^builtin-/, '');
}

export default function WorkflowList({
  t,
  workflows,
  onRun,
  lobsterInstalled,
  onInstallLobster,
  lobsterInstalling,
}: WorkflowListProps) {
  const [selectedId, setSelectedId] = useState<string | null>(workflows[0]?.id || null);
  const [argValues, setArgValues] = useState<Record<string, string>>({});

  const selected = workflows.find((w) => w.id === selectedId);

  function handleArgChange(name: string, value: string) {
    setArgValues((prev) => ({ ...prev, [name]: value }));
  }

  function handleRun() {
    if (!selected) return;
    onRun(selected, argValues);
  }

  if (!lobsterInstalled) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center space-y-4 max-w-sm">
          <div className="flex justify-center">
            <Workflow size={32} className="text-sky-300" />
          </div>
          <p className="text-sm text-slate-400">{t('taskCenter.lobster.notInstalled')}</p>
          <button
            onClick={onInstallLobster}
            disabled={lobsterInstalling}
            className="px-5 py-2.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-2 mx-auto"
          >
            {lobsterInstalling && <Loader2 size={14} className="animate-spin" />}
            {lobsterInstalling ? t('taskCenter.lobster.installing') : t('taskCenter.lobster.install')}
          </button>
          {lobsterInstalling && (
            <p className="text-xs text-slate-500 animate-pulse">
              {t('taskCenter.lobster.installHint', 'This may take a minute. OpenClaw is loading plugins...')}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (workflows.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 text-sm">
        {t('taskCenter.emptyWorkflows')}
      </div>
    );
  }

  return (
    <div className="flex gap-4 h-full min-h-0">
      {/* Left: workflow list */}
      <div className="w-72 flex-shrink-0 overflow-y-auto space-y-1">
        {workflows.map((wf) => {
          const meta = BUILTIN_META[getBuiltinKey(wf.id)];
          const isSelected = wf.id === selectedId;
          const Icon = meta?.icon || ClipboardList;
          return (
            <button
              key={wf.id}
              onClick={() => {
                setSelectedId(wf.id);
                setArgValues({});
              }}
              className={`
                w-full text-left px-3 py-3 rounded-xl transition-all duration-150
                ${isSelected
                  ? 'bg-sky-600/15 border border-sky-500/30'
                  : 'bg-slate-800/40 border border-transparent hover:bg-slate-800/70 hover:border-slate-700/50'
                }
              `}
            >
              <div className="flex items-center gap-2.5">
                <Icon size={18} className={isSelected ? 'text-sky-300' : 'text-slate-400'} />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${isSelected ? 'text-sky-300' : 'text-slate-200'}`}>
                    {wf.name}
                  </p>
                  <p className="text-[11px] text-slate-500 line-clamp-1 mt-0.5">
                    {meta ? t(meta.descKey, meta.descFallback) : wf.description}
                  </p>
                </div>
                {isSelected && <ChevronRight size={14} className="text-sky-400 flex-shrink-0" />}
              </div>
              {wf.isBuiltin && (
                <span className="inline-block mt-1.5 text-[10px] px-1.5 py-0.5 rounded bg-slate-700/50 text-slate-500">
                  Built-in
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Right: selected workflow detail */}
      {selected && (
        <div className="flex-1 min-w-0 bg-slate-800/30 rounded-xl border border-slate-700/40 p-5 overflow-y-auto">
          {/* Header */}
          <div className="flex items-center gap-3 mb-4">
            {(() => {
              const Icon = BUILTIN_META[getBuiltinKey(selected.id)]?.icon || ClipboardList;
              return <Icon size={20} className="text-sky-300" />;
            })()}
            <div>
              <h3 className="text-base font-semibold text-slate-100">{selected.name}</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                {BUILTIN_META[getBuiltinKey(selected.id)]
                  ? t(BUILTIN_META[getBuiltinKey(selected.id)].descKey, BUILTIN_META[getBuiltinKey(selected.id)].descFallback)
                  : selected.description}
              </p>
            </div>
          </div>

          {/* Steps preview */}
          {selected.steps && selected.steps.length > 0 && (
            <div className="mb-5">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                {t('workflow.steps')}
              </h4>
              <div className="flex items-center gap-1 flex-wrap">
                {selected.steps.map((step, i) => (
                  <div key={step.id} className="flex items-center gap-1">
                    <span className={`
                      text-xs px-2 py-1 rounded-md border
                      ${step.approval
                        ? 'bg-amber-900/20 border-amber-700/40 text-amber-400'
                        : 'bg-slate-800 border-slate-700/60 text-slate-300'
                      }
                    `}>
                      <span className="inline-flex items-center gap-1">
                        {step.approval ? <Lock size={11} /> : null}
                        {step.id}
                      </span>
                    </span>
                    {i < selected.steps!.length - 1 && (
                      <ChevronRight size={11} className="text-slate-600" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Parameters form */}
          {selected.args && selected.args.length > 0 && (
            <div className="mb-5">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                {t('workflow.args')}
              </h4>
              <div className="space-y-3">
                {selected.args.map((arg) => (
                  <div key={arg.name}>
                    <label className="text-xs text-slate-400 mb-1 block">
                      {arg.name}
                      {arg.required && <span className="text-red-400 ml-0.5">*</span>}
                    </label>
                    <textarea
                      value={argValues[arg.name] ?? arg.default ?? ''}
                      onChange={(e) => handleArgChange(arg.name, e.target.value)}
                      rows={2}
                      placeholder={arg.description || arg.name}
                      className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500/40 resize-none"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Run button */}
          <button
            onClick={handleRun}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium transition-colors"
          >
            <Zap size={16} />
            {t('workflow.run')}
          </button>

          {/* YAML path (small) */}
          <div className="mt-4 flex items-center gap-1.5 text-[10px] text-slate-600">
            <FileText size={10} />
            <span className="truncate">{selected.yamlPath}</span>
          </div>
        </div>
      )}
    </div>
  );
}
