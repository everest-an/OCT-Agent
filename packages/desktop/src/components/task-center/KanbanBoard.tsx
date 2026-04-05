/**
 * KanbanBoard — 5-column task board.
 * Columns: Backlog → Queued → Running → Done → Failed
 * Cards are directly clickable to show detail panel.
 * Drag: only backlog/failed → queued triggers spawn/retry.
 */

import { useState } from 'react';
import KanbanCard from './KanbanCard';
import type { Task, TaskStatus } from '../../lib/task-store';
import { Trash2 } from 'lucide-react';

const DISPLAY_COLUMNS: readonly TaskStatus[] = ['backlog', 'queued', 'running', 'done', 'failed'] as const;
const DROPPABLE_COLUMNS: ReadonlySet<TaskStatus> = new Set(['queued']);

const COLUMN_I18N: Record<string, string> = {
  backlog: 'kanban.backlog',
  queued: 'kanban.queued',
  running: 'kanban.running',
  done: 'kanban.done',
  failed: 'kanban.failed',
};

const COLUMN_COLORS: Record<string, string> = {
  backlog: 'bg-slate-500',
  queued: 'bg-amber-500',
  running: 'bg-sky-500',
  done: 'bg-emerald-500',
  failed: 'bg-red-500',
};

interface KanbanBoardProps {
  tasks: readonly Task[];
  t: (key: string, fallback?: string) => string;
  onMoveTask: (taskId: string, fromColumn: TaskStatus, toColumn: TaskStatus) => void;
  onRetryTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
  onViewDetail: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onClearCompleted: () => void;
}

function tasksByColumn(tasks: readonly Task[]): Record<TaskStatus, readonly Task[]> {
  const result: Record<string, Task[]> = {
    backlog: [], queued: [], running: [], done: [], failed: [],
  };
  for (const t of tasks) {
    (result[t.status] ?? result.backlog).push(t);
  }
  return result as Record<TaskStatus, readonly Task[]>;
}

export default function KanbanBoard({
  tasks, t, onMoveTask, onRetryTask, onCancelTask, onViewDetail, onDeleteTask, onClearCompleted,
}: KanbanBoardProps) {
  const columns = tasksByColumn(tasks);
  const [dragOverColumn, setDragOverColumn] = useState<TaskStatus | null>(null);
  const completedCount = (columns.done?.length || 0) + (columns.failed?.length || 0);

  function canDrop(column: TaskStatus): boolean {
    return DROPPABLE_COLUMNS.has(column);
  }

  function handleDragOver(e: React.DragEvent, column: TaskStatus) {
    if (!canDrop(column)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverColumn(column);
  }

  function handleDragLeave() {
    setDragOverColumn(null);
  }

  function handleDrop(e: React.DragEvent, toColumn: TaskStatus) {
    e.preventDefault();
    setDragOverColumn(null);
    if (!canDrop(toColumn)) return;

    const taskId = e.dataTransfer.getData('text/plain');
    if (!taskId) return;

    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status === toColumn) return;
    if (task.status !== 'backlog' && task.status !== 'failed') return;

    onMoveTask(taskId, task.status, toColumn);
  }

  return (
    <div className="flex flex-col gap-2 min-h-0 flex-1">
      {/* Clear completed button */}
      {completedCount > 0 && (
        <div className="flex justify-end">
          <button
            onClick={onClearCompleted}
            className="flex items-center gap-1.5 text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
          >
            <Trash2 size={11} />
            {t('kanban.clearCompleted', 'Clear completed')} ({completedCount})
          </button>
        </div>
      )}

      <div className="flex gap-3 overflow-x-auto pb-4 min-h-0 flex-1">
        {DISPLAY_COLUMNS.map((column) => {
          const items = columns[column] || [];
          const isOver = dragOverColumn === column;
          const droppable = canDrop(column);

          return (
            <div
              key={column}
              className={`
                flex-shrink-0 w-64 flex flex-col rounded-xl
                bg-slate-900/50 border transition-colors duration-150
                ${isOver && droppable ? 'border-sky-500/50 bg-sky-950/20' : 'border-slate-800/60'}
              `}
              onDragOver={(e) => handleDragOver(e, column)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, column)}
            >
              {/* Column header */}
              <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-800/60">
                <div className={`w-2 h-2 rounded-full ${COLUMN_COLORS[column]}`} />
                <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  {t(COLUMN_I18N[column])}
                </span>
                {items.length > 0 && (
                  <span className="ml-auto text-[10px] text-slate-500 bg-slate-800 rounded-full px-1.5 py-0.5">
                    {items.length}
                  </span>
                )}
              </div>

              {/* Cards */}
              <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[120px]">
                {items.length === 0 && (
                  <div className="text-center py-6 text-[11px] text-slate-600">
                    {column === 'queued'
                      ? t('kanban.dropHint', 'Drop tasks here to run')
                      : ''}
                  </div>
                )}
                {items.map((task) => (
                  <KanbanCard
                    key={task.id}
                    task={task}
                    t={t}
                    onClick={() => onViewDetail(task.id)}
                    onRetry={() => onRetryTask(task.id)}
                    onCancel={() => onCancelTask(task.id)}
                    onDelete={() => onDeleteTask(task.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
