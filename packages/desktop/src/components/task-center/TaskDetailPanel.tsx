/**
 * TaskDetailPanel — sliding side panel showing task details + sub-agent history.
 * Includes a "continue conversation" input for sending follow-up messages.
 * Close button is large and easy to click.
 */

import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X, Loader2, Clock, Bot, AlertTriangle, CheckCircle2, RotateCw, Send, Trash2 } from 'lucide-react';
import AgentAvatar from '../AgentAvatar';
import type { Task } from '../../lib/task-store';

interface TaskDetailPanelProps {
  t: (key: string, fallback?: string) => string;
  task: Task;
  onClose: () => void;
  onRetry?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: any) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .replace(/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?(?:<<<END_OPENCLAW_INTERNAL_CONTEXT>>>|$)/g, '')
    .replace(/\[Internal task completion event\][\s\S]*?(?=\n\n|\n[A-Z]|$)/g, '')
    .trim();
}

function isInternalMessage(msg: any): boolean {
  const text = extractMessageText(msg.content);
  if (!text) return true;
  if (text.startsWith('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>')) return true;
  if (text.includes('[Internal task completion event]') && text.length < 200) return true;
  return false;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  backlog: { label: 'Backlog', color: 'text-slate-400', bg: 'bg-slate-800' },
  queued: { label: 'Queued', color: 'text-amber-400', bg: 'bg-amber-900/20' },
  running: { label: 'Running', color: 'text-sky-400', bg: 'bg-sky-900/20' },
  done: { label: 'Done', color: 'text-emerald-400', bg: 'bg-emerald-900/20' },
  failed: { label: 'Failed', color: 'text-red-400', bg: 'bg-red-900/20' },
};

function formatTime(isoStr?: string): string {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function durationStr(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return '—';
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - new Date(startedAt).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

export default function TaskDetailPanel({ t, task, onClose, onRetry, onCancel, onDelete }: TaskDetailPanelProps) {
  const [history, setHistory] = useState<any[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [followUp, setFollowUp] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.backlog;

  // Use sub-agent sessionKey for history (falls back to main session)
  const effectiveSessionKey = task.subagentSessionKey || task.sessionKey;

  // Load sub-agent session history
  useEffect(() => {
    if (!effectiveSessionKey) return;
    setLoadingHistory(true);
    window.electronAPI?.taskDetail?.(effectiveSessionKey)
      .then((result: any) => {
        if (result?.success) setHistory(result.messages || []);
      })
      .catch(() => {})
      .finally(() => setLoadingHistory(false));
  }, [effectiveSessionKey]);

  // Scroll to bottom when history updates
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history]);

  // Send follow-up message to sub-agent session
  async function handleSendFollowUp() {
    if (!followUp.trim() || !effectiveSessionKey || sending) return;
    setSending(true);
    try {
      await window.electronAPI?.taskSendMessage?.(effectiveSessionKey, followUp.trim());
      setFollowUp('');
      // Reload history after sending
      const result = await window.electronAPI?.taskDetail?.(effectiveSessionKey);
      if (result?.success) setHistory(result.messages || []);
    } catch { /* ignore */ }
    setSending(false);
  }

  return (
    <div className="fixed inset-y-0 right-0 w-[420px] z-40 bg-slate-900 border-l border-slate-700 shadow-2xl flex flex-col animate-in slide-in-from-right">
      {/* Header — large close button */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <AgentAvatar name={task.agentName || task.agentId} emoji={task.agentEmoji || ''} size={18} />
          <h3 className="text-sm font-semibold text-slate-200 truncate">{task.title}</h3>
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors ml-2"
          aria-label={t('common.close', 'Close')}
        >
          <X size={20} />
        </button>
      </div>

      {/* Task metadata */}
      <div className="px-4 py-3 border-b border-slate-800 space-y-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.color} ${cfg.bg}`}>
            {t(`kanban.${task.status}`, cfg.label)}
          </span>
          <span className="text-[10px] text-slate-500">
            {task.agentName || task.agentId}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div>
            <span className="text-slate-500">{t('taskCard.created', 'Created')}</span>
            <p className="text-slate-300">{formatTime(task.createdAt)}</p>
          </div>
          <div>
            <span className="text-slate-500">{t('taskCard.elapsed', 'Elapsed')}</span>
            <p className="text-slate-300">{durationStr(task.startedAt, task.completedAt)}</p>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 pt-1">
          {task.status === 'failed' && onRetry && (
            <button onClick={onRetry} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 text-xs font-medium border border-amber-600/30">
              <RotateCw size={11} /> {t('taskCard.retry', 'Retry')}
            </button>
          )}
          {(task.status === 'running' || task.status === 'queued') && onCancel && (
            <button onClick={onCancel} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-600/20 hover:bg-red-600/30 text-red-300 text-xs font-medium border border-red-600/30">
              <X size={11} /> {t('taskCard.cancel', 'Cancel')}
            </button>
          )}
          {onDelete && (
            <button onClick={onDelete} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-700/30 hover:bg-slate-700/50 text-slate-400 text-xs font-medium border border-slate-700/40">
              <Trash2 size={11} /> {t('taskCard.delete', 'Delete')}
            </button>
          )}
        </div>
      </div>

      {/* Result / Error */}
      {task.result && (
        <div className="px-4 py-3 border-b border-slate-800 flex-shrink-0">
          <div className="flex items-center gap-1.5 text-[11px] text-emerald-400 mb-1">
            <CheckCircle2 size={11} />
            <span>{t('taskCard.result', 'Result')}</span>
          </div>
          <div className="text-xs text-slate-300 bg-slate-950 rounded-lg px-3 py-2 max-h-40 overflow-y-auto prose prose-invert prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.result}</ReactMarkdown>
          </div>
        </div>
      )}
      {task.error && (
        <div className="px-4 py-3 border-b border-slate-800 flex-shrink-0">
          <div className="flex items-center gap-1.5 text-[11px] text-red-400 mb-1">
            <AlertTriangle size={11} />
            <span>{t('taskCard.error', 'Error')}</span>
          </div>
          <pre className="text-xs text-red-300/80 whitespace-pre-wrap bg-red-950/20 rounded-lg px-3 py-2 max-h-24 overflow-y-auto">
            {task.error}
          </pre>
        </div>
      )}

      {/* Sub-agent conversation history */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
        <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mb-2">
          <Clock size={11} />
          <span>{t('taskCard.history', 'Conversation')}</span>
        </div>

        {loadingHistory && (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="animate-spin text-slate-500" />
          </div>
        )}

        {!loadingHistory && (!history || history.length === 0) && (
          <div className="text-center py-8 text-[11px] text-slate-600">
            {effectiveSessionKey
              ? t('taskCard.noHistory', 'No conversation history yet')
              : t('taskCard.noSession', 'Task not yet started')}
          </div>
        )}

        {history && history.length > 0 && (
          <div className="space-y-2">
            {history.filter((msg: any) => !isInternalMessage(msg)).map((msg: any, i: number) => {
              const text = extractMessageText(msg.content);
              if (!text) return null;
              return (
                <div key={i} className={`rounded-lg px-3 py-2.5 text-xs ${
                  msg.role === 'user' ? 'bg-sky-950/20 border border-sky-900/30' : 'bg-slate-800/50 border border-slate-700/30'
                }`}>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    {msg.role === 'user' ? (
                      <span className="text-[10px] text-sky-400 font-medium">User</span>
                    ) : (
                      <Bot size={10} className="text-slate-400" />
                    )}
                    <span className="text-[10px] text-slate-500 font-medium">
                      {msg.role === 'assistant' ? 'Agent' : ''}
                    </span>
                  </div>
                  <div className="text-slate-300 text-xs leading-relaxed prose prose-invert prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-pre:my-1 prose-code:text-sky-300">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Follow-up input (continue conversation with sub-agent) */}
      {effectiveSessionKey && (
        <div className="flex-shrink-0 px-4 py-3 border-t border-slate-800">
          <div className="flex gap-2">
            <input
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              placeholder={t('taskDetail.followUp', 'Continue the conversation...')}
              className="flex-1 rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendFollowUp(); }
              }}
              disabled={sending}
            />
            <button
              onClick={handleSendFollowUp}
              disabled={!followUp.trim() || sending}
              className="px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50 transition-colors"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
