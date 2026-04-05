/**
 * TaskCreateModal — guided task creation wizard.
 *
 * Step 1: Pick a scenario card OR type freely (with rotating examples)
 * Step 2: Optional refinement chips + directory picker + preview
 *
 * All technical params (agent, priority, timeout) are auto-decided.
 * Target user: non-technical, "10-year-old friendly".
 */

import { useState, useEffect } from 'react';
import {
  ArrowLeft, Bug, Code2, FileText, FolderOpen,
  Loader2, Rocket, Search, Sparkles, TestTube2, X,
} from 'lucide-react';

interface AgentOption {
  id: string;
  name?: string;
  emoji?: string;
}

interface TaskCreateModalProps {
  t: (key: string, fallback?: string) => string;
  agents: readonly AgentOption[];
  onClose: () => void;
  onCreate: (params: {
    title: string;
    agentId: string;
    priority: 'low' | 'medium' | 'high';
    model?: string;
    timeoutSeconds?: number;
    workDir?: string;
  }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

interface Scenario {
  id: string;
  icon: React.ReactNode;
  labelKey: string;
  labelFallback: string;
  exampleKey: string;
  exampleFallback: string;
  placeholder: string;
  techChips?: string[];
  defaultTimeout: number;
  priority: 'low' | 'medium' | 'high';
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: 'project',
    icon: <Rocket size={20} />,
    labelKey: 'scenario.project',
    labelFallback: 'Build a Project',
    exampleKey: 'scenario.project.example',
    exampleFallback: '"Build a snake game in pure HTML"',
    placeholder: 'Describe the project you want to build...',
    techChips: ['HTML/CSS/JS', 'React', 'Python', 'Vue', 'Node.js'],
    defaultTimeout: 600,
    priority: 'medium',
  },
  {
    id: 'review',
    icon: <Search size={20} />,
    labelKey: 'scenario.review',
    labelFallback: 'Review Code',
    exampleKey: 'scenario.review.example',
    exampleFallback: '"Check the auth module for security issues"',
    placeholder: 'What code should be reviewed?',
    defaultTimeout: 300,
    priority: 'medium',
  },
  {
    id: 'bugfix',
    icon: <Bug size={20} />,
    labelKey: 'scenario.bugfix',
    labelFallback: 'Fix a Bug',
    exampleKey: 'scenario.bugfix.example',
    exampleFallback: '"Login page shows a blank screen"',
    placeholder: 'Describe the bug...',
    defaultTimeout: 300,
    priority: 'high',
  },
  {
    id: 'docs',
    icon: <FileText size={20} />,
    labelKey: 'scenario.docs',
    labelFallback: 'Write Docs',
    exampleKey: 'scenario.docs.example',
    exampleFallback: '"Generate API docs for the user module"',
    placeholder: 'What documentation do you need?',
    defaultTimeout: 300,
    priority: 'low',
  },
  {
    id: 'test',
    icon: <TestTube2 size={20} />,
    labelKey: 'scenario.test',
    labelFallback: 'Write Tests',
    exampleKey: 'scenario.test.example',
    exampleFallback: '"Write unit tests for the payment service"',
    placeholder: 'What should be tested?',
    defaultTimeout: 300,
    priority: 'medium',
  },
  {
    id: 'custom',
    icon: <Sparkles size={20} />,
    labelKey: 'scenario.custom',
    labelFallback: 'Something Else',
    exampleKey: 'scenario.custom.example',
    exampleFallback: 'Describe anything you want AI to do',
    placeholder: 'Describe what you want...',
    defaultTimeout: 300,
    priority: 'medium',
  },
];

// Rotating example prompts for the free-text input
const EXAMPLE_PROMPTS = [
  'Build a to-do list app with React',
  'Review my auth code for security issues',
  'Fix the CSS layout on the dashboard',
  'Generate API documentation',
  'Refactor the database queries for performance',
  'Create a landing page with animations',
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Step = 'pick' | 'refine';

export default function TaskCreateModal({ t, agents, onClose, onCreate }: TaskCreateModalProps) {
  const [step, setStep] = useState<Step>('pick');
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [description, setDescription] = useState('');
  const [techChoice, setTechChoice] = useState('');
  const [workDir, setWorkDir] = useState('');
  const [creating, setCreating] = useState(false);
  const [exampleIdx, setExampleIdx] = useState(0);

  // Rotate example prompts every 3 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      setExampleIdx((i) => (i + 1) % EXAMPLE_PROMPTS.length);
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  function handlePickScenario(s: Scenario) {
    setScenario(s);
    setStep('refine');
  }

  function handleFreeTextNext() {
    if (!description.trim()) return;
    // Auto-detect best scenario from description
    setScenario(SCENARIOS[SCENARIOS.length - 1]); // default to 'custom'
    setStep('refine');
  }

  async function handlePickDir() {
    const result = await window.electronAPI?.taskPickDirectory?.();
    if (result && !result.cancelled && result.path) {
      setWorkDir(result.path);
    }
  }

  async function handleStart() {
    const desc = description.trim();
    if (!desc || creating) return;
    setCreating(true);

    // Build rich description
    const parts: string[] = [];
    if (techChoice) parts.push(`Tech: ${techChoice}`);
    if (workDir) parts.push(`Working directory: ${workDir}`);
    parts.push(desc);
    const fullDesc = parts.join('\n');

    // Auto-select best agent (first available, or 'main')
    const agentId = agents[0]?.id || 'main';

    try {
      await onCreate({
        title: fullDesc,
        agentId,
        priority: scenario?.priority || 'medium',
        timeoutSeconds: scenario?.defaultTimeout || 300,
        workDir: workDir || undefined,
      });
      onClose();
    } catch {
      setCreating(false);
    }
  }

  // Build preview text
  const previewParts: string[] = [];
  if (scenario && scenario.id !== 'custom') {
    previewParts.push(t(scenario.labelKey, scenario.labelFallback));
  }
  if (techChoice) previewParts.push(techChoice);
  if (workDir) {
    const shortDir = workDir.length > 30 ? '...' + workDir.slice(-30) : workDir;
    previewParts.push(shortDir);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg mx-4 shadow-2xl animate-in zoom-in-95 max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            {step === 'refine' && (
              <button
                onClick={() => setStep('pick')}
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
              >
                <ArrowLeft size={16} />
              </button>
            )}
            <h2 className="text-base font-semibold text-slate-100">
              {step === 'pick'
                ? t('taskCreate.whatToDo', 'What do you want AI to do?')
                : t('taskCreate.refineTask', 'A few more details')
              }
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
            aria-label={t('common.close', 'Close')}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {step === 'pick' && (
            <div className="space-y-4">
              {/* Scenario cards grid */}
              <div className="grid grid-cols-3 gap-2">
                {SCENARIOS.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => handlePickScenario(s)}
                    className="flex flex-col items-center gap-2 p-4 rounded-xl bg-slate-800/50 border border-slate-700/50 hover:bg-slate-800 hover:border-sky-500/30 transition-all text-center group"
                  >
                    <div className="text-slate-400 group-hover:text-sky-400 transition-colors">
                      {s.icon}
                    </div>
                    <span className="text-xs font-medium text-slate-200">
                      {t(s.labelKey, s.labelFallback)}
                    </span>
                    <span className="text-[10px] text-slate-500 line-clamp-1">
                      {t(s.exampleKey, s.exampleFallback)}
                    </span>
                  </button>
                ))}
              </div>

              {/* Divider */}
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-slate-800" />
                <span className="text-[10px] text-slate-600 uppercase tracking-wider">
                  {t('taskCreate.orDescribe', 'or describe directly')}
                </span>
                <div className="flex-1 h-px bg-slate-800" />
              </div>

              {/* Free text input with rotating examples */}
              <div>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={EXAMPLE_PROMPTS[exampleIdx]}
                  rows={3}
                  className="w-full rounded-xl bg-slate-800/70 border border-slate-700 px-4 py-3 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500/50 resize-none transition-all"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleFreeTextNext();
                  }}
                />
                <div className="flex items-center justify-between mt-2">
                  <p className="text-[10px] text-slate-600">
                    💡 {t('taskCreate.tipRotating', 'Try one of the examples above')}
                  </p>
                  {description.trim() && (
                    <button
                      onClick={handleFreeTextNext}
                      className="text-xs text-sky-400 hover:text-sky-300 font-medium"
                    >
                      {t('taskCreate.next', 'Next →')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {step === 'refine' && scenario && (
            <div className="space-y-5">
              {/* Scenario badge */}
              <div className="flex items-center gap-2 text-sky-400">
                {scenario.icon}
                <span className="text-sm font-medium">
                  {t(scenario.labelKey, scenario.labelFallback)}
                </span>
              </div>

              {/* Description */}
              <div>
                <label className="text-xs font-medium text-slate-400 mb-1.5 block">
                  {t('taskCreate.describeIt', 'Describe what you need')}
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={scenario.placeholder}
                  rows={3}
                  autoFocus
                  className="w-full rounded-xl bg-slate-800/70 border border-slate-700 px-4 py-3 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500/40 resize-none"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleStart();
                  }}
                />
              </div>

              {/* Tech chips (optional, only for some scenarios) */}
              {scenario.techChips && (
                <div>
                  <label className="text-xs font-medium text-slate-400 mb-2 block">
                    {t('taskCreate.techStack', 'Tech stack')}
                    <span className="text-slate-600 ml-1">({t('taskCreate.optional', 'optional')})</span>
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {scenario.techChips.map((chip) => (
                      <button
                        key={chip}
                        onClick={() => setTechChoice(techChoice === chip ? '' : chip)}
                        className={`
                          px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                          ${techChoice === chip
                            ? 'bg-sky-600/20 text-sky-400 border border-sky-500/40'
                            : 'bg-slate-800 text-slate-400 border border-slate-700/60 hover:bg-slate-700'
                          }
                        `}
                      >
                        {chip}
                      </button>
                    ))}
                    <button
                      onClick={() => setTechChoice('')}
                      className={`
                        px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                        ${!techChoice
                          ? 'bg-sky-600/20 text-sky-400 border border-sky-500/40'
                          : 'bg-slate-800 text-slate-400 border border-slate-700/60 hover:bg-slate-700'
                        }
                      `}
                    >
                      {t('taskCreate.letAiDecide', 'Let AI decide')}
                    </button>
                  </div>
                </div>
              )}

              {/* Directory picker */}
              <div>
                <label className="text-xs font-medium text-slate-400 mb-2 block">
                  {t('taskCreate.whereToWork', 'Where should AI work?')}
                  <span className="text-slate-600 ml-1">({t('taskCreate.optional', 'optional')})</span>
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setWorkDir('')}
                    className={`
                      flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all text-left
                      ${!workDir
                        ? 'bg-sky-600/20 text-sky-400 border border-sky-500/40'
                        : 'bg-slate-800 text-slate-400 border border-slate-700/60 hover:bg-slate-700'
                      }
                    `}
                  >
                    {t('taskCreate.defaultDir', 'Default location')}
                  </button>
                  <button
                    onClick={handlePickDir}
                    className={`
                      flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all
                      ${workDir
                        ? 'bg-sky-600/20 text-sky-400 border border-sky-500/40'
                        : 'bg-slate-800 text-slate-400 border border-slate-700/60 hover:bg-slate-700'
                      }
                    `}
                  >
                    <FolderOpen size={13} />
                    {workDir
                      ? (workDir.length > 25 ? '...' + workDir.slice(-25) : workDir)
                      : t('taskCreate.chooseFolder', 'Choose folder')
                    }
                  </button>
                </div>
              </div>

              {/* Preview card */}
              {description.trim() && (
                <div className="rounded-xl bg-slate-800/40 border border-slate-700/30 p-4">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">
                    {t('taskCreate.preview', 'Preview')}
                  </p>
                  <p className="text-sm text-slate-300">
                    {t('taskCreate.previewText', 'AI will')}: {description.trim().slice(0, 100)}{description.length > 100 ? '...' : ''}
                  </p>
                  {previewParts.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {previewParts.map((part, i) => (
                        <span key={i} className="text-[10px] px-2 py-0.5 rounded bg-slate-700/50 text-slate-400">
                          {part}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="text-[10px] text-slate-600 mt-2">
                    {t('taskCreate.estimatedTime', 'Estimated')}: {(scenario?.defaultTimeout || 300) / 60} {t('taskCreate.minutes', 'min')}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {step === 'refine' && (
          <div className="flex items-center justify-between px-5 py-4 border-t border-slate-800 flex-shrink-0">
            <button
              onClick={handleStart}
              disabled={!description.trim()}
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-30"
            >
              {t('taskCreate.skipDetails', 'Skip details, just start')}
            </button>
            <button
              onClick={handleStart}
              disabled={!description.trim() || creating}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
              {creating ? t('taskCreate.starting', 'Starting...') : t('taskCreate.start', 'Start')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
