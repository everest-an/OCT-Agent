/**
 * MissionDetail — full mission view showing each agent's step.
 *
 * Vertical timeline with:
 * - Agent avatar + role + status
 * - Output preview (collapsible)
 * - "Open in Chat" button per step
 * - "Continue" input for running/done steps
 */

import { useState } from 'react';
import {
  ArrowLeft, CheckCircle2, ChevronDown, ChevronUp, Clock,
  ExternalLink, Loader2, MessageSquare, RotateCw, Trash2, XCircle,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import AgentAvatar from '../AgentAvatar';
import type { Mission, MissionStep } from '../../lib/mission-store';
import { formatElapsed, missionProgress } from '../../lib/mission-store';

interface MissionDetailProps {
  mission: Mission;
  streamingText?: string;
  onBack: () => void;
  onOpenChat: (sessionKey: string, title: string) => void;
  onRetry?: () => void;
  onDelete?: () => void;
  t: (key: string, fallback?: string) => string;
}

function StepStatusBadge({ status, t }: { status: MissionStep['status']; t: MissionDetailProps['t'] }) {
  const config = {
    waiting: { label: t('step.waiting', 'Waiting'), color: 'text-slate-500 bg-slate-800', icon: <Clock size={10} /> },
    running: { label: t('step.running', 'Working'), color: 'text-sky-400 bg-sky-900/30', icon: <Loader2 size={10} className="animate-spin" /> },
    done: { label: t('step.done', 'Done'), color: 'text-emerald-400 bg-emerald-900/30', icon: <CheckCircle2 size={10} /> },
    failed: { label: t('step.failed', 'Failed'), color: 'text-red-400 bg-red-900/30', icon: <XCircle size={10} /> },
    skipped: { label: t('step.skipped', 'Skipped'), color: 'text-slate-500 bg-slate-800', icon: null },
  }[status];

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${config.color}`}>
      {config.icon}
      {config.label}
    </span>
  );
}

function StepCard({
  step,
  index,
  isLast,
  onOpenChat,
  t,
}: {
  step: MissionStep;
  index: number;
  isLast: boolean;
  onOpenChat: MissionDetailProps['onOpenChat'];
  t: MissionDetailProps['t'];
}) {
  const [expanded, setExpanded] = useState(step.status === 'running');
  const elapsed = formatElapsed(step.startedAt, step.completedAt);
  const hasOutput = !!(step.result || step.error);

  return (
    <div className="flex gap-3">
      {/* Timeline line + dot */}
      <div className="flex flex-col items-center flex-shrink-0 w-8">
        <div className={`w-3 h-3 rounded-full border-2 flex-shrink-0 mt-1.5 ${
          step.status === 'done' ? 'bg-emerald-500 border-emerald-400' :
          step.status === 'running' ? 'bg-sky-500 border-sky-400 animate-pulse' :
          step.status === 'failed' ? 'bg-red-500 border-red-400' :
          'bg-slate-700 border-slate-600'
        }`} />
        {!isLast && (
          <div className={`w-0.5 flex-1 min-h-[24px] ${
            step.status === 'done' ? 'bg-emerald-700/50' : 'bg-slate-700/50'
          }`} />
        )}
      </div>

      {/* Step content */}
      <div className="flex-1 pb-4 min-w-0">
        {/* Header: avatar + role + status + time */}
        <div className="flex items-center gap-2 mb-1.5">
          <AgentAvatar emoji={step.agentEmoji || ''} size={20} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-200">{step.role}</span>
              <span className="text-[10px] text-slate-500">{step.agentName}</span>
            </div>
          </div>
          <StepStatusBadge status={step.status} t={t} />
          {elapsed && <span className="text-[10px] text-slate-600 tabular-nums">{elapsed}</span>}
        </div>

        {/* Output preview / expand */}
        {hasOutput && (
          <div className="rounded-lg bg-slate-800/50 border border-slate-700/30 overflow-hidden">
            <button
              onClick={() => setExpanded(!expanded)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-700/30 transition-colors"
            >
              {expanded ? <ChevronUp size={12} className="text-slate-500" /> : <ChevronDown size={12} className="text-slate-500" />}
              <span className="text-xs text-slate-400 truncate flex-1">
                {step.error ? t('step.errorPreview', 'Something went wrong...') : (step.result || '').slice(0, 80)}
              </span>
            </button>
            {expanded && (
              <div className="px-3 pb-3 border-t border-slate-700/20">
                <div className="text-xs text-slate-300 leading-relaxed mt-2 prose prose-invert prose-sm max-w-none prose-p:my-1">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {step.error || step.result || ''}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Running indicator */}
        {step.status === 'running' && !hasOutput && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-sky-950/20 border border-sky-900/30">
            <Loader2 size={12} className="animate-spin text-sky-400" />
            <span className="text-xs text-sky-300">
              {step.instruction || t('step.working', 'Working on this step...')}
            </span>
          </div>
        )}

        {/* Action buttons */}
        {step.sessionKey && (step.status === 'done' || step.status === 'running') && (
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => onOpenChat(step.sessionKey!, `${step.role}: ${step.agentName}`)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-700/30 hover:bg-slate-700/50 text-slate-300 text-[11px] font-medium transition-colors"
            >
              {step.status === 'running'
                ? <><MessageSquare size={10} /> {t('step.watchLive', 'Watch Live')}</>
                : <><ExternalLink size={10} /> {t('step.openChat', 'Open in Chat')}</>
              }
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function MissionDetail({
  mission,
  streamingText = '',
  onBack,
  onOpenChat,
  onRetry,
  onDelete,
  t,
}: MissionDetailProps) {
  const progress = missionProgress(mission);
  const elapsed = formatElapsed(mission.startedAt, mission.completedAt);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-slate-200 truncate">{mission.goal}</h2>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-slate-500">
                {mission.steps.length} {t('mission.agents', 'agents')}
              </span>
              {elapsed && <span className="text-[10px] text-slate-500">• {elapsed}</span>}
              <span className="text-[10px] text-slate-500">• {progress}%</span>
            </div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="h-1.5 rounded-full bg-slate-700/50 overflow-hidden mt-3">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              mission.status === 'failed' ? 'bg-red-500' :
              mission.status === 'done' ? 'bg-emerald-500' :
              'bg-sky-500'
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Steps timeline */}
      <div className="flex-1 overflow-y-auto px-4 py-4 min-h-0">
        {/* Streaming output from main agent */}
        {(mission.status === 'planning' || mission.status === 'running') && (
          <div className="rounded-lg bg-sky-950/20 border border-sky-900/30 px-4 py-3 mb-3">
            <div className="flex items-center gap-2 mb-2">
              <Loader2 size={14} className="animate-spin text-sky-400" />
              <span className="text-[11px] text-sky-400 font-medium">
                {mission.steps.length === 0
                  ? t('mission.planning', 'AI is analyzing your task...')
                  : t('mission.orchestrating', 'AI is coordinating the team...')}
              </span>
            </div>
            {streamingText ? (
              <div className="text-xs text-slate-300 leading-relaxed max-h-48 overflow-y-auto prose prose-invert prose-sm max-w-none prose-p:my-1">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-[11px] text-sky-400/60">{t('mission.planningHint', 'It will pick the right agents and start working')}</p>
            )}
          </div>
        )}

        {mission.steps.map((step, i) => (
          <StepCard
            key={step.id}
            step={step}
            index={i}
            isLast={i === mission.steps.length - 1}
            onOpenChat={onOpenChat}
            t={t}
          />
        ))}

        {/* Mission result */}
        {mission.result && mission.status === 'done' && (
          <div className="mt-4 rounded-lg bg-emerald-950/20 border border-emerald-900/30 px-4 py-3">
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-400 mb-2">
              <CheckCircle2 size={12} />
              <span className="font-medium">{t('mission.summary', 'Summary')}</span>
            </div>
            <div className="text-xs text-slate-300 leading-relaxed prose prose-invert prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{mission.result}</ReactMarkdown>
            </div>
          </div>
        )}

        {/* Mission error */}
        {mission.error && mission.status === 'failed' && (
          <div className="mt-4 rounded-lg bg-red-950/20 border border-red-900/30 px-4 py-3">
            <div className="flex items-center gap-1.5 text-[11px] text-red-400 mb-1">
              <XCircle size={12} />
              <span>{t('mission.error', 'Error')}</span>
            </div>
            <p className="text-xs text-red-300/80">{mission.error}</p>
          </div>
        )}
      </div>

      {/* Bottom actions */}
      <div className="flex-shrink-0 px-4 py-3 border-t border-slate-800 flex gap-2">
        {/* Open main agent chat */}
        {(() => {
          // Prefer the mission-level sessionKey, but fall back to the first step's
          // sessionKey if the mission key is still the synthetic local missionId
          // (which Gateway doesn't know about). This happens briefly before the
          // backend patches the mission with the real agent session key.
          const isSyntheticKey = mission.sessionKey?.startsWith('mission-');
          const fallbackKey = isSyntheticKey
            ? mission.steps.find(s => s.sessionKey && !s.sessionKey.startsWith('pending-'))?.sessionKey
            : undefined;
          const chatSessionKey = fallbackKey || (isSyntheticKey ? undefined : mission.sessionKey);
          return chatSessionKey ? (
            <button
              onClick={() => onOpenChat(chatSessionKey, mission.goal)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 text-xs font-medium border border-sky-600/30"
            >
              <ExternalLink size={11} /> {t('mission.openOrchestratorChat', 'View Full Chat')}
            </button>
          ) : null;
        })()}
        {mission.status === 'failed' && onRetry && (
          <button
            onClick={onRetry}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 text-xs font-medium border border-amber-600/30"
          >
            <RotateCw size={11} /> {t('mission.retry', 'Retry')}
          </button>
        )}
        {onDelete && (
          <button
            onClick={onDelete}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700/30 hover:bg-slate-700/50 text-slate-400 text-xs font-medium border border-slate-700/40"
          >
            <Trash2 size={11} /> {t('mission.delete', 'Delete')}
          </button>
        )}
      </div>
    </div>
  );
}
