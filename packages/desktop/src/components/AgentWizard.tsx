/**
 * Agent Creation Wizard — single-step flow (2026-04-08 simplification):
 *   Step 0: Name → Create agent (preserving BOOTSTRAP.md) → Auto-navigate to chat
 *
 * Channel binding was removed. New agents do NOT touch openclaw.json bindings[]
 * on creation — they are simply "eligible" for all channels, and users route a
 * channel to a specific agent from the Channels page via the per-channel
 * "Replied by" dropdown. This keeps the creation flow trivial for first-time
 * users, avoids the OpenClaw first-match-wins footgun (where binding the same
 * channel to multiple agents silently breaks all but the first one), and
 * matches OpenClaw's own model of "one agent per channel default, optional
 * peer-level overrides for power users".
 */
import { useState } from 'react';
import {
  Sparkles, Bot, Loader2, X, MessageSquare,
} from 'lucide-react';
import AgentAvatar from './AgentAvatar';
import { useI18n } from '../lib/i18n';

interface AgentWizardProps {
  onComplete: (agentId?: string) => void;
  onCancel: () => void;
}

const TOTAL_STEPS = 1;

const AGENT_EMOJIS = [
  '🤖', '🧠', '🔬', '🎯', '📊', '💡', '🛡️', '🚀',
  '📝', '🔧', '🎨', '📚', '🐾', '💼', '⚡', '🌙',
  '🔥', '🐚', '🏠', '🦞', '👨‍💻', '🧪', '📡', '🎭',
];

const DEFAULT_AGENT_EMOJI = AGENT_EMOJIS[0];

function buildIdentityMarkdown(name: string, emoji?: string): string {
  const normalizedEmoji = emoji?.trim() || '';
  return [
    '# IDENTITY.md - Agent Identity',
    '',
    `- **Name:** ${name}`,
    '- **Creature:**',
    '- **Vibe:**',
    normalizedEmoji ? `- **Emoji:** ${normalizedEmoji}` : '- **Emoji:**',
    '- **Avatar:**',
    '',
  ].join('\n');
}

function isMeaningfulAgentName(name: string): boolean {
  const trimmed = String(name || '').trim();
  if (!trimmed) return false;
  return /[\p{L}\p{N}]/u.test(trimmed);
}

function isDisallowedAgentName(name: string): boolean {
  const trimmed = String(name || '').trim();
  if (!trimmed) return false;
  const lowered = trimmed.toLowerCase();
  if (lowered === 'main' || lowered === 'default') return true;
  return /^oc-\d{6,}$/i.test(trimmed);
}

export default function AgentWizard({ onComplete, onCancel }: AgentWizardProps) {
  const { t } = useI18n();

  const [step] = useState(0);
  const [agentName, setAgentName] = useState('');
  const [agentEmoji, setAgentEmoji] = useState(DEFAULT_AGENT_EMOJI);
  const [saving, setSaving] = useState(false);
  const [savingStatus, setSavingStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    const finalName = agentName.trim();
    if (!finalName) {
      setError(t('agentWizard.error.nameRequired', 'Please enter a name for the agent'));
      return;
    }
    if (!isMeaningfulAgentName(finalName)) {
      setError(t('agentWizard.error.nameInvalid', 'Use at least one letter or number in the agent name.'));
      return;
    }
    if (isDisallowedAgentName(finalName)) {
      setError(t('agentWizard.error.nameReserved', 'This name looks like a system/reserved ID. Please choose a human-readable name.'));
      return;
    }
    if (finalName.length > 64) {
      setError(t('agentWizard.error.nameTooLong', 'Agent name is too long (max 64 characters).'));
      return;
    }

    setSaving(true);
    setSavingStatus(t('agentWizard.status.creating', 'Creating agent (loading plugins)...'));
    setError(null);

    try {
      const api = window.electronAPI as any;
      if (!api) { onComplete(); return; }

      // 1. Create agent — NO systemPrompt → BOOTSTRAP.md preserved for first-chat Q&A
      const result = await api.agentsAdd(finalName, undefined, undefined);
      const alreadyExists = !result.success && /already exists|duplicate/i.test(result.error || '');
      if (!result.success && !alreadyExists) {
        const errMsg = result.error || '';
        if (/permission|access|denied/i.test(errMsg)) {
          setError(t('agentWizard.error.permission', 'Permission denied. Check system permissions.'));
        } else if (/timed? ?out/i.test(errMsg)) {
          setError(t('agentWizard.error.timeout', 'OpenClaw is loading plugins — this can take up to 30s. Please try again.'));
        } else {
          setError(errMsg || t('agentWizard.error.createFailed', 'Failed to create agent.'));
        }
        setSaving(false);
        setSavingStatus('');
        return;
      }

      // 2. Set identity
      setSavingStatus(t('agentWizard.status.identity', 'Setting identity...'));
      const slug = result.agentId || finalName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || `oc-${Date.now()}`;
      const normalizedEmoji = agentEmoji.trim();
      if (api.agentsSetIdentity) {
        const identityResult = await api.agentsSetIdentity(slug, finalName, normalizedEmoji);
        if (!identityResult?.success) {
          throw new Error(identityResult?.error || t('agentWizard.error.identityFailed', 'Failed to save agent identity.'));
        }
      }

      // 3. Write IDENTITY.md
      setSavingStatus(t('agentWizard.status.workspace', 'Setting up workspace...'));
      if (api.agentsWriteFile) {
        const writeResult = await api.agentsWriteFile(slug, 'IDENTITY.md', buildIdentityMarkdown(finalName, normalizedEmoji));
        if (!writeResult?.success) {
          throw new Error(writeResult?.error || t('agentWizard.error.identityFileFailed', 'Failed to write IDENTITY.md.'));
        }
      }

      // Channel binding removed 2026-04-08. New agents no longer touch
      // openclaw.json bindings[] on creation. Routing is set from the
      // Channels page by switching a channel's "Replied by" dropdown to
      // this new agent (optional).
      onComplete(slug);
    } catch (err: any) {
      setError(err?.message || t('agentWizard.error.unexpected', 'Unexpected error.'));
    } finally {
      setSaving(false);
      setSavingStatus('');
    }
  };

  const canProceed = agentName.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/95 flex items-center justify-center p-6">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-full bg-brand-500/10 flex items-center justify-center mx-auto mb-3">
            <Bot size={28} className="text-brand-400" />
          </div>
          <h1 className="text-xl font-bold text-white mb-1">{t('agentWizard.title', 'Create New Agent')}</h1>
          <p className="text-slate-400 text-sm">{t('agentWizard.subtitle', 'Set up an isolated agent with its own workspace')}</p>
        </div>

        {/* Progress dots */}
        <div className="flex justify-center gap-2 mb-6">
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <div key={i} className={`w-2 h-2 rounded-full transition-colors ${
              i === step ? 'bg-brand-500' : i < step ? 'bg-brand-500/50' : 'bg-slate-700'
            }`} />
          ))}
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 flex items-center gap-2 p-3 bg-red-600/10 border border-red-600/20 rounded-xl text-xs text-red-400">
            <span className="flex-1">{error}</span>
            <button
              onClick={() => setError(null)}
              aria-label={t('common.close', 'Close')}
              title={t('common.close', 'Close')}
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/* Step content */}
        <div className="bg-slate-900/80 rounded-2xl border border-slate-800 p-6 min-h-[300px] flex flex-col">

          {/* Step 0: Name */}
          {step === 0 && (
            <div className="flex-1 flex flex-col gap-4">
              <div className="text-center">
                <h2 className="text-lg font-semibold text-white mb-1">{t('agentWizard.step1.title', 'Name your agent')}</h2>
                <p className="text-xs text-slate-500">{t('agentWizard.step1.hint', 'Give it a unique name and emoji')}</p>
              </div>

              <div className="flex items-center gap-3 mx-auto w-full max-w-xs">
                <div className="w-12 h-12 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center shrink-0">
                  <AgentAvatar name={agentName} emoji={agentEmoji} size={20} className="scale-125" />
                </div>
                <input
                  type="text"
                  value={agentName}
                  onChange={e => setAgentName(e.target.value)}
                  placeholder={t('agentWizard.step1.placeholder', 'e.g. Research, Coding, Writer...')}
                  className="flex-1 px-4 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-slate-100 text-sm focus:outline-none focus:border-brand-500"
                  autoFocus
                  onKeyDown={e => e.key === 'Enter' && canProceed && !saving && handleCreate()}
                />
              </div>

              <div>
                <p className="text-[11px] text-slate-500 mb-2">{t('agentWizard.step1.pickEmoji', 'Pick an icon:')}</p>
                <div className="grid grid-cols-8 gap-1.5">
                  {AGENT_EMOJIS.map(emoji => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => setAgentEmoji(emoji)}
                      className={`w-9 h-9 rounded-lg text-lg flex items-center justify-center transition-all ${
                        agentEmoji === emoji
                          ? 'bg-brand-500/20 ring-2 ring-brand-500 scale-110'
                          : 'bg-slate-800/50 hover:bg-slate-700/70'
                      }`}
                      aria-label={emoji}
                      title={emoji}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>

              {/* Bootstrap hint */}
              <div className="flex items-start gap-2 p-3 bg-amber-600/5 border border-amber-600/15 rounded-xl">
                <MessageSquare size={16} className="text-amber-400 shrink-0 mt-0.5" />
                <div className="text-[11px] text-slate-400 leading-relaxed">
                  {t('agentWizard.bootstrapHint',
                    'After creating, you\'ll start a conversation with your new agent. It will ask you questions to understand your needs and setup — all through natural chat.'
                  )}
                </div>
              </div>

              <p className="text-[10px] text-slate-600 text-center">{t('agentWizard.step1.naming', 'Any language supported - Chinese, English, etc.')}</p>
            </div>
          )}

          {/* Channel binding step removed 2026-04-08 (see file header). */}
        </div>

        {/* Status message during creation */}
        {saving && savingStatus && (
          <div className="mt-4 flex items-center justify-center gap-2 text-xs text-slate-400">
            <Loader2 size={12} className="animate-spin" />
            <span>{savingStatus}</span>
          </div>
        )}

        {/* Navigation buttons — single-step wizard, just Cancel + Create. */}
        <div className="flex items-center justify-between mt-4">
          <div>
            {saving ? (
              <span />
            ) : (
              <button onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
                {t('common.cancel', 'Cancel')}
              </button>
            )}
          </div>
          <div>
            <button
              onClick={handleCreate}
              disabled={saving || !canProceed}
              data-testid="agent-create-btn"
              className="flex items-center gap-2 px-5 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-colors"
            >
              {saving ? (
                <><Loader2 size={14} className="animate-spin" /> {t('agentWizard.creating', 'Creating...')}</>
              ) : (
                <><Sparkles size={14} /> {t('agentWizard.finish', 'Create & Start Chat')}</>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
