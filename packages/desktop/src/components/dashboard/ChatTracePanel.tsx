import { memo, useState, useCallback } from 'react';
import { AlertTriangle, BookOpen, Brain, CheckCircle2, ChevronDown, ChevronRight, Copy, Check, Loader2, Save, Search, Terminal, Wrench, Zap } from 'lucide-react';

export interface ChatTraceEvent {
  id: string;
  kind: 'status' | 'debug' | 'thinking' | 'stream';
  label: string;
  detail?: string;
  raw?: unknown;
  timestamp: number;
  mergeKey?: string;
}

type ToolCallInfo = {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'approved' | 'recalling' | 'saving' | 'cached' | 'awaiting_approval' | 'failed';
  timestamp: number;
  detail?: string;
  args?: unknown;
  output?: string;
  rawResult?: unknown;
  approvalRequestId?: string;
  approvalCommand?: string;
};

function formatValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getToolIcon(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes('exec') || lower.includes('bash') || lower.includes('shell') || lower.includes('command')) return <Terminal size={11} />;
  if (lower.includes('recall') || lower.includes('search') || lower.includes('memory')) return <Search size={11} />;
  if (lower.includes('perception') || lower.includes('signal')) return <Zap size={11} />;
  if (lower.includes('capture') || lower.includes('save') || lower.includes('record')) return <Save size={11} />;
  if (lower.includes('read') || lower.includes('file') || lower.includes('doc')) return <BookOpen size={11} />;
  return <Wrench size={11} />;
}

function getToolLabel(name: string, status: string, t: (key: string, fallback?: string) => string) {
  if (status === 'awaiting_approval') return `${name}: ${t('tool.status.awaitingApproval', 'Awaiting approval')}`;
  if (status === 'recalling') return `${name}: ${t('tool.status.recalling', 'Recalling context...')}`;
  if (status === 'saving') return `${name}: ${t('tool.status.saving', 'Saving memory...')}`;
  if (status === 'cached') return `${name}: ${t('tool.status.cached', 'Signals cached')}`;
  if (status === 'approved') return `${name}: ${t('tool.status.approved', 'Approved')}`;
  if (status === 'completed') return `${name}: ${t('tool.status.completed', 'Done')}`;
  if (status === 'failed') return `${name}: ${t('tool.status.failed', 'Failed')}`;
  if (status === 'running' || status === 'in_progress') return `${name}: ${t('tool.status.running', 'Running...')}`;
  return `${name}: ${status}`;
}

function getTraceIcon(event: ChatTraceEvent) {
  if (event.kind === 'thinking') return <Brain size={11} className="text-purple-300" />;
  if (event.kind === 'stream') return <Loader2 size={11} className="animate-spin text-brand-300" />;
  if (event.kind === 'debug') return <Terminal size={11} className="text-sky-300" />;
  if (event.label.toLowerCase().includes('error') || event.detail?.toLowerCase().includes('error')) {
    return <AlertTriangle size={11} className="text-amber-300" />;
  }
  return <CheckCircle2 size={11} className="text-emerald-300" />;
}

function formatTimestamp(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Collapsible code block — shows first N lines, click to expand. */
function CollapsiblePre({ content, maxLines = 6 }: { content: string; maxLines?: number }) {
  const [collapsed, setCollapsed] = useState(true);
  const lines = content.split('\n');
  const needsCollapse = lines.length > maxLines;
  const displayed = collapsed && needsCollapse ? lines.slice(0, maxLines).join('\n') + '\n...' : content;

  return (
    <div className="relative">
      <pre className="ml-[17px] mt-1 overflow-x-auto whitespace-pre-wrap rounded-md bg-slate-950 px-2 py-1 text-[10px] leading-relaxed text-slate-400">
        {displayed}
      </pre>
      {needsCollapse && (
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="ml-[17px] mt-0.5 text-[9px] text-sky-400/70 hover:text-sky-300 transition-colors"
        >
          {collapsed ? `Show all ${lines.length} lines` : 'Collapse'}
        </button>
      )}
    </div>
  );
}

const TraceEventCard = memo(function TraceEventCard({ event }: { event: ChatTraceEvent }) {
  const detailText = event.detail || '';
  const rawText = event.raw != null ? formatValue(event.raw) : '';
  const hasExpandableContent = detailText.length > 120 || rawText.length > 120 || detailText.includes('\n') || rawText.includes('\n');
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-slate-800/80 bg-slate-900/40 px-3 py-2">
      <button
        onClick={() => hasExpandableContent && setExpanded(!expanded)}
        className={`flex w-full items-center gap-2 text-left text-[11px] text-slate-300 ${hasExpandableContent ? 'cursor-pointer' : ''}`}
      >
        {getTraceIcon(event)}
        <span className="flex-1 min-w-0 truncate">{event.label}</span>
        {hasExpandableContent && (
          <ChevronDown size={10} className={`text-slate-600 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`} />
        )}
        <span className="text-[10px] text-slate-600">{formatTimestamp(event.timestamp)}</span>
      </button>

      {detailText && (
        expanded && hasExpandableContent ? (
          <CollapsiblePre content={detailText} maxLines={8} />
        ) : (
          <div className="mt-1 ml-[19px] whitespace-pre-wrap break-words text-[10px] leading-relaxed text-slate-500/90 line-clamp-3">
            {detailText}
          </div>
        )
      )}

      {rawText && rawText !== detailText && (
        expanded ? (
          <div>
            <div className="ml-[17px] mt-1 text-[9px] text-slate-600 uppercase tracking-wider mb-0.5">raw</div>
            <CollapsiblePre content={rawText} maxLines={10} />
          </div>
        ) : (
          <pre className="mt-1 ml-[19px] overflow-x-auto whitespace-pre-wrap rounded-md bg-slate-950 px-2 py-1 text-[10px] leading-relaxed text-slate-500 line-clamp-3">
            {rawText}
          </pre>
        )
      )}
    </div>
  );
});

/** Single tool call card with collapsible args/output sections. */
const ToolCallCard = memo(function ToolCallCard({
  tc,
  t,
  onApprove,
  onCopyApproval,
  onStopRequest,
}: {
  tc: ToolCallInfo;
  t: (key: string, fallback?: string) => string;
  onApprove?: (tc: ToolCallInfo) => void;
  onCopyApproval?: (tc: ToolCallInfo) => void;
  onStopRequest?: () => void;
}) {
  // Auto-expand completed tool calls that have short output (historical messages)
  const isCompleted = tc.status === 'completed' || tc.status === 'failed' || tc.status === 'approved' || tc.status === 'cached';
  const [detailExpanded, setDetailExpanded] = useState(isCompleted);
  const [copied, setCopied] = useState(false);

  const argsText = tc.args != null ? formatValue(tc.args) : '';
  const outputText = tc.output || '';
  const rawText = tc.rawResult != null ? formatValue(tc.rawResult) : '';
  // Use rawResult if output is empty but rawResult exists and differs
  const displayOutput = outputText || (rawText && rawText !== argsText ? rawText : '');
  const hasExpandableContent = argsText.length > 80 || displayOutput.length > 80;
  const isActive = tc.status === 'running' || tc.status === 'recalling' || tc.status === 'saving';

  const handleCopyOutput = useCallback(() => {
    const text = displayOutput || argsText;
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [displayOutput, argsText]);

  return (
    <div className="rounded-lg border border-slate-800/80 bg-slate-900/40 px-3 py-2 text-[11px] text-slate-400">
      {/* Header: icon + name + status + expand toggle */}
      <div
        className={`flex items-center gap-1.5 ${hasExpandableContent ? 'cursor-pointer' : ''}`}
        onClick={() => hasExpandableContent && setDetailExpanded(!detailExpanded)}
      >
        {tc.status === 'failed' ? (
          <AlertTriangle size={11} className="text-amber-400/80" />
        ) : tc.status === 'awaiting_approval' || isActive ? (
          <Loader2 size={11} className="animate-spin text-brand-400/70" />
        ) : (
          <span className="text-emerald-500/70">{getToolIcon(tc.name)}</span>
        )}
        <span className="flex-1">{getToolLabel(tc.name, tc.status, t)}</span>
        {hasExpandableContent && (
          <ChevronDown
            size={10}
            className={`text-slate-600 transition-transform duration-150 ${detailExpanded ? 'rotate-180' : ''}`}
          />
        )}
        {(displayOutput || argsText) && (
          <button
            onClick={(e) => { e.stopPropagation(); handleCopyOutput(); }}
            className="p-0.5 rounded hover:bg-slate-800 text-slate-600 hover:text-slate-400 transition-colors"
            title="Copy output"
          >
            {copied ? <Check size={9} className="text-emerald-400" /> : <Copy size={9} />}
          </button>
        )}
      </div>

      {/* Compact summary when collapsed */}
      {tc.detail && !detailExpanded && (
        <div className="ml-[17px] mt-1 text-[10px] text-slate-500/90 line-clamp-2 break-all">{tc.detail}</div>
      )}

      {/* Always show output for completed tools (not gated by expand) */}
      {!detailExpanded && displayOutput && displayOutput !== tc.detail && (
        <pre className="ml-[17px] mt-1 overflow-x-auto whitespace-pre-wrap rounded-md bg-slate-950 px-2 py-1 text-[10px] leading-relaxed text-slate-400 line-clamp-3">
          {displayOutput}
        </pre>
      )}

      {/* Expanded content — full args + output with collapse control */}
      {detailExpanded && (
        <div className="mt-1.5 space-y-1.5">
          {tc.detail && (
            <div className="ml-[17px] text-[10px] text-slate-500/90 break-all">{tc.detail}</div>
          )}

          {argsText && argsText !== tc.detail && (
            <div>
              <div className="ml-[17px] text-[9px] text-slate-600 uppercase tracking-wider mb-0.5">args</div>
              <CollapsiblePre content={argsText} maxLines={8} />
            </div>
          )}

          {displayOutput && (
            <div>
              <div className="ml-[17px] text-[9px] text-slate-600 uppercase tracking-wider mb-0.5">output</div>
              <CollapsiblePre content={displayOutput} maxLines={12} />
            </div>
          )}
        </div>
      )}

      {/* Approval buttons */}
      {tc.status === 'awaiting_approval' && (
        <div className="ml-[17px] mt-2 flex flex-wrap gap-2">
          <button
            onClick={() => onApprove?.(tc)}
            className="px-2 py-0.5 rounded-md bg-brand-600/20 hover:bg-brand-600/30 border border-brand-500/30 text-brand-200 text-[10px] transition-colors"
          >
            {t('chat.approveOnce', 'Approve once')}
          </button>
          <button
            onClick={() => onCopyApproval?.(tc)}
            className="px-2 py-0.5 rounded-md bg-slate-800/80 hover:bg-slate-700 border border-slate-700/60 text-slate-300 text-[10px] transition-colors"
          >
            {t('chat.copyApprovalCommand', 'Copy approval command')}
          </button>
          <button
            onClick={() => onStopRequest?.()}
            className="px-2 py-0.5 rounded-md bg-slate-800/80 hover:bg-red-500/10 border border-slate-700/60 hover:border-red-500/30 text-slate-300 hover:text-red-300 text-[10px] transition-colors"
          >
            {t('chat.stopRequest', 'Stop request')}
          </button>
        </div>
      )}
    </div>
  );
});

/** Collapsible "Thought for Ns" block, Claude/ChatGPT style — italic gray reasoning text.
 * When `thinking` is empty but `live` is true, renders a pulsing "Thinking…" placeholder
 * so users have visible feedback even before reasoning content streams in. */
const ThoughtBlock = memo(function ThoughtBlock({
  thinking,
  live,
  t,
}: {
  thinking: string;
  live?: boolean;
  t: (key: string, fallback?: string) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasContent = Boolean(thinking);
  const label = !hasContent && live
    ? t('chat.trace.thinking', 'Thinking…')
    : live
      ? t('chat.trace.thinking', 'Thinking…')
      : t('chat.trace.thoughtFor', 'Thought process');
  const canExpand = hasContent;
  return (
    <div className="mb-1.5">
      <button
        onClick={() => canExpand && setExpanded((v) => !v)}
        className={`flex items-center gap-1.5 text-[11px] text-slate-500 ${canExpand ? 'hover:text-slate-300 cursor-pointer' : 'cursor-default'} transition-colors`}
      >
        {canExpand ? (
          <ChevronRight size={12} className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
        ) : (
          <span className="inline-block w-3" />
        )}
        <Brain size={11} className={live ? 'text-purple-300 animate-pulse' : 'text-purple-300/70'} />
        <span>{label}</span>
      </button>
      {expanded && hasContent && (
        <div className="mt-1 ml-4 border-l-2 border-purple-500/20 pl-3">
          <div className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-400 italic">
            {thinking}
          </div>
        </div>
      )}
    </div>
  );
});

/** Flat, Claude-style trace panel: "Thought for Ns" block + tool cards inline + hidden debug events.
 * No outer accordion wrapper — tool cards are first-class citizens. */
export function ChatTracePanel({
  t,
  thinking,
  toolCalls,
  traceEvents,
  onApprove,
  onCopyApproval,
  onStopRequest,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  defaultExpanded = false,
  live = false,
}: {
  t: (key: string, fallback?: string) => string;
  thinking?: string;
  toolCalls?: ToolCallInfo[];
  traceEvents?: ChatTraceEvent[];
  onApprove?: (toolCall: ToolCallInfo) => void;
  onCopyApproval?: (toolCall: ToolCallInfo) => void;
  onStopRequest?: () => void;
  defaultExpanded?: boolean;
  live?: boolean;
}) {
  const [eventsExpanded, setEventsExpanded] = useState(false);
  // In live mode, always show the ThoughtBlock as a pulsing "Thinking…" placeholder
  // even before any reasoning content has streamed in — this gives users feedback
  // that the agent is alive.
  const hasThinking = Boolean(thinking) || Boolean(live);
  const hasTools = Boolean(toolCalls && toolCalls.length > 0);
  // Filter out only per-chunk stream events and thinking events (both have dedicated UI).
  // Keep lifecycle / status / request / tool-related events so users always see activity
  // even when the model didn't actually call any tools.
  const meaningfulEvents = (traceEvents || []).filter((event) => {
    if (event.kind === 'stream') return false;
    if (event.kind === 'thinking') return false;
    return true;
  });
  const hasMeaningfulEvents = meaningfulEvents.length > 0;
  if (!hasThinking && !hasTools && !hasMeaningfulEvents) return null;

  return (
    <div className="mb-2 space-y-1.5">
      {hasThinking && <ThoughtBlock thinking={thinking || ''} live={live} t={t} />}

      {hasTools && (
        <div className="space-y-1">
          {toolCalls?.map((tc) => (
            <ToolCallCard
              key={tc.id}
              tc={tc}
              t={t}
              onApprove={onApprove}
              onCopyApproval={onCopyApproval}
              onStopRequest={onStopRequest}
            />
          ))}
        </div>
      )}

      {hasMeaningfulEvents && (
        <div>
          <button
            onClick={() => setEventsExpanded((v) => !v)}
            className="flex items-center gap-1.5 text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
          >
            <ChevronRight size={10} className={`transition-transform duration-200 ${eventsExpanded ? 'rotate-90' : ''}`} />
            <span>{t('chat.trace.details', '{0} detail(s)').replace('{0}', String(meaningfulEvents.length))}</span>
          </button>
          {eventsExpanded && (
            <div className="mt-1 ml-4 space-y-1">
              {meaningfulEvents.map((event) => (
                <TraceEventCard key={event.id} event={event} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}