/**
 * Workspace content views for the Wiki tab.
 * Renders file details, document previews, and wiki page content
 * fetched from the local daemon scan API.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ArrowLeft, Loader2, Code2, FileText, GitBranch, Link2,
  Brain, FolderOpen, RefreshCw, BookType, Layers, Sparkles, Search,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../../lib/i18n';
import { memoryMarkdownComponents, getCategoryDisplay } from './memory-helpers';
import type { KnowledgeCard } from './memory-helpers';
import type {
  WikiSelectedItem, WorkspaceFileDetail, ScanStatus, WorkspaceStats, WikiPageItem,
  WorkspaceFileItem,
} from './wiki-types';
import { DAEMON_API_BASE } from './wiki-types';

/* ── Shared helpers ──────────────────────────────────── */

function BackButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-4 flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors"
    >
      <ArrowLeft size={14} />
      {t('common.back', 'Back')}
    </button>
  );
}

function SectionHeader({ icon, title, badge }: { icon: React.ReactNode; title: string; badge?: string | number }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-slate-400">{icon}</span>
      <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
      {badge !== undefined && (
        <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-500">
          {badge}
        </span>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── WorkspaceOverviewView ───────────────────────────── */

interface WorkspaceOverviewViewProps {
  stats: WorkspaceStats | null;
  scanStatus: ScanStatus | null;
  onSelect: (item: WikiSelectedItem) => void;
  onTriggerScan?: (mode?: 'full' | 'incremental') => Promise<void>;
}

export function WorkspaceOverviewView({ stats, scanStatus, onSelect, onTriggerScan }: WorkspaceOverviewViewProps) {
  const { t } = useI18n();

  const statCards = stats ? [
    { label: t('memory.wiki.wsFiles', 'Files'), value: stats.totalFiles, icon: <Code2 size={16} /> },
    { label: t('memory.wiki.wsSymbols', 'Symbols'), value: stats.totalSymbols, icon: <Layers size={16} /> },
    { label: t('memory.wiki.wsDocs', 'Documents'), value: stats.totalDocs, icon: <FileText size={16} /> },
    { label: t('memory.wiki.wsWiki', 'Wiki Pages'), value: stats.totalWikiPages, icon: <BookType size={16} /> },
  ] : [];

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2">
            <FolderOpen size={18} className="text-sky-400" />
            {t('memory.wiki.workspaceTitle', 'Project Workspace')}
          </h2>
          {onTriggerScan && (
            <button
              type="button"
              onClick={() => onTriggerScan('incremental')}
              disabled={scanStatus?.status === 'scanning' || scanStatus?.status === 'indexing'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 bg-slate-800 rounded-lg transition-colors disabled:opacity-50"
            >
              <RefreshCw size={12} className={scanStatus?.status !== 'idle' ? 'animate-spin' : ''} />
              {scanStatus?.status !== 'idle'
                ? t('memory.wiki.scanning', 'Scanning...')
                : t('memory.wiki.rescan', 'Rescan')}
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500">
          {t('memory.wiki.workspaceDesc', 'Code structure, documents, and auto-generated wiki pages for this project.')}
        </p>
      </div>

      {/* Stats grid */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {statCards.map((s) => (
            <div
              key={s.label}
              className="rounded-xl border border-slate-700/50 bg-slate-900/60 p-3.5 text-center"
            >
              <div className="flex justify-center mb-2 text-slate-500">{s.icon}</div>
              <div className="text-xl font-bold text-slate-100 tabular-nums">
                {s.value.toLocaleString()}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Scan status */}
      {scanStatus && scanStatus.status !== 'idle' && (
        <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Loader2 size={14} className="text-sky-400 animate-spin" />
            <span className="text-sm font-medium text-sky-300">
              {scanStatus.phase === 'embedding'
                ? t('memory.wiki.embedding', 'Embedding vectors...')
                : scanStatus.phase ?? t('memory.wiki.scanInProgress', 'Scanning workspace...')}
            </span>
          </div>
          {scanStatus.phase === 'embedding' && (scanStatus.embed_total ?? 0) > 0 ? (
            <>
              <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-cyan-500 transition-all duration-300"
                  style={{ width: `${Math.min(100, Math.round(((scanStatus.embed_done ?? 0) / scanStatus.embed_total!) * 100))}%` }}
                />
              </div>
              <div className="text-[11px] text-slate-500 mt-1.5">
                {scanStatus.embed_done ?? 0} / {scanStatus.embed_total} nodes
              </div>
            </>
          ) : (
            <>
              {typeof scanStatus.percent === 'number' && (
                <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-sky-500 transition-all duration-300"
                    style={{ width: `${Math.min(100, scanStatus.percent)}%` }}
                  />
                </div>
              )}
              {scanStatus.total_files != null && (
                <div className="text-[11px] text-slate-500 mt-1.5">
                  {scanStatus.processed_files ?? 0} / {scanStatus.total_files} files
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── WorkspaceFileView ───────────────────────────────── */

interface WorkspaceFileViewProps {
  fileId: string;
  fileTitle: string;
  cards: KnowledgeCard[];
  onSelect: (item: WikiSelectedItem) => void;
}

export function WorkspaceFileView({ fileId, fileTitle, cards, onSelect }: WorkspaceFileViewProps) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<WorkspaceFileDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const id = fileId.startsWith('file:') ? fileId : `file:${fileId}`;
    fetch(`${DAEMON_API_BASE}/scan/file/${encodeURIComponent(id)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!cancelled && data) setDetail(data);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fileId]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-12">
        <Loader2 size={24} className="animate-spin text-brand-500" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex-1 overflow-y-auto p-6 max-w-3xl mx-auto">
        <BackButton onClick={() => onSelect({ type: 'workspace_overview' })} />
        <p className="text-sm text-slate-500">{t('memory.wiki.fileNotFound', 'File not found')}</p>
      </div>
    );
  }

  const meta = detail.metadata ?? {};
  const symbols = (detail.edges ?? []).filter((e) => e.type === 'contains');
  const imports = (detail.edges ?? []).filter((e) => e.type === 'import');
  // Dedup doc references by target id to avoid showing the same file multiple times
  const docRefsRaw = (detail.edges ?? []).filter((e) => e.type === 'doc_reference');
  const docRefs = [...new Map(docRefsRaw.map((e) => [e.to, e])).values()];
  const similars = (detail.edges ?? []).filter((e) => e.type === 'similarity')
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  const language = (meta.language as string) ?? (meta.category as string) ?? '';
  const size = typeof meta.size === 'number' ? meta.size : 0;
  const relPath = (meta.relativePath as string) ?? detail.title;

  // Find related knowledge cards based on file path mentions
  const relatedCards = cards.filter((c) => {
    const s = (c.summary ?? '').toLowerCase();
    const fileName = relPath.split('/').pop()?.toLowerCase() ?? '';
    return fileName.length > 3 && s.includes(fileName);
  }).slice(0, 8);

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-3xl mx-auto space-y-5">
      <BackButton onClick={() => onSelect({ type: 'workspace_overview' })} />

      {/* File header */}
      <div className="rounded-xl border border-slate-700/50 bg-slate-900/60 p-4">
        <h2 className="text-lg font-semibold text-slate-100 mb-2 flex items-center gap-2">
          <Code2 size={18} className="text-sky-400" />
          {fileTitle}
        </h2>
        <div className="flex flex-wrap gap-3 text-xs text-slate-500">
          {language && (
            <span className="rounded-lg bg-slate-800/80 px-2 py-1">{language}</span>
          )}
          {size > 0 && (
            <span className="rounded-lg bg-slate-800/80 px-2 py-1">{formatBytes(size)}</span>
          )}
          <span className="rounded-lg bg-slate-800/80 px-2 py-1 font-mono text-[11px]">{relPath}</span>
        </div>
      </div>

      {/* Symbols */}
      {symbols.length > 0 && (
        <div>
          <SectionHeader icon={<Layers size={14} />} title={t('memory.wiki.symbols', 'Symbols')} badge={symbols.length} />
          <div className="rounded-xl border border-slate-700/50 divide-y divide-slate-700/30">
            {symbols.slice(0, 30).map((edge) => {
              const parts = edge.to.split(':');
              const symName = parts.length >= 3 ? parts[2] : edge.to;
              const line = parts.length >= 4 ? parts[3] : null;
              return (
                <div
                  key={edge.to}
                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-800/30 transition-colors"
                >
                  <span className="text-purple-400 font-mono text-xs shrink-0">fn</span>
                  <span className="flex-1 text-slate-300 font-mono truncate">{symName}</span>
                  {line && (
                    <span className="text-[10px] text-slate-600 tabular-nums">:{line}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Dependencies */}
      {imports.length > 0 && (
        <div>
          <SectionHeader icon={<GitBranch size={14} />} title={t('memory.wiki.dependencies', 'Dependencies')} badge={imports.length} />
          <div className="rounded-xl border border-slate-700/50 divide-y divide-slate-700/30">
            {imports.slice(0, 30).map((edge) => {
              const target = edge.to.replace(/^file:/, '');
              const isExternal = !target.includes('/') || target.startsWith('node_modules');
              return (
                <button
                  key={edge.to}
                  type="button"
                  onClick={() => {
                    if (!isExternal) onSelect({ type: 'workspace_file', id: edge.to, title: target });
                  }}
                  className={`flex items-center gap-2 px-3 py-2 text-sm w-full text-left transition-colors ${
                    isExternal ? 'text-slate-500' : 'text-slate-300 hover:bg-slate-800/30 cursor-pointer'
                  }`}
                >
                  <Link2 size={12} className={isExternal ? 'text-slate-600' : 'text-emerald-400/70'} />
                  <span className="flex-1 font-mono truncate text-xs">{target}</span>
                  {isExternal && (
                    <span className="text-[10px] text-slate-600 italic">external</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Doc references */}
      {docRefs.length > 0 && (
        <div>
          <SectionHeader icon={<FileText size={14} />} title={t('memory.wiki.docRefs', 'Doc References')} badge={docRefs.length} />
          <div className="rounded-xl border border-slate-700/50 divide-y divide-slate-700/30">
            {docRefs.map((edge) => {
              const target = edge.to.replace(/^file:/, '');
              return (
                <button
                  key={edge.to}
                  type="button"
                  onClick={() => onSelect({ type: 'workspace_doc', id: edge.to, title: target })}
                  className="flex items-center gap-2 px-3 py-2 text-sm w-full text-left text-slate-300 hover:bg-slate-800/30 transition-colors"
                >
                  <FileText size={12} className="text-amber-400/70" />
                  <span className="flex-1 font-mono truncate text-xs">{target}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Similar files (via vector similarity) */}
      {similars.length > 0 && (
        <div>
          <SectionHeader icon={<Sparkles size={14} />} title={t('memory.wiki.similarFiles', 'Similar Files')} badge={similars.length} />
          <div className="rounded-xl border border-slate-700/50 divide-y divide-slate-700/30">
            {similars.slice(0, 12).map((edge) => {
              const target = edge.from === fileId ? edge.to : edge.from;
              const targetLabel = target.replace(/^(file|wiki|doc|sym):/, '');
              const prefix = target.split(':')[0];
              const navType = prefix === 'wiki' ? 'wiki_page' : prefix === 'doc' ? 'workspace_doc' : 'workspace_file';
              const score = edge.weight ? `${(edge.weight * 100).toFixed(0)}%` : '';
              return (
                <button
                  key={`${edge.from}-${edge.to}`}
                  type="button"
                  onClick={() => onSelect({ type: navType, id: target, title: targetLabel })}
                  className="flex items-center gap-2 px-3 py-2 text-sm w-full text-left text-slate-300 hover:bg-slate-800/30 transition-colors"
                >
                  <Sparkles size={12} className="text-cyan-400/70" />
                  <span className="flex-1 font-mono truncate text-xs">{targetLabel}</span>
                  {score && (
                    <span className="text-[10px] text-slate-500 tabular-nums font-mono">{score}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Related knowledge cards */}
      {relatedCards.length > 0 && (
        <div>
          <SectionHeader icon={<Brain size={14} />} title={t('memory.wiki.relatedCards', 'Related Knowledge')} badge={relatedCards.length} />
          <div className="rounded-xl border border-slate-700/50 divide-y divide-slate-700/30">
            {relatedCards.map((card) => {
              const display = getCategoryDisplay(card.category);
              const CatIcon = display.icon;
              return (
                <button
                  key={card.id}
                  type="button"
                  onClick={() => onSelect({ type: 'card', id: card.id })}
                  className="flex items-start gap-2.5 px-3 py-2.5 w-full text-left hover:bg-slate-800/30 transition-colors"
                >
                  <span className="text-sm shrink-0 mt-0.5"><CatIcon size={14} className={display.color} /></span>
                  <div className="min-w-0">
                    <div className="text-sm text-slate-200 font-medium truncate">{card.title}</div>
                    <div className="text-[11px] text-slate-500 line-clamp-1 mt-0.5">{card.summary}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Source preview */}
      {detail.content && (
        <div>
          <SectionHeader
            icon={<FileText size={14} />}
            title={symbols.length > 0 || imports.length > 0 || docRefs.length > 0
              ? t('memory.wiki.sourcePreview', 'Source Preview')
              : t('memory.wiki.fileContent', 'File Content')}
          />
          <pre className="rounded-xl border border-slate-700/50 bg-slate-950/60 p-4 overflow-x-auto text-xs leading-relaxed text-slate-400 max-h-[500px] overflow-y-auto whitespace-pre-wrap break-all font-mono">
            {detail.content.length > 3000
              ? detail.content.substring(0, 3000) + '\n\n... (truncated)'
              : detail.content}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ── WorkspaceDocView ────────────────────────────────── */

interface WorkspaceDocViewProps {
  docId: string;
  docTitle: string;
  onSelect: (item: WikiSelectedItem) => void;
}

export function WorkspaceDocView({ docId, docTitle, onSelect }: WorkspaceDocViewProps) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<WorkspaceFileDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const id = docId.startsWith('file:') ? docId : `file:${docId}`;
    fetch(`${DAEMON_API_BASE}/scan/file/${encodeURIComponent(id)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (!cancelled && data) setDetail(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [docId]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-12">
        <Loader2 size={24} className="animate-spin text-brand-500" />
      </div>
    );
  }

  const content = detail?.content ?? '';
  const meta = detail?.metadata ?? {};
  const relPath = (meta.relativePath as string) ?? docTitle;
  const docEdges = detail?.edges ?? [];
  const docSimilars = docEdges.filter((e) => e.type === 'similarity')
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  const docRefs = docEdges.filter((e) => e.type === 'doc_reference');

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-3xl mx-auto space-y-4">
      <BackButton onClick={() => onSelect({ type: 'workspace_overview' })} />

      <div className="rounded-xl border border-slate-700/50 bg-slate-900/60 p-4 mb-4">
        <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2 mb-1">
          <FileText size={18} className="text-amber-400" />
          {docTitle}
        </h2>
        <span className="text-xs text-slate-500 font-mono">{relPath}</span>
      </div>

      {content ? (
        <article className="prose prose-invert prose-sm max-w-none rounded-xl border border-slate-700/40 bg-slate-950/40 p-5">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={memoryMarkdownComponents}>
            {content}
          </ReactMarkdown>
        </article>
      ) : (
        <p className="text-sm text-slate-500 italic">
          {t('memory.wiki.noDocContent', 'No content available for this document.')}
        </p>
      )}

      {/* Similar documents (via vector similarity) */}
      {docSimilars.length > 0 && (
        <div>
          <SectionHeader icon={<Sparkles size={14} />} title={t('memory.wiki.similarDocs', 'Similar Documents')} badge={docSimilars.length} />
          <div className="rounded-xl border border-slate-700/50 divide-y divide-slate-700/30">
            {docSimilars.slice(0, 12).map((edge) => {
              const target = edge.from === docId ? edge.to : edge.from;
              const targetLabel = target.replace(/^(file|doc):/, '');
              const score = edge.weight ? `${(edge.weight * 100).toFixed(0)}%` : '';
              return (
                <button
                  key={`${edge.from}-${edge.to}`}
                  type="button"
                  onClick={() => onSelect({ type: 'workspace_doc', id: target, title: targetLabel })}
                  className="flex items-center gap-2 px-3 py-2 text-sm w-full text-left text-slate-300 hover:bg-slate-800/30 transition-colors"
                >
                  <FileText size={12} className="text-amber-400/70" />
                  <span className="flex-1 font-mono truncate text-xs">{targetLabel}</span>
                  {score && (
                    <span className="text-[10px] text-slate-500 tabular-nums font-mono">{score}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Doc references */}
      {docRefs.length > 0 && (
        <div>
          <SectionHeader icon={<Link2 size={14} />} title={t('memory.wiki.references', 'References')} badge={docRefs.length} />
          <div className="rounded-xl border border-slate-700/50 divide-y divide-slate-700/30">
            {docRefs.slice(0, 20).map((edge) => {
              const target = edge.from === docId ? edge.to : edge.from;
              const targetLabel = target.replace(/^(file|doc|wiki):/, '');
              const prefix = target.split(':')[0];
              const navType = prefix === 'wiki' ? 'wiki_page' : prefix === 'doc' ? 'workspace_doc' : 'workspace_file';
              return (
                <button
                  key={`${edge.from}-${edge.to}`}
                  type="button"
                  onClick={() => onSelect({ type: navType, id: target, title: targetLabel })}
                  className="flex items-center gap-2 px-3 py-2 text-sm w-full text-left text-slate-300 hover:bg-slate-800/30 transition-colors"
                >
                  <Link2 size={12} className="text-emerald-400/70" />
                  <span className="flex-1 font-mono truncate text-xs">{targetLabel}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── WikiPageView ────────────────────────────────────── */

interface WikiPageViewProps {
  pageId: string;
  pageTitle: string;
  cards: KnowledgeCard[];
  onSelect: (item: WikiSelectedItem) => void;
}

export function WikiPageView({ pageId, pageTitle, cards, onSelect }: WikiPageViewProps) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<WorkspaceFileDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const id = pageId.startsWith('wiki:') ? pageId : `wiki:${pageId}`;
    fetch(`${DAEMON_API_BASE}/scan/file/${encodeURIComponent(id)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (!cancelled && data) setDetail(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [pageId]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-12">
        <Loader2 size={24} className="animate-spin text-brand-500" />
      </div>
    );
  }

  const content = detail?.content ?? '';
  const isModule = pageId.includes('modules/');
  const edges = detail?.edges ?? [];
  const memberFiles = edges.filter((e) => e.type === 'contains' || e.type === 'import');
  const wikiSimilars = edges.filter((e) => e.type === 'similarity')
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-3xl mx-auto space-y-5">
      <BackButton onClick={() => onSelect({ type: 'workspace_overview' })} />

      <div className="rounded-xl border border-slate-700/50 bg-slate-900/60 p-4">
        <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2 mb-1">
          <span className="text-lg">{isModule ? '📘' : '📗'}</span>
          {pageTitle}
        </h2>
        <span className="text-[11px] text-slate-500">
          {isModule
            ? t('memory.wiki.modulePage', 'Module Page')
            : t('memory.wiki.conceptPage', 'Concept Page')}
        </span>
      </div>

      {content ? (
        <article className="prose prose-invert prose-sm max-w-none rounded-xl border border-slate-700/40 bg-slate-950/40 p-5">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={memoryMarkdownComponents}>
            {content}
          </ReactMarkdown>
        </article>
      ) : (
        <p className="text-sm text-slate-500 italic">
          {t('memory.wiki.noWikiContent', 'No wiki content generated yet. Run a scan to generate wiki pages.')}
        </p>
      )}

      {/* Member files */}
      {memberFiles.length > 0 && (
        <div>
          <SectionHeader icon={<Code2 size={14} />} title={t('memory.wiki.memberFiles', 'Files')} badge={memberFiles.length} />
          <div className="rounded-xl border border-slate-700/50 divide-y divide-slate-700/30">
            {memberFiles.slice(0, 30).map((edge) => {
              const target = (edge.from === pageId ? edge.to : edge.from).replace(/^file:/, '');
              return (
                <button
                  key={`${edge.from}-${edge.to}`}
                  type="button"
                  onClick={() => onSelect({ type: 'workspace_file', id: edge.from === pageId ? edge.to : edge.from, title: target })}
                  className="flex items-center gap-2 px-3 py-2 text-sm w-full text-left text-slate-300 hover:bg-slate-800/30 transition-colors"
                >
                  <Code2 size={12} className="text-sky-400/70" />
                  <span className="flex-1 font-mono truncate text-xs">{target}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Similar wiki pages (via vector similarity) */}
      {wikiSimilars.length > 0 && (
        <div>
          <SectionHeader icon={<Sparkles size={14} />} title={t('memory.wiki.similarPages', 'Similar Pages')} badge={wikiSimilars.length} />
          <div className="rounded-xl border border-slate-700/50 divide-y divide-slate-700/30">
            {wikiSimilars.slice(0, 12).map((edge) => {
              const target = edge.from === pageId ? edge.to : edge.from;
              const targetLabel = target.replace(/^wiki:(modules|concepts)\//, '');
              const isConcept = target.includes('concepts/');
              const score = edge.weight ? `${(edge.weight * 100).toFixed(0)}%` : '';
              return (
                <button
                  key={`${edge.from}-${edge.to}`}
                  type="button"
                  onClick={() => onSelect({ type: 'wiki_page', id: target, title: targetLabel })}
                  className="flex items-center gap-2 px-3 py-2 text-sm w-full text-left text-slate-300 hover:bg-slate-800/30 transition-colors"
                >
                  <span className="text-sm shrink-0">{isConcept ? '📗' : '📘'}</span>
                  <span className="flex-1 truncate text-xs">{targetLabel}</span>
                  {score && (
                    <span className="text-[10px] text-slate-500 tabular-nums font-mono">{score}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── WorkspaceListView — full list for Code/Docs/Wiki ── */

type ListCategory = 'code' | 'docs' | 'wiki';

interface WorkspaceListViewProps {
  category: ListCategory;
  files: WorkspaceFileItem[];
  wikiPages: WikiPageItem[];
  onSelect: (item: WikiSelectedItem) => void;
}

const LIST_ICONS: Record<ListCategory, React.ReactNode> = {
  code: <Code2 size={18} className="text-sky-400" />,
  docs: <FileText size={18} className="text-amber-400" />,
  wiki: <BookType size={18} className="text-purple-400" />,
};

const LIST_TITLES: Record<ListCategory, string> = {
  code: 'Code Files',
  docs: 'Documents',
  wiki: 'Wiki Pages',
};

export function WorkspaceListView({ category, files, wikiPages, onSelect }: WorkspaceListViewProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  const q = filter.toLowerCase().trim();

  const items = category === 'wiki' ? wikiPages : files;

  const filtered = useMemo(
    () => items.filter((f) => {
      if (!q) return true;
      const searchable = ('relativePath' in f ? (f as WorkspaceFileItem).relativePath ?? '' : '') + ' ' + (f.title ?? '') + ' ' + (f.id ?? '');
      return searchable.toLowerCase().includes(q);
    }),
    [items, q],
  );

  // For wiki: group by modules/concepts
  const wikiModules = useMemo(
    () => category === 'wiki' ? filtered.filter((p) => p.id?.startsWith('wiki:modules/')) : [],
    [category, filtered],
  );
  const wikiConcepts = useMemo(
    () => category === 'wiki' ? filtered.filter((p) => p.id?.startsWith('wiki:concepts/')) : [],
    [category, filtered],
  );

  // For code/docs: group by directory
  const dirGroups = useMemo(() => {
    if (category === 'wiki') return [];
    const map = new Map<string, WorkspaceFileItem[]>();
    for (const f of filtered as WorkspaceFileItem[]) {
      const rel = f.relativePath ?? f.title ?? '';
      const parts = rel.split('/');
      const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
      const arr = map.get(dir) ?? [];
      arr.push(f);
      map.set(dir, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [category, filtered]);

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-3xl mx-auto space-y-5">
      <BackButton onClick={() => onSelect({ type: 'workspace_overview' })} />

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2">
          {LIST_ICONS[category]}
          {LIST_TITLES[category]}
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-500">
            {filtered.length}
          </span>
        </h2>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('memory.wiki.filterPlaceholder', 'Filter...')}
            className="rounded-lg border border-slate-700/60 bg-slate-950/50 pl-8 pr-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500/50 w-48"
          />
        </div>
      </div>

      {filtered.length === 0 && (
        <p className="text-sm text-slate-500 italic">
          {t('memory.wiki.noMatchingItems', 'No items match your filter.')}
        </p>
      )}

      {/* Wiki: modules + concepts */}
      {category === 'wiki' && (
        <>
          {wikiModules.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
                <span>{'📘'}</span> Modules
                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500">{wikiModules.length}</span>
              </h3>
              <div className="rounded-xl border border-slate-700/50 divide-y divide-slate-700/30">
                {wikiModules.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onSelect({ type: 'wiki_page', id: p.id, title: p.title })}
                    className="flex items-center gap-2 px-3 py-2 text-sm w-full text-left text-slate-300 hover:bg-slate-800/30 transition-colors"
                  >
                    <span className="text-sm">{'📘'}</span>
                    <span className="flex-1 truncate">{p.title || p.id}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {wikiConcepts.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
                <span>{'📗'}</span> Concepts
                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500">{wikiConcepts.length}</span>
              </h3>
              <div className="rounded-xl border border-slate-700/50 divide-y divide-slate-700/30">
                {wikiConcepts.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onSelect({ type: 'wiki_page', id: p.id, title: p.title })}
                    className="flex items-center gap-2 px-3 py-2 text-sm w-full text-left text-slate-300 hover:bg-slate-800/30 transition-colors"
                  >
                    <span className="text-sm">{'📗'}</span>
                    <span className="flex-1 truncate">{p.title || p.id}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Code/Docs: grouped by directory */}
      {category !== 'wiki' && dirGroups.map(([dir, dirFiles]) => (
        <div key={dir}>
          <div className="flex items-center gap-1.5 mb-2 text-sm font-semibold text-slate-300">
            <FolderOpen size={14} className="text-sky-400/70" />
            {dir}
            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500">{dirFiles.length}</span>
          </div>
          <div className="rounded-xl border border-slate-700/50 divide-y divide-slate-700/30">
            {dirFiles.map((f) => {
              const fileName = (f.relativePath ?? f.title).split('/').pop() ?? f.title;
              const navType = category === 'code' ? 'workspace_file' : 'workspace_doc';
              const sizeStr = f.size ? formatBytes(f.size) : '';
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => onSelect({ type: navType, id: f.id, title: f.title })}
                  className="flex items-center gap-2 px-3 py-2 text-sm w-full text-left text-slate-300 hover:bg-slate-800/30 transition-colors"
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${category === 'code' ? 'bg-cyan-400' : 'bg-amber-400'}`} />
                  <span className="flex-1 font-mono text-xs truncate">{fileName}</span>
                  {sizeStr && (
                    <span className="text-[10px] text-slate-600">{sizeStr}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
