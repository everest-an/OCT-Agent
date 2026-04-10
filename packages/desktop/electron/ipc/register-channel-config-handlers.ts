import fs from 'fs';
import os from 'os';
import path from 'path';
import { ipcMain } from 'electron';
import type { CatalogEntry, ChannelDef, ConfigField } from '../channel-registry';
import {
  enforceDesktopChannelSessionIsolation,
  hardenWhatsAppDmPolicy,
  migrateLegacyChannelConfig,
  patchGatewayCmdStackSize,
} from '../openclaw-config';
import {
  isIgnorablePluginInstallError,
  resolveChannelPluginInstallSpec,
  ensureTelegramRuntimeDeps,
  ensureChannelRuntimeDeps,
} from './channel-plugin-spec';
import { clearChannelStatusCache } from './register-channel-list-handlers';
import { dedupedChannelsAddHelp, dedupedChannelsList, killActiveLoginForChannel } from '../openclaw-process-guard';

let discoveryDone = false;

const CHANNEL_ADD_IDLE_TIMEOUT_MS = 45000;
const CHANNEL_REMOVE_IDLE_TIMEOUT_MS = 30000;
const GATEWAY_RESTART_IDLE_TIMEOUT_MS = 30000;
const CHANNEL_BIND_IDLE_TIMEOUT_MS = 30000;
const CHANNEL_PAIRING_IDLE_TIMEOUT_MS = 30000;
const CHANNEL_LOGOUT_IDLE_TIMEOUT_MS = 30000;

const CHANNELS_WITH_PERSISTED_LOGIN_SESSION = new Set([
  'openclaw-weixin',
  'whatsapp',
  'signal',
]);

const RESERVED_PAIRING_WORDS = new Set([
  'TELEGRAM',
  'WHATSAPP',
  'DISCORD',
  'IMESSAGE',
  'OPENCLAW',
  'PAIRING',
  'APPROVED',
  'APPROVE',
  'PENDING',
  'CHANNEL',
]);

function sanitizeChannelId(channelId: string): string | null {
  const trimmed = String(channelId || '').trim();
  if (!trimmed) return null;
  return /^[a-zA-Z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

function isTimeoutLike(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('timed out') || lower.includes('timeout');
}

function isNpxEnoentLike(message: string): boolean {
  return /spawn\s+npx(?:\.cmd)?\s+ENOENT/i.test(message || '');
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function disableOpenClawMemoryPlugin(config: Record<string, any>) {
  const plugins = isPlainRecord(config.plugins) ? config.plugins : null;
  if (!plugins) return false;

  let changed = false;
  const entries = isPlainRecord(plugins.entries) ? plugins.entries : null;
  const memoryEntry = entries && isPlainRecord(entries['openclaw-memory'])
    ? entries['openclaw-memory']
    : null;
  if (entries && memoryEntry && memoryEntry.enabled !== false) {
    entries['openclaw-memory'] = {
      ...memoryEntry,
      enabled: false,
    };
    changed = true;
  }

  if (Array.isArray(plugins.allow)) {
    const nextAllow = plugins.allow.filter((id: unknown) => String(id || '') !== 'openclaw-memory');
    if (nextAllow.length !== plugins.allow.length) {
      plugins.allow = nextAllow;
      changed = true;
    }
  }

  if (isPlainRecord(plugins.slots) && plugins.slots.memory === 'openclaw-memory') {
    delete plugins.slots.memory;
    changed = true;
    if (Object.keys(plugins.slots).length === 0) {
      delete plugins.slots;
    }
  }

  return changed;
}

function setNestedValue(target: Record<string, any>, nestedPath: string, value: unknown) {
  const parts = nestedPath.split('.').filter(Boolean);
  if (parts.length === 0) return;

  let cursor: Record<string, any> = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainRecord(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function getNestedValue(source: Record<string, any>, nestedPath: string): unknown {
  const parts = nestedPath.split('.').filter(Boolean);
  let cursor: unknown = source;
  for (const part of parts) {
    if (!isPlainRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function isAccountScopedField(field: ConfigField): boolean {
  return typeof field.configPath === 'string' && field.configPath.length > 0;
}

function applyStoredChannelConfig(channelDef: ChannelDef | undefined, existingConfig: Record<string, any>, inputConfig: Record<string, string>) {
  const nextConfig: Record<string, any> = isPlainRecord(existingConfig) ? { ...existingConfig } : {};
  const fields = channelDef?.configFields || [];
  const handledKeys = new Set<string>();

  for (const field of fields) {
    const value = inputConfig[field.key];
    if (!value) continue;
    handledKeys.add(field.key);

    if (isAccountScopedField(field)) {
      setNestedValue(nextConfig, `${field.configPath}.${field.key}`, value);
    } else {
      nextConfig[field.key] = value;
    }
  }

  for (const [key, value] of Object.entries(inputConfig)) {
    if (!value || handledKeys.has(key)) continue;
    nextConfig[key] = value;
  }

  const accountScopedFields = fields.filter(isAccountScopedField);
  if (accountScopedFields.length > 0) {
    for (const field of accountScopedFields) {
      delete nextConfig[field.key];
    }

    if (!fields.some((field) => field.key === 'token')) {
      delete nextConfig.token;
    }

    setNestedValue(nextConfig, 'accounts.default.enabled', true);
  }

  return nextConfig;
}

function flattenStoredChannelConfig(channelDef: ChannelDef | undefined, storedConfig: Record<string, any>) {
  if (!channelDef || !Array.isArray(channelDef.configFields) || channelDef.configFields.length === 0) {
    return storedConfig;
  }

  const flattened: Record<string, any> = {};
  for (const field of channelDef.configFields) {
    const value = isAccountScopedField(field)
      ? getNestedValue(storedConfig, `${field.configPath}.${field.key}`)
      : storedConfig[field.key];
    if (typeof value === 'string' && value) {
      flattened[field.key] = value;
    }
  }

  // Fallback: if field-based extraction found nothing, include any non-meta
  // string values from the stored config. This handles key mismatches between
  // dynamic configFields and OpenClaw's internal storage (e.g. token vs botToken).
  if (Object.keys(flattened).length === 0) {
    for (const [key, value] of Object.entries(storedConfig)) {
      if (key === 'enabled') continue;
      if (typeof value === 'string' && value) flattened[key] = value;
    }
  }

  return flattened;
}

function hasRequiredChannelCredentials(channelDef: ChannelDef | undefined, storedConfig: Record<string, any>): boolean {
  if (!channelDef || !Array.isArray(channelDef.configFields) || channelDef.configFields.length === 0) {
    return Object.keys(storedConfig).some((key) => key !== 'enabled' && !!storedConfig[key]);
  }

  const fieldCheck = channelDef.configFields.every((field) => {
    if (field.required === false) return true;
    const value = isAccountScopedField(field)
      ? getNestedValue(storedConfig, `${field.configPath}.${field.key}`)
      : storedConfig[field.key];
    return typeof value === 'string' ? value.trim().length > 0 : !!value;
  });

  if (fieldCheck) return true;

  // Fallback: OpenClaw may store credentials under a different key than what
  // dynamic configFields declare (e.g. CLI --token → stored as botToken for
  // Telegram). Accept the config if any non-meta string value exists.
  return Object.keys(storedConfig).some((key) =>
    key !== 'enabled' && typeof storedConfig[key] === 'string' && storedConfig[key].trim().length > 0,
  );
}

function channelAppearsConfigured(listOutput: string | null, openclawId: string): boolean {
  if (!listOutput) return false;
  const target = openclawId.toLowerCase();
  return listOutput
    .split('\n')
    .some((line) => {
      const lower = line.toLowerCase();
      if (!lower.includes(target)) return false;
      return /configured|enabled|active|linked/i.test(line);
    });
}

function isGatewayActiveOutput(output: string | null): boolean {
  if (!output) return false;
  const lower = output.toLowerCase();
  const authGatedHandshake =
    lower.includes('device-required')
    || lower.includes('pairing-required')
    || lower.includes('pairing required')
    || lower.includes('scope-upgrade');

  if (authGatedHandshake) {
    return true;
  }

  if (lower.includes('not reachable') || lower.includes('timeout after')) {
    return false;
  }

  return (
    /rpc probe:\s*ok/i.test(output)
    || /runtime:\s*running/i.test(output)
    || /\|\s*gateway\s*\|\s*reachable\b/i.test(output)
    || /\bgateway\b[\s\S]{0,80}\breachable\b/i.test(output)
    || /\bgateway\b[\s\S]{0,80}\bactive\b/i.test(output)
  );
}

function sanitizePairingCode(pairingCode: string): string | null {
  const normalized = String(pairingCode || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!normalized) return null;
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(normalized)) return null;
  if (RESERVED_PAIRING_WORDS.has(normalized)) return null;
  return normalized;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractPairingCodeFromInput(rawInput: string): string | null {
  const input = String(rawInput || '').trim();
  if (!input) return null;

  // 1) Any `openclaw pairing approve ...` form, including:
  //    - openclaw pairing approve <channel> <CODE>
  //    - openclaw pairing approve --channel <channel> <CODE>
  //    - openclaw pairing approve <CODE>
  const commandMatch = input.match(/openclaw\s+pairing\s+approve\b([\s\S]*)/i);
  if (commandMatch?.[1]) {
    const commandCodes = Array.from(commandMatch[1].toUpperCase().matchAll(/\b([A-HJ-NP-Z2-9]{8})\b/g)).map((m) => m[1]);
    if (commandCodes.length > 0) {
      return commandCodes[commandCodes.length - 1];
    }
  }

  // 2) "Pairing code: XXXXXXXX" format
  const labelMatch = input.match(/pairing\s*code\s*[:：]\s*([A-HJ-NP-Z2-9]{8})/i);
  if (labelMatch?.[1]) return labelMatch[1].toUpperCase();

  // 3) Raw code only input
  const rawCode = sanitizePairingCode(input);
  if (rawCode) return rawCode;

  // 4) Single candidate fallback only when unambiguous
  const candidates = Array.from(input.toUpperCase().matchAll(/\b([A-HJ-NP-Z2-9]{8})\b/g)).map((m) => m[1]);
  const unique = Array.from(new Set(candidates));
  if (unique.length === 1) return unique[0];

  return null;
}

function collectPairingCodesFromValue(value: any, out: string[]) {
  if (typeof value === 'string') {
    const code = sanitizePairingCode(value);
    if (code) out.push(code);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPairingCodesFromValue(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, any>;
    for (const key of Object.keys(record)) {
      const val = record[key];
      if (/code|pair/i.test(key) && typeof val === 'string') {
        const code = sanitizePairingCode(val);
        if (code) out.push(code);
      }
      collectPairingCodesFromValue(val, out);
    }
  }
}

function extractPendingPairingCodes(output: string | null): string[] {
  if (!output) return [];
  if (/no pending/i.test(output)) return [];

  const unique = new Set<string>();
  const ordered: string[] = [];
  const addCode = (code: string | null) => {
    if (!code || unique.has(code)) return;
    unique.add(code);
    ordered.push(code);
  };

  const objectStart = output.indexOf('{');
  const arrayStart = output.indexOf('[');
  const jsonStart = [objectStart, arrayStart].filter(index => index >= 0).sort((a, b) => a - b)[0];
  if (jsonStart !== undefined) {
    try {
      const parsed = JSON.parse(output.slice(jsonStart));
      const collected: string[] = [];
      collectPairingCodesFromValue(parsed, collected);
      for (const code of collected) addCode(code);
    } catch {
      // Fall back to line regex parsing.
    }
  }

  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    if (/openclaw\s+pairing\s+approve/i.test(line)) {
      const commandCodes = line.toUpperCase().match(/\b[A-HJ-NP-Z2-9]{8}\b/g) || [];
      if (commandCodes.length > 0) {
        addCode(sanitizePairingCode(commandCodes[commandCodes.length - 1]));
      }
    }

    const labelMatch = line.match(/pairing\s*code\s*[:=]\s*([A-HJ-NP-Z2-9]{8})/i);
    if (labelMatch?.[1]) addCode(sanitizePairingCode(labelMatch[1]));

    if (!/pair|pending|approve|code/i.test(line)) continue;
    const candidates = line.toUpperCase().match(/\b[A-HJ-NP-Z2-9]{8}\b/g) || [];
    for (const raw of candidates) addCode(sanitizePairingCode(raw));
  }

  return ordered;
}

function describeTelegramPairingState(output: string | null): string | null {
  if (!output) return null;

  if (/no pending/i.test(output)) {
    return 'Telegram is connected. To generate a pairing code, open Telegram and send your bot a first direct message. OpenClaw only creates the code after that inbound message arrives.';
  }

  const codes = extractPendingPairingCodes(output);
  if (codes.length > 0) {
    return `Telegram is connected. Pairing code: ${codes[0]}. Approve it below to enable replies.`;
  }

  return null;
}

function coerceTelegramCliConfig(channelDef: ChannelDef | undefined, config: Record<string, string>) {
  if (!channelDef) return config;
  if (channelDef.openclawId !== 'telegram' && channelDef.id !== 'telegram') return config;

  const tokenValue = config.botToken || config.token;
  if (!tokenValue) return config;

  const wantsToken = channelDef.configFields?.some((field) => field.key === 'token');
  const wantsBotToken = channelDef.configFields?.some((field) => field.key === 'botToken');
  const next = { ...config };
  if (wantsToken && !next.token) next.token = tokenValue;
  if (wantsBotToken && !next.botToken) next.botToken = tokenValue;
  return next;
}

function normalizeTelegramConfigInFile(config: any) {
  migrateLegacyChannelConfig(config);
  enforceDesktopChannelSessionIsolation(config);
  hardenWhatsAppDmPolicy(config);
  return config;
}

function sanitizeLegacyChannelConfigInFile(home: string, openclawId?: string): boolean {
  void openclawId;
  try {
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let changed = migrateLegacyChannelConfig(existing);
    changed = enforceDesktopChannelSessionIsolation(existing) || changed;
    changed = hardenWhatsAppDmPolicy(existing) || changed;
    if (!changed) return false;

    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
    return true;
  } catch {
    return false;
  }
}

function isChannelBoundToMainAgentInConfig(home: string, openclawId: string): boolean {
  try {
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!Array.isArray(existing?.bindings)) return false;

    return existing.bindings.some((binding: any) => {
      if (!isPlainRecord(binding)) return false;
      if (binding.agentId !== 'main') return false;
      const match = isPlainRecord(binding.match) ? binding.match : null;
      return match?.channel === openclawId;
    });
  } catch {
    return false;
  }
}

function formatChannelActionError(openclawId: string, action: 'install' | 'bind', rawError: string): string {
  const message = (rawError || '').trim();

  if (isTimeoutLike(message)) {
    if (openclawId === 'telegram') {
      return 'OpenClaw is still loading Telegram or waiting for pairing confirmation. Wait 20-60 seconds, run "openclaw pairing list telegram", approve any pending code, then retry.';
    }
    return `OpenClaw is still loading channel "${openclawId}". Please wait a moment and retry.`;
  }

  if (isNpxEnoentLike(message)) {
    return 'OpenClaw could not launch required helper tools (npx not found in runtime PATH). Please rerun Setup to repair the runtime, then retry channel setup.';
  }

  if (/Unknown channel/i.test(message)) {
    return `OpenClaw does not recognize channel "${openclawId}" yet. Please reinstall the channel plugin and retry.`;
  }

  if (/plugin|install/i.test(message) && action === 'install') {
    return `OpenClaw failed to install the plugin for "${openclawId}". ${message.slice(0, 220)}`;
  }

  if (action === 'bind') {
    return `Channel "${openclawId}" was saved, but binding to the main agent failed. ${message.slice(0, 220)}`;
  }

  return message.slice(0, 300) || `OpenClaw ${action} failed for channel "${openclawId}".`;
}

function getManagedRuntimeDist(home: string): string | undefined {
  return [
    path.join(home, '.awareness-claw', 'openclaw-runtime', 'node_modules', 'openclaw', 'dist'),
    path.join(home, '.awareness-claw', 'openclaw-runtime', 'lib', 'node_modules', 'openclaw', 'dist'),
  ].find((candidate) => fs.existsSync(candidate));
}

export function registerChannelConfigHandlers(deps: {
  home: string;
  safeShellExecAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  readShellOutputAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  runAsync: (cmd: string, timeoutMs?: number) => Promise<string>;
  discoverOpenClawChannels: () => void;
  parseCliHelp: (helpOutput: string) => {
    cliChannels: Set<string>;
    channelFields: Map<string, ConfigField[]>;
  };
  applyCliHelp: (
    cliChannels: Set<string>,
    channelFields: Map<string, ConfigField[]>,
  ) => void;
  parseChannelCapabilitiesJson?: (capabilitiesOutput: string) => {
    channelFields: Map<string, ConfigField[]>;
  };
  applyChannelCapabilities?: (channelFields: Map<string, ConfigField[]>) => void;
  mergeCatalog: (entries: CatalogEntry[]) => void;
  mergeChannelOptions: (channelIds: string[]) => void;
  getAllChannels: () => Array<unknown>;
  serializeRegistry: () => Array<unknown>;
  getChannel: (channelId: string) => ChannelDef | undefined;
  getChannelByOpenclawId?: (openclawId: string) => ChannelDef | undefined;
  buildCLIFlags: (channelDef: ChannelDef, config: Record<string, string>) => string;
  toOpenclawId: (channelId: string) => string;
}) {
  const OPENCLAW_CONFIG_PATH = path.join(deps.home, '.openclaw', 'openclaw.json');

  const wrapOpenclawConfigPathCommand = (command: string, scopedConfigPath: string) => {
    if (process.platform === 'win32') {
      const escapedPath = scopedConfigPath.replace(/"/g, '""');
      return `set "OPENCLAW_CONFIG_PATH=${escapedPath}" && ${command}`;
    }
    const escapedPath = scopedConfigPath.replace(/"/g, '\\"');
    return `OPENCLAW_CONFIG_PATH="${escapedPath}" ${command}`;
  };

  const runCommandWithScopedConfig = async (command: string, timeoutMs: number) => {
    let tempConfigPath: string | null = null;
    try {
      const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (!isPlainRecord(parsed)) {
        return {
          usedScopedConfig: false,
          output: null as string | null,
          error: null as string | null,
        };
      }

      const isolated = JSON.parse(JSON.stringify(parsed));
      const changed = disableOpenClawMemoryPlugin(isolated);
      if (!changed) {
        return {
          usedScopedConfig: false,
          output: null as string | null,
          error: null as string | null,
        };
      }

      tempConfigPath = path.join(
        os.tmpdir(),
        `awarenessclaw-channel-cmd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );
      fs.writeFileSync(tempConfigPath, JSON.stringify(isolated, null, 2));

      try {
        const output = await deps.runAsync(wrapOpenclawConfigPathCommand(command, tempConfigPath), timeoutMs);
        return {
          usedScopedConfig: true,
          output,
          error: null as string | null,
        };
      } catch (scopedErr: unknown) {
        return {
          usedScopedConfig: true,
          output: null as string | null,
          error: scopedErr instanceof Error ? scopedErr.message || String(scopedErr) : String(scopedErr || ''),
        };
      }
    } catch {
      return {
        usedScopedConfig: false,
        output: null as string | null,
        error: null as string | null,
      };
    } finally {
      if (tempConfigPath) {
        try { fs.rmSync(tempConfigPath, { force: true }); } catch {}
      }
    }
  };

  const bindChannelToMainAgent = async (openclawId: string) => {
    if (isChannelBoundToMainAgentInConfig(deps.home, openclawId)) {
      return { success: true as const, retried: false as const, skipped: true as const };
    }

    try {
      await deps.runAsync(`openclaw agents bind --agent main --bind ${openclawId} 2>&1`, CHANNEL_BIND_IDLE_TIMEOUT_MS);
      return { success: true as const, retried: false as const, skipped: false as const };
    } catch {
      if (process.platform === 'win32') patchGatewayCmdStackSize(deps.home);
      try { await deps.runAsync('openclaw gateway restart 2>&1', GATEWAY_RESTART_IDLE_TIMEOUT_MS); } catch {}
      try {
        await deps.runAsync(`openclaw agents bind --agent main --bind ${openclawId} 2>&1`, CHANNEL_BIND_IDLE_TIMEOUT_MS);
        return { success: true as const, retried: true as const, skipped: false as const };
      } catch (retryErr: any) {
        return {
          success: false as const,
          retried: true as const,
          skipped: false as const,
          error: (retryErr?.message || String(retryErr)).slice(0, 240),
        };
      }
    }
  };

  const detectChannelConnectivity = async (openclawId: string, channelId: string) => {
    // Fast path: check openclaw.json directly to skip the slow `openclaw channels list`
    // CLI call (which triggers full plugin preload on every invocation).
    let listedFromFile = false;
    try {
      const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
      const cfg = JSON.parse(raw);
      listedFromFile = cfg?.channels?.[openclawId]?.enabled === true;
    } catch { /* fall through to CLI check */ }

    // Still probe the gateway status — this is lighter than `channels list`.
    const statusOutput = await deps.readShellOutputAsync('openclaw channels status --probe 2>&1', CHANNEL_ADD_IDLE_TIMEOUT_MS);

    let listed = listedFromFile;
    if (!listedFromFile) {
      const listOutput = await dedupedChannelsList(deps.readShellOutputAsync, CHANNEL_ADD_IDLE_TIMEOUT_MS);
      listed = !!listOutput && (
        listOutput.toLowerCase().includes(openclawId.toLowerCase())
        || listOutput.toLowerCase().includes(channelId.toLowerCase())
      );
    }

    let gatewayActive = isGatewayActiveOutput(statusOutput);
    if (!gatewayActive) {
      // Prefer gateway-only status check here. `openclaw status --deep` can load
      // all plugins and trigger unrelated failures while pairing/connectivity is
      // being confirmed.
      const gatewayStatusOutput = await deps.readShellOutputAsync('openclaw gateway status 2>&1', CHANNEL_ADD_IDLE_TIMEOUT_MS);
      gatewayActive = isGatewayActiveOutput(gatewayStatusOutput);
    }

    return {
      listed,
      gatewayActive,
      ready: listed && gatewayActive,
    };
  };

  ipcMain.handle('channel:get-registry', async () => {
    sanitizeLegacyChannelConfigInFile(deps.home);

    const stderrRedirect = process.platform === 'win32' ? '2>NUL' : '2>/dev/null';
    const dlog = (msg: string) => { try { fs.appendFileSync(path.join(os.homedir(), '.awareness-channel-debug.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch { } };
    const enrichRuntimeMetadata = async (distDir?: string) => {
      const debugLog = (msg: string) => { try { fs.appendFileSync(path.join(deps.home, '.awareness-channel-debug.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch {} };

      if (distDir) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(distDir, 'cli-startup-metadata.json'), 'utf8'));
          if (meta.channelOptions) {
            deps.mergeChannelOptions(meta.channelOptions as string[]);
            debugLog(`metadata merged: ${meta.channelOptions.length} options`);
          }
        } catch (e: any) {
          debugLog(`metadata error: ${e.message}`);
        }

        try {
          const catalog = JSON.parse(fs.readFileSync(path.join(distDir, 'channel-catalog.json'), 'utf8'));
          if (catalog.entries) {
            deps.mergeCatalog(catalog.entries as CatalogEntry[]);
            debugLog(`catalog merged: ${catalog.entries.length} entries`);
          }
        } catch (e: any) {
          debugLog(`catalog error: ${e.message}`);
        }
      }

      if (deps.parseChannelCapabilitiesJson && deps.applyChannelCapabilities) {
        try {
          const scopedCapabilities = await runCommandWithScopedConfig('openclaw channels capabilities --channel all --json 2>&1', 15000);
          let capabilitiesOutput = scopedCapabilities.output;
          if (!capabilitiesOutput && !scopedCapabilities.usedScopedConfig) {
            capabilitiesOutput = await deps.safeShellExecAsync(`openclaw channels capabilities --channel all --json ${stderrRedirect}`, 15000);
          }
          if (capabilitiesOutput) {
            const { channelFields } = deps.parseChannelCapabilitiesJson(capabilitiesOutput);
            if (channelFields.size > 0) {
              deps.applyChannelCapabilities(channelFields);
              debugLog(`capabilities fields applied for: ${[...channelFields.keys()].join(', ')}`);
              return;
            }
          }
        } catch (e: any) {
          debugLog(`capabilities error: ${e.message}`);
        }
      }

      try {
        const helpOut = await dedupedChannelsAddHelp(deps.safeShellExecAsync, 5000, stderrRedirect);
        if (helpOut) {
          const { cliChannels, channelFields } = deps.parseCliHelp(helpOut);
          if (cliChannels.size > 0 || channelFields.size > 0) {
            deps.applyCliHelp(cliChannels, channelFields);
            debugLog(`help fallback applied: channels=${cliChannels.size}, fields=${channelFields.size}`);
          }
        }
      } catch (e: any) {
        debugLog(`help fallback error: ${e.message}`);
      }
    };

    dlog(`ENTRY: channel:get-registry called. _discoveryDone=${discoveryDone}, HOME=${os.homedir()}`);
    if (!discoveryDone) {
      discoveryDone = true;
      deps.discoverOpenClawChannels();
      const debugLog = (msg: string) => { try { fs.appendFileSync(path.join(deps.home, '.awareness-channel-debug.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch {} };
      if (deps.getAllChannels().length <= 2) {
        debugLog(`Sync discovery found only ${deps.getAllChannels().length} channels, trying async...`);
        try {
          const managedDist = getManagedRuntimeDist(deps.home);
          if (managedDist) {
            debugLog(`async managed distDir: ${managedDist} exists=true`);
            await enrichRuntimeMetadata(managedDist);
            debugLog(`Final channel count: ${deps.getAllChannels().length}`);
          } else {
            const globalRoot = await deps.safeShellExecAsync(`npm root -g ${stderrRedirect}`, 5000);
            debugLog(`async npm root -g: "${globalRoot?.trim()}"`);
            if (globalRoot) {
              const distDir = path.join(globalRoot.trim(), 'openclaw', 'dist');
              const exists = fs.existsSync(distDir);
              debugLog(`async distDir: ${distDir} exists=${exists}`);
              if (exists) {
                await enrichRuntimeMetadata(distDir);
                debugLog(`Final channel count: ${deps.getAllChannels().length}`);
              }
            }
          }
        } catch (e: any) {
          debugLog(`async fallback error: ${e.message}`);
        }
      } else {
        const managedDist = getManagedRuntimeDist(deps.home);
        const globalRoot = managedDist ? null : await deps.safeShellExecAsync(`npm root -g ${stderrRedirect}`, 5000);
        const distDir = managedDist || (globalRoot ? path.join(globalRoot.trim(), 'openclaw', 'dist') : undefined);
        if (distDir && fs.existsSync(distDir)) {
          await enrichRuntimeMetadata(distDir);
        }
        debugLog(`Sync discovery OK: ${deps.getAllChannels().length} channels`);
      }
    }
    return { channels: deps.serializeRegistry() };
  });

  ipcMain.handle('channel:save', async (_e, channelId: string, config: Record<string, string>) => {
    try {
      const safeChannelId = sanitizeChannelId(channelId);
      if (!safeChannelId || safeChannelId !== channelId) {
        return { success: false, error: `Invalid channel ID: ${channelId}` };
      }

      const channelDef = deps.getChannel(safeChannelId);
      const openclawId = channelDef?.openclawId || channelId;
      const safeOpenclawId = sanitizeChannelId(openclawId);
      if (!safeOpenclawId) {
        return { success: false, error: `Invalid OpenClaw channel ID: ${openclawId}` };
      }

      sanitizeLegacyChannelConfigInFile(deps.home, safeOpenclawId);

      const pluginPkg = (
        await resolveChannelPluginInstallSpec({
          pluginId: safeOpenclawId,
          preferredSpec: channelDef?.pluginPackage || null,
          getChannel: deps.getChannel,
          getChannelByOpenclawId: deps.getChannelByOpenclawId,
          readShellOutputAsync: deps.readShellOutputAsync,
        })
      ) || channelDef?.pluginPackage || `@openclaw/${openclawId}`;
      // Force json-direct when channel has account-scoped credential fields
      // (e.g. Slack appToken/botToken under accounts.default) — CLI flags can't
      // express nested config paths.
      const hasAccountScopedFields = channelDef?.configFields?.some(isAccountScopedField) || false;
      const saveStrategy = hasAccountScopedFields ? 'json-direct' : (channelDef?.saveStrategy || 'cli');
      const configForCli = safeOpenclawId === 'telegram' ? coerceTelegramCliConfig(channelDef, config) : config;
      let pluginInstallError: string | null = null;

      // Channel runtime-deps fix: ensure external deps (grammy, @buape/carbon,
      // @slack/bolt, silk-wasm, etc.) are accessible before any CLI command that
      // loads the channel plugin (see channel-plugin-spec.ts).
      ensureChannelRuntimeDeps(safeOpenclawId);

      try {
        await deps.runAsync(`openclaw plugins install "${pluginPkg}" 2>&1`, 60000);
      } catch (err: any) {
        const installMessage = err?.message || String(err);
        if (process.platform === 'win32' && isNpxEnoentLike(installMessage)) {
          const scopedInstall = await runCommandWithScopedConfig(`openclaw plugins install "${pluginPkg}" 2>&1`, 60000);
          if (!scopedInstall.usedScopedConfig) {
            pluginInstallError = installMessage;
          } else if (scopedInstall.error && !isIgnorablePluginInstallError(scopedInstall.error)) {
            pluginInstallError = scopedInstall.error;
          }
        } else if (!isIgnorablePluginInstallError(installMessage)) {
          pluginInstallError = installMessage;
        }
      }

      if (saveStrategy === 'json-direct') {
        const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
        let existing: any = {};
        try { existing = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
        if (!existing.channels) existing.channels = {};
        existing.channels[safeOpenclawId] = applyStoredChannelConfig(channelDef, existing.channels[safeOpenclawId], config);
        existing.channels[safeOpenclawId].enabled = true;
        normalizeTelegramConfigInFile(existing);
        fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
      } else {
        const cliFlags = channelDef ? deps.buildCLIFlags(channelDef, configForCli) : '';
        const addCmd = `openclaw channels add --channel ${safeOpenclawId} ${cliFlags} 2>&1`;
        try {
          await deps.runAsync(addCmd, CHANNEL_ADD_IDLE_TIMEOUT_MS);
        } catch (firstErr: any) {
          const msg = firstErr.message || '';
          if (msg.includes('already') || msg.includes('exists')) {
            try { await deps.runAsync(`openclaw channels remove --channel ${safeOpenclawId} 2>&1`, CHANNEL_REMOVE_IDLE_TIMEOUT_MS); } catch {}
            try {
              await deps.runAsync(addCmd, CHANNEL_ADD_IDLE_TIMEOUT_MS);
            } catch (retryErr: any) {
              const retryMsg = retryErr?.message || String(retryErr);
              if (isTimeoutLike(retryMsg)) {
                const listOutput = await dedupedChannelsList(deps.readShellOutputAsync, CHANNEL_ADD_IDLE_TIMEOUT_MS);
                if (!channelAppearsConfigured(listOutput, safeOpenclawId)) {
                  return { success: false, error: formatChannelActionError(safeOpenclawId, 'install', retryMsg) };
                }
              } else {
                return { success: false, error: retryMsg.slice(0, 300) };
              }
            }
          } else {
            if (isTimeoutLike(msg)) {
              const listOutput = await dedupedChannelsList(deps.readShellOutputAsync, CHANNEL_ADD_IDLE_TIMEOUT_MS);
              if (!channelAppearsConfigured(listOutput, safeOpenclawId)) {
                return { success: false, error: formatChannelActionError(safeOpenclawId, 'install', msg) };
              }
            } else {
              return { success: false, error: msg.slice(0, 300) };
            }
          }
        }
      }

      if (safeOpenclawId === 'telegram') {
        try {
          const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
          const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          normalizeTelegramConfigInFile(existing);
          fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
        } catch {}
      }

      // Defensive: ensure channels[id].enabled = true in openclaw.json.
      // For json-direct channels enabled:true is already written above.
      // For cli-strategy channels, `openclaw channels add` should set it, but
      // some bundled channel stubs omit the flag — write it defensively.
      if (saveStrategy !== 'json-direct') {
        try {
          const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
          const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          if (isPlainRecord(existing)) {
            if (!isPlainRecord(existing.channels)) existing.channels = {};
            if (!isPlainRecord(existing.channels[safeOpenclawId])) existing.channels[safeOpenclawId] = {};
            if (!existing.channels[safeOpenclawId].enabled) {
              existing.channels[safeOpenclawId].enabled = true;
              fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
            }
          }
        } catch { /* non-fatal */ }
      }

      sanitizeLegacyChannelConfigInFile(deps.home, safeOpenclawId);

      if (process.platform === 'win32') patchGatewayCmdStackSize(deps.home);
      try { await deps.runAsync('openclaw gateway restart 2>&1', GATEWAY_RESTART_IDLE_TIMEOUT_MS); } catch {}

      const bindResult = await bindChannelToMainAgent(safeOpenclawId);
      if (!bindResult.success) {
        const combined = pluginInstallError ? `${pluginInstallError}\n${bindResult.error}` : bindResult.error;
        return { success: false, error: formatChannelActionError(safeOpenclawId, 'bind', combined) };
      }

      // Flush the channel list cache so the next channel:list-configured call
      // returns fresh data immediately without waiting for the CLI refresh.
      clearChannelStatusCache();

      return { success: true };
    } catch (err: any) {
      return { success: false, error: (err.message || String(err)).slice(0, 300) };
    }
  });

  ipcMain.handle('channel:pairing-approve', async (_e, channelId: string, pairingCode: string) => {
    try {
      const safeChannelId = sanitizeChannelId(channelId);
      if (!safeChannelId || safeChannelId !== channelId) {
        return { success: false, error: `Invalid channel ID: ${channelId}` };
      }

      const channelDef = deps.getChannel(safeChannelId);
      const openclawId = channelDef?.openclawId || deps.toOpenclawId(safeChannelId) || safeChannelId;
      const safeOpenclawId = sanitizeChannelId(openclawId);
      if (!safeOpenclawId) {
        return { success: false, error: `Invalid OpenClaw channel ID: ${openclawId}` };
      }

      sanitizeLegacyChannelConfigInFile(deps.home, safeOpenclawId);

      const pairingChannelName = channelDef?.label || safeChannelId;

      const safePairingCode = extractPairingCodeFromInput(pairingCode);
      if (!safePairingCode) {
        return {
          success: false,
          error: 'Could not parse pairing code. Paste the 8-character code, or paste the full line containing "openclaw pairing approve ...".',
        };
      }

      const pendingOutput = await deps.readShellOutputAsync(`openclaw pairing list ${safeOpenclawId} 2>&1`, CHANNEL_PAIRING_IDLE_TIMEOUT_MS);
      if (!pendingOutput) {
        return {
          success: false,
          error: 'Could not verify pending pairing requests yet. Please retry in a few seconds.',
        };
      }

      const codeRegex = new RegExp(`\\b${escapeRegExp(safePairingCode)}\\b`, 'i');
      if (!codeRegex.test(pendingOutput)) {
        if (/no pending|none|empty/i.test(pendingOutput)) {
          return {
            success: false,
            error: `No pending pairing request found. Send a new ${pairingChannelName} message to get a fresh code, then try again.`,
          };
        }
        return {
          success: false,
          error: `Pairing code ${safePairingCode} is not in the current pending list. Please use the latest code shown by ${pairingChannelName}.`,
        };
      }

      try {
        const notifyFlag = safeOpenclawId === 'whatsapp' ? ' --notify' : '';
        await deps.runAsync(`openclaw pairing approve --channel ${safeOpenclawId} ${safePairingCode}${notifyFlag} 2>&1`, CHANNEL_PAIRING_IDLE_TIMEOUT_MS);
      } catch (approveErr: any) {
        const msg = (approveErr?.message || String(approveErr)).slice(0, 260);
        return {
          success: false,
          error: isTimeoutLike(msg)
            ? 'Pairing approve timed out. Please retry after OpenClaw finishes loading plugins.'
            : msg,
        };
      }

      const bindResult = await bindChannelToMainAgent(safeOpenclawId);
      if (!bindResult.success) {
        return {
          success: false,
          error: `Pairing approved, but channel binding failed: ${bindResult.error}`,
        };
      }

      sanitizeLegacyChannelConfigInFile(deps.home, safeOpenclawId);

      const connectivity = await detectChannelConnectivity(safeOpenclawId, safeChannelId);
      if (connectivity.ready) {
        return {
          success: true,
          message: `Pairing approved and ${safeChannelId} is ready.`,
          connectivity,
          bindRetried: bindResult.retried,
        };
      }

      return {
        success: true,
        pendingConfirmation: true,
        message: 'Pairing approved. OpenClaw is still syncing the channel state. Please retry in a few seconds.',
        connectivity,
        bindRetried: bindResult.retried,
      };
    } catch (err: any) {
      return {
        success: false,
        error: (err?.message || String(err)).slice(0, 300),
      };
    }
  });

  ipcMain.handle('channel:pairing-latest-code', async (_e, channelId: string) => {
    try {
      const safeChannelId = sanitizeChannelId(channelId);
      if (!safeChannelId || safeChannelId !== channelId) {
        return { success: false, error: `Invalid channel ID: ${channelId}` };
      }

      const channelDef = deps.getChannel(safeChannelId);
      const openclawId = channelDef?.openclawId || deps.toOpenclawId(safeChannelId) || safeChannelId;
      const safeOpenclawId = sanitizeChannelId(openclawId);
      if (!safeOpenclawId) {
        return { success: false, error: `Invalid OpenClaw channel ID: ${openclawId}` };
      }

      const pairingChannelName = channelDef?.label || safeChannelId;

      const pendingOutput = await deps.readShellOutputAsync(`openclaw pairing list ${safeOpenclawId} 2>&1`, CHANNEL_PAIRING_IDLE_TIMEOUT_MS);
      if (!pendingOutput) {
        return { success: false, error: 'Could not read pending pairing requests yet.' };
      }

      const codes = extractPendingPairingCodes(pendingOutput);
      if (codes.length === 0) {
        return {
          success: false,
          error: `No pending pairing code found. Send a new ${pairingChannelName} message to generate one.`,
        };
      }

      return {
        success: true,
        code: codes[0],
        codes,
      };
    } catch (err: any) {
      return {
        success: false,
        error: (err?.message || String(err)).slice(0, 300),
      };
    }
  });

  // ── Disconnect (soft) — kill worker + disable, keep config for easy reconnect ──
  ipcMain.handle('channel:disconnect', async (_e, channelId: string) => {
    try {
      const channelDef = deps.getChannel(channelId);
      const openclawId = channelDef?.openclawId || channelId;

      // 1. Kill running login worker (if any).
      await killActiveLoginForChannel(openclawId).catch(() => {});

      // 2. Set enabled: false in openclaw.json (keep all other config intact).
      try {
        const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
        const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const key = existing.channels?.[openclawId] ? openclawId : channelId;
        if (existing.channels?.[key]) {
          existing.channels[key].enabled = false;
          fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
        }
      } catch { /* config file may not exist */ }

      // 3. Restart gateway so the channel stops receiving messages.
      if (process.platform === 'win32') patchGatewayCmdStackSize(deps.home);
      try { await deps.runAsync('openclaw gateway restart 2>&1', GATEWAY_RESTART_IDLE_TIMEOUT_MS); } catch {}

      // 4. Flush cache so UI reflects the new state immediately.
      clearChannelStatusCache();

      return { success: true };
    } catch (err: any) {
      return { success: false, error: (err.message || String(err)).slice(0, 300) };
    }
  });

  // ── Remove (hard) — full deletion: unbind + purge config + restart ──
  ipcMain.handle('channel:remove', async (_e, channelId: string) => {
    try {
      const channelDef = deps.getChannel(channelId);
      const openclawId = channelDef?.openclawId || channelId;

      // 0. Kill any running login worker for this channel BEFORE removing config.
      // Without this, the bot worker stays alive after the config is deleted, which
      // produces the half-broken state seen in production: WeChat session still
      // connected to a now-stale config, leading to "connected but not replying" or
      // "channel not found" errors. tree-kill (taskkill /T /F on Windows) ensures
      // both the cmd.exe wrapper AND the node openclaw.mjs grandchild are gone.
      await killActiveLoginForChannel(openclawId).catch(() => { /* best-effort */ });

      // 0.5 Clear cached channel auth on hard remove so switching to a new account
      // doesn't silently reuse the old session credentials.
      if (CHANNELS_WITH_PERSISTED_LOGIN_SESSION.has(openclawId)) {
        try {
          await deps.runAsync(`openclaw channels logout --channel ${openclawId} 2>&1`, CHANNEL_LOGOUT_IDLE_TIMEOUT_MS);
        } catch {
          // Best-effort cleanup only. Some channels may return non-zero when no session exists.
        }
      }

      // 1. Unbind from all agents (best-effort — ignore errors)
      try {
        const listOutput = await deps.readShellOutputAsync('openclaw agents list --json 2>&1', 15000);
        if (listOutput) {
          const agents = JSON.parse(listOutput);
          for (const agent of agents) {
            if (agent.bindings?.some((b: string) => b === openclawId || b.startsWith(openclawId + ':'))) {
              try {
                await deps.runAsync(`openclaw agents unbind --agent ${agent.id} --bind ${openclawId} 2>&1`, 30000);
              } catch { /* best-effort */ }
            }
          }
        }
      } catch { /* agent list failed — continue with removal */ }

      // 2. Remove channel via CLI (--delete = purge config, not just disable)
      try {
        await deps.runAsync(`openclaw channels remove --channel ${openclawId} --delete 2>&1`, 15000);
      } catch { /* may fail if channel was json-direct only */ }

      // 3. Also clean from openclaw.json directly (handles json-direct channels + leftovers)
      try {
        const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
        const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        let changed = false;
        if (existing.channels?.[openclawId]) {
          delete existing.channels[openclawId];
          changed = true;
        }
        if (existing.channels?.[channelId] && channelId !== openclawId) {
          delete existing.channels[channelId];
          changed = true;
        }
        if (changed) {
          fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
        }
      } catch { /* config file may not exist */ }

      // 4. Restart gateway so channel stops receiving messages
      if (process.platform === 'win32') patchGatewayCmdStackSize(deps.home);
      try { await deps.runAsync('openclaw gateway restart 2>&1', 20000); } catch { /* best-effort */ }

      // 5. Flush the channel list cache so the removed channel disappears immediately.
      // Without this, the cached CLI result (valid for 60 s) would union with the
      // fresh file read and re-add the removed channel on the next list call.
      clearChannelStatusCache();

      return { success: true };
    } catch (err: any) {
      return { success: false, error: (err.message || String(err)).slice(0, 300) };
    }
  });

  ipcMain.handle('channel:test', async (_e, channelId: string) => {
    try {
      const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
      const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const ocId = deps.toOpenclawId(channelId);
      const channelDef = deps.getChannel(channelId) || deps.getChannel(ocId);
      const channelConfig = existing?.channels?.[channelId] || existing?.channels?.[ocId];
      if (!channelConfig || !channelConfig.enabled) {
        return { success: false, error: 'Channel not configured' };
      }
      const hasCredentials = hasRequiredChannelCredentials(channelDef, channelConfig);
      if (!hasCredentials) {
        return { success: false, error: 'No credentials found' };
      }

      // Use readShellOutputAsync — OpenClaw emits config warnings to stderr which causes
      // non-zero exit codes on Windows; safeShellExecAsync would return null.
      // Timeout 20s — plugin loading (awareness-memory, weixin, etc.) takes 10-15s.
      const gwStatus = await deps.readShellOutputAsync('openclaw channels status 2>&1', 20000);
      const gwRunning = gwStatus && (gwStatus.includes('running') || gwStatus.includes('active'));

      const listOutput = await dedupedChannelsList(deps.readShellOutputAsync, 20000);
      const isListed = listOutput && listOutput.toLowerCase().includes(channelId);

      if (ocId === 'telegram' && isListed && gwRunning) {
        const pairingOutput = await deps.readShellOutputAsync('openclaw pairing list telegram 2>&1', 20000);
        const pairingStatus = describeTelegramPairingState(pairingOutput);
        if (pairingStatus) {
          return { success: true, output: pairingStatus };
        }
      }

      if (isListed && gwRunning) {
        return { success: true, output: `${channelId}: configured and gateway active` };
      }
      if (isListed) {
        return { success: true, output: `${channelId}: configured. Start Gateway to activate.` };
      }
      return { success: true, output: `${channelId}: credentials saved. Start Gateway to connect.` };
    } catch {
      return { success: false, error: 'Could not read channel configuration' };
    }
  });

  ipcMain.handle('channel:read-config', async (_e, channelId: string) => {
    try {
      const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
      const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const ocId = deps.toOpenclawId(channelId);
      const channelDef = deps.getChannel(channelId) || deps.getChannel(ocId);
      const channelConfig = existing?.channels?.[channelId] || existing?.channels?.[ocId];
      if (channelConfig) {
        return { success: true, config: flattenStoredChannelConfig(channelDef, channelConfig) };
      }
      return { success: false };
    } catch {
      return { success: false };
    }
  });
}
