import { dialog } from 'electron';
import fs from 'fs';
import path from 'path';

export async function previewFile(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'].includes(ext);

    if (isImage) {
      if (stat.size > 5 * 1024 * 1024) return { type: 'image', error: 'Image too large (>5MB)' };
      const data = fs.readFileSync(filePath);
      const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      return { type: 'image', dataUri: `data:${mime};base64,${data.toString('base64')}`, size: stat.size };
    }

    if (stat.size > 1024 * 1024) return { type: 'text', content: '(File too large for preview)', size: stat.size, lines: 0 };
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const preview = lines.slice(0, 20).join('\n');
    return { type: 'text', content: preview, size: stat.size, lines: lines.length, truncated: lines.length > 20 };
  } catch (err: any) {
    return { type: 'error', error: err.message };
  }
}

export async function selectFile(options?: { filters?: Array<{ name: string; extensions: string[] }> }) {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: options?.filters || [{ name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return { filePath: null };
  return { filePath: result.filePaths[0] };
}

export async function selectDirectory() {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return { directoryPath: null };
  return { directoryPath: result.filePaths[0] };
}