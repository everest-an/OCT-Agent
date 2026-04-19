import React, { useCallback, useMemo, useState } from 'react';
import { FileText, ExternalLink } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

export function looksLikeAbsolutePath(raw: string): boolean {
  if (!raw) return false;
  const t = raw.trim();
  if (!t || t.length > 4096) return false;
  // Exclude URLs (http://, https://, file://, etc) that may sneak into inline code.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t)) return false;
  // Exclude things that look like options/flags or code identifiers.
  if (/\n/.test(t)) return false;
  // Unix / macOS absolute path: /Users/..., /tmp/..., /opt/... (not //protocol)
  if (t.startsWith('/') && t.length > 1 && !t.startsWith('//')) return true;
  // Home directory shorthand: ~/foo  ~\foo
  if (/^~[/\\]/.test(t)) return true;
  // Windows drive letter: C:\foo  D:/foo
  if (/^[A-Za-z]:[/\\]/.test(t)) return true;
  // Windows UNC path: \\server\share\...
  if (/^\\\\[^\\/]+[/\\]/.test(t)) return true;
  return false;
}

function detectPlatform(): 'mac' | 'win' | 'linux' {
  if (typeof navigator === 'undefined') return 'mac';
  const p = (navigator.platform || navigator.userAgent || '').toLowerCase();
  if (p.includes('win')) return 'win';
  if (p.includes('mac')) return 'mac';
  return 'linux';
}

function shortenPath(fullPath: string, maxLen = 48): string {
  if (fullPath.length <= maxLen) return fullPath;
  const sep = fullPath.includes('\\') && !fullPath.includes('/') ? '\\' : '/';
  const segments = fullPath.split(sep).filter(Boolean);
  if (segments.length <= 2) return fullPath;
  // Keep first root marker + last 2 segments: /…/dir/file.ext
  const tail = segments.slice(-2).join(sep);
  const prefix = fullPath.startsWith(sep) ? sep : '';
  const candidate = `${prefix}…${sep}${tail}`;
  if (candidate.length <= maxLen) return candidate;
  // Fall back to truncating filename
  const last = segments[segments.length - 1];
  return `…${sep}${last.length > maxLen - 2 ? last.slice(0, maxLen - 3) + '…' : last}`;
}

export function FilePathChip({ path }: { path: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'opening' | 'missing' | 'error'>('idle');
  const platform = useMemo(detectPlatform, []);
  const display = useMemo(() => shortenPath(path), [path]);

  const revealLabel =
    platform === 'win'
      ? t('chat.filePath.revealWin', 'Show in Explorer')
      : platform === 'mac'
        ? t('chat.filePath.revealMac', 'Show in Finder')
        : t('chat.filePath.revealLinux', 'Show in file manager');
  const openLabel = t('chat.filePath.openHint', 'Open with default app');
  const clickLabel = t('chat.filePath.clickHint', 'Click');
  const modifierKey = platform === 'mac' ? '⌘' : 'Ctrl';
  const tooltip = `${path}\n\n${clickLabel}: ${revealLabel}\n${modifierKey}+${clickLabel}: ${openLabel}`;

  const handleClick = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const api: any = (window as any).electronAPI;
      if (!api) return;
      const useOpen = e.metaKey || e.ctrlKey;
      setState('opening');
      try {
        const fn = useOpen ? api.openPath : api.showItemInFolder;
        if (typeof fn !== 'function') {
          setState('error');
          return;
        }
        const res = await fn(path);
        if (res && res.ok === false) {
          setState(res.error === 'file not found' ? 'missing' : 'error');
          return;
        }
        setState('idle');
      } catch {
        setState('error');
      }
    },
    [path],
  );

  const statusText =
    state === 'opening'
      ? '…'
      : state === 'missing'
        ? ` (${t('chat.filePath.notFound', 'not found')})`
        : state === 'error'
          ? ` (${t('chat.filePath.failed', 'failed')})`
          : '';

  const tone =
    state === 'missing' || state === 'error'
      ? 'border-amber-500/40 text-amber-300 hover:border-amber-400'
      : 'border-slate-700/60 text-slate-200 hover:border-brand-400 hover:text-brand-200';

  return (
    <button
      type="button"
      onClick={handleClick}
      title={tooltip}
      className={`chat-file-path-chip inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[12px] border bg-slate-800/60 transition-colors cursor-pointer max-w-full align-middle ${tone}`}
    >
      <FileText size={11} className="flex-shrink-0 opacity-70" />
      <span className="truncate font-mono text-[11px]">{display}</span>
      {statusText ? (
        <span className="opacity-70 text-[10px]">{statusText}</span>
      ) : (
        <ExternalLink size={10} className="flex-shrink-0 opacity-50" />
      )}
    </button>
  );
}
