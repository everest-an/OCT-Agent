import type { WorkspaceFileDetail } from './wiki-types';

const BINARY_DOC_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.odt', '.ods', '.odp',
]);

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.rst']);

function isAbsolutePathLike(raw: string): boolean {
  const text = raw.trim();
  if (!text || text.length > 4096) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) return false;
  if (text.startsWith('/') && !text.startsWith('//')) return true;
  if (/^[A-Za-z]:[/\\]/.test(text)) return true;
  if (/^~[/\\]/.test(text)) return true;
  if (/^\\\\[^\\/]+[/\\]/.test(text)) return true;
  return false;
}

function normalizeJoin(root: string, relativePath: string): string {
  const useBackslash = root.includes('\\') && !root.includes('/');
  const sep = useBackslash ? '\\' : '/';
  const normalizedRoot = root.replace(/[\\/]+$/, '');
  const normalizedRelative = relativePath.replace(/^[\\/]+/, '').replace(/[\\/]+/g, sep);
  return `${normalizedRoot}${sep}${normalizedRelative}`;
}

export function getFileExtension(pathLike: string): string {
  const base = (pathLike || '').split(/[\\/]/).pop() || '';
  const idx = base.lastIndexOf('.');
  if (idx < 0) return '';
  return base.slice(idx).toLowerCase();
}

export function shouldRenderMarkdown(extension: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extension);
}

export function isLikelyUnreadableBinaryText(content: string): boolean {
  if (!content) return false;
  const sample = content.slice(0, 5000);
  const replacementChars = (sample.match(/\uFFFD/g) || []).length;
  const controlChars = (sample.match(/[\x00-\x08\x0E-\x1F]/g) || []).length;
  const mojibakeMarkers = (sample.match(/[ÃÂÐÑ]/g) || []).length;
  const pkHeader = sample.includes('PK\u0003\u0004') || sample.startsWith('PK');
  const length = Math.max(sample.length, 1);

  return pkHeader
    || replacementChars / length > 0.01
    || controlChars / length > 0.02
    || mojibakeMarkers / length > 0.05;
}

export function shouldPreferNativeDocViewer(extension: string, content: string): boolean {
  if (!BINARY_DOC_EXTENSIONS.has(extension)) return false;
  if (!content) return true;
  return isLikelyUnreadableBinaryText(content);
}

export function resolveDocAbsolutePath(
  detail: WorkspaceFileDetail | null,
  docTitle: string,
  workspaceRoot?: string | null,
): string | null {
  const metadata = detail?.metadata ?? {};
  const candidates = [
    metadata.absolutePath,
    metadata.path,
    metadata.filePath,
    metadata.abs_path,
    metadata.source_path,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && isAbsolutePathLike(candidate)) {
      return candidate;
    }
  }

  const relativePath = typeof metadata.relativePath === 'string'
    ? metadata.relativePath
    : (detail?.title || docTitle);

  if (workspaceRoot && relativePath && !isAbsolutePathLike(relativePath)) {
    return normalizeJoin(workspaceRoot, relativePath);
  }

  return null;
}