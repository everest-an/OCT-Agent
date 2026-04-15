import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { ipcMain } from 'electron';

export function registerCloudWorkspaceHandlers(deps: {
  home: string;
  getWorkspaceDir: () => string;
}) {
  const daemonBase = 'http://127.0.0.1:37800/api/v1';

  function parseDaemonResponse(res: http.IncomingMessage, raw: string) {
    let parsed: any;
    try {
      parsed = JSON.parse(raw || '{}');
    } catch {
      throw new Error('Invalid JSON from daemon');
    }

    if ((res.statusCode || 500) >= 400) {
      throw new Error(parsed?.error || `Daemon request failed (${res.statusCode})`);
    }

    return parsed;
  }

  function daemonPost(route: string, body: Record<string, any> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(`${daemonBase}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 15000,
      }, (res) => {
        let raw = '';
        res.on('data', (chunk: string) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve(parseDaemonResponse(res, raw));
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Daemon request timeout')); });
      req.write(data);
      req.end();
    });
  }

  function daemonGet(route: string): Promise<any> {
    return new Promise((resolve, reject) => {
      http.get(`${daemonBase}${route}`, { timeout: 10000 }, (res) => {
        let raw = '';
        res.on('data', (chunk: string) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve(parseDaemonResponse(res, raw));
          } catch (error) {
            reject(error);
          }
        });
      }).on('error', reject).on('timeout', function(this: any) { this.destroy(); reject(new Error('Timeout')); });
    });
  }

  ipcMain.handle('cloud:auth-start', async () => {
    try {
      const result = await daemonPost('/cloud/auth/start', {});
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('cloud:auth-poll', async (_e, deviceCode: string) => {
    try {
      const result = await new Promise<any>((resolve, reject) => {
        const data = JSON.stringify({ device_code: deviceCode });
        const req = https.request('https://awareness.market/api/v1/auth/device/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          timeout: 10000,
        }, (res) => {
          let raw = '';
          res.on('data', (chunk: string) => { raw += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(data);
        req.end();
      });
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('cloud:list-memories', async (_e, apiKey: string) => {
    try {
      const result = await daemonGet(`/cloud/memories?api_key=${encodeURIComponent(apiKey)}`);
      return { success: true, ...(Array.isArray(result) ? { memories: result } : result) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('cloud:get-profile', async (_e, apiKey: string) => {
    try {
      const result = await daemonPost('/cloud/profile', { api_key: apiKey });
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('cloud:connect', async (_e, apiKey: string, memoryId: string) => {
    try {
      const result = await daemonPost('/cloud/connect', { api_key: apiKey, memory_id: memoryId });
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('cloud:disconnect', async () => {
    try {
      const result = await daemonPost('/cloud/disconnect', {});
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('cloud:status', async () => {
    try {
      const health = await daemonGet('/../healthz');
      return { success: true, mode: health?.mode || 'local', cloud: health?.cloud || null };
    } catch (err: any) {
      return { success: false, error: err.message, mode: 'local' };
    }
  });

  ipcMain.handle('workspace:read-file', async (_e, filename: string) => {
    const allowed = ['SOUL.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md', 'MEMORY.md', 'AGENTS.md'];
    if (!allowed.includes(filename)) return { success: false, error: 'File not allowed' };
    try {
      const filePath = path.join(deps.getWorkspaceDir(), filename);
      if (!fs.existsSync(filePath)) return { success: true, content: '', exists: false };
      return { success: true, content: fs.readFileSync(filePath, 'utf8'), exists: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('workspace:write-file', async (_e, filename: string, content: string) => {
    const allowed = ['SOUL.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md', 'MEMORY.md', 'AGENTS.md'];
    if (!allowed.includes(filename)) return { success: false, error: 'File not allowed' };
    try {
      const workspaceDir = deps.getWorkspaceDir();
      fs.mkdirSync(workspaceDir, { recursive: true });
      const filePath = path.join(workspaceDir, filename);
      fs.writeFileSync(filePath, content);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}