// Doctor checks: channel routing and agent bindings.

import type { CheckResult, FixResult, Ctx } from './types';
import { CHANNEL_BINDINGS_CHECK_TIMEOUT_MS } from './utils';
import { patchGatewayCmdStackSize } from '../openclaw-config';

// Cache for channel-bindings check to avoid slow CLI calls on every startup
let _lastBindingsCheckPass: number = 0;
const BINDINGS_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Channels supported by `openclaw channels add --channel <id>`
const CHANNELS_ADD_SUPPORTED = new Set([
  'telegram',
  'whatsapp',
  'discord',
  'irc',
  'googlechat',
  'slack',
  'signal',
  'imessage',
  'line',
]);

// --- Parsing helpers ---

function parseAgentBindings(output: string | null): any[] {
  if (!output) return [];

  const objectStart = output.indexOf('{');
  const arrayStart = output.indexOf('[');
  const jsonStart = [objectStart, arrayStart].filter(index => index >= 0).sort((a, b) => a - b)[0];
  if (jsonStart === undefined) return [];

  try {
    const parsed = JSON.parse(output.slice(jsonStart));
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.bindings)) return parsed.bindings;
    if (Array.isArray(parsed.data)) return parsed.data;
  } catch {
    return [];
  }

  return [];
}

function parseBindingsOutput(output: string | null): { ok: boolean; bindings: any[] } {
  if (!output) return { ok: false, bindings: [] };

  const normalized = output.trim();
  if (!normalized) return { ok: false, bindings: [] };

  const parseCandidate = (candidate: string): { ok: boolean; bindings: any[] } | null => {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return { ok: true, bindings: parsed };
      if (Array.isArray(parsed.bindings)) return { ok: true, bindings: parsed.bindings };
      if (Array.isArray(parsed.data)) return { ok: true, bindings: parsed.data };
      return { ok: true, bindings: [] };
    } catch {
      return null;
    }
  };

  const lines = normalized.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    const parsed = parseCandidate(line);
    if (parsed) return parsed;
  }

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch !== '{' && ch !== '[') continue;
    const parsed = parseCandidate(normalized.slice(i));
    if (parsed) return parsed;
  }

  return { ok: false, bindings: [] };
}

function getEnabledChannels(config: any | null): string[] {
  if (!config?.channels || typeof config.channels !== 'object') return [];
  return Object.entries(config.channels)
    .filter(([, value]: [string, any]) => value?.enabled)
    .map(([channelId]) => channelId);
}

function sanitizeChannelId(channelId: string): string | null {
  const trimmed = String(channelId || '').trim();
  if (!trimmed) return null;
  return /^[a-zA-Z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

function getRepairPluginPackage(channelId: string): string | null {
  if (channelId === 'local') return null;
  if (channelId === 'openclaw-weixin') return '@tencent-weixin/openclaw-weixin';
  return `@openclaw/${channelId}`;
}

function getNullDevice(platform: NodeJS.Platform) {
  return platform === 'win32' ? 'NUL' : '/dev/null';
}

function parsePluginLoadFailure(message: string): { channelId: string; missingModule: string | null } | null {
  const pluginMatch = message.match(/plugin load failed:\s*([a-zA-Z0-9_-]+):/i)
    || message.match(/\[plugins\]\s*([a-zA-Z0-9_-]+)\s*failed to load/i);
  if (!pluginMatch?.[1]) return null;
  const missingModule = message.match(/Cannot find module '([^']+)'/i)?.[1] || null;
  return { channelId: pluginMatch[1], missingModule };
}

async function repairBundledPluginRuntimeDeps(ctx: Ctx, channelId: string): Promise<boolean> {
  const installPath = ctx.config?.plugins?.installs?.[channelId]?.installPath;
  if (!installPath || !ctx.openclawPackageDir) return false;

  if (!String(installPath).startsWith(ctx.openclawPackageDir)) return false;

  const pkgPath = `${installPath}/package.json`;
  const { existsSync, readFileSync } = await import('fs');
  if (!existsSync(pkgPath)) return false;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const dependencies = Object.keys(pkg?.dependencies || {}).filter((name) => /^[a-zA-Z0-9@._/-]+$/.test(name));
    if (dependencies.length === 0) return false;

    await ctx.deps.shellRun(
      `cd "${ctx.openclawPackageDir}" && npm install --no-save ${dependencies.map((dep) => `"${dep}"`).join(' ')} 2>&1`,
      120000,
    );
    return true;
  } catch {
    return false;
  }
}

// --- Core logic ---

async function getUnboundChannels(ctx: Ctx): Promise<string[] | null> {
  const enabledChannels = getEnabledChannels(ctx.config);
  if (enabledChannels.length === 0) return [];

  // Fast path: read bindings directly from openclaw.json (already parsed as ctx.config)
  // This avoids spawning `openclaw agents bindings --json` which loads all plugins (130s+).
  const configBindings = ctx.config?.agents?.list;
  if (Array.isArray(configBindings) && configBindings.length > 0) {
    const boundChannels = new Set<string>();
    for (const agent of configBindings) {
      const bindings = agent?.bindings || agent?.routes || [];
      if (!Array.isArray(bindings)) continue;
      for (const b of bindings) {
        const ch = b?.match?.channel || b?.channel;
        if (ch) boundChannels.add(ch);
      }
    }
    return enabledChannels.filter((channelId) => !boundChannels.has(channelId));
  }

  const nullDev = getNullDevice(ctx.deps.platform);

  let output: string | null = null;
  try {
    output = await ctx.deps.shellRun('openclaw agents bindings --json', CHANNEL_BINDINGS_CHECK_TIMEOUT_MS);
  } catch {
    output = null;
  }

  let parsed = parseBindingsOutput(output);
  if (!parsed.ok) {
    output = await ctx.deps.shellExec(
      `openclaw agents bindings --json 2>${nullDev}`,
      CHANNEL_BINDINGS_CHECK_TIMEOUT_MS,
    );
    parsed = parseBindingsOutput(output);
  }

  if (!parsed.ok) return null;
  const bindings = parsed.bindings;

  const boundChannels = new Set(bindings.map((binding: any) => binding.match?.channel).filter(Boolean));
  return enabledChannels.filter((channelId) => !boundChannels.has(channelId));
}

// --- Check and fix ---

export async function checkChannelBindings(ctx: Ctx): Promise<CheckResult> {
  if (!ctx.openclawPath || !ctx.config) return { id: 'channel-bindings', label: 'Channel routing', status: 'skipped', message: 'Skipped', fixable: 'none' };
  const enabledChannels = getEnabledChannels(ctx.config);
  if (enabledChannels.length === 0) return { id: 'channel-bindings', label: 'Channel routing', status: 'pass', message: 'No channels configured', fixable: 'none' };

  // Skip expensive CLI check if we verified recently
  if (Date.now() - _lastBindingsCheckPass < BINDINGS_CACHE_TTL_MS) {
    return { id: 'channel-bindings', label: 'Channel routing', status: 'pass', message: 'All channels routed (cached)', fixable: 'none' };
  }

  try {
    const unbound = await getUnboundChannels(ctx);
    if (unbound === null) {
      const hasTelegram = enabledChannels.includes('telegram');
      return {
        id: 'channel-bindings',
        label: 'Channel routing',
        status: 'warn',
        message: 'Could not verify channel routing',
        fixable: 'auto',
        fixDescription: hasTelegram
          ? 'Run Telegram one-click repair (plugin + channel + main-agent binding)'
          : 'Run one-click channel routing repair',
      };
    }

    if (unbound.length > 0) {
      const hasTelegramUnbound = unbound.includes('telegram');
      return { id: 'channel-bindings', label: 'Channel routing', status: 'warn',
        message: `${unbound.length} channel(s) not bound to any agent`, fixable: 'auto',
        fixDescription: hasTelegramUnbound
          ? `Telegram one-click repair + bind ${unbound.join(', ')} to the main agent`
          : `Bind ${unbound.join(', ')} to the main agent`,
        detail: unbound.join(', ') };
    }

    _lastBindingsCheckPass = Date.now();
    return { id: 'channel-bindings', label: 'Channel routing', status: 'pass', message: 'All channels routed', fixable: 'none' };
  } catch {
    return {
      id: 'channel-bindings',
      label: 'Channel routing',
      status: 'warn',
      message: 'Could not verify channel routing',
      fixable: 'auto',
      fixDescription: 'Run one-click channel routing repair',
    };
  }
}

export async function fixChannelBindings(ctx: Ctx): Promise<FixResult> {
  const enabledChannels = getEnabledChannels(ctx.config);
  if (enabledChannels.length === 0) {
    return { id: 'channel-bindings', success: true, message: 'No enabled channels to repair' };
  }

  const unboundChannels = await getUnboundChannels(ctx);
  const channelsToRepair = unboundChannels === null ? enabledChannels : unboundChannels;

  if (channelsToRepair.length === 0) {
    return { id: 'channel-bindings', success: true, message: 'All channels are already bound' };
  }

  let fixed = 0;
  const failed: string[] = [];
  const repairedViaRecovery: string[] = [];

  const tryBind = async (channelId: string) => {
    await ctx.deps.shellRun(`openclaw agents bind --agent main --bind "${channelId}" 2>&1`, 30000);
  };

  for (const rawChannelId of channelsToRepair) {
    const ch = sanitizeChannelId(rawChannelId);
    if (!ch) {
      failed.push(rawChannelId);
      continue;
    }

    try {
      await tryBind(ch);
      fixed++;
      continue;
    } catch (bindErr: any) {
      const bindMessage = String(bindErr?.message || '');
      const pluginLoadFailure = parsePluginLoadFailure(bindMessage);
      if (pluginLoadFailure && await repairBundledPluginRuntimeDeps(ctx, pluginLoadFailure.channelId)) {
        try {
          await tryBind(ch);
          fixed++;
          repairedViaRecovery.push(`${ch}:deps`);
          continue;
        } catch {
          // Fall through to the existing channel recovery path.
        }
      }

      const needRecovery = /unknown channel|not found|no such channel/i.test(bindMessage) || ch === 'telegram';
      if (!needRecovery) {
        failed.push(ch);
        continue;
      }

      try {
        const pluginPackage = getRepairPluginPackage(ch);
        if (pluginPackage) {
          await ctx.deps.shellRun(`openclaw plugins install "${pluginPackage}" 2>&1`, 90000);
        }

        if (CHANNELS_ADD_SUPPORTED.has(ch)) {
          try {
            await ctx.deps.shellRun(`openclaw channels add --channel ${ch} 2>&1`, 45000);
          } catch {
            // Keep going; existing channel config may already be present.
          }
        }

        try {
          if (ctx.deps.platform === 'win32') patchGatewayCmdStackSize(ctx.deps.homedir);
          await ctx.deps.shellRun('openclaw gateway restart 2>&1', 30000);
        } catch {
          // Binding can still succeed even when restart command reports already running.
        }

        await tryBind(ch);
        fixed++;
        repairedViaRecovery.push(ch);
      } catch {
        failed.push(ch);
      }
    }
  }

  if (failed.length > 0) {
    return { id: 'channel-bindings', success: false, message: `Could not bind: ${failed.join(', ')}` };
  }

  const recoveryHint = repairedViaRecovery.length > 0
    ? ` (repaired: ${repairedViaRecovery.join(', ')})`
    : '';
  return { id: 'channel-bindings', success: true, message: `Bound ${fixed} channel(s) to main agent${recoveryHint}` };
}

// Re-export for access by index.ts if needed
export { parseAgentBindings };
