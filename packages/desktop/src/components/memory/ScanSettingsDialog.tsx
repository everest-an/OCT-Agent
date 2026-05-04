import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Save, RotateCcw, X } from 'lucide-react';
import type { TranslateFunc } from '../../lib/i18n';
import { DAEMON_API_BASE } from './wiki-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanConfig {
  enabled: boolean;
  watch_enabled: boolean;
  scan_code: boolean;
  scan_docs: boolean;
  scan_config: boolean;
  scan_convertible: boolean;
  max_file_size_kb: number;
  max_total_files: number;
  max_depth: number;
  exclude: string[];
}

const DEFAULT_CONFIG: Readonly<ScanConfig> = Object.freeze({
  enabled: true,
  watch_enabled: true,
  scan_code: true,
  scan_docs: true,
  scan_config: false,
  scan_convertible: true,
  max_file_size_kb: 500,
  max_total_files: 10000,
  max_depth: 15,
  exclude: [],
});

export interface ScanSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  workspacePath?: string | null;
  t: TranslateFunc;
  /** Optional override for unit tests to avoid real network. */
  fetchImpl?: typeof fetch;
  /** Called after a successful save. */
  onSaved?: (config: ScanConfig, rescanTriggered: boolean) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mergeConfig(partial: Partial<ScanConfig> | null | undefined): ScanConfig {
  if (!partial) return { ...DEFAULT_CONFIG };
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    exclude: Array.isArray(partial.exclude) ? [...partial.exclude] : [],
  };
}

function excludeToText(list: readonly string[]): string {
  return list.join('\n');
}

function textToExclude(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface FieldErrors {
  max_file_size_kb?: string;
  max_total_files?: string;
  max_depth?: string;
}

function validate(config: ScanConfig, t: TranslateFunc): FieldErrors {
  const errs: FieldErrors = {};
  if (config.max_file_size_kb < 10 || config.max_file_size_kb > 10000) {
    errs.max_file_size_kb = t('scanSettings.err.fileSize');
  }
  if (config.max_total_files < 100) {
    errs.max_total_files = t('scanSettings.err.totalFiles');
  }
  if (config.max_depth < 1 || config.max_depth > 50) {
    errs.max_depth = t('scanSettings.err.depth');
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScanSettingsDialog({
  open, onClose, workspacePath, t,
  fetchImpl, onSaved,
}: ScanSettingsDialogProps) {
  const doFetch = fetchImpl ?? fetch;
  const [config, setConfig] = useState<ScanConfig>(DEFAULT_CONFIG);
  const [excludeText, setExcludeText] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  // Load config when opened
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const res = await doFetch(`${DAEMON_API_BASE}/scan/config`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as Partial<ScanConfig>;
        if (cancelled) return;
        const merged = mergeConfig(data);
        setConfig(merged);
        setExcludeText(excludeToText(merged.exclude));
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setConfig({ ...DEFAULT_CONFIG });
        setExcludeText('');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, doFetch]);

  const errors = useMemo(() => validate(config, t), [config, t]);
  const hasErrors = Object.keys(errors).length > 0;

  const handleReset = useCallback(() => {
    setConfig({ ...DEFAULT_CONFIG });
    setExcludeText(excludeToText(DEFAULT_CONFIG.exclude));
    setSaveError(null);
  }, []);

  const handleSave = useCallback(async (triggerRescan: boolean) => {
    if (hasErrors) return;
    setSaving(true);
    setSaveError(null);
    const payload: ScanConfig = { ...config, exclude: textToExclude(excludeText) };
    try {
      const res = await doFetch(`${DAEMON_API_BASE}/scan/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const saved = await res.json() as Partial<ScanConfig>;
      const merged = mergeConfig(saved);
      if (triggerRescan) {
        // Fire-and-forget. Config changes may invalidate prior index.
        void doFetch(`${DAEMON_API_BASE}/scan/trigger`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'full' }),
        }).catch(() => undefined);
      }
      onSaved?.(merged, triggerRescan);
      if (mountedRef.current) {
        setConfig(merged);
        setExcludeText(excludeToText(merged.exclude));
        onClose();
      }
    } catch (err) {
      if (mountedRef.current) {
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [config, excludeText, doFetch, hasErrors, onClose, onSaved]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="scan-settings-title"
      className="fixed inset-0 z-[60] overflow-y-auto bg-black/60"
    >
      <div
        className="flex min-h-full items-center justify-center p-4"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
      <div className="flex w-full max-w-xl max-h-[calc(100dvh-2rem)] flex-col overflow-hidden bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl">
        <header className="flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-800">
          <div className="min-w-0">
            <h2 id="scan-settings-title" className="text-base font-semibold text-slate-100">
              {t('scanSettings.title')}
            </h2>
            {workspacePath && (
              <p className="mt-0.5 text-xs text-slate-500 truncate" title={workspacePath}>
                {workspacePath}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1 text-slate-500 hover:text-slate-200 transition-colors"
          >
            <X size={18} />
          </button>
        </header>

        {loading ? (
          <div className="flex flex-1 items-center justify-center py-16 text-slate-500">
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            {loadError && (
              <p className="text-xs text-amber-400" role="alert">
                {t('scanSettings.loadError')}: {loadError}
              </p>
            )}

            {/* General */}
            <Section title={t('scanSettings.general')}>
              <Checkbox
                label={t('scanSettings.enable')}
                checked={config.enabled}
                onChange={(v) => setConfig({ ...config, enabled: v })}
              />
              <Checkbox
                label={t('scanSettings.watch')}
                checked={config.watch_enabled}
                onChange={(v) => setConfig({ ...config, watch_enabled: v })}
              />
            </Section>

            {/* What to scan */}
            <Section title={t('scanSettings.whatToScan')}>
              <Checkbox
                label={t('scanSettings.scanCode')}
                hint=".ts .py .go .rs .java …"
                checked={config.scan_code}
                onChange={(v) => setConfig({ ...config, scan_code: v })}
              />
              <Checkbox
                label={t('scanSettings.scanDocs')}
                hint=".md .mdx .txt .rst"
                checked={config.scan_docs}
                onChange={(v) => setConfig({ ...config, scan_docs: v })}
              />
              <Checkbox
                label={t('scanSettings.scanConvertible')}
                hint=".pdf .docx"
                checked={config.scan_convertible}
                onChange={(v) => setConfig({ ...config, scan_convertible: v })}
              />
              <Checkbox
                label={t('scanSettings.scanConfig')}
                hint=".json .yaml .toml"
                checked={config.scan_config}
                onChange={(v) => setConfig({ ...config, scan_config: v })}
              />
            </Section>

            {/* Limits */}
            <Section title={t('scanSettings.limits')}>
              <NumberInput
                label={t('scanSettings.maxFileSize')}
                value={config.max_file_size_kb}
                onChange={(n) => setConfig({ ...config, max_file_size_kb: n })}
                error={errors.max_file_size_kb}
              />
              <NumberInput
                label={t('scanSettings.maxTotal')}
                value={config.max_total_files}
                onChange={(n) => setConfig({ ...config, max_total_files: n })}
                error={errors.max_total_files}
              />
              <NumberInput
                label={t('scanSettings.maxDepth')}
                value={config.max_depth}
                onChange={(n) => setConfig({ ...config, max_depth: n })}
                error={errors.max_depth}
              />
            </Section>

            {/* Exclude */}
            <Section title={t('scanSettings.exclude')}>
              <textarea
                aria-label={t('scanSettings.exclude')}
                value={excludeText}
                onChange={(e) => setExcludeText(e.target.value)}
                rows={5}
                placeholder={'vendor/\n*.generated.ts\nbuild/'}
                className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500/50"
              />
              <p className="mt-1.5 text-[11px] text-slate-500">
                {t('scanSettings.excludeHint')}
              </p>
            </Section>

            {saveError && (
              <p className="text-xs text-red-400" role="alert">
                {t('scanSettings.saveError')}: {saveError}
              </p>
            )}
          </div>
        )}

        <footer className="flex items-center justify-between gap-2 px-5 py-3 border-t border-slate-800 bg-slate-950/40">
          <button
            onClick={handleReset}
            disabled={loading || saving}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-slate-400 hover:text-slate-200 disabled:opacity-40 transition-colors"
          >
            <RotateCcw size={12} /> {t('scanSettings.reset')}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 text-xs text-slate-300 hover:text-slate-100 disabled:opacity-40 transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={() => handleSave(false)}
              disabled={loading || saving || hasErrors}
              className="px-3 py-1.5 text-xs text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg disabled:opacity-40 transition-colors"
            >
              {t('scanSettings.saveOnly')}
            </button>
            <button
              onClick={() => handleSave(true)}
              disabled={loading || saving || hasErrors}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-brand-500 hover:bg-brand-400 rounded-lg disabled:opacity-40 transition-colors"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              {t('scanSettings.saveRescan')}
            </button>
          </div>
        </footer>
      </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny subcomponents
// ---------------------------------------------------------------------------

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-[11px] uppercase tracking-wider text-slate-500 mb-1.5">{title}</legend>
      <div className="space-y-1.5">{children}</div>
    </fieldset>
  );
}

interface CheckboxProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

function Checkbox({ label, hint, checked, onChange }: CheckboxProps) {
  return (
    <label className="flex items-center gap-2.5 cursor-pointer text-sm text-slate-300 hover:text-slate-100">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-brand-500 focus:ring-1 focus:ring-brand-500"
      />
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[11px] text-slate-600 font-mono">{hint}</span>}
    </label>
  );
}

interface NumberInputProps {
  label: string;
  value: number;
  onChange: (n: number) => void;
  error?: string;
}

function NumberInput({ label, value, onChange, error }: NumberInputProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label className="text-sm text-slate-300 flex-1">{label}</label>
      <div className="flex flex-col items-end">
        <input
          type="number"
          aria-label={label}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange(Number.isFinite(n) ? n : 0);
          }}
          className={`w-28 rounded-lg border bg-slate-950/60 px-2.5 py-1 text-xs text-right text-slate-200 focus:outline-none focus:ring-1 ${
            error
              ? 'border-red-500/60 focus:ring-red-500/50'
              : 'border-slate-700 focus:ring-brand-500/50'
          }`}
        />
        {error && <span className="mt-0.5 text-[10px] text-red-400" role="alert">{error}</span>}
      </div>
    </div>
  );
}
