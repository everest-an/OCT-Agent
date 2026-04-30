/**
 * ShareAgentForm — modal for submitting a locally-created agent to the
 * marketplace review queue (F-063).
 *
 * 0.4.4 changes:
 *   - Category is now a proper <select> populated from the 20 real catalog
 *     categories (previously a free-form text input — users couldn't pick
 *     the right bucket)
 *   - All UI strings threaded through useI18n() — no hardcoded Chinese
 *   - Escape key closes the modal, backdrop click is disabled during submit
 *     so a misclick can't cancel a 10s in-flight submission
 *   - Errors highlight the offending field instead of only showing a
 *     generic message at the bottom
 */

import { useState, useEffect, useMemo } from 'react';
import { Loader2, X } from 'lucide-react';

import { useI18n } from '../lib/i18n';

type Tier = 'consumer' | 'prosumer' | 'engineering';

interface StructuredFields {
  soul_md?: string;
  agents_md?: string;
  vibe?: string;
  memory_md?: string;
  user_md?: string;
  heartbeat_md?: string;
  boot_md?: string;
  bootstrap_md?: string;
}

interface ComposedAgent {
  markdown: string;
  description: string;
  tools: string[];
  name: string;
  emoji?: string;
  files: string[];
  structured: StructuredFields;
}

interface Props {
  /** Local agent id (from openclaw.json agents.list[].id) to pre-select. */
  preselectedAgentId: string;
  onClose: () => void;
  onSubmitted?: () => void;
}

// Must match backend `_ALLOWED_CATEGORIES` and the keys under
// sdks/.../marketplace-agents/sources. Keep alphabetical — the select order
// matters for usability. 'community' + 'other' are end-user fallbacks when
// nothing fits.
const CATEGORY_OPTIONS = [
  'academic',
  'career',
  'community',
  'data',
  'design',
  'education',
  'engineering',
  'finance',
  'game-dev',
  'lifestyle',
  'marketing',
  'paid-media',
  'product',
  'productivity',
  'project-mgmt',
  'sales',
  'spatial',
  'specialized',
  'support',
  'wellness',
  'writing',
  'other',
] as const;

function yamlEscape(value: string): string {
  if (/[:#"\n]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

type FieldError = 'slug' | 'description' | null;

export default function ShareAgentForm({ preselectedAgentId, onClose, onSubmitted }: Props) {
  const { t } = useI18n();
  const [composed, setComposed] = useState<ComposedAgent | null>(null);
  const [loading, setLoading] = useState(true);
  const [slug, setSlug] = useState(preselectedAgentId);
  const [category, setCategory] = useState('community');
  const [tier, setTier] = useState<Tier>('consumer');
  const [descriptionOverride, setDescriptionOverride] = useState('');
  const [contact, setContact] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<FieldError>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  // Elapsed-seconds counter so users on slow prod (3-10s latency) see
  // progress instead of a blind spinner. Reset on every submit attempt.
  useEffect(() => {
    if (!submitting) {
      setElapsedSec(0);
      return;
    }
    const started = Date.now();
    const handle = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - started) / 1000));
    }, 500);
    return () => window.clearInterval(handle);
  }, [submitting]);

  // Escape key closes the modal (unless submitting, to avoid dropping an
  // in-flight request).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submitting, onClose]);

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.marketplaceComposeFromLocal) {
      setError(t('share.versionRequired'));
      setLoading(false);
      return;
    }
    api
      .marketplaceComposeFromLocal(preselectedAgentId)
      .then((res: any) => {
        if (res?.success) {
          setComposed({
            markdown: res.markdown,
            description: res.description,
            tools: res.tools || [],
            name: res.name,
            emoji: res.emoji,
            files: res.files || [],
            structured: res.structured || {},
          });
          setDescriptionOverride(res.description);
        } else {
          setError(res?.error || t('share.workspaceLoadFailed'));
        }
      })
      .catch((err: any) => setError(String(err?.message || err)))
      .finally(() => setLoading(false));
  }, [preselectedAgentId, t]);

  const composedHelp = useMemo(() => {
    if (!composed) return '';
    return t('share.composedFrom')
      .replace('{count}', String(composed.files.length))
      .replace('{slug}', preselectedAgentId);
  }, [composed, preselectedAgentId, t]);

  const handleSubmit = async () => {
    if (!composed) return;
    setError(null);
    setMessage(null);
    setFieldError(null);
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(slug)) {
      setError(t('share.slugInvalid'));
      setFieldError('slug');
      return;
    }
    if (!descriptionOverride.trim()) {
      setError(t('share.descriptionRequired'));
      setFieldError('description');
      return;
    }

    let finalMarkdown = composed.markdown;
    if (descriptionOverride.trim() !== composed.description) {
      finalMarkdown = composed.markdown.replace(
        /(\ndescription:\s*)("[^"]*"|'[^']*'|[^\n]+)(\n)/,
        (_m, p1, _old, p3) => `${p1}${yamlEscape(descriptionOverride.trim())}${p3}`
      );
    }

    setSubmitting(true);
    try {
      const api = (window as any).electronAPI;
      const res = await api.marketplaceSubmit({
        slug,
        name: composed.name,
        description: descriptionOverride.trim(),
        category,
        tier,
        emoji: composed.emoji || '🤖',
        markdown: finalMarkdown,
        author_contact: contact || undefined,
        soul_md: composed.structured.soul_md,
        agents_md: composed.structured.agents_md,
        vibe: composed.structured.vibe,
        memory_md: composed.structured.memory_md,
        user_md: composed.structured.user_md,
        heartbeat_md: composed.structured.heartbeat_md,
        boot_md: composed.structured.boot_md,
        bootstrap_md: composed.structured.bootstrap_md,
      });
      if (res?.success) {
        setMessage(t('share.submitted'));
        setTimeout(() => {
          onSubmitted?.();
          onClose();
        }, 1500);
      } else {
        // Prefer the friendly localized message matched to the error code;
        // fall back to the raw backend message so users can still diagnose.
        const code = res?.errorCode as
          | 'timeout'
          | 'network'
          | 'rate_limit'
          | 'validation'
          | 'unknown'
          | undefined;
        const friendly =
          code && code !== 'unknown' ? t(`share.error.${code}`) : null;
        setError(friendly || res?.error || t('share.submitFailed'));
      }
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setSubmitting(false);
    }
  };

  const slowHint = t('share.slowHint').replace('{elapsed}', String(elapsedSec));

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={submitting ? undefined : onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('share.title')}
    >
      <div
        className="bg-slate-900/80 backdrop-blur-3xl rounded-3xl shadow-[0_24px_48px_rgba(0,0,0,0.5)] max-w-2xl w-full max-h-[90vh] overflow-y-auto border border-white/[0.08]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-white/[0.08] flex items-center justify-between">
          <h2 className="font-semibold text-slate-100">
            🔗 {t('share.title')}
            {composed && <span className="ml-2 text-slate-400 font-normal">— {composed.name}</span>}
          </h2>
          <button
            onClick={onClose}
            disabled={submitting}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 disabled:opacity-40"
            aria-label={t('share.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading && (
          <div className="p-12 flex justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
          </div>
        )}

        {!loading && error && !composed && (
          <div className="p-6">
            <div className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded p-3">{error}</div>
            <button onClick={onClose} className="mt-4 px-4 py-2 text-sm rounded border border-slate-700 text-slate-200">
              {t('share.close')}
            </button>
          </div>
        )}

        {composed && (
          <div className="p-5 space-y-4">
            <p className="text-xs text-slate-500">
              {composedHelp}<br/>
              <span className="font-mono text-[11px]">{composed.files.join(' · ')}</span>
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <label className="block">
                <span className="text-xs text-slate-400">
                  {t('share.slugLabel')} <span className="text-red-400">*</span>
                </span>
                <input
                  className={`mt-1 w-full px-2 py-1.5 rounded border bg-slate-800 text-slate-100 ${
                    fieldError === 'slug'
                      ? 'border-red-500 focus:outline-red-500'
                      : 'border-slate-700'
                  }`}
                  value={slug}
                  onChange={(e) => {
                    setSlug(e.target.value);
                    if (fieldError === 'slug') setFieldError(null);
                  }}
                  pattern="^[a-z][a-z0-9-]{2,63}$"
                  aria-invalid={fieldError === 'slug' || undefined}
                />
                <span className="text-[10px] text-slate-600">{t('share.slugHelp')}</span>
              </label>
              <div className="flex items-center gap-2 md:pt-5">
                <span className="text-2xl">{composed.emoji || '🤖'}</span>
                <span className="text-sm text-slate-300">{composed.name}</span>
              </div>

              <label className="md:col-span-2 block">
                <span className="text-xs text-slate-400">
                  {t('share.descriptionLabel')} <span className="text-red-400">*</span>
                </span>
                <textarea
                  className={`mt-1 w-full px-2 py-1.5 rounded border bg-slate-800 text-slate-100 ${
                    fieldError === 'description'
                      ? 'border-red-500 focus:outline-red-500'
                      : 'border-slate-700'
                  }`}
                  value={descriptionOverride}
                  onChange={(e) => {
                    setDescriptionOverride(e.target.value);
                    if (fieldError === 'description') setFieldError(null);
                  }}
                  rows={3}
                  aria-invalid={fieldError === 'description' || undefined}
                />
              </label>

              <label className="block">
                <span className="text-xs text-slate-400">{t('share.categoryLabel')}</span>
                <select
                  className="mt-1 w-full px-2 py-1.5 rounded border border-slate-700 bg-slate-800 text-slate-100"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  {CATEGORY_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {t(`share.category.${c}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-slate-400">{t('share.tierLabel')}</span>
                <select
                  className="mt-1 w-full px-2 py-1.5 rounded border border-slate-700 bg-slate-800 text-slate-100"
                  value={tier}
                  onChange={(e) => setTier(e.target.value as Tier)}
                >
                  <option value="consumer">{t('share.tier.consumer')}</option>
                  <option value="prosumer">{t('share.tier.prosumer')}</option>
                  <option value="engineering">{t('share.tier.engineering')}</option>
                </select>
              </label>

              <label className="md:col-span-2 block">
                <span className="text-xs text-slate-400">{t('share.contactLabel')}</span>
                <input
                  className="mt-1 w-full px-2 py-1.5 rounded border border-slate-700 bg-slate-800 text-slate-100"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  placeholder={t('share.contactPlaceholder')}
                />
              </label>

              {composed.tools.length > 0 && (
                <div className="md:col-span-2">
                  <span className="text-xs text-slate-400">{t('share.toolsExtracted')}</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {composed.tools.map((tool) => (
                      <span key={tool} className="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <details className="md:col-span-2 rounded border border-slate-700 p-2 text-xs">
                <summary className="cursor-pointer text-slate-500">{t('share.previewLabel')}</summary>
                <pre className="mt-2 text-[10px] bg-slate-950 border border-slate-800 rounded p-2 font-mono overflow-auto max-h-64 text-slate-300">
                  {composed.markdown}
                </pre>
              </details>
            </div>

            {error && (
              <div
                className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded p-2"
                role="alert"
                data-testid="share-error"
              >
                {error}
                <div className="text-[10px] text-slate-500 mt-1">{t('share.formRetained')}</div>
              </div>
            )}
            {message && (
              <div
                className="text-xs text-emerald-400"
                role="status"
                data-testid="share-success"
              >
                {message}
              </div>
            )}
            {submitting && elapsedSec >= 6 && (
              <div
                className="text-xs text-amber-300 bg-amber-950/30 border border-amber-900 rounded p-2"
                data-testid="share-slow-hint"
              >
                {slowHint}
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm rounded border border-slate-700 text-slate-200"
                disabled={submitting}
              >
                {t('share.cancel')}
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="px-4 py-2 text-sm rounded bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-60 inline-flex items-center gap-2"
                data-testid="share-submit"
              >
                {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {submitting
                  ? `${t('share.submitting')}${elapsedSec > 0 ? ` (${elapsedSec}s)` : ''}`
                  : error
                  ? t('share.retry')
                  : t('share.submit')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
