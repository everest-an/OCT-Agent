/**
 * WorkflowList — "Automation Rules" card-based UI.
 *
 * Each rule is a toggle card with plain-language description.
 * No YAML editing, no technical params exposed.
 * Users see: icon + name + description + ON/OFF toggle.
 *
 * Custom rules are created via natural language, not YAML editor.
 */

import { useState } from 'react';
import {
  ChevronDown, ChevronUp, Loader2, Plus, Shield, TestTube2,
  FileText, Rocket, Workflow, Zap,
} from 'lucide-react';

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

// Human-readable rule definitions for builtin workflows
const BUILTIN_RULES: Record<string, {
  icon: React.ReactNode;
  nameKey: string;
  nameFallback: string;
  descKey: string;
  descFallback: string;
  detailKey: string;
  detailFallback: string;
  recommended?: boolean;
}> = {
  'code-review': {
    icon: <Shield size={20} className="text-emerald-400" />,
    nameKey: 'rule.codeReview.name',
    nameFallback: 'Code Security Review',
    descKey: 'rule.codeReview.desc',
    descFallback: 'After writing code, automatically check for security issues and code quality',
    detailKey: 'rule.codeReview.detail',
    detailFallback: 'AI will analyze your code for: security vulnerabilities (OWASP Top 10), code quality issues, performance problems, and suggest fixes with severity levels.',
    recommended: true,
  },
  'bug-fix': {
    icon: <Zap size={20} className="text-amber-400" />,
    nameKey: 'rule.bugFix.name',
    nameFallback: 'Auto Bug Investigation',
    descKey: 'rule.bugFix.desc',
    descFallback: 'When you report a bug, AI investigates the root cause and suggests a fix',
    detailKey: 'rule.bugFix.detail',
    detailFallback: 'AI will: 1) Investigate the root cause 2) Propose a minimal fix 3) Wait for your approval 4) Verify the fix works.',
  },
  'feature-dev': {
    icon: <Rocket size={20} className="text-sky-400" />,
    nameKey: 'rule.featureDev.name',
    nameFallback: 'Feature Development Pipeline',
    descKey: 'rule.featureDev.desc',
    descFallback: 'Plan → implement → test → review. Full feature development with quality checks',
    detailKey: 'rule.featureDev.detail',
    detailFallback: 'AI will: 1) Create an implementation plan 2) Wait for your approval 3) Write the code 4) Write tests 5) Do a final review.',
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [customDesc, setCustomDesc] = useState('');
  const [runningId, setRunningId] = useState<string | null>(null);

  function handleToggleExpand(id: string) {
    setExpandedId(expandedId === id ? null : id);
  }

  async function handleRunWorkflow(wf: WorkflowInfo) {
    setRunningId(wf.id);
    try {
      await onRun(wf, {});
    } finally {
      setRunningId(null);
    }
  }

  // Lobster not installed — show friendly install prompt
  if (!lobsterInstalled) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center space-y-4 max-w-sm">
          <Workflow size={32} className="text-sky-300 mx-auto" />
          <div>
            <p className="text-sm text-slate-300 font-medium">
              {t('taskCenter.lobster.title', 'Automation Engine')}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              {t('taskCenter.lobster.desc', 'Install the automation engine to enable workflow rules')}
            </p>
          </div>
          <button
            onClick={onInstallLobster}
            disabled={lobsterInstalling}
            className="px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-2 mx-auto"
          >
            {lobsterInstalling && <Loader2 size={14} className="animate-spin" />}
            {lobsterInstalling ? t('taskCenter.lobster.installing', 'Installing...') : t('taskCenter.lobster.install', 'Install')}
          </button>
          {lobsterInstalling && (
            <p className="text-[10px] text-slate-600 animate-pulse">
              {t('taskCenter.lobster.installHint', 'This may take a minute...')}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 overflow-y-auto flex-1 min-h-0">
      {/* Header */}
      <div className="mb-1">
        <h3 className="text-sm font-semibold text-slate-200">
          {t('rules.title', 'Automation Rules')}
        </h3>
        <p className="text-[11px] text-slate-500 mt-0.5">
          {t('rules.subtitle', 'Set up once, AI runs them automatically')}
        </p>
      </div>

      {/* Builtin rule cards */}
      {workflows.map((wf) => {
        const key = getBuiltinKey(wf.id);
        const rule = BUILTIN_RULES[key];
        const isExpanded = expandedId === wf.id;
        const isRunning = runningId === wf.id;

        return (
          <div
            key={wf.id}
            className="rounded-xl bg-slate-800/40 border border-slate-700/40 overflow-hidden transition-all"
          >
            {/* Card header */}
            <div className="flex items-center gap-3 px-4 py-3.5">
              <div className="flex-shrink-0">
                {rule?.icon || <FileText size={20} className="text-slate-400" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-slate-200 truncate">
                    {rule ? t(rule.nameKey, rule.nameFallback) : wf.name}
                  </p>
                  {rule?.recommended && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-900/30 text-emerald-400 border border-emerald-700/30 font-medium">
                      {t('rules.recommended', 'Recommended')}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">
                  {rule ? t(rule.descKey, rule.descFallback) : wf.description}
                </p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => handleToggleExpand(wf.id)}
                  className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-colors"
                  title={isExpanded ? t('rules.collapse', 'Collapse') : t('rules.expand', 'Learn more')}
                >
                  {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
                <button
                  onClick={() => handleRunWorkflow(wf)}
                  disabled={isRunning}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600/20 text-sky-400 hover:bg-sky-600/30 border border-sky-500/30 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                >
                  {isRunning ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                  {t('rules.run', 'Run')}
                </button>
              </div>
            </div>

            {/* Expanded detail */}
            {isExpanded && (
              <div className="px-4 pb-4 border-t border-slate-700/30">
                <p className="text-xs text-slate-400 mt-3 leading-relaxed">
                  {rule ? t(rule.detailKey, rule.detailFallback) : wf.description}
                </p>
                {/* Steps preview */}
                {wf.steps && wf.steps.length > 0 && (
                  <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                    {wf.steps.map((step, i) => (
                      <div key={step.id} className="flex items-center gap-1">
                        <span className="text-[10px] px-2 py-0.5 rounded bg-slate-700/50 text-slate-400">
                          {step.id}
                        </span>
                        {i < wf.steps!.length - 1 && (
                          <span className="text-slate-600 text-[10px]">→</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Custom rule input */}
      <div className="rounded-xl bg-slate-800/20 border border-dashed border-slate-700/40 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Plus size={16} className="text-slate-500" />
          <p className="text-xs font-medium text-slate-400">
            {t('rules.createCustom', 'Create a custom rule')}
          </p>
        </div>
        <div className="flex gap-2">
          <textarea
            value={customDesc}
            onChange={(e) => setCustomDesc(e.target.value)}
            placeholder={t('rules.customPlaceholder', 'e.g. "After every commit, run a security check"')}
            rows={2}
            className="flex-1 rounded-lg bg-slate-900/50 border border-slate-700/50 px-3 py-2 text-xs text-slate-300 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500/30 resize-none"
          />
        </div>
        {customDesc.trim() && (
          <button
            onClick={async () => {
              // Save as a simple custom workflow that passes the description as the task
              const name = customDesc.trim().slice(0, 30).replace(/[^a-zA-Z0-9\u4e00-\u9fff ]/g, '').trim() || 'custom-rule';
              const yaml = `# ${customDesc.trim()}\nname: ${name.replace(/ /g, '-').toLowerCase()}\nargs:\n  task:\n    default: "${customDesc.trim().replace(/"/g, '\\"')}"\nsteps:\n  - id: execute\n    run: openclaw agent -m "$LOBSTER_ARG_TASK"\n`;
              await window.electronAPI?.workflowSave?.(name, yaml);
              setCustomDesc('');
            }}
            className="mt-2 text-xs text-sky-400 hover:text-sky-300 font-medium"
          >
            {t('rules.save', 'Save Rule')}
          </button>
        )}
      </div>

      {/* Empty state for no workflows */}
      {workflows.length === 0 && (
        <div className="text-center py-8 text-slate-600 text-xs">
          {t('rules.empty', 'No automation rules available yet')}
        </div>
      )}
    </div>
  );
}
