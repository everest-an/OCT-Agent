import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { ipcMain } from 'electron';

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON response')); }
      });
    }).on('error', reject).on('timeout', function(this: any) { this.destroy(); reject(new Error('Request timeout')); });
  });
}

export function registerSkillHandlers(deps: {
  home: string;
  runAsync: (cmd: string, timeoutMs?: number) => Promise<string>;
}) {
  const clawhubApi = 'https://clawhub.ai/api/v1';
  const workspaceDir = path.join(deps.home, '.openclaw', 'workspace');
  const lockFile = path.join(workspaceDir, '.clawhub', 'lock.json');

  ipcMain.handle('skill:list-installed', async () => {
    try {
      const raw = fs.readFileSync(lockFile, 'utf8');
      const lock = JSON.parse(raw);
      return { success: true, skills: lock.skills || {} };
    } catch {
      return { success: true, skills: {} };
    }
  });

  ipcMain.handle('skill:explore', async () => {
    const keywords = ['memory', 'coding', 'search', 'automation', 'file', 'git', 'test'];
    const seen = new Set<string>();
    const all: any[] = [];
    for (const kw of keywords) {
      try {
        const res = await fetchJson(`${clawhubApi}/search?q=${kw}&limit=8`);
        const results = res?.results || [];
        for (const result of results) {
          if (!seen.has(result.slug)) { seen.add(result.slug); all.push(result); }
        }
      } catch {}
    }
    return { success: true, skills: all };
  });

  ipcMain.handle('skill:search', async (_e, query: string) => {
    try {
      const res = await fetchJson(`${clawhubApi}/search?q=${encodeURIComponent(query)}&limit=20`);
      return { success: true, results: res?.results || [] };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('skill:detail', async (_e, slug: string) => {
    try {
      const res = await fetchJson(`${clawhubApi}/skills/${encodeURIComponent(slug)}`);
      return { success: true, skill: res?.skill || null };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('skill:install', async (_e, slug: string) => {
    try {
      await deps.runAsync(`npx -y clawhub@latest install ${slug} --force`, 60000);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message?.slice(0, 300) };
    }
  });

  ipcMain.handle('skill:uninstall', async (_e, slug: string) => {
    try {
      await deps.runAsync(`npx -y clawhub@latest uninstall ${slug}`, 30000);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message?.slice(0, 300) };
    }
  });

  ipcMain.handle('skill:get-config', async (_e, slug: string) => {
    try {
      const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const skillConfig = config.skills?.[slug]?.config || {};
      return { success: true, config: skillConfig };
    } catch (err: any) {
      return { success: false, error: err.message, config: {} };
    }
  });

  ipcMain.handle('skill:save-config', async (_e, slug: string, newConfig: Record<string, unknown>) => {
    try {
      const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
      let config: any = {};
      try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
      if (!config.skills) config.skills = {};
      if (!config.skills[slug]) config.skills[slug] = {};
      config.skills[slug].config = { ...config.skills[slug].config, ...newConfig };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}