/**
 * KanbanCard — a single task card in the kanban board.
 * Entire card is clickable (opens detail panel).
 * Displays agent avatar, title, status, elapsed time, priority stripe.
 * Hover shows retry/cancel/delete actions.
 */

import { CheckCircle2, Loader2, RotateCw, Trash2, X, XCircle } from 'lucide-react';
import AgentAvatar from '../AgentAvatar';
import type { Task } from '../../lib/task-store';

const PRIORITY_COLORS: Record<string, string> = {
  high: 'border-l-red-500',
  medium: 'border-l-amber-500',
  low: 'border-l-slate-500',
};

function elapsed(startedAt?: string, endedAt?: string): string {
  if (!startedAt) return '';
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const ms = end - new Date(startedAt).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3600_000)}h ${Math.floor((ms % 3600_000) / 60_000)}m`;
}

interface KanbanCardProps {
  task: Task;
  t: (key: string, fallback?: string) => string;
  onClick?: () => void;
  onRetry?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
}

export default function KanbanCard({ task, t, onClick, onRetry, onCancel, onDelete }: KanbanCardProps) {
  const isActive = task.status === 'running' || task.status === 'queued';

  return (
    <button
      type="button"
      onClick={onClick}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      className={`
        group relative w-full text-left rounded-lg border-l-4 ${PRIORITY_COLORS[task.priority] || PRIORITY_COLORS.medium}
        bg-slate-800/60 border border-slate-700/50 p-3 cursor-pointer
        hover:bg-slate-800 hover:border-slate-600/60 transition-all duration-150
      `}
    >
      {/* Header: agent + title */}
      <div className="flex items-start gap-2 mb-2">
        <AgentAvatar name={task.agentName || task.agentId} emoji={task.agentEmoji || ''} size={16} className="flex-shrink-0" />
        <p className="text-sm font-medium text-slate-200 line-clamp-2 leading-snug min-w-0 flex-1">
          {task.title}
        </p>
      </div>

      {/* Status + elapsed */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {isActive && <Loader2 size={12} className="animate-spin text-sky-400" />}
          {task.status === 'done' && <CheckCircle2 size={12} className="text-emerald-400" />}
          {task.status === 'failed' && <XCircle size={12} className="text-red-400" />}
          <span className="text-[11px] text-slate-400">
            {isActive && task.startedAt ? elapsed(task.startedAt) : ''}
            {(task.status === 'done' || task.status === 'failed') && task.startedAt
              ? elapsed(task.startedAt, task.completedAt)
              : ''}
          </span>
        </div>

        {/* Hover actions */}
        <div
          className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          {task.status === 'failed' && onRetry && (
            <button
              onClick={onRetry}
              className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-amber-400"
              title={t('taskCard.retry', 'Retry')}
            >
              <RotateCw size={12} />
            </button>
          )}
          {isActive && onCancel && (
            <button
              onClick={onCancel}
              className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-red-400"
              title={t('taskCard.cancel', 'Cancel')}
            >
              <X size={12} />
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-red-400"
              title={t('taskCard.delete', 'Delete')}
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Result preview */}
      {task.status === 'done' && task.result && (
        <p className="text-[11px] text-slate-500 mt-2 line-clamp-2 leading-relaxed border-t border-slate-700/40 pt-2">
          {task.result}
        </p>
      )}
      {task.status === 'failed' && task.error && (
        <p className="text-[11px] text-red-400/70 mt-2 line-clamp-1 leading-relaxed border-t border-slate-700/40 pt-2">
          {task.error}
        </p>
      )}
    </button>
  );
}
