import { AlertTriangle, Bot, Check, ChevronDown, File, Image, Loader2, Paperclip, Send, Shield, Square, X } from 'lucide-react';
import AgentAvatar from '../AgentAvatar';

type AttachedFile = {
  name: string;
  path: string;
  preview?: {
    type: 'text' | 'image' | 'error';
    content?: string;
    dataUri?: string;
    size?: number;
    truncated?: boolean;
  };
};

type AgentInfo = {
  id: string;
  name: string;
  emoji: string;
};

type PermissionOption = {
  key: string;
  label: string;
  desc: string;
};

export function ChatComposer({
  t,
  input,
  textareaRef,
  fileInputRef,
  attachedFiles,
  agents,
  showAgentMenu,
  agentMenuRef,
  selectedAgentId,
  permissionOptions,
  showPermissionMenu,
  permissionMenuRef,
  selectedPermissionLabel,
  permissionUpdating,
  canSendCurrentMessage,
  agentStatus,
  memoryWarning,
  onInputChange,
  onKeyDown,
  onOpenFilePicker,
  onFilesSelected,
  onRemoveFile,
  onToggleAgentMenu,
  onSelectAgent,
  onTogglePermissionMenu,
  onSelectPermission,
  onManageAgents,
  onManagePermissions,
  onDismissMemoryWarning,
  queuedCount,
  onSend,
  onStop,
}: {
  t: (key: string, fallback?: string) => string;
  input: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  attachedFiles: AttachedFile[];
  agents: AgentInfo[];
  showAgentMenu: boolean;
  agentMenuRef: React.RefObject<HTMLDivElement | null>;
  selectedAgentId: string;
  permissionOptions: PermissionOption[];
  showPermissionMenu: boolean;
  permissionMenuRef: React.RefObject<HTMLDivElement | null>;
  selectedPermissionLabel: string;
  permissionUpdating: boolean;
  canSendCurrentMessage: boolean;
  agentStatus: 'idle' | 'thinking' | 'generating' | 'error';
  memoryWarning: string | null;
  onInputChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onOpenFilePicker: () => void;
  onFilesSelected: (files: FileList | null) => void;
  onRemoveFile: (index: number) => void;
  onToggleAgentMenu: () => void;
  onSelectAgent: (agentId: string) => void;
  onTogglePermissionMenu: () => void;
  onSelectPermission: (key: string) => void;
  onManageAgents?: () => void;
  onManagePermissions?: () => void;
  onDismissMemoryWarning: () => void;
  queuedCount?: number;
  onSend: () => void;
  onStop?: () => void;
}) {
  const isRunning = agentStatus === 'thinking' || agentStatus === 'generating';
  return (
    <>
      {memoryWarning && (
        <div className="px-4 pb-1">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-900/30 border border-amber-700/40 text-amber-300 text-xs animate-in fade-in slide-in-from-bottom-2">
              <AlertTriangle size={14} className="flex-shrink-0" />
              <span className="truncate">{t('chat.memoryWarningPrefix', 'Memory save failed:')} {memoryWarning}</span>
              <button
                onClick={onDismissMemoryWarning}
                title={t('common.close', 'Close')}
                aria-label={t('common.close', 'Close')}
                className="ml-auto flex-shrink-0 text-amber-400 hover:text-amber-200"
              >
                <X size={12} />
              </button>
            </div>
          </div>
        </div>
      )}

      {attachedFiles.length > 0 && (
        <div className="px-4 py-2 border-t border-slate-800/50 space-y-2 max-w-3xl mx-auto">
          <div className="flex gap-2 flex-wrap">
            {attachedFiles.map((file, index) => (
              <div key={`${file.name}-${index}`} className="bg-slate-800 rounded-lg border border-slate-700/50 overflow-hidden max-w-[240px]">
                {file.preview?.type === 'image' && file.preview.dataUri && (
                  <div className="w-full h-24 bg-slate-900 flex items-center justify-center">
                    <img src={file.preview.dataUri} alt={file.name} className="max-w-full max-h-24 object-contain" />
                  </div>
                )}
                {file.preview?.type === 'text' && file.preview.content && (
                  <div className="px-2 py-1.5 bg-slate-900 max-h-20 overflow-hidden">
                    <pre className="text-[9px] text-slate-500 font-mono leading-tight whitespace-pre-wrap">{file.preview.content.slice(0, 200)}</pre>
                    {file.preview.truncated && <span className="text-[9px] text-slate-600">...</span>}
                  </div>
                )}
                <div className="flex items-center gap-1.5 px-2 py-1">
                  {file.preview?.type === 'image' ? <Image size={10} className="text-brand-400" /> : <File size={10} className="text-slate-400" />}
                  <span className="text-[10px] text-slate-300 truncate flex-1">{file.name}</span>
                  {file.preview?.size && <span className="text-[9px] text-slate-600">{(file.preview.size / 1024).toFixed(0)}KB</span>}
                  <button
                    onClick={() => onRemoveFile(index)}
                    aria-label={t('common.removeFile', 'Remove {0}').replace('{0}', file.name)}
                    title={t('common.removeFile', 'Remove {0}').replace('{0}', file.name)}
                    className="text-slate-500 hover:text-red-400 flex-shrink-0"
                  >
                    <X size={10} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="px-5 py-3.5">
        <div className="max-w-3xl mx-auto">
          <div className="relative bg-slate-800/80 backdrop-blur-sm rounded-2xl border border-slate-700/50 focus-within:border-brand-500/40 focus-within:ring-2 focus-within:ring-brand-500/15 transition-all duration-200 shadow-lg shadow-black/20">
            {/* @agent mention autocomplete popup */}
            {(() => {
              // Detect if user just typed @ at the start or after a space
              const mentionMatch = input.match(/(?:^|\s)@(\S*)$/);
              const showMentionPopup = mentionMatch && agents.length > 1;
              const mentionFilter = mentionMatch?.[1]?.toLowerCase() || '';
              const filteredAgents = showMentionPopup
                ? agents.filter((a) => a.id !== 'main' && (!mentionFilter || a.id.toLowerCase().includes(mentionFilter) || a.name.toLowerCase().includes(mentionFilter)))
                : [];

              if (filteredAgents.length === 0) return null;

              return (
                <div className="absolute bottom-full left-4 mb-2 w-56 bg-slate-900/95 backdrop-blur-xl border border-slate-700/60 rounded-2xl shadow-2xl shadow-black/40 overflow-hidden z-20 animate-in fade-in slide-in-from-bottom-2">
                  <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800">
                    {t('chat.mention.hint', 'Type @agent to delegate a task')}
                  </div>
                  {filteredAgents.map((agent) => (
                    <button
                      key={agent.id}
                      onClick={() => {
                        // Replace the @partial with @agentId + space
                        const newInput = input.replace(/(?:^|\s)@\S*$/, (match) => {
                          const prefix = match.startsWith(' ') ? ' ' : '';
                          return `${prefix}@${agent.name} `;
                        });
                        onInputChange(newInput);
                        textareaRef.current?.focus();
                      }}
                      className="w-full px-3 py-2 flex items-center gap-2 hover:bg-slate-800/60 transition-all duration-150 text-left"
                    >
                      <AgentAvatar name={agent.name} emoji={agent.emoji} size={16} className="flex-shrink-0" />
                      <div>
                        <span className="text-xs text-slate-200 font-medium">{agent.name}</span>
                        <span className="text-[10px] text-slate-500 ml-1.5">@{agent.name}</span>
                      </div>
                    </button>
                  ))}
                </div>
              );
            })()}

            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                agentStatus === 'thinking' || agentStatus === 'generating'
                  ? t('chat.input.canQueue', 'AI is working... you can still type')
                  : t('chat.input.placeholder')
              }
              rows={2}
              className="w-full pl-4 pr-4 pt-3 pb-11 bg-transparent rounded-2xl text-sm leading-relaxed focus:outline-none resize-none placeholder:text-slate-600 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ minHeight: '80px', maxHeight: '200px' }}
              disabled={false}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              aria-label={t('chat.attachFile', 'Attach file')}
              onChange={(event) => onFilesSelected(event.target.files)}
            />
            <div className="absolute bottom-2.5 left-3 right-3 flex items-center justify-between">
              <div className="flex items-center gap-1">
                {/* Attach file */}
                <button onClick={onOpenFilePicker} aria-label={t('chat.attachFile', 'Attach file')} className="p-1.5 text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 rounded-lg transition-colors" title={t('chat.attachFile', 'Attach file')}>
                  <Paperclip size={14} />
                </button>

                {/* Divider */}
                <div className="w-px h-4 bg-slate-700/50 mx-0.5" />

                {/* Permission — icon-only with tooltip, dropdown on click */}
                <div className="relative" ref={permissionMenuRef}>
                  <button
                    onClick={onTogglePermissionMenu}
                    className="flex items-center gap-1 p-1.5 text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 rounded-lg transition-colors"
                    title={`${t('chat.permissions.switch', 'Permissions')}: ${selectedPermissionLabel}`}
                    disabled={permissionUpdating}
                  >
                    {permissionUpdating ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />}
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      selectedPermissionLabel.toLowerCase().includes('safe') ? 'bg-blue-400' :
                      selectedPermissionLabel.toLowerCase().includes('developer') ? 'bg-purple-400' :
                      'bg-emerald-400'
                    }`} />
                  </button>
                  {showPermissionMenu && (
                    <div className="absolute bottom-full left-0 mb-2 w-52 bg-slate-900/95 backdrop-blur-xl border border-slate-700/60 rounded-2xl shadow-2xl shadow-black/40 overflow-hidden z-50">
                      <div className="px-3 py-1.5 text-[10px] text-slate-500 uppercase tracking-wider border-b border-slate-700/50">{t('chat.permissions.switch', 'Permissions')}</div>
                      {permissionOptions.map((option) => (
                        <button
                          key={option.key}
                          onClick={() => onSelectPermission(option.key)}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
                            option.label === selectedPermissionLabel ? 'bg-brand-600/15 text-brand-300' : 'text-slate-300 hover:bg-slate-700/60'
                          }`}
                        >
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-medium">{option.label}</span>
                            <span className="ml-1.5 text-[10px] text-slate-500">{option.desc}</span>
                          </div>
                          {option.label === selectedPermissionLabel && <Check size={11} className="text-brand-400 flex-shrink-0" />}
                        </button>
                      ))}
                      {onManagePermissions && (
                        <button onClick={onManagePermissions} className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[10px] text-slate-500 hover:text-slate-300 hover:bg-slate-700/40 border-t border-slate-700/50 transition-colors">
                          <Shield size={10} />
                          <span>{t('chat.permissions.manage', 'Full settings')}</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Agent selector — compact icon + name */}
                {agents.length > 1 && (
                  <div className="relative" ref={agentMenuRef}>
                    <button
                      onClick={onToggleAgentMenu}
                      className="flex items-center gap-1 p-1.5 text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 rounded-lg transition-colors"
                      title={`${t('chat.agent.switch', 'Switch agent')}: ${agents.find((a) => a.id === selectedAgentId)?.name || ''}`}
                    >
                      <AgentAvatar
                        name={agents.find((a) => a.id === selectedAgentId)?.name || ''}
                        emoji={agents.find((a) => a.id === selectedAgentId)?.emoji || ''}
                        size={14}
                      />
                      <ChevronDown size={10} />
                    </button>
                    {showAgentMenu && (
                      <div className="absolute bottom-full left-0 mb-2 w-48 bg-slate-900/95 backdrop-blur-xl border border-slate-700/60 rounded-2xl shadow-2xl shadow-black/40 overflow-hidden z-50">
                        <div className="px-3 py-1.5 text-[10px] text-slate-500 uppercase tracking-wider border-b border-slate-700/50">{t('chat.agent.switch', 'Agents')}</div>
                        {agents.map((agent) => (
                          <button
                            key={agent.id}
                            onClick={() => onSelectAgent(agent.id)}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors ${
                              agent.id === selectedAgentId ? 'bg-brand-600/15 text-brand-300' : 'text-slate-300 hover:bg-slate-700/60'
                            }`}
                          >
                            <AgentAvatar name={agent.name} emoji={agent.emoji} size={14} />
                            <span className="flex-1 truncate">{agent.name}</span>
                            {agent.id === selectedAgentId && <Check size={11} className="text-brand-400" />}
                          </button>
                        ))}
                        {onManageAgents && (
                          <button onClick={onManageAgents} className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[10px] text-slate-500 hover:text-slate-300 hover:bg-slate-700/40 border-t border-slate-700/50 transition-colors">
                            <Bot size={10} />
                            <span>{t('chat.agent.manage', 'Manage Agents')}</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Send + Stop buttons — both visible when running so user can queue messages */}
              {isRunning && onStop && (
                <button
                  onClick={onStop}
                  className="p-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors"
                  title={`${t('chat.stop', 'Stop')} (Esc)`}
                >
                  <Square size={14} fill="currentColor" />
                </button>
              )}
              <div className="relative">
                <button
                  onClick={onSend}
                  disabled={!canSendCurrentMessage}
                  title={isRunning ? t('chat.queue', 'Queue message') : t('chat.send', 'Send')}
                  aria-label={isRunning ? t('chat.queue', 'Queue message') : t('chat.send', 'Send')}
                  className="p-1.5 bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700/60 disabled:text-slate-500 text-white rounded-lg transition-all duration-150 shadow-sm shadow-brand-900/30"
                >
                  <Send size={14} />
                </button>
                {(queuedCount ?? 0) > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 flex items-center justify-center min-w-[16px] h-4 px-1 text-[9px] font-bold text-white bg-amber-500 rounded-full">
                    {queuedCount}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}