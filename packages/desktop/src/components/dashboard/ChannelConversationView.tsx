import { AlertTriangle, ChevronRight, Loader2, MessageSquare, Send } from 'lucide-react';
import ChannelIcon from '../ChannelIcon';
import { useI18n } from '../../lib/i18n';

type ChannelSession = {
  sessionKey: string;
  channel: string;
  displayName: string;
};

type ChannelMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
};

export function ChannelConversationView({
  activeChannelKey,
  channelSessions,
  channelLoading,
  channelMessages,
  channelReplyText,
  channelReplying,
  messagesEndRef,
  gatewayRunning,
  onBack,
  onReplyTextChange,
  onReplySubmit,
}: {
  activeChannelKey: string;
  channelSessions: ChannelSession[];
  channelLoading: boolean;
  channelMessages: ChannelMessage[];
  channelReplyText: string;
  channelReplying: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  /** Whether the OpenClaw Gateway is currently running — if false, show a warning */
  gatewayRunning?: boolean;
  onBack: () => void;
  onReplyTextChange: (value: string) => void;
  onReplySubmit: () => void;
}) {
  const { t } = useI18n();
  const currentSession = channelSessions.find((session) => session.sessionKey === activeChannelKey);

  // Per-channel hint for empty state
  const getEmptyHint = () => {
    const ch = currentSession?.channel || '';
    const label = currentSession?.displayName || ch;
    switch (ch) {
      case 'whatsapp':
        return t('channels.empty.whatsapp', `Open WhatsApp on your phone → send any message to start chatting with your AI agent.`);
      case 'wechat':
      case 'openclaw-weixin':
        return t('channels.empty.wechat', `Open WeChat on your phone → send a message to the linked account.`);
      case 'signal':
        return t('channels.empty.signal', `Open Signal on your phone → send a message to start the conversation.`);
      case 'telegram':
        return t('channels.empty.telegram', `Open Telegram → find your bot → send /start or any message.`);
      case 'discord':
        return t('channels.empty.discord', `Head to Discord → type in the configured channel to chat with your agent.`);
      case 'slack':
        return t('channels.empty.slack', `Open Slack → send a message in the configured channel.`);
      default:
        return t('channels.empty.default', `Send a message via ${label} to start the conversation.`);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-2 border-b border-slate-800/50 flex items-center gap-2">
        <button onClick={onBack} className="p-1 text-slate-500 hover:text-slate-200 hover:bg-slate-800 rounded-md transition-colors" title={t('common.back', 'Back')}>
          <ChevronRight size={14} className="rotate-180" />
        </button>
        {currentSession ? (
          <>
            <ChannelIcon channelId={currentSession.channel} size={18} />
            <span className="text-sm text-slate-200 font-medium">{currentSession.displayName || currentSession.channel}</span>
            <span className="text-xs text-slate-500">{currentSession.channel}</span>
          </>
        ) : (
          <span className="text-sm text-slate-400">{activeChannelKey}</span>
        )}
      </div>

      {/* Gateway offline warning */}
      {gatewayRunning === false && (
        <div className="mx-4 mt-2 px-3 py-2 bg-amber-900/20 border border-amber-700/40 rounded-lg flex items-start gap-2 text-xs text-amber-300">
          <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
          <span>{t('channels.gatewayOffline', 'Gateway is not running — messages from your phone will not arrive. Go to Settings → Gateway to start it.')}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        <div className="max-w-3xl mx-auto space-y-4 w-full">
          {channelLoading ? (
            <div className="flex items-center justify-center py-12 text-slate-500">
              <Loader2 size={20} className="animate-spin mr-2" />
              <span className="text-sm">{t('channels.loadingHistory', 'Loading history...')}</span>
            </div>
          ) : channelMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-500 space-y-3 max-w-xs mx-auto text-center">
              {currentSession && <ChannelIcon channelId={currentSession.channel} size={40} />}
              <MessageSquare size={24} className="opacity-30" />
              <p className="text-sm font-medium text-slate-400">{t('channels.noMessages', 'No messages yet')}</p>
              <p className="text-xs text-slate-500 leading-relaxed">{getEmptyHint()}</p>
            </div>
          ) : (
            channelMessages.map((message) => (
              message.role === 'user' ? (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[75%]">
                    <div className="px-4 py-3 rounded-2xl rounded-br-md text-sm bg-brand-600 text-white">
                      {message.content}
                    </div>
                    {message.timestamp && (
                      <div className="text-right mt-1">
                        <span className="text-[10px] text-slate-600">{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div key={message.id} className="flex justify-start gap-2.5">
                  {currentSession && <span className="mt-0.5 flex-shrink-0 opacity-70"><ChannelIcon channelId={currentSession.channel} size={20} /></span>}
                  <div className="max-w-[85%]">
                    <div className="px-4 py-3 rounded-2xl rounded-bl-md bg-slate-800/50 text-sm text-slate-200 whitespace-pre-wrap">
                      {message.content}
                    </div>
                    {message.timestamp && (
                      <div className="mt-1">
                        <span className="text-[10px] text-slate-600">{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            ))
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="px-4 py-3 border-t border-slate-800/50">
        <div className="max-w-3xl mx-auto relative">
          <textarea
            value={channelReplyText}
            onChange={(event) => onReplyTextChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onReplySubmit();
              }
            }}
            placeholder={t('channels.replyPlaceholder', 'Reply to this channel...')}
            className="w-full pl-4 pr-12 py-3 bg-slate-900 border border-slate-700/50 rounded-2xl text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none placeholder:text-slate-600"
            style={{ minHeight: '44px', maxHeight: '120px' }}
            disabled={channelReplying}
          />
          <button
            onClick={onReplySubmit}
            disabled={!channelReplyText.trim() || channelReplying}
            className="absolute right-2 bottom-2 p-1.5 bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg transition-colors"
          >
            {channelReplying ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}