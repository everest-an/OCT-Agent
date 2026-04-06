/**
 * MissionCard — compact card showing a mission's progress.
 *
 * Shows: goal title, agent avatars in a row with status dots,
 * progress bar, and elapsed time.
 */

import { CheckCircle2, Loader2, XCircle, Clock, ChevronRight } from 'lucide-react';
import AgentAvatar from '../AgentAvatar';
import type { Mission } from '../../lib/mission-store';
import { missionProgress, formatElapsed } from '../../lib/mission-store';

interface MissionCardProps {
  mission: Mission;
  onClick: () => void;
  t: (key: string, fallback?: string) => string;
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  done: <CheckCircle2 size={14} className="text-emerald-400" />,
  failed: <XCircle size={14} className="text-red-400" />,
  running: <Loader2 size={14} className="text-sky-400 animate-spin" />,
  planning: <Loader2 size={14} className="text-amber-400 animate-spin" />,
  paused: <Clock size={14} className="text-amber-400" />,
};

export default function MissionCard({ mission, onClick, t }: MissionCardProps) {
  const progress = missionProgress(mission);
  const elapsed = formatElapsed(mission.startedAt, mission.completedAt);
  const currentStep = mission.currentStepIndex >= 0
    ? mission.steps[mission.currentStepIndex]
    : null;

  return (
    <button
      onClick={onClick}
      className="w-full text-left px-4 py-3.5 rounded-xl bg-slate-800/40 border border-slate-700/30 hover:bg-slate-800/60 hover:border-slate-600/40 transition-all group"
    >
      {/* Header: status icon + title + arrow */}
      <div className="flex items-center gap-2.5 mb-2.5">
        {STATUS_ICON[mission.status] || STATUS_ICON.planning}
        <span className="text-sm font-medium text-slate-200 truncate flex-1">
          {mission.goal}
        </span>
        <ChevronRight size={14} className="text-slate-600 group-hover:text-slate-400 transition-colors" />
      </div>

      {/* Agent avatars row with status */}
      <div className="flex items-center gap-1.5 mb-2.5">
        {mission.steps.map((step, i) => (
          <div key={step.id} className="flex items-center gap-0.5">
            <div className="relative">
              <AgentAvatar
                emoji={step.agentEmoji || ''}
                size={22}
              />
              {/* Status dot */}
              <div className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-slate-900 ${
                step.status === 'done' ? 'bg-emerald-400' :
                step.status === 'running' ? 'bg-sky-400 animate-pulse' :
                step.status === 'failed' ? 'bg-red-400' :
                'bg-slate-600'
              }`} />
            </div>
            {i < mission.steps.length - 1 && (
              <span className={`text-[10px] mx-0.5 ${
                step.status === 'done' ? 'text-emerald-600' : 'text-slate-700'
              }`}>→</span>
            )}
          </div>
        ))}
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-slate-700/50 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              mission.status === 'failed' ? 'bg-red-500' :
              mission.status === 'done' ? 'bg-emerald-500' :
              'bg-sky-500'
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-[10px] text-slate-500 tabular-nums w-8 text-right">
          {progress}%
        </span>
      </div>

      {/* Current step + elapsed */}
      <div className="flex items-center justify-between mt-2">
        <span className="text-[11px] text-slate-500 truncate">
          {currentStep
            ? `${currentStep.agentEmoji || '🤖'} ${currentStep.role}: ${t('mission.working', 'working...')}`
            : mission.status === 'done'
              ? t('mission.allDone', 'All agents finished')
              : mission.status === 'failed'
                ? t('mission.stepFailed', 'A step failed')
                : t('mission.preparing', 'Preparing team...')
          }
        </span>
        {elapsed && (
          <span className="text-[10px] text-slate-600 tabular-nums ml-2">{elapsed}</span>
        )}
      </div>
    </button>
  );
}
