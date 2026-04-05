import { useState, useEffect, useRef } from 'react';
import { Check, CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, Loader2, MessageSquare, Pencil, Radio, Unplug, X } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { useExternalNavigator } from '../lib/useExternalNavigator';
import PasswordInput from '../components/PasswordInput';
import ChannelIcon from '../components/ChannelIcon';
import {
  getAllChannels, getChannel, isOneClick as isOneClickChannel,
  type ChannelDef, type ConfigField, loadFromSerialized,
} from '../lib/channel-registry';

type WizardStep = 'intro' | 'token' | 'test';

const PAIRING_APPROVAL_CHANNELS = new Set(['telegram', 'whatsapp']);

// ---------------------------------------------------------------------------
// DynamicConfigForm — renders config fields from registry definition
// ---------------------------------------------------------------------------

function DynamicConfigForm({ fields, values, onChange, t }: {
  fields: ConfigField[];
  values: Record<string, string>;
  onChange: (key: string, val: string) => void;
  t: (key: string, fallback?: string) => string;
}) {
  const inputClass = 'w-full px-4 py-2.5 bg-slate-800 border border-slate-600 rounded-lg text-sm focus:outline-none focus:border-brand-500';
  return (
    <div className="space-y-4">
      {fields.map(field => (
        <div key={field.key}>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            {t(field.label, field.label)}
          </label>
          {field.type === 'file' ? (
            <div className="flex gap-2">
              <input value={values[field.key] || ''} readOnly
                placeholder={t('channels.gchat.noFile', 'No file selected')}
                className="flex-1 px-4 py-2.5 bg-slate-800 border border-slate-600 rounded-lg text-sm text-slate-400" />
              <button onClick={async () => {
                if (window.electronAPI) {
                  const result = await (window.electronAPI as any).selectFile?.({ filters: [{ name: 'JSON', extensions: ['json'] }] });
                  if (result?.filePath) onChange(field.key, result.filePath);
                }
              }} className="px-4 py-2.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-slate-100 whitespace-nowrap">
                {t('channels.gchat.browse', 'Browse...')}
              </button>
            </div>
          ) : field.type === 'password' ? (
            <PasswordInput value={values[field.key] || ''} onChange={(e) => onChange(field.key, e.target.value)}
              placeholder={field.placeholder || ''} className={inputClass} />
          ) : (
            <input value={values[field.key] || ''} onChange={(e) => onChange(field.key, e.target.value)}
              placeholder={field.placeholder || ''} className={inputClass} />
          )}
          {field.hint && (
            <p className="mt-1.5 text-xs text-slate-500">{t(field.hint, field.hint)}</p>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Channels page
// ---------------------------------------------------------------------------

type Page = 'chat' | 'memory' | 'channels' | 'models' | 'skills' | 'automation' | 'agents' | 'settings';

export default function Channels({ onNavigate }: { onNavigate?: (page: Page) => void }) {
  const { t } = useI18n();
  const { openExternal, isOpening } = useExternalNavigator();

  const extractPairingCodeFromText = (rawInput: string): string | null => {
    const input = String(rawInput || '').trim();
    if (!input) return null;

    const commandMatch = input.match(/openclaw\s+pairing\s+approve\b([\s\S]*)/i);
    if (commandMatch?.[1]) {
      const commandCodes = Array.from(commandMatch[1].toUpperCase().matchAll(/\b([A-HJ-NP-Z2-9]{8})\b/g)).map((m) => m[1]);
      if (commandCodes.length > 0) {
        return commandCodes[commandCodes.length - 1];
      }
    }

    const labelMatch = input.match(/pairing\s*code\s*[:：]\s*([A-HJ-NP-Z2-9]{8})/i);
    if (labelMatch?.[1]) return labelMatch[1].toUpperCase();

    const codeOnly = input.toUpperCase().replace(/\s+/g, '');
    if (/^[A-HJ-NP-Z2-9]{8}$/.test(codeOnly)) return codeOnly;

    if (!/pairing|approve|code/i.test(input)) return null;
    const candidates = Array.from(input.toUpperCase().matchAll(/\b([A-HJ-NP-Z2-9]{8})\b/g)).map((m) => m[1]);
    const unique = Array.from(new Set(candidates));
    return unique.length === 1 ? unique[0] : null;
  };

  const isTimeoutLike = (message: string | null) => {
    const text = String(message || '').toLowerCase();
    return text.includes('timed out') || text.includes('timeout');
  };

  const getTimeoutHint = () => (
    activeWizard === 'telegram'
      ? t('channels.failedTimeoutHintTelegram', 'This is usually not a bad token. Wait 20-60 seconds, then retry. If Telegram sent a pairing code, approve it first.')
      : t('channels.failedTimeoutHint', 'This is usually not a credential issue. Wait 20-60 seconds, then retry.')
  );

  const translateStatus = (statusKey: string): string => {
    const [key, param] = statusKey.split('::');
    const translated = t(key, '');
    if (!translated) return statusKey;
    return param ? translated.replace('{0}', param) : translated;
  };

  const [activeWizard, setActiveWizard] = useState<string | null>(null);
  const [wizardStep, setWizardStep] = useState<WizardStep>('intro');
  // Single state for all config fields (replaces 9 separate useState)
  const [formValues, setFormValues] = useState<Record<string, string>>({});

  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testError, setTestError] = useState<string | null>(null);
  const [testNotice, setTestNotice] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingApproving, setPairingApproving] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingNotice, setPairingNotice] = useState<string | null>(null);
  const [asciiQR, setAsciiQR] = useState<string | null>(null);
  const [channelProgress, setChannelProgress] = useState<string | null>(null);
  const [configuredChannels, setConfiguredChannels] = useState<Set<string>>(new Set());
  const [channels, setChannels] = useState<ChannelDef[]>(getAllChannels());
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [removingChannel, setRemovingChannel] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const hasLoadedOnce = useRef(false);

  // Get the active channel definition from registry
  const activeChannel = activeWizard ? getChannel(activeWizard) : undefined;
  const isOneClick = activeChannel?.connectionType === 'one-click';
  const supportsPairingApproval = !!activeWizard && PAIRING_APPROVAL_CHANNELS.has(activeWizard);

  const loadConfiguredChannels = async (showLoading = true) => {
    if (!window.electronAPI) { setLoadingChannels(false); return; }
    if (showLoading) setLoadingChannels(true);
    try {
      const result = await (window.electronAPI as any).channelListConfigured();
      const configured = new Set<string>(result.configured || []);
      configured.add('local');
      setConfiguredChannels(configured);
    } catch {
      setConfiguredChannels(new Set(['local']));
    }
    // Load dynamic channel registry from backend (OpenClaw catalog discovery)
    try {
      const api = window.electronAPI as any;
      console.log('[Channels] channelGetRegistry exists:', typeof api?.channelGetRegistry);
      const regResult = await api?.channelGetRegistry?.();
      console.log('[Channels] registry result:', regResult?.channels?.length, 'channels');
      if (regResult?.channels?.length > 0) {
        loadFromSerialized(regResult.channels);
        setChannels(getAllChannels());
        console.log('[Channels] loaded', getAllChannels().length, 'total channels');
      }
    } catch (e) { console.error('[Channels] registry error:', e); }
    setLoadingChannels(false);
    hasLoadedOnce.current = true;
  };

  useEffect(() => { loadConfiguredChannels(); }, []);

  // Listen for ASCII QR and progress status from backend
  useEffect(() => {
    if (!window.electronAPI) return;
    (window.electronAPI as any).onChannelQR?.((art: string) => {
      setAsciiQR(art);
      setChannelProgress(null);
    });
    (window.electronAPI as any).onChannelStatus?.((statusKey: string) => {
      setChannelProgress(statusKey);
      // QR scan done — backend is now binding/confirming; clear QR so status messages show
      if (statusKey.includes('binding') || statusKey.includes('confirming') || statusKey.includes('awaitingConfirmation')) {
        setAsciiQR(null);
      }
    });
  }, []);

  // Silent prefill: if hints/errors contain a pairing code, auto-populate input.
  useEffect(() => {
    if (!supportsPairingApproval) return;
    if (pairingCode.trim()) return;

    const combinedHints = [testError, lastError, testNotice, channelProgress]
      .filter(Boolean)
      .join('\n');
    const detected = extractPairingCodeFromText(combinedHints);
    if (detected) setPairingCode(detected);
  }, [supportsPairingApproval, pairingCode, testError, lastError, testNotice, channelProgress]);

  useEffect(() => {
    if (!supportsPairingApproval || !activeWizard) return;
    if (pairingCode.trim()) return;
    if (!window.electronAPI) return;

    let disposed = false;
    let inFlight = false;

    const tick = async () => {
      if (disposed || inFlight || pairingApproving) return;
      inFlight = true;
      try {
        const result = await (window.electronAPI as any).channelPairingLatestCode?.(activeWizard);
        if (!disposed && result?.success && result?.code) {
          setPairingCode(result.code);
          setPairingNotice(t('channels.pairing.latestFilled', 'Latest pending pairing code has been filled automatically.'));
          setPairingError(null);
        }
      } catch {
        // Silent background retry.
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const timer = setInterval(() => { void tick(); }, 8000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [supportsPairingApproval, activeWizard, pairingCode, pairingApproving, t]);

  const openWizard = async (channelId: string) => {
    setActiveWizard(channelId);
    setWizardStep('intro');
    setFormValues({});
    setPairingCode('');
    setPairingApproving(false);
    setPairingError(null);
    setPairingNotice(null);
    setAsciiQR(null); setChannelProgress(null);
    setTestStatus('idle'); setTestError(null); setTestNotice(null); setLastError(null);

    // Pre-fill from existing config
    if (window.electronAPI && configuredChannels.has(channelId)) {
      try {
        const res = await (window.electronAPI as any).channelReadConfig(channelId);
        if (res?.success && res.config) {
          const ch = getChannel(channelId);
          if (ch) {
            const prefilled: Record<string, string> = {};
            for (const field of ch.configFields) {
              // Try exact key, then snake_case variant
              const val = res.config[field.key]
                || res.config[field.key.replace(/[A-Z]/g, (c: string) => '_' + c.toLowerCase())];
              if (val) prefilled[field.key] = val;
            }
            // Also try generic 'token' field
            if (Object.keys(prefilled).length === 0 && res.config.token) {
              prefilled.token = res.config.token;
            }
            setFormValues(prefilled);
          }
        }
      } catch { /* start fresh */ }
    }
  };

  const closeWizard = () => { setActiveWizard(null); loadConfiguredChannels(false); };

  const handleRemove = async (channelId: string) => {
    if (!window.electronAPI) return;
    setRemovingChannel(channelId);
    setConfirmRemove(null);
    try {
      const result = await (window.electronAPI as any).channelRemove(channelId);
      if (!result.success) {
        console.error('[Channels] remove failed:', result.error);
      }
    } catch (e) {
      console.error('[Channels] remove error:', e);
    }
    setRemovingChannel(null);
    loadConfiguredChannels(false);
  };

  // Build config from form values — driven by channel definition
  const buildConfig = (): Record<string, string> | null => {
    if (!activeChannel) return null;
    const config: Record<string, string> = {};
    for (const field of activeChannel.configFields) {
      const val = formValues[field.key]?.trim();
      if (field.required && !val) return null;
      if (val) config[field.key] = val;
    }
    return Object.keys(config).length > 0 ? config : null;
  };

  const isFormValid = (): boolean => {
    if (!activeChannel) return false;
    if (isOneClick) return true;
    return buildConfig() !== null;
  };

  const handleConnect = async () => {
    if (!activeWizard || !activeChannel) return;
    setTestStatus('testing'); setTestError(null); setTestNotice(null);

    if (!window.electronAPI) {
      setTimeout(() => setTestStatus(isFormValid() ? 'success' : 'error'), 1500);
      return;
    }

    if (isOneClick) {
      const result = await (window.electronAPI as any).channelSetup(activeWizard);
      setTestStatus(result.success ? 'success' : 'error');
      if (result.success && result.pendingConfirmation) {
        setTestNotice(t('channels.pendingConfirmation', 'Login completed. OpenClaw is still confirming the channel. This can take a few seconds.'));
      }
      if (result.success) {
        // Backend has flushed the channel list cache; refresh the displayed list.
        await loadConfiguredChannels(false);
      }
      if (!result.success) {
        setTestError(result.error || t('channels.setupFailed', 'Setup failed. Check Gateway in Settings.'));
      }
    } else {
      const config = buildConfig()!;
      const saveResult = await (window.electronAPI as any).channelSave(activeWizard, config);
      if (!saveResult.success) { setTestStatus('error'); setTestError(saveResult.error || t('channels.saveFailed', 'Could not save. Please try again.')); return; }

      // Refresh the channel list immediately after a successful save so the
      // sidebar shows the newly-connected channel without waiting for the next
      // poll cycle.
      await loadConfiguredChannels(false);

      const testResult = await (window.electronAPI as any).channelTest(activeWizard);
      setTestStatus(testResult.success ? 'success' : 'error');
      if (!testResult.success) setTestError(testResult.error || testResult.output || null);
    }
  };

  const handleApprovePairing = async () => {
    if (!activeWizard || !window.electronAPI) return;

    const rawPairingInput = pairingCode.trim();
    if (!rawPairingInput) {
      setPairingError(t('channels.pairing.codeRequired', 'Please paste the pairing code first.'));
      return;
    }

    setPairingApproving(true);
    setPairingError(null);
    setPairingNotice(null);

    try {
      const result = await (window.electronAPI as any).channelPairingApprove?.(activeWizard, rawPairingInput);
      if (!result?.success) {
        setPairingError(result?.error || t('channels.pairing.approveFailed', 'Could not approve this pairing code.'));
        return;
      }

      setPairingCode('');
      setPairingNotice(result.message || t('channels.pairing.approvedNotice', 'Pairing approved.'));
      setTestError(null);
      setLastError(null);
      setTestStatus('success');
      setTestNotice(result.pendingConfirmation
        ? t('channels.pairing.pending', 'Pairing approved. OpenClaw is still syncing, please wait a few seconds.')
        : t('channels.pairing.ready', 'Pairing approved and channel routing is ready.'));
      setWizardStep('test');

      await loadConfiguredChannels(false);

      if (result?.connectivity?.ready) {
        const probe = await (window.electronAPI as any).channelTest?.(activeWizard);
        if (probe && !probe.success) {
          setTestStatus('error');
          setTestError(probe.error || probe.output || t('channels.pairing.probeFailed', 'Pairing was approved, but channel health check failed.'));
        }
      }
    } catch (err: any) {
      setPairingError(err?.message || t('channels.pairing.approveFailed', 'Could not approve this pairing code.'));
    } finally {
      setPairingApproving(false);
    }
  };

  const renderPairingApprovalPanel = () => {
    if (!supportsPairingApproval) return null;

    return (
      <div className="p-3 bg-slate-800/50 border border-slate-700 rounded-lg space-y-2">
        <p className="text-xs text-slate-300">
          {t('channels.pairing.help', 'Received a pairing prompt? Paste the 8-character code or the full "openclaw pairing approve ..." line here.')}
        </p>
        <div className="flex gap-2">
          <input
            value={pairingCode}
            onChange={(e) => {
              const incoming = e.target.value;
              const detected = extractPairingCodeFromText(incoming);
              setPairingCode(detected || incoming);
            }}
            placeholder={t('channels.pairing.placeholder', 'Paste code or full approve line')}
            className="flex-1 px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm focus:outline-none focus:border-brand-500"
          />
          <button
            onClick={handleApprovePairing}
            disabled={pairingApproving || !pairingCode.trim()}
            className="px-3 py-2 bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-lg text-xs font-medium text-white"
          >
            {pairingApproving ? <Loader2 size={12} className="animate-spin" /> : t('channels.pairing.approveBtn', 'Approve')}
          </button>
        </div>
        {pairingNotice && (
          <p className="text-[11px] text-emerald-400 bg-emerald-900/20 rounded px-2 py-1">{pairingNotice}</p>
        )}
        {pairingError && (
          <p className="text-[11px] text-red-400 bg-red-900/20 rounded px-2 py-1">{pairingError}</p>
        )}
      </div>
    );
  };

  // --- Guide content —  rich guides for known channels, generic for dynamic ---

  const oneClickGuide = (steps: (string | React.ReactNode)[]) => (
    <div className="space-y-2 text-sm">
      {steps.map((step, i) => (
        <div key={i} className="flex items-start gap-3 p-3 bg-slate-800/50 rounded-lg">
          <span className="text-brand-400 font-bold">{i + 1}</span>
          <p>{step}</p>
        </div>
      ))}
    </div>
  );

  const getGuide = () => {
    if (!activeWizard || !activeChannel) return null;

    // Rich guides for known channels (preserved from original)
    switch (activeWizard) {
      case 'whatsapp':
        return oneClickGuide([
          t('channels.guide.oneclick.gateway', 'Make sure Gateway is running (Settings page)'),
          t('channels.guide.oneclick.click', 'Click "Connect" below — everything is automatic'),
          t('channels.guide.whatsapp.scan', 'Open WhatsApp on your phone → Settings → Linked Devices → Scan the QR code'),
        ]);
      case 'wechat':
        return oneClickGuide([
          t('channels.guide.oneclick.gateway', 'Make sure Gateway is running (Settings page)'),
          t('channels.guide.oneclick.click', 'Click "Connect" below — we\'ll install the plugin automatically'),
          t('channels.guide.wechat.scan', 'Open WeChat on your phone → Scan the QR code'),
        ]);
      case 'signal':
        return oneClickGuide([
          t('channels.guide.oneclick.gateway', 'Make sure Gateway is running (Settings page)'),
          t('channels.guide.oneclick.click', 'Click "Connect" — we\'ll set up Signal automatically'),
          t('channels.guide.signal.scan', 'Open Signal on your phone → Settings → Linked Devices → Scan QR code'),
        ]);
      case 'imessage':
        return (
          <div className="space-y-3 text-sm">
            <div className="p-3 bg-blue-600/10 border border-blue-600/20 rounded-lg text-xs text-blue-300">
              {t('channels.guide.imessage.macOnly', 'Only works on Mac. You may need to allow "Full Disk Access" in System Settings when prompted.')}
            </div>
            {oneClickGuide([
              t('channels.guide.oneclick.gateway', 'Make sure Gateway is running (Settings page)'),
              t('channels.guide.oneclick.click', 'Click "Connect" — we\'ll detect your Messages automatically'),
            ])}
          </div>
        );
      default: {
        // Generic guide: try i18n key, fallback to channel description + docs link
        const guideText = t(`channels.guide.${activeWizard}`, '') || activeChannel.description || t('channels.guide.default', 'Follow the steps below to connect this channel.');
        const docsSlug = activeChannel.docsSlug || activeChannel.openclawId;
        return (
          <div className="p-4 bg-slate-800/50 rounded-xl">
            <p className="text-sm text-slate-300">{guideText}</p>
            <button onClick={() => {
              void openExternal(`https://docs.openclaw.ai/channels/${docsSlug}`, `channel-guide-${docsSlug}`);
            }}
              disabled={isOpening(`channel-guide-${docsSlug}`)}
              className="mt-3 flex items-center gap-1.5 text-sm text-brand-400 hover:text-brand-300">
              {isOpening(`channel-guide-${docsSlug}`) ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />} {t('channels.viewTutorial')}
            </button>
          </div>
        );
      }
    }
  };

  // --- Config form — now fully driven by registry ---
  const getTokenForm = () => {
    if (!activeChannel || activeChannel.configFields.length === 0) return null;
    return (
      <DynamicConfigForm
        fields={activeChannel.configFields}
        values={formValues}
        onChange={(key, val) => setFormValues(prev => ({ ...prev, [key]: val }))}
        t={t}
      />
    );
  };

  // Channel display helpers
  const getChannelLabel = (ch: ChannelDef) => t(`channels.channel.${ch.id}`, ch.label);
  const getChannelDesc = (ch: ChannelDef) => t(`channels.channel.${ch.id}.desc`, ch.description || '');

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-slate-800">
        <h1 className="text-lg font-semibold inline-flex items-center gap-2">
          <Radio size={18} className="text-sky-300" />
          {t('channels.title')}
        </h1>
        <p className="text-xs text-slate-500">{t('channels.subtitleConnected')}</p>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {loadingChannels && (
          <div className="flex items-center gap-2 mb-4 p-3 bg-slate-800/30 rounded-lg text-xs text-slate-400">
            <Loader2 size={12} className="animate-spin" />
            {t('channels.loading', 'Loading channel status...')}
          </div>
        )}

        {/* Connected */}
        <div className="mb-6">
          <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">{t('channels.connected')}</h3>
          <div className="grid grid-cols-2 gap-3">
            {channels.filter((c) => c.id === 'local' || configuredChannels.has(c.id)).map((ch) => (
              <div key={ch.id} className={`p-4 bg-emerald-600/10 border border-emerald-600/30 rounded-xl text-left ${ch.id !== 'local' ? 'hover:border-emerald-500/50' : ''} transition-colors`}>
                <div className="flex items-center gap-3">
                  <button onClick={() => ch.id !== 'local' && openWizard(ch.id)} disabled={ch.id === 'local'}
                    className="flex items-center gap-3 flex-1 min-w-0 text-left">
                    <ChannelIcon channelId={ch.id} size={28} />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm">{getChannelLabel(ch)}</div>
                      <div className="text-xs text-emerald-400 inline-flex items-center gap-1.5">
                        <CheckCircle2 size={12} />
                        {ch.id === 'local' ? t('channels.builtIn') : t('channels.configured')}
                      </div>
                    </div>
                  </button>
                  {ch.id !== 'local' && (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => openWizard(ch.id)} className="p-1 text-slate-600 hover:text-slate-300 transition-colors" title={t('channels.editingBadge', 'Edit')}>
                        <ChevronRight size={14} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmRemove(ch.id); }}
                        disabled={removingChannel === ch.id}
                        className="p-1 text-slate-600 hover:text-red-400 transition-colors"
                        title={t('channels.disconnect', 'Disconnect')}
                      >
                        {removingChannel === ch.id ? <Loader2 size={14} className="animate-spin" /> : <Unplug size={14} />}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Available */}
        <div>
          <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">{t('channels.available')}</h3>
          <div className="grid grid-cols-2 gap-3">
            {channels.filter((c) => c.id !== 'local' && !configuredChannels.has(c.id)).map((ch) => (
              <button key={ch.id} onClick={() => openWizard(ch.id)}
                className="p-4 bg-slate-800/50 border border-slate-700 rounded-xl hover:border-slate-600 transition-colors text-left group">
                <div className="flex items-center gap-3">
                  <ChannelIcon channelId={ch.id} size={28} />
                  <div className="flex-1">
                    <div className="font-medium text-sm">{getChannelLabel(ch)}</div>
                    <div className="text-xs text-slate-500">{getChannelDesc(ch)}</div>
                  </div>
                  <ChevronRight size={16} className="text-slate-600 group-hover:text-slate-400 transition-colors" />
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Confirm Remove Modal */}
      {confirmRemove && (() => {
        const ch = getChannel(confirmRemove);
        return (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-8">
            <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-sm p-6 space-y-4">
              <div className="flex items-center gap-3">
                {ch && <ChannelIcon channelId={confirmRemove} size={24} />}
                <h3 className="text-base font-semibold">{t('channels.confirmRemoveTitle', 'Disconnect Channel')}</h3>
              </div>
              <p className="text-sm text-slate-400">
                {t('channels.confirmRemoveMsg', 'This will remove the channel configuration and unbind it from all agents. You can reconnect later.')}
              </p>
              <div className="flex justify-end gap-3">
                <button onClick={() => setConfirmRemove(null)}
                  className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors">
                  {t('channels.cancel', 'Cancel')}
                </button>
                <button onClick={() => handleRemove(confirmRemove)}
                  className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium transition-colors">
                  {t('channels.disconnect', 'Disconnect')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Wizard Modal */}
      {activeWizard && activeChannel && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-8">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-slate-800">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <ChannelIcon channelId={activeWizard} size={24} />
                {t('channels.connectPrefix')} {getChannelLabel(activeChannel)}
                {configuredChannels.has(activeWizard) && (
                  <span className="text-xs font-normal px-2 py-0.5 bg-amber-600/20 border border-amber-600/30 text-amber-400 rounded-full">
                    <span className="inline-flex items-center gap-1">
                      <Pencil size={11} />
                      {t('channels.editingBadge', 'Editing')}
                    </span>
                  </span>
                )}
              </h2>
              <button
                onClick={closeWizard}
                aria-label={t('common.close', 'Close')}
                className="text-slate-500 hover:text-slate-300"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-5 space-y-5">
              {/* Step 1: Guide */}
              {wizardStep === 'intro' && (
                <>
                  {getGuide()}

                  {configuredChannels.has(activeWizard) && (
                    <div className="p-3 bg-amber-600/10 border border-amber-600/20 rounded-lg text-xs text-amber-400">
                      {t('channels.alreadyConfigured', 'Already connected. You can reconnect or update credentials.')}
                    </div>
                  )}

                  {supportsPairingApproval && configuredChannels.has(activeWizard) && renderPairingApprovalPanel()}

                  <div className="flex justify-end">
                    <button
                      onClick={() => {
                        if (isOneClick) { handleConnect(); setWizardStep('test'); }
                        else { setWizardStep('token'); }
                      }}
                      className="px-5 py-2.5 bg-brand-600 hover:bg-brand-500 text-white rounded-xl text-sm font-medium transition-colors flex items-center gap-1.5"
                    >
                      {isOneClick
                        ? t('channels.connectBtn', 'Connect')
                        : <>{t('channels.next')} <ChevronRight size={14} /></>}
                    </button>
                  </div>
                </>
              )}

              {/* Step 2: Credentials */}
              {wizardStep === 'token' && (
                <>
                  {lastError && (
                    <div className="p-3 bg-red-900/20 border border-red-600/30 rounded-lg text-xs text-red-400 break-words">
                      <span className="font-medium">{t('channels.lastErrorPrefix', 'Last attempt failed:')}</span>{' '}
                      {lastError}
                      {!lastError.trim() || lastError === t('channels.setupFailed', 'Setup failed. Check Gateway in Settings.') ? null : (
                        <span className="block mt-1 text-red-400/70">{t('channels.checkGatewayHint', 'If the issue persists, check Gateway in Settings.')}</span>
                      )}
                    </div>
                  )}
                  {getTokenForm()}
                  {renderPairingApprovalPanel()}
                  <div className="flex justify-between">
                    <button onClick={() => setWizardStep('intro')} className="px-4 py-2 text-slate-400 hover:text-slate-200 flex items-center gap-1 text-sm">
                      <ChevronLeft size={14} /> {t('channels.back')}
                    </button>
                    <button onClick={() => { handleConnect(); setWizardStep('test'); }}
                      disabled={!isFormValid()}
                      className="px-5 py-2.5 bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700 text-white rounded-xl text-sm font-medium transition-colors">
                      {t('channels.connectBtn', 'Connect')}
                    </button>
                  </div>
                </>
              )}

              {/* Step 3: Result */}
              {wizardStep === 'test' && (
                <>
                  <div className={asciiQR ? 'py-2' : 'text-center py-6'}>
                    {testStatus === 'testing' && (
                      <div>
                        {asciiQR ? (
                          <div className="space-y-3">
                            <p className="text-sm text-slate-300 text-center font-medium">
                              {activeWizard === 'whatsapp'
                                ? t('channels.whatsapp.scanHint', 'Open WhatsApp → Linked Devices → Link a Device')
                                : activeWizard === 'wechat'
                                  ? t('channels.guide.wechat.scan', 'Scan QR with WeChat to link')
                                  : t('channels.signal.scanHint', 'Open Signal → Settings → Linked Devices → Link New Device')}
                            </p>
                            <div className="flex justify-center bg-white rounded-xl p-3">
                              <pre className="text-black text-[10px] leading-none font-mono whitespace-pre select-text">{asciiQR}</pre>
                            </div>
                            <p className="text-xs text-slate-500 text-center">{t('channels.qr.waiting', 'Waiting for scan...')}</p>
                          </div>
                        ) : (
                          <div className="text-center space-y-4">
                            <div className="w-10 h-10 mx-auto border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                            <div className="space-y-2">
                              <p className="text-slate-300">{t('channels.testing')}</p>
                              {isOneClick && (
                                <p className="text-xs text-slate-500 animate-pulse">{channelProgress ? translateStatus(channelProgress) : t('channels.oneclick.wait', 'Initializing...')}</p>
                              )}
                              {isOneClick && !asciiQR && (
                                <p className="text-[11px] text-slate-600 mt-3">
                                  {t('channels.oneclick.patience', 'First time may take 15-20s to load')}
                                </p>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {testStatus === 'success' && (
                      <div className="space-y-3">
                        <div className="w-16 h-16 mx-auto bg-emerald-600/20 rounded-full flex items-center justify-center">
                          <Check size={32} className="text-emerald-400" />
                        </div>
                        <p className="text-emerald-300 font-medium">{t('channels.success')}</p>
                        {testNotice && (
                          <p className="text-xs text-slate-400 bg-slate-800/60 rounded-lg px-3 py-2 max-w-sm mx-auto">
                            {testNotice}
                          </p>
                        )}
                      </div>
                    )}
                    {testStatus === 'error' && (
                      <div className="space-y-3">
                        <p className="text-red-400">
                          {isTimeoutLike(testError)
                            ? t('channels.failedTimeoutTitle', 'Connection timed out while OpenClaw was still loading')
                            : t('channels.failed')}
                        </p>
                        {isTimeoutLike(testError) && (
                          <p className="text-xs text-amber-400/80 bg-amber-900/20 rounded-lg px-3 py-2 text-left break-words">
                            {getTimeoutHint()}
                          </p>
                        )}
                        {testError && (
                          <p className="text-xs text-red-400/70 bg-red-900/20 rounded-lg px-3 py-2 text-left break-words max-h-24 overflow-y-auto">
                            {testError}
                          </p>
                        )}
                        {renderPairingApprovalPanel()}
                        <button onClick={() => {
                          if (!isOneClick && testError) setLastError(testError);
                          setTestError(null);
                          setWizardStep(isOneClick ? 'intro' : 'token');
                        }}
                          className="text-sm text-brand-400 hover:text-brand-300">
                          {t('channels.tryAgain', 'Try again')}
                        </button>
                      </div>
                    )}
                  </div>
                  {testStatus === 'success' && (
                    <div className="flex justify-end gap-2">
                      <button onClick={closeWizard}
                        className="px-5 py-2 border border-slate-600 hover:border-slate-400 text-slate-300 hover:text-white rounded-xl text-sm font-medium transition-colors">
                        {t('channels.done')}
                      </button>
                      <button onClick={() => { closeWizard(); onNavigate?.('chat'); }}
                        className="px-5 py-2 bg-brand-600 hover:bg-brand-500 text-white rounded-xl text-sm font-medium transition-colors inline-flex items-center gap-1.5">
                        <MessageSquare size={14} />
                        {t('channels.openChat', 'Open Chat')}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
