import fs from 'fs';
import path from 'path';
import { ipcMain } from 'electron';
import { parseJsonShellOutput } from '../openclaw-shell-output';
import { dedupedChannelsList } from '../openclaw-process-guard';

const channelStatusCache: { configured: string[]; ts: number } = { configured: [], ts: 0 };

export function clearChannelStatusCache() {
  channelStatusCache.configured = [];
  channelStatusCache.ts = 0;
}

function readConfiguredFromFile(home: string, toFrontendId: (openclawId: string) => string): { configured: string[]; disconnected: string[] } {
  try {
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const channels = existing?.channels || {};
    const configured: string[] = [];
    const disconnected: string[] = [];
    for (const [id, cfg] of Object.entries(channels)) {
      const frontendId = toFrontendId(id);
      if ((cfg as any)?.enabled === true) {
        configured.push(frontendId);
      } else if ((cfg as any)?.enabled === false) {
        disconnected.push(frontendId);
      }
    }
    return {
      configured: Array.from(new Set(configured)),
      disconnected: Array.from(new Set(disconnected)).filter((id) => !configured.includes(id)),
    };
  } catch {
    return { configured: [], disconnected: [] };
  }
}

export function registerChannelListHandlers(deps: {
  home: string;
  safeShellExecAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  readShellOutputAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  toFrontendId: (openclawId: string) => string;
}) {
  // Deduplicated `openclaw channels list` — shared with all other handlers
  // via openclaw-process-guard so concurrent callers from any IPC handler
  // (channel-config, channel-setup, agents, wizard, startup pre-warm) all
  // reuse the same in-flight process instead of spawning their own.
  function channelsListDeduped(timeoutMs: number): Promise<string | null> {
    return dedupedChannelsList(deps.readShellOutputAsync, timeoutMs);
  }

  ipcMain.handle('channel:list-configured', async () => {
    const fromFile = readConfiguredFromFile(deps.home, deps.toFrontendId);

    // Always start from the freshly-read file. Supplement with recent CLI cache
    // so channels detected by CLI (but not yet written to file) also appear.
    // This ensures a just-completed WeChat/one-click setup is immediately visible.
    const cacheIsRecent = Date.now() - channelStatusCache.ts < 60000;
    const immediateConfigured: string[] = cacheIsRecent && channelStatusCache.configured.length > 0
      ? [...new Set([...fromFile.configured, ...channelStatusCache.configured])]
      : fromFile.configured;
    const immediateDisconnected: string[] = fromFile.disconnected.filter((id) => !immediateConfigured.includes(id));

    // Fire-and-forget background refresh — deduplicated so concurrent calls
    // from Channels/Agents/AgentWizard pages share one CLI process.
    channelsListDeduped(20000).then((output) => {
      if (!output) return;
      try {
        const jsonParsed = parseJsonShellOutput<any>(output);
        if (!jsonParsed) {
          throw new Error('Could not parse configured channels JSON');
        }
        const arr = Array.isArray(jsonParsed) ? jsonParsed : (jsonParsed.channels || jsonParsed.items || []);
        const jsonConfigured: string[] = arr
          .filter((ch: any) => {
            const status = (ch.status || ch.state || '').toLowerCase();
            return status.includes('configured') || status.includes('linked') || status.includes('active') || status.includes('enabled');
          })
          .map((ch: any) => {
            const id = (ch.id || ch.name || '').toLowerCase();
            return deps.toFrontendId(id);
          })
          .filter(Boolean);
        if (jsonConfigured.length > 0) {
          channelStatusCache.configured = jsonConfigured;
          channelStatusCache.ts = Date.now();
          return;
        }
      } catch {}

      const configured: string[] = [];
      for (const line of output.split('\n')) {
        const match1 = line.match(/^-\s+(\S+)\s+.*?:\s*(configured|linked|active)/i);
        if (match1) {
          configured.push(deps.toFrontendId(match1[1].toLowerCase()));
          continue;
        }
        const match2 = line.match(/^\s*(\w[\w-]*)\s*:\s*(configured|linked|active|enabled)/i);
        if (match2 && match2[1] !== 'Channels') {
          configured.push(deps.toFrontendId(match2[1].toLowerCase()));
          continue;
        }
        const match3 = line.match(/^\s*(\w[\w-]*)\s+\[(configured|linked|active)\]/i);
        if (match3) {
          configured.push(deps.toFrontendId(match3[1].toLowerCase()));
        }
      }
      if (configured.length > 0) {
        channelStatusCache.configured = configured;
        channelStatusCache.ts = Date.now();
      }
    }).catch(() => {});

    return { success: true, configured: immediateConfigured, disconnected: immediateDisconnected };
  });

  ipcMain.handle('channel:list-supported', async () => {
    try {
      const output = await channelsListDeduped(15000);
      if (output) {
        try {
          const parsed = parseJsonShellOutput<any>(output);
          if (!parsed) {
            throw new Error('Could not parse supported channels JSON');
          }
          const arr = Array.isArray(parsed) ? parsed : (parsed.channels || parsed.items || []);
          const channels = arr.map((ch: any) => (ch.id || ch.name || '').toLowerCase()).filter(Boolean);
          if (channels.length > 0) return { success: true, channels };
        } catch {}

        const skipWords = new Set(['channels', 'no', 'available', 'configured', 'status', 'list']);
        const channels: string[] = [];
        for (const line of output.split('\n')) {
          const match = line.match(/^[-*\s]*(\w[\w-]+)/);
          if (match) {
            const name = match[1].toLowerCase();
            if (!skipWords.has(name) && name.length > 1) channels.push(name);
          }
        }
        if (channels.length > 0) return { success: true, channels };
      }
      return { success: false, channels: [] };
    } catch {
      return { success: false, channels: [] };
    }
  });
}