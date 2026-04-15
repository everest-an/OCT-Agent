import { useEffect, useRef, useState } from 'react';
import { Brain, CheckCircle, ChevronLeft, ChevronRight, Cloud, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

interface CloudMemory {
  id: string;
  name: string;
  card_count?: number;
}

type AuthPhase = 'starting' | 'pending' | 'selecting' | 'done' | 'error' | 'timeout';

interface CloudAuthStepProps {
  onNext: (result: { email?: string; memoryId?: string; memoryName?: string } | null) => void;
  onCancel: () => void;  // user chose to skip cloud — back to local mode
}

export default function CloudAuthStep({ onNext, onCancel }: CloudAuthStepProps) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<AuthPhase>('starting');
  const [userCode, setUserCode] = useState('');
  const [verifyLink, setVerifyLink] = useState('');
  const [deviceCode, setDeviceCode] = useState('');
  const [pollInterval, setPollInterval] = useState(5);
  const [countdown, setCountdown] = useState(300); // 5 min
  const [memories, setMemories] = useState<CloudMemory[]>([]);
  const [selectedMemoryId, setSelectedMemoryId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const cancelledRef = useRef(false);

  // Countdown timer
  useEffect(() => {
    if (phase !== 'pending') return;
    if (countdown <= 0) { setPhase('timeout'); return; }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, countdown]);

  const formatTime = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

  const startAuth = async () => {
    const api = window.electronAPI as any;
    if (!api) { setPhase('error'); setErrorMsg('Electron API not available'); return; }
    setPhase('starting');
    cancelledRef.current = false;
    try {
      const result = await api.invoke?.('cloud:auth-start') ?? await (api as any)['cloud:auth-start']?.();
      if (!result?.success) throw new Error(result?.error || 'Start failed');
      const {
        user_code,
        verification_uri,
        verification_url,
        device_code: dc,
        interval: intv,
      } = result;
      setUserCode(user_code || '');
      setDeviceCode(dc || '');
      setPollInterval(intv || 5);
      setCountdown(300);

      // Protocol whitelist — XSS guard (prevents javascript: URL; see F-040 security fix)
      const uiReadyUrl = verification_url || (user_code ? `${verification_uri}?code=${encodeURIComponent(user_code)}` : verification_uri);
      const safeUri = /^https?:\/\//i.test(String(uiReadyUrl || ''))
        ? String(uiReadyUrl)
        : 'about:blank';
      setVerifyLink(safeUri);
      setPhase('pending');

      // Open browser automatically
      if (!result.is_headless) {
        try { await api.invoke?.('shell:openExternal', safeUri); } catch { /* ignore */ }
      }

      // Poll loop
      pollForAuth(dc || '', intv || 5);
    } catch (err: any) {
      if (!cancelledRef.current) {
        setPhase('error');
        setErrorMsg(err.message || 'Failed to start authentication');
      }
    }
  };

  const pollForAuth = async (dc: string, intv: number) => {
    const api = window.electronAPI as any;
    let remaining = 300;
    while (remaining > 0 && !cancelledRef.current) {
      await new Promise((r) => setTimeout(r, intv * 1000));
      remaining -= intv;
      if (cancelledRef.current) return;
      try {
        const result = await api.invoke?.('cloud:auth-poll', dc) ?? await (api as any)['cloud:auth-poll']?.(dc);
        if (!result) continue;
        if (result.api_key) {
          setApiKey(result.api_key);
          try {
            const profile = await api.invoke?.('cloud:get-profile', result.api_key)
              ?? await (api as any)['cloud:get-profile']?.(result.api_key);
            if (profile?.success && profile?.email) setUserEmail(profile.email);
          } catch { /* non-fatal */ }
          // Fetch memory list
          const memResult = await api.invoke?.('cloud:list-memories', result.api_key)
            ?? await (api as any)['cloud:list-memories']?.(result.api_key);
          const mems: CloudMemory[] = memResult?.memories || [];
          setMemories(mems);
          if (mems.length > 0) setSelectedMemoryId(mems[0].id);
          setPhase('selecting');
          return;
        }
        if (result.error === 'Auth expired') { setPhase('timeout'); return; }
      } catch { /* continue polling */ }
    }
    if (!cancelledRef.current) setPhase('timeout');
  };

  const handleConfirm = async () => {
    if (!selectedMemoryId || !apiKey) return;
    const api = window.electronAPI as any;
    try {
      let emailForSummary = userEmail;
      if (!emailForSummary) {
        try {
          const profile = await api.invoke?.('cloud:get-profile', apiKey)
            ?? await (api as any)['cloud:get-profile']?.(apiKey);
          if (profile?.success && profile?.email) {
            emailForSummary = profile.email;
            setUserEmail(profile.email);
          }
        } catch { /* non-fatal */ }
      }
      const connectResult = await api.invoke?.('cloud:connect', apiKey, selectedMemoryId)
        ?? await (api as any)['cloud:connect']?.(apiKey, selectedMemoryId);
      if (!connectResult?.success) {
        throw new Error(connectResult?.error || 'Failed to connect');
      }
      const selectedMem = memories.find((m) => m.id === selectedMemoryId);
      onNext({ email: emailForSummary, memoryId: selectedMemoryId, memoryName: selectedMem?.name });
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to connect');
      setPhase('error');
    }
  };

  const handleCancel = () => {
    cancelledRef.current = true;
    onCancel();
  };

  const handleReopenBrowser = async () => {
    if (!verifyLink) return;
    const api = window.electronAPI as any;
    try { await api.invoke?.('shell:openExternal', verifyLink); } catch { /* ignore */ }
  };

  // Auto-start on mount
  useEffect(() => { startAuth(); return () => { cancelledRef.current = true; }; }, []);

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-sky-600/15 text-sky-300 mb-3">
          <Cloud size={24} />
        </div>
        <h2 className="text-2xl font-bold mb-2">
          {t('setup.cloudauth.title', 'Connect your Awareness cloud account')}
        </h2>
        <p className="text-slate-400 text-sm">
          {t('setup.cloudauth.body', 'Sign in once on your browser — this desktop will be authorized via device code (just like GitHub CLI).')}
        </p>
      </div>

      {/* Starting / Loading */}
      {(phase === 'starting') && (
        <div className="flex flex-col items-center gap-3 py-8">
          <Loader2 size={28} className="animate-spin text-brand-400" />
          <p className="text-sm text-slate-400">Initializing…</p>
        </div>
      )}

      {/* Pending — waiting for user to authorize */}
      {phase === 'pending' && (
        <div className="space-y-4">
          <p className="text-sm text-slate-400">
            {t('setup.cloudauth.no_account', 'No account? The page will prompt you to sign up.')}
          </p>

          {/* Device code */}
          <div className="text-center">
            <p className="text-xs text-slate-500 mb-2">
              {t('setup.cloudauth.enter_code', 'Enter this code on the web page:')}
            </p>
            <div className="inline-block px-8 py-3 bg-slate-800 border border-slate-600 rounded-xl">
              <span className="text-2xl font-mono font-bold text-brand-400 tracking-widest">{userCode}</span>
            </div>
          </div>

          {/* Open browser button */}
          <button
            onClick={handleReopenBrowser}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-brand-600 hover:bg-brand-500 text-white rounded-xl text-sm font-medium transition-colors"
          >
            <ExternalLink size={14} />
            {t('setup.cloudauth.reopen', 'Reopen browser')}
          </button>

          {/* Countdown */}
          <div className="flex items-center justify-center gap-2 text-xs text-slate-500">
            <Loader2 size={12} className="animate-spin" />
            {t('setup.cloudauth.waiting', 'Waiting for authorization (expires in {time})').replace('{time}', formatTime(countdown))}
          </div>

          {/* Cancel */}
          <div className="text-center">
            <button onClick={handleCancel} className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
              {t('setup.cloudauth.cancel', 'Cancel — use Local only')}
            </button>
          </div>
        </div>
      )}

      {/* Timeout — show retry */}
      {phase === 'timeout' && (
        <div className="space-y-4 text-center">
          <p className="text-sm text-amber-400">Authorization timed out.</p>
          <button
            onClick={startAuth}
            className="flex items-center gap-1.5 mx-auto px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg text-sm"
          >
            <RefreshCw size={14} />
            {t('setup.cloudauth.retry', 'Retry')}
          </button>
          <button onClick={handleCancel} className="block mx-auto text-xs text-slate-500 hover:text-slate-300">
            {t('setup.cloudauth.cancel', 'Cancel — use Local only')}
          </button>
        </div>
      )}

      {/* Error */}
      {phase === 'error' && (
        <div className="space-y-4 text-center">
          <p className="text-sm text-red-400">{errorMsg || 'Authentication failed'}</p>
          <button
            onClick={startAuth}
            className="flex items-center gap-1.5 mx-auto px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg text-sm"
          >
            <RefreshCw size={14} />
            {t('setup.cloudauth.retry', 'Retry')}
          </button>
          <button onClick={handleCancel} className="block mx-auto text-xs text-slate-500 hover:text-slate-300">
            {t('setup.cloudauth.cancel', 'Cancel — use Local only')}
          </button>
        </div>
      )}

      {/* Memory selection */}
      {phase === 'selecting' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-emerald-400">
            <CheckCircle size={16} />
            <span className="text-sm font-medium">Authorized successfully</span>
          </div>
          <p className="text-sm text-slate-400">
            {t('setup.cloudauth.select_title', 'Pick a cloud memory to sync into this desktop:')}
          </p>
          <div className="space-y-2">
            {memories.map((m) => (
              <button
                key={m.id}
                onClick={() => setSelectedMemoryId(m.id)}
                className={`w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all border ${
                  selectedMemoryId === m.id
                    ? 'border-brand-500 bg-brand-600/10'
                    : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
                }`}
              >
                <Brain size={16} className="text-brand-400 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium">{m.name || m.id}</p>
                  {m.card_count !== undefined && (
                    <p className="text-xs text-slate-500">{m.card_count.toLocaleString()} cards</p>
                  )}
                </div>
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            {t('setup.cloudauth.sync_hint', 'First full sync may take a few minutes for large memories.')}
          </p>

          <div className="flex justify-between">
            <button onClick={handleCancel} className="px-4 py-2 text-slate-400 hover:text-slate-200 flex items-center gap-1">
              <ChevronLeft size={16} />
              {t('setup.cloudauth.cancel_cloud', 'Cancel cloud, use Local')}
            </button>
            <button
              onClick={handleConfirm}
              disabled={!selectedMemoryId}
              className="px-6 py-2.5 bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-xl font-medium transition-colors flex items-center gap-2"
            >
              {t('setup.cloudauth.confirm', 'Confirm & sync')}
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
