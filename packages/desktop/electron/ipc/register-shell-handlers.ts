import { ipcMain, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type ShellResult = { ok: boolean; error?: string };

function expandHome(raw: string): string {
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

type NormalizeResult = { ok: boolean; value?: string; error?: string };

function normalizePath(raw: unknown): NormalizeResult {
  if (typeof raw !== 'string') return { ok: false, error: 'path must be a string' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'path is empty' };
  if (trimmed.length > 4096) return { ok: false, error: 'path too long' };
  const expanded = expandHome(trimmed);
  if (!path.isAbsolute(expanded)) return { ok: false, error: 'path must be absolute' };
  const resolved = path.resolve(expanded);
  return { ok: true, value: resolved };
}

export function registerShellHandlers() {
  ipcMain.handle('shell:show-item-in-folder', async (_e, rawPath: unknown): Promise<ShellResult> => {
    const check = normalizePath(rawPath);
    if (!check.ok || !check.value) return { ok: false, error: check.error || 'invalid path' };
    const abs = check.value;
    if (!fs.existsSync(abs)) return { ok: false, error: 'file not found' };
    try {
      shell.showItemInFolder(abs);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  ipcMain.handle('shell:open-path', async (_e, rawPath: unknown): Promise<ShellResult> => {
    const check = normalizePath(rawPath);
    if (!check.ok || !check.value) return { ok: false, error: check.error || 'invalid path' };
    const abs = check.value;
    if (!fs.existsSync(abs)) return { ok: false, error: 'file not found' };
    try {
      const err = await shell.openPath(abs);
      if (err) return { ok: false, error: err };
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  });
}
