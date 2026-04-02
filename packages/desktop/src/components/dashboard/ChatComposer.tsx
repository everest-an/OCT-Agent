import { AlertTriangle, Bot, Check, ChevronDown, File, Image, Loader2, Paperclip, Send, Shield, X } from 'lucide-react';

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
  onSend,
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
  onSend: () => void;
}) {
  return (
    <>
      {memoryWarning && (
        <div className="px-4 pb-1">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-900/30 border border-amber-700/40 text-amber-300 text-xs animate-in fade-in slide-in-from-bottom-2">
              <AlertTriangle size={14} className="flex-shrink-0" />
              <span className="truncate">Memory save failed: {memoryWarning}</span>
              <button onClick={onDismissMemoryWarning} className="ml-auto flex-shrink-0 text-amber-400 hover:text-amber-200">
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
                  <button onClick={() => onRemoveFile(index)} aria-label={`Remove ${file.name}`} title={`Remove ${file.name}`} className="text-slate-500 hover:text-red-400 flex-shrink-0">
                    <X size={10} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="px-4 py-3">
        <div className="max-w-3xl mx-auto">
          <div className="relative bg-slate-800 rounded-2xl border border-slate-700/60 focus-within:border-brand-500/50 focus-within:ring-1 focus-within:ring-brand-500/20 transition-all">
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
              rows={1}
              className="w-full pl-4 pr-4 pt-3 pb-10 bg-transparent rounded-2xl text-sm focus:outline-none resize-none placeholder:text-slate-600 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ minHeight: '52px', maxHeight: '160px', height: input.includes('\n') ? 'auto' : '52px' }}
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
            <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
              <div className="flex items-center gap-1">
                <button onClick={onOpenFilePicker} aria-label={t('chat.attachFile', 'Attach file')} className="p-1.5 text-slate-500 hover:text-slate-300 hover:bg-slate-700 rounded-lg transition-colors" title={t('chat.attachFile', 'Attach file')}>
                  <Paperclip size={14} />
                </button>
                <div className="relative" ref={permissionMenuRef}>
                  <button
                    onClick={onTogglePermissionMenu}
                    className="flex items-center gap-1 px-2 py-1 text-[11px] text-slate-500 hover:text-slate-300 hover:bg-slate-700 rounded-lg transition-colors"
                    title={t('chat.permissions.switch', 'Switch permissions')}
                    disabled={permissionUpdating}
                  >
                    {permissionUpdating ? <Loader2 size={11} className="animate-spin" /> : <Shield size={11} />}
                    <span className="max-w-[92px] truncate">{selectedPermissionLabel}</span>
                    <ChevronDown size={10} />
                  </button>
                  {showPermissionMenu && (
                    <div className="absolute bottom-full left-0 mb-1 min-w-[220px] bg-slate-800 border border-slate-700 rounded-xl shadow-lg overflow-hidden z-50">
                      {permissionOptions.map((option) => (
                        <button
                          key={option.key}
                          onClick={() => onSelectPermission(option.key)}
                          className="w-full px-3 py-2.5 text-left transition-colors text-slate-300 hover:bg-slate-700"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium">{option.label}</span>
                            {option.label === selectedPermissionLabel && <Check size={12} className="text-brand-400 flex-shrink-0" />}
                          </div>
                          <div className="mt-1 text-[10px] text-slate-500">{option.desc}</div>
                        </button>
                      ))}
                      {onManagePermissions && (
                        <button onClick={onManagePermissions} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left text-slate-500 hover:text-slate-300 hover:bg-slate-700 border-t border-slate-700 transition-colors">
                          <Shield size={12} />
                          <span>{t('chat.permissions.manage', 'Open full permission settings')}</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {agents.length > 1 && (
                  <div className="relative" ref={agentMenuRef}>
                    <button
                      onClick={onToggleAgentMenu}
                      className="flex items-center gap-1 px-2 py-1 text-[11px] text-slate-500 hover:text-slate-300 hover:bg-slate-700 rounded-lg transition-colors"
                      title={t('chat.agent.switch')}
                    >
                      <span>{agents.find((agent) => agent.id === selectedAgentId)?.emoji || '🤖'}</span>
                      <span className="max-w-[80px] truncate">{agents.find((agent) => agent.id === selectedAgentId)?.name || t('chat.agent.default')}</span>
                      <ChevronDown size={10} />
                    </button>
                    {showAgentMenu && (
                      <div className="absolute bottom-full left-0 mb-1 min-w-[180px] bg-slate-800 border border-slate-700 rounded-xl shadow-lg overflow-hidden z-50">
                        {agents.map((agent) => (
                          <button
                            key={agent.id}
                            onClick={() => onSelectAgent(agent.id)}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors ${
                              agent.id === selectedAgentId ? 'bg-brand-600/20 text-brand-300' : 'text-slate-300 hover:bg-slate-700'
                            }`}
                          >
                            <span>{agent.emoji}</span>
                            <span className="flex-1 truncate">{agent.name}</span>
                            {agent.id === selectedAgentId && <Check size={12} className="text-brand-400" />}
                          </button>
                        ))}
                        {onManageAgents && (
                          <button onClick={onManageAgents} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left text-slate-500 hover:text-slate-300 hover:bg-slate-700 border-t border-slate-700 transition-colors">
                            <Bot size={12} />
                            <span>{t('chat.agent.manage', 'Manage Agents')}</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <button onClick={onSend} disabled={!canSendCurrentMessage} className="p-1.5 bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg transition-colors">
                {!canSendCurrentMessage && agentStatus !== 'idle' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}