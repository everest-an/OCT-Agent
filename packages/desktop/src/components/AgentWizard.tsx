/**
 * Agent Creation Wizard — 2-step flow:
 *   Step 0: Name
 *   Step 1: Channel binding (optional, from dynamic OpenClaw registry)
 *   → Create agent (preserving BOOTSTRAP.md)
 *   → Auto-navigate to chat for Bootstrap Q&A ritual
 */
import { useState, useEffect } from 'react';
import {
  ChevronRight, ChevronLeft, Sparkles, Bot, Loader2, X, Link, Check, MessageSquare,
} from 'lucide-react';
import { useI18n } from '../lib/i18n';

interface AgentWizardProps {
  onComplete: (agentId?: string) => void;
  onCancel: () => void;
}

const TOTAL_STEPS = 2;

export default function AgentWizard({ onComplete, onCancel }: AgentWizardProps) {
  const { t } = useI18n();

  const [step, setStep] = useState(0);
  const [agentName, setAgentName] = useState('');
  const [agentEmoji] = useState('');
  const [saving, setSaving] = useState(false);
  const [savingStatus, setSavingStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Channel binding (step 1)
  const [availableChannels, setAvailableChannels] = useState<Array<{ id: string; label: string }>>([]);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [selectedBindings, setSelectedBindings] = useState<string[]>([]);

  // Load channels from dynamic registry on mount
  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) { setChannelsLoading(false); return; }
      try {
        const api = window.electronAPI as any;
        const regResult = await api.channelGetRegistry?.();
        const configured = await api.channelListConfigured?.();
        const configuredSet = new Set<string>(configured?.configured || []);

        if (regResult?.channels?.length > 0) {
          const channels = (regResult.channels as Array<{ id: string; openclawId?: string; label: string }>)
            .filter(ch => ch.id !== 'local')
            .map(ch => ({
              id: ch.openclawId || ch.id,
              label: ch.label || ch.id,
              configured: configuredSet.has(ch.id) || configuredSet.has(ch.openclawId || ''),
            }))
            .sort((a, b) => {
              if (a.configured !== b.configured) return a.configured ? -1 : 1;
              return a.label.localeCompare(b.label);
            });
          setAvailableChannels(channels);
        } else {
          const ids = Array.from(configuredSet).filter(id => id !== 'local');
          setAvailableChannels(ids.map(id => ({ id, label: id })).sort((a, b) => a.label.localeCompare(b.label)));
        }
      } catch { /* ignore */ }
      setChannelsLoading(false);
    };
    load();
  }, []);

  const toggleBinding = (channelId: string) => {
    setSelectedBindings(prev =>
      prev.includes(channelId) ? prev.filter(c => c !== channelId) : [...prev, channelId]
    );
  };

  const handleCreate = async () => {
    const finalName = agentName.trim();
    if (!finalName) {
      setError(t('agentWizard.error.nameRequired', 'Please enter a name for the agent'));
      setStep(0);
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
      if (api.agentsSetIdentity) {
        await api.agentsSetIdentity(slug, finalName, agentEmoji);
      }

      // 3. Write IDENTITY.md
      setSavingStatus(t('agentWizard.status.workspace', 'Setting up workspace...'));
      if (api.agentsWriteFile) {
        await api.agentsWriteFile(slug, 'IDENTITY.md',
          `# Identity\n\n- **name**: ${finalName}\n- **emoji**: ${agentEmoji || 'default'}\n- **role**: AI Assistant\n`
        );
      }

      // 4. Bind selected channels
      if (api.agentsBind && selectedBindings.length > 0) {
        setSavingStatus(t('agentWizard.status.binding', 'Binding channels...'));
        for (const channel of selectedBindings) {
          try { await api.agentsBind(slug, channel); } catch { /* ignore */ }
        }
      }

      onComplete(slug);
    } catch (err: any) {
      setError(err?.message || t('agentWizard.error.unexpected', 'Unexpected error.'));
    } finally {
      setSaving(false);
      setSavingStatus('');
    }
  };

  const handleNext = () => {
    if (step < TOTAL_STEPS - 1) { setError(null); setStep(step + 1); }
    else handleCreate();
  };

  const canProceed = step === 0 ? agentName.trim().length > 0 : true;

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
                <p className="text-xs text-slate-500">{t('agentWizard.step1.hint', 'Give it a unique name')}</p>
              </div>

              <div className="flex items-center gap-3 mx-auto w-full max-w-xs">
                <div className="w-12 h-12 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center shrink-0">
                  <Bot size={22} className="text-sky-300" />
                </div>
                <input
                  type="text"
                  value={agentName}
                  onChange={e => setAgentName(e.target.value)}
                  placeholder={t('agentWizard.step1.placeholder', 'e.g. Research, Coding, Writer...')}
                  className="flex-1 px-4 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-slate-100 text-sm focus:outline-none focus:border-brand-500"
                  autoFocus
                  onKeyDown={e => e.key === 'Enter' && canProceed && handleNext()}
                />
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

          {/* Step 1: Channel Binding */}
          {step === 1 && (
            <div className="flex-1 flex flex-col gap-4">
              <div className="text-center mb-1">
                <h2 className="text-lg font-semibold text-white">{t('agentWizard.step4.title', 'Bind channels')}</h2>
                <p className="text-xs text-slate-500">{t('agentWizard.step4.hint', 'Optionally bind messaging channels to this agent')}</p>
              </div>

              {channelsLoading ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-3">
                  <Loader2 size={24} className="text-slate-500 animate-spin" />
                  <p className="text-sm text-slate-500">{t('agentWizard.step4.loading', 'Loading channels...')}</p>
                </div>
              ) : availableChannels.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-3">
                  <Link size={24} className="text-slate-600" />
                  <p className="text-sm text-slate-500 text-center">
                    {t('agentWizard.step4.noChannels', 'No channels connected yet. You can bind channels later from the Agents page.')}
                  </p>
                </div>
              ) : (
                <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
                  <p className="text-[11px] text-slate-500">
                    {t('agentWizard.step4.selectChannels', 'Select channels to route to this agent:')}
                  </p>
                  {availableChannels.map(ch => (
                    <button
                      key={ch.id}
                      onClick={() => toggleBinding(ch.id)}
                      className={`w-full p-3 rounded-xl border text-left transition-all flex items-center gap-3 ${
                        selectedBindings.includes(ch.id)
                          ? 'border-emerald-500 bg-emerald-500/10'
                          : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
                      }`}
                    >
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                        selectedBindings.includes(ch.id) ? 'border-emerald-500 bg-emerald-500' : 'border-slate-600'
                      }`}>
                        {selectedBindings.includes(ch.id) && <Check size={12} className="text-white" />}
                      </div>
                      <Link size={14} className={selectedBindings.includes(ch.id) ? 'text-emerald-400' : 'text-slate-500'} />
                      <span className={`text-sm ${selectedBindings.includes(ch.id) ? 'text-emerald-300' : 'text-slate-300'}`}>
                        {ch.label}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Status message during creation */}
        {saving && savingStatus && (
          <div className="mt-4 flex items-center justify-center gap-2 text-xs text-slate-400">
            <Loader2 size={12} className="animate-spin" />
            <span>{savingStatus}</span>
          </div>
        )}

        {/* Navigation buttons */}
        <div className="flex items-center justify-between mt-4">
          <div>
            {saving ? (
              <span />
            ) : step > 0 ? (
              <button
                onClick={() => { setStep(step - 1); setError(null); }}
                className="flex items-center gap-1 text-sm text-slate-400 hover:text-white transition-colors"
              >
                <ChevronLeft size={16} />
                {t('bootstrap.back', 'Back')}
              </button>
            ) : (
              <button onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
                {t('common.cancel', 'Cancel')}
              </button>
            )}
          </div>
          <div>
            {step < TOTAL_STEPS - 1 ? (
              <button
                onClick={handleNext}
                disabled={!canProceed}
                className="flex items-center gap-1 px-5 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl transition-colors"
              >
                {t('bootstrap.next', 'Next')}
                <ChevronRight size={16} />
              </button>
            ) : (
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
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
