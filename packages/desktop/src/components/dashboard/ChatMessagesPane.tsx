import React from 'react';
import { AlertTriangle, Check, Copy, File, FolderOpen, Loader2 } from 'lucide-react';
import { ChatTracePanel, type ChatTraceEvent } from './ChatTracePanel';
import AgentAvatar from '../AgentAvatar';

type ToolCallInfo = {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'approved' | 'recalling' | 'saving' | 'cached' | 'awaiting_approval' | 'failed';
  timestamp: number;
  detail?: string;
  args?: unknown;
  output?: string;
  approvalRequestId?: string;
  approvalCommand?: string;
};

type AttachedFile = {
  name: string;
  path: string;
};

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  files?: AttachedFile[];
  model?: string;
  toolCalls?: ToolCallInfo[];
  thinking?: string;
  traceEvents?: ChatTraceEvent[];
  contentBlocks?: Array<Record<string, unknown>>;
  agentName?: string;
  agentEmoji?: string;
};

type CurrentAgent = { id: string; name: string; emoji?: string };

type GatewayCircuitHint = {
  active: boolean;
  failureStreak: number;
  cooldownRemainingSec: number;
  lastError?: string;
};

/** Parse inline thinking / tool markers that providers like qwen/deepseek embed directly
 * in the text stream (Anthropic / Gateway won't always surface these as structured blocks).
 * Returns the cleaned text plus any extracted thinking and tool calls. */
function parseInlineMarkers(text: string): {
  clean: string;
  thinking: string;
  toolCalls: ToolCallInfo[];
} {
  if (!text) return { clean: text || '', thinking: '', toolCalls: [] };

  const thinkingParts: string[] = [];
  const toolCalls: ToolCallInfo[] = [];
  let idx = 0;

  // Extract <thinking>/<reasoning>/<think> blocks.
  let withoutThinking = text.replace(
    /<(thinking|reasoning|think)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_m, _tag, inner) => {
      const t = String(inner || '').trim();
      if (t) thinkingParts.push(t);
      return '';
    },
  );

  // Extract leading "Reasoning: ..." blob (some providers prefix with this).
  withoutThinking = withoutThinking.replace(
    /^\s*Reasoning:([\s\S]*?)(?:\n\n|$)/i,
    (_m, inner) => {
      const t = String(inner || '').trim();
      if (t) thinkingParts.push(t);
      return '';
    },
  );

  // Extract <tool_call>...</tool_call> blocks (qwen / deepseek / glm format, JSON inside).
  let withoutTools = withoutThinking.replace(
    /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi,
    (_m, inner) => {
      const raw = String(inner || '').trim();
      if (!raw) return '';
      let name = 'tool';
      let args: unknown = raw;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          name = String((parsed as any).name || (parsed as any).tool || 'tool');
          args = (parsed as any).arguments ?? (parsed as any).args ?? parsed;
        }
      } catch {
        // Not JSON, keep raw as detail.
      }
      toolCalls.push({
        id: `inline-tc-${idx++}`,
        name,
        status: 'completed',
        timestamp: Date.now(),
        args,
        detail: typeof args === 'string' ? args : undefined,
      });
      return '';
    },
  );

  // Extract ```tool_code ... ``` fenced blocks (gemini-style).
  withoutTools = withoutTools.replace(
    /```(?:tool_code|tool|tool_call)\n([\s\S]*?)```/gi,
    (_m, inner) => {
      const code = String(inner || '').trim();
      if (code) {
        toolCalls.push({
          id: `inline-tc-${idx++}`,
          name: 'code',
          status: 'completed',
          timestamp: Date.now(),
          args: code,
          detail: code,
        });
      }
      return '';
    },
  );

  return {
    clean: withoutTools.trim(),
    thinking: thinkingParts.join('\n\n'),
    toolCalls,
  };
}

export function ChatMessagesPane({
  t,
  logoUrl,
  config,
  messages,
  agentStatus,
  thinkingContent,
  traceEvents,
  activeToolCalls,
  streamingContent,
  newestMsgId,
  copiedId,
  projectRoot,
  messagesEndRef,
  liveThinkingExpanded,
  currentAgent,
  onToggleLiveThinking,
  onSelectProjectRoot,
  onSelectModel,
  onSuggestionSelect,
  onCopyMessage,
  onApproveTool,
  onCopyApproval,
  onStopRequest,
  errorHint,
  gatewayHint,
  gatewayCircuitHint,
  onDismissError,
  renderStreamingContent,
  TypewriterMessage,
  ThinkingBlock,
  LiveThinkingBlock,
}: {
  t: (key: string, fallback?: string) => string;
  logoUrl: string;
  config: Record<string, any>;
  messages: Message[];
  agentStatus: 'idle' | 'thinking' | 'generating' | 'error';
  thinkingContent: string;
  traceEvents: ChatTraceEvent[];
  activeToolCalls: ToolCallInfo[];
  streamingContent: string;
  newestMsgId: string | null;
  copiedId: string | null;
  projectRoot: string;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  liveThinkingExpanded: boolean;
  currentAgent?: CurrentAgent;
  onToggleLiveThinking: () => void;
  onSelectProjectRoot: () => void;
  onSelectModel: () => void;
  onSuggestionSelect: (text: string) => void;
  onCopyMessage: (message: Message) => void;
  onApproveTool: (toolCall: ToolCallInfo) => void | Promise<void>;
  onCopyApproval: (toolCall: ToolCallInfo) => void;
  onStopRequest: () => void | Promise<void>;
  errorHint?: string | null;
  gatewayHint?: string | null;
  gatewayCircuitHint?: GatewayCircuitHint | null;
  onDismissError: () => void;
  renderStreamingContent: (content: string) => React.ReactNode;
  TypewriterMessage: ({ content, isNew }: { content: string; isNew: boolean }) => React.ReactNode;
  ThinkingBlock: ({ thinking }: { thinking: string }) => React.ReactNode;
  LiveThinkingBlock: ({ thinking, expanded, onToggle }: { thinking: string; expanded: boolean; onToggle: () => void }) => React.ReactNode;
}) {
  const statusLabel = agentStatus === 'thinking'
    ? t('chat.status.thinking')
    : agentStatus === 'generating'
      ? t('chat.status.generating')
      : agentStatus === 'error'
        ? t('chat.status.error')
        : null;

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
      <div className="max-w-3xl mx-auto space-y-6 w-full">
        {messages.length === 0 && agentStatus === 'idle' && (
          <div className="flex flex-col items-center justify-center h-full text-slate-500 space-y-6">
            <img src={logoUrl} alt="" className="w-16 h-16 opacity-30" />
            {!config.modelId ? (
              <div className="text-center space-y-3">
                <p className="text-base mb-1">{t('chat.selectModel') || 'Select a model to start chatting'}</p>
                <button onClick={onSelectModel} className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors">
                  {t('chat.selectModelBtn') || 'Choose Model'}
                </button>
              </div>
            ) : (
              <>
                <div className="text-center">
                  <p className="text-base mb-1">{t('chat.empty.title')}</p>
                  <p className="text-xs text-slate-600">{t('chat.empty.subtitle')}</p>
                </div>
                <div className="w-full max-w-lg rounded-2xl border border-slate-800/80 bg-slate-900/50 backdrop-blur-sm p-5 text-left shadow-lg shadow-black/10">
                  <div className="flex items-start gap-3">
                    <div className="rounded-xl bg-sky-500/10 p-2 text-sky-400">
                      <FolderOpen size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs uppercase tracking-[0.16em] text-slate-500">{t('chat.workspace.current', 'Project folder')}</div>
                      <div className="mt-1 truncate text-sm text-slate-200">{projectRoot || t('chat.workspace.none', 'No project folder selected')}</div>
                      <p className="mt-1 text-xs text-slate-500">{t('chat.workspace.hint', 'AI file edits will run inside this local project folder')}</p>
                    </div>
                    <button onClick={onSelectProjectRoot} className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-200 transition-colors hover:bg-slate-700">
                      {projectRoot ? t('chat.workspace.change', 'Change folder') : t('chat.workspace.select', 'Choose folder')}
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 max-w-lg justify-center">
                  {[t('chat.suggest.plan'), t('chat.suggest.review'), t('chat.suggest.analyze')].map((question) => (
                    <button key={question} onClick={() => onSuggestionSelect(question)} className="px-3.5 py-2 text-xs bg-slate-800/60 hover:bg-slate-800 rounded-xl text-slate-400 hover:text-slate-200 border border-slate-700/40 hover:border-slate-600/60 transition-all duration-150">
                      {question}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {messages.map((message) => (
          message.role === 'user' ? (
            <div key={message.id} className="flex justify-end group">
              <div className="max-w-[78%]">
                <div className="px-4 py-3 rounded-[18px] rounded-br-[6px] text-sm bg-brand-600 text-white shadow-md shadow-brand-900/30 leading-relaxed">
                  {message.files && message.files.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {message.files.map((file, index) => (
                        <span key={index} className="flex items-center gap-1 px-2 py-0.5 bg-black/20 rounded text-[10px]">
                          <File size={10} /> {file.name}
                        </span>
                      ))}
                    </div>
                  )}
                  <span className="whitespace-pre-wrap">{message.content}</span>
                </div>
                <div className="text-right mt-1">
                  <span className="text-[10px] text-slate-600">{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </div>
            </div>
          ) : (
            <div key={message.id} className="group -mx-3 px-3 py-3.5 rounded-2xl hover:bg-slate-800/25 transition-all duration-200">
              <div className="flex gap-3">
                <AgentAvatar
                  name={message.agentName || currentAgent?.name || t('app.name', 'OCT')}
                  emoji={message.agentEmoji}
                  size={24}
                  fallback="logo"
                  className="mt-0.5 flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] text-slate-300 font-medium">{message.agentName || currentAgent?.name || t('app.name', 'OCT')}</span>
                    {message.model && <span className="text-[10px] text-slate-600">{message.model.split('/').pop()}</span>}
                    <span className="text-[10px] text-slate-600">{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>

                  {(() => {
                    const parsed = parseInlineMarkers(message.content);
                    const mergedThinking = [message.thinking, parsed.thinking].filter(Boolean).join('\n\n') || undefined;
                    const mergedTools = [...(message.toolCalls || []), ...parsed.toolCalls];
                    return (
                      <>
                        <ChatTracePanel
                          t={t}
                          thinking={mergedThinking}
                          toolCalls={mergedTools.length > 0 ? mergedTools : undefined}
                          traceEvents={message.traceEvents}
                          onApprove={onApproveTool}
                          onCopyApproval={onCopyApproval}
                          onStopRequest={onStopRequest}
                        />
                        <div className="text-sm text-slate-200 leading-relaxed">
                          <TypewriterMessage content={parsed.clean} isNew={message.id === newestMsgId} />
                        </div>
                      </>
                    );
                  })()}

                  <div className="mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-3">
                    <button onClick={() => onCopyMessage(message)} className="text-slate-600 hover:text-slate-300 text-[10px] flex items-center gap-1 transition-colors">
                      {copiedId === message.id ? <><Check size={10} /> {t('common.copied', 'Copied')}</> : <><Copy size={10} /> {t('common.copy', 'Copy')}</>}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )
        ))}

        {agentStatus !== 'idle' && (
          <div className="group -mx-4 px-4 py-3 bg-slate-800/20 rounded-xl">
            <div className="flex gap-3">
              <AgentAvatar
                name={currentAgent?.name || t('app.name', 'OCT')}
                emoji={currentAgent?.emoji}
                size={24}
                fallback="logo"
                className={`mt-0.5 flex-shrink-0 ${agentStatus !== 'error' ? 'animate-pulse' : ''}`}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] text-slate-300 font-medium">{currentAgent?.name || t('app.name', 'OCT')}</span>
                  {config.modelId && <span className="text-[10px] text-slate-600">{config.modelId.split('/').pop()}</span>}
                </div>

                {(() => {
                  const parsedLive = parseInlineMarkers(streamingContent);
                  const mergedLiveThinking = [thinkingContent, parsedLive.thinking].filter(Boolean).join('\n\n');
                  const mergedLiveTools = [...activeToolCalls, ...parsedLive.toolCalls];
                  return (
                    <>
                      <ChatTracePanel
                        t={t}
                        thinking={mergedLiveThinking || undefined}
                        toolCalls={mergedLiveTools.length > 0 ? mergedLiveTools : undefined}
                        traceEvents={traceEvents}
                        onApprove={onApproveTool}
                        onCopyApproval={onCopyApproval}
                        onStopRequest={onStopRequest}
                        defaultExpanded={true}
                        live={true}
                      />

                      {agentStatus === 'error' && (
                        <div className="flex flex-col gap-1.5 text-sm text-red-400">
                          <div className="flex items-center gap-2">
                            <AlertTriangle size={14} />
                            <span>{errorHint
                              ? t(`chat.errorHint.${errorHint}`, t('chat.status.error', 'Response timed out or failed'))
                              : t('chat.status.error', 'Response timed out or failed')}</span>
                            <button onClick={onDismissError} className="ml-2 px-2 py-0.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors">
                              {t('chat.dismiss', 'Dismiss')}
                            </button>
                          </div>
                          {errorHint && t(`chat.errorHint.${errorHint}.tip`, '') ? (
                            <p className="text-xs text-slate-400 ml-6">{t(`chat.errorHint.${errorHint}.tip`)}</p>
                          ) : null}
                        </div>
                      )}

                      {agentStatus !== 'error' && parsedLive.clean ? (
                        <div className="text-sm text-slate-200 leading-relaxed">{renderStreamingContent(parsedLive.clean)}</div>
                      ) : null}
                    </>
                  );
                })()}
                {agentStatus !== 'error' && !streamingContent ? (
                  <div className="space-y-1.5 text-sm text-slate-400">
                    <div className="flex items-center gap-2">
                      <Loader2 size={14} className="animate-spin text-brand-400" />
                      <span>{statusLabel}</span>
                    </div>
                    {gatewayHint ? (
                      <p className="ml-6 text-xs text-sky-300/90">{gatewayHint}</p>
                    ) : null}
                    {gatewayCircuitHint ? (
                      <div className="ml-6 mt-1 space-y-1 text-[11px] text-sky-200/80">
                        <p>
                          {t('chat.gatewayCircuit.failureCount', 'Gateway preflight failures')}: {gatewayCircuitHint.failureStreak}
                        </p>
                        {gatewayCircuitHint.active && gatewayCircuitHint.cooldownRemainingSec > 0 ? (
                          <p>
                            {t('chat.gatewayCircuit.cooldown', 'Forced fallback cooldown')}: {gatewayCircuitHint.cooldownRemainingSec}s
                          </p>
                        ) : null}
                        {gatewayCircuitHint.lastError ? (
                          <p className="break-words text-sky-100/75">
                            {t('chat.gatewayCircuit.lastError', 'Last preflight error')}: {gatewayCircuitHint.lastError}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {agentStatus !== 'error' && (
                  <button
                    onClick={() => { void onStopRequest(); }}
                    className="mt-2 flex items-center gap-1.5 px-3 py-1 text-xs text-slate-400 hover:text-red-400 bg-slate-800/60 hover:bg-red-500/10 border border-slate-700/50 hover:border-red-500/30 rounded-lg transition-colors"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect width="10" height="10" rx="1.5" /></svg>
                    {t('chat.stop', 'Stop')}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}