import { FileCode } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../../lib/i18n';
import {
  type MemoryEvent,
  getSourceDisplay,
  parseCodeChangeContent,
  formatRelativeTime,
  memoryMarkdownComponents,
} from './memory-helpers.js';

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query.trim() || !text) return <>{text}</>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
          ? <mark key={i} className="bg-amber-500/30 text-amber-200 rounded-sm px-0.5">{part}</mark>
          : part
      )}
    </>
  );
}

export interface TimelineTabProps {
  events: MemoryEvent[];
  displayedEvents: MemoryEvent[];
  eventsTotal: number;
  eventsOffset: number;
  sourceView: 'chat' | 'dev' | 'all';
  selectedEventType: string;
  expandedEvent: string | null;
  searchQuery: string;
  searchResults: unknown[] | null;
  setSourceView: (v: 'chat' | 'dev' | 'all') => void;
  setSelectedEventType: (v: string) => void;
  setExpandedEvent: (v: string | null) => void;
  loadEvents: (offset: number, append: boolean) => void;
}

export function TimelineTab({
  events,
  displayedEvents,
  eventsTotal,
  eventsOffset,
  sourceView,
  selectedEventType,
  expandedEvent,
  searchQuery,
  searchResults,
  setSourceView,
  setSelectedEventType,
  setExpandedEvent,
  loadEvents,
}: TimelineTabProps) {
  const { t } = useI18n();

  return (
    <>
      {/* Source view toggle — separate conversations from dev memories */}
      <div className="flex gap-1.5 mb-2">
        {([['chat', 'Conversations'], ['dev', 'Dev Logs'], ['all', 'All']] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSourceView(key)}
            className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
              sourceView === key
                ? 'bg-brand-600/20 text-brand-400 border border-brand-500/40'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {/* Event type filter chips — dynamically generated from actual event types */}
      <div className="flex gap-2 flex-wrap mb-2">
        {['all', ...[...new Set(events.map(e => e.type).filter(Boolean))].sort()].map((filterType) => {
          const typeLabels: Record<string, string> = {
            all: `All (${events.length})`,
            code_change: 'Code',
            conversation: 'Chat',
            task: 'Task',
            note: 'Note',
          };
          const label = typeLabels[filterType!] ?? filterType!;
          const count = filterType === 'all' ? null : events.filter(e => e.type === filterType).length;
          return (
            <button
              key={filterType}
              onClick={() => setSelectedEventType(filterType!)}
              className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                selectedEventType === filterType
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              {label}{count !== null ? ` (${count})` : ''}
            </button>
          );
        })}
      </div>

      {displayedEvents.length === 0 && (
        <div className="text-center py-12 text-slate-500 space-y-2">
          {searchQuery && searchResults !== null ? (
            <p className="text-sm">{t('memory.noResults', 'No results for "{query}"').replace('{query}', searchQuery)}</p>
          ) : (
            <>
              <p>{t('memory.noData')}</p>
              <p className="text-xs mt-1">{t('memory.noData.hint')}</p>
            </>
          )}
        </div>
      )}

      {displayedEvents.map((event) => {
        const src = getSourceDisplay(event.source);
        const SourceIcon = src.icon;
        const isExpanded = expandedEvent === event.id;
        const isCodeChange = event.type === 'code_change';

        // For code_change events, parse the content for a cleaner display
        const parsedCode = isCodeChange && event.fts_content
          ? parseCodeChangeContent(event.fts_content)
          : null;

        const contentPreview = event.fts_content || event.title || '';
        const hasLongContent = isCodeChange
          ? (parsedCode ? parsedCode.diffLines.length > 8 : false)
          : contentPreview.length > 600;

        return (
          <div
            key={event.id}
            className="p-4 bg-slate-800/50 rounded-xl border border-slate-700/50 hover:border-slate-600 transition-colors"
          >
            {/* Event header */}
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <SourceIcon size={16} className="text-slate-300" />
              <span className="text-xs font-medium text-slate-300">{src.label}</span>
              {event.type && (
                <span className="text-[10px] px-1.5 py-0.5 bg-slate-700 rounded text-slate-400">
                  {event.type}
                </span>
              )}
              {event.session_id && (
                <span className="text-[10px] text-slate-600 truncate max-w-[120px]" title={event.session_id}>
                  {event.session_id.slice(0, 12)}...
                </span>
              )}
              {event.agent_role && (
                <span className="text-[10px] px-1.5 py-0.5 bg-blue-500/10 rounded text-blue-400">
                  {event.agent_role}
                </span>
              )}
              {event.created_at && (
                <span className="ml-auto text-[11px] text-slate-500" title={new Date(event.created_at).toLocaleString()}>
                  {formatRelativeTime(event.created_at)}
                </span>
              )}
            </div>

            {/* Event title — for code_change show parsed shortPath */}
            {isCodeChange && parsedCode ? (
              <h4 className="flex items-center gap-1.5 font-medium text-sm mb-1 text-slate-200">
                <FileCode size={14} className="text-slate-400" />
                {parsedCode.shortPath}
              </h4>
            ) : event.title ? (
              <h4 className="font-medium text-sm mb-1 text-slate-200">
                <HighlightText text={event.title} query={searchQuery} />
              </h4>
            ) : null}

            {/* Event content — never truncate, only collapse very long content */}
            {isCodeChange && parsedCode ? (
              parsedCode.diffLines.length > 0 && (
                <div className="text-slate-400 leading-relaxed">
                  <div className="space-y-0.5">
                    {(isExpanded || !hasLongContent ? parsedCode.diffLines : parsedCode.diffLines.slice(0, 8)).map((line, i) => (
                      <p key={i} className="text-xs font-mono truncate">{line}</p>
                    ))}
                  </div>
                  {hasLongContent && (
                    <button
                      onClick={() => setExpandedEvent(isExpanded ? null : event.id)}
                      className="text-xs text-brand-400 hover:text-brand-300 mt-1"
                    >
                      {isExpanded ? t('memory.collapseContent') : `${t('memory.expandContent')} (${parsedCode.diffLines.length} lines)`}
                    </button>
                  )}
                </div>
              )
            ) : contentPreview ? (
              <div className="text-sm text-slate-400 leading-relaxed">
                <div className={hasLongContent && !isExpanded ? 'line-clamp-6' : ''}>
                  {searchQuery ? (
                    <p><HighlightText text={contentPreview} query={searchQuery} /></p>
                  ) : (
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={memoryMarkdownComponents}>
                      {contentPreview}
                    </ReactMarkdown>
                  )}
                </div>
                {hasLongContent && (
                  <button
                    onClick={() => setExpandedEvent(isExpanded ? null : event.id)}
                    className="text-xs text-brand-400 hover:text-brand-300 mt-1"
                  >
                    {isExpanded ? t('memory.collapseContent') : t('memory.expandContent')}
                  </button>
                )}
              </div>
            ) : null}

            {/* Tags */}
            {event.tags && (
              <div className="flex gap-1 mt-2 flex-wrap">
                {event.tags.split(',').map((tag, i) => (
                  <span key={i} className="text-[10px] px-1.5 py-0.5 bg-slate-700/50 rounded text-slate-500">
                    {tag.trim()}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Load More */}
      {events.length > 0 && events.length < eventsTotal && (
        <button
          onClick={() => loadEvents(eventsOffset, true)}
          className="w-full py-2.5 text-xs text-slate-400 hover:text-slate-200 bg-slate-800/50 rounded-xl transition-colors"
        >
          {t('memory.loadMore')} ({events.length}/{eventsTotal})
        </button>
      )}
    </>
  );
}
