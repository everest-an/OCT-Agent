/**
 * Shared OpenClaw configuration utilities.
 *
 * Used by both main.ts and doctor.ts to avoid code duplication.
 * All functions accept explicit parameters (e.g. homedir) instead of relying on module-level globals.
 */

import fs from 'fs';
import path from 'path';
import { readJsonFileWithBom } from './json-file';

// --- Constants ---

export const GATEWAY_DEFAULT_PORT = 18789;

export const GATEWAY_DEFAULTS = {
  mode: 'local' as const,
  bind: 'loopback' as const,
  port: GATEWAY_DEFAULT_PORT,
};

export const DEFAULT_EXEC_APPROVAL_ASK = 'on-miss' as const;
export const DEFAULT_EXEC_APPROVAL_SECURITY = 'deny' as const;
export const DEFAULT_EXEC_APPROVAL_ASK_FALLBACK = 'deny' as const;
export const DESKTOP_HOST_EXEC_DEFAULTS = {
  security: 'full' as const,
  ask: 'off' as const,
  askFallback: 'full' as const,
  autoAllowSkills: true,
};

export type ExecApprovalAsk = 'off' | 'on-miss' | 'always';
export type ExecApprovalSecurity = 'deny' | 'allowlist' | 'full';

export type ExecApprovalAllowlistEntry = {
  id?: string;
  pattern: string;
  source?: string;
  lastUsedAt?: number;
  lastUsedCommand?: string;
  lastResolvedPath?: string;
};

export type ExecApprovalSettings = {
  security: ExecApprovalSecurity;
  ask: ExecApprovalAsk;
  askFallback: ExecApprovalSecurity;
  autoAllowSkills: boolean;
  allowlist: ExecApprovalAllowlistEntry[];
};

interface ExecApprovalsConfig {
  version: number;
  defaults?: {
    ask?: string;
    security?: string;
    askFallback?: string;
    autoAllowSkills?: boolean;
    [key: string]: unknown;
  };
  agents?: Record<string, {
    ask?: string;
    security?: string;
    askFallback?: string;
    autoAllowSkills?: boolean;
    allowlist?: ExecApprovalAllowlistEntry[];
    [key: string]: unknown;
  }>;
  socket?: Record<string, unknown>;
  [key: string]: unknown;
}

// --- Plugin allow-list normalization ---

/**
 * Normalize a `plugins.allow` value into a deduplicated string array.
 * Handles the case where OpenClaw config writes it as a single string instead of an array.
 */
export function normalizePluginAllow(value: unknown): string[] | undefined {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];

  const normalized = Array.from(new Set(
    rawValues
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean),
  ));

  return normalized.length > 0 ? normalized : undefined;
}

// --- Gateway status detection ---

/**
 * Determine whether `openclaw gateway status` output indicates a running Gateway.
 * Rejects negative signals (stopped, probe timeout, handshake close) before accepting positive ones.
 * When the CLI prints explicit probe/connect lines, require those to be healthy instead of trusting
 * a listener-only signal. This avoids false positives where the port is open but RPC is still dead.
 */
export function isGatewayRunningOutput(output: string | null): boolean {
  if (!output) return false;

  const normalized = output.toLowerCase();
  // Auth-gated handshakes mean the Gateway process is alive but the probing
  // client is not trusted/paired yet (common with token + device scope upgrade).
  // Treat this as running to avoid false "Gateway is not running" regressions.
  const authGatedHandshake =
    normalized.includes('device-required') ||
    normalized.includes('pairing-required') ||
    normalized.includes('pairing required') ||
    normalized.includes('scope-upgrade');

  if (authGatedHandshake) {
    return true;
  }

  if (
    normalized.includes('runtime: stopped') ||
    normalized.includes('not running') ||
    normalized.includes('no listener detected') ||
    normalized.includes('rpc probe: failed') ||
    normalized.includes('rpc probe: timeout') ||
    normalized.includes('gateway closed') ||
    normalized.includes('reachable: no') ||
    normalized.includes('connect: failed') ||
    normalized.includes('closed before connect')
  ) {
    return false;
  }

   const hasExplicitProbeResult =
    normalized.includes('rpc probe:') ||
    normalized.includes('reachable:') ||
    normalized.includes('connect:');

  if (hasExplicitProbeResult) {
    return normalized.includes('rpc probe: ok') || normalized.includes('reachable: yes');
  }

  return normalized.includes('runtime: running') ||
    normalized.includes('listening:');
}

export function getGatewayPort(homedir: string): number {
  try {
    const configPath = path.join(homedir, '.openclaw', 'openclaw.json');
    const config = readJsonFileWithBom<Record<string, any>>(configPath);
    return Number(config?.gateway?.port) || GATEWAY_DEFAULT_PORT;
  } catch {
    return GATEWAY_DEFAULT_PORT;
  }
}

export function getAgentWorkspaceDir(homedir: string): string {
  const fallback = path.join(homedir, '.openclaw', 'workspace');
  try {
    const configPath = path.join(homedir, '.openclaw', 'openclaw.json');
    const config = readJsonFileWithBom<Record<string, any>>(configPath);
    const configured = config?.agents?.defaults?.workspace;
    return typeof configured === 'string' && configured.trim() ? configured.trim() : fallback;
  } catch {
    return fallback;
  }
}

export function getExecApprovalsPath(homedir: string): string {
  return path.join(homedir, '.openclaw', 'exec-approvals.json');
}

export function readExecApprovalsConfig(homedir: string): ExecApprovalsConfig {
  const configPath = getExecApprovalsPath(homedir);

  try {
    const parsed = readJsonFileWithBom<ExecApprovalsConfig>(configPath);
    return {
      ...parsed,
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      defaults: typeof parsed.defaults === 'object' && parsed.defaults ? parsed.defaults : {},
      agents: typeof parsed.agents === 'object' && parsed.agents ? parsed.agents : {},
      socket: typeof parsed.socket === 'object' && parsed.socket ? parsed.socket : undefined,
    };
  } catch {
    return {
      version: 1,
      defaults: {},
      agents: {},
    };
  }
}

export function getExecApprovalAsk(homedir: string): ExecApprovalAsk {
  const config = readExecApprovalsConfig(homedir);
  const ask = config.defaults?.ask;
  return ask === 'off' || ask === 'always' ? ask : DEFAULT_EXEC_APPROVAL_ASK;
}

export function writeExecApprovalAsk(homedir: string, ask: ExecApprovalAsk): void {
  writeExecApprovalSettings(homedir, { ask });
}

export function writeDesktopExecApprovalDefaults(homedir: string, agentId = 'main'): void {
  writeExecApprovalSettings(homedir, DESKTOP_HOST_EXEC_DEFAULTS, agentId);
}

function normalizeExecApprovalSecurity(value: unknown): ExecApprovalSecurity {
  return value === 'deny' || value === 'allowlist' || value === 'full' ? value : DEFAULT_EXEC_APPROVAL_SECURITY;
}

function normalizeExecApprovalAsk(value: unknown): ExecApprovalAsk {
  return value === 'off' || value === 'always' ? value : DEFAULT_EXEC_APPROVAL_ASK;
}

function normalizeAllowlist(value: unknown): ExecApprovalAllowlistEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => ({
      ...(typeof entry.id === 'string' ? { id: entry.id } : {}),
      pattern: typeof entry.pattern === 'string' ? entry.pattern.trim() : '',
      ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
      ...(typeof entry.lastUsedAt === 'number' ? { lastUsedAt: entry.lastUsedAt } : {}),
      ...(typeof entry.lastUsedCommand === 'string' ? { lastUsedCommand: entry.lastUsedCommand } : {}),
      ...(typeof entry.lastResolvedPath === 'string' ? { lastResolvedPath: entry.lastResolvedPath } : {}),
    }))
    .filter((entry) => entry.pattern);
}

export function getExecApprovalSettings(homedir: string, agentId = 'main'): ExecApprovalSettings {
  const config = readExecApprovalsConfig(homedir);
  const defaults = config.defaults || {};
  const agent = config.agents?.[agentId] || {};

  return {
    security: normalizeExecApprovalSecurity(agent.security ?? defaults.security),
    ask: normalizeExecApprovalAsk(agent.ask ?? defaults.ask),
    askFallback: normalizeExecApprovalSecurity(agent.askFallback ?? defaults.askFallback ?? DEFAULT_EXEC_APPROVAL_ASK_FALLBACK),
    autoAllowSkills: typeof (agent.autoAllowSkills ?? defaults.autoAllowSkills) === 'boolean'
      ? Boolean(agent.autoAllowSkills ?? defaults.autoAllowSkills)
      : false,
    allowlist: normalizeAllowlist(agent.allowlist),
  };
}

export function hasExplicitExecApprovalConfig(homedir: string): boolean {
  const configPath = getExecApprovalsPath(homedir);
  if (!fs.existsSync(configPath)) return false;

  const config = readExecApprovalsConfig(homedir);
  const defaults = config.defaults || {};
  const defaultsConfigured = [
    defaults.security,
    defaults.ask,
    defaults.askFallback,
    defaults.autoAllowSkills,
  ].some((value) => value !== undefined);

  const agentsConfigured = Object.values(config.agents || {}).some((agent) => {
    if (!agent || typeof agent !== 'object') return false;
    return [
      agent.security,
      agent.ask,
      agent.askFallback,
      agent.autoAllowSkills,
    ].some((value) => value !== undefined) || normalizeAllowlist(agent.allowlist).length > 0;
  });

  return defaultsConfigured || agentsConfigured;
}

export function writeExecApprovalSettings(
  homedir: string,
  updates: Partial<ExecApprovalSettings>,
  agentId = 'main',
): void {
  const configPath = getExecApprovalsPath(homedir);
  const config = readExecApprovalsConfig(homedir);
  const defaults = config.defaults || {};
  const agents = typeof config.agents === 'object' && config.agents ? config.agents : {};
  const agent = agents[agentId] || {};

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    ...config,
    version: typeof config.version === 'number' ? config.version : 1,
    defaults: {
      ...defaults,
      ...(updates.security !== undefined ? { security: updates.security } : {}),
      ...(updates.ask !== undefined ? { ask: updates.ask } : {}),
      ...(updates.askFallback !== undefined ? { askFallback: updates.askFallback } : {}),
      ...(updates.autoAllowSkills !== undefined ? { autoAllowSkills: updates.autoAllowSkills } : {}),
    },
    agents: {
      ...agents,
      [agentId]: {
        ...agent,
        ...(updates.allowlist !== undefined ? { allowlist: updates.allowlist } : {}),
      },
    },
  }, null, 2));
}

export function migrateLegacyChannelConfig(config: Record<string, any>): boolean {
  let changed = false;

  if (config?.channels?.telegram?.token) {
    if (!config.channels.telegram.botToken) {
      config.channels.telegram.botToken = config.channels.telegram.token;
    }
    delete config.channels.telegram.token;
    changed = true;
  }

  const whatsappConfig = config?.channels?.whatsapp;
  if (
    whatsappConfig
    && typeof whatsappConfig === 'object'
    && Object.prototype.hasOwnProperty.call(whatsappConfig, 'errorPolicy')
  ) {
    delete whatsappConfig.errorPolicy;
    changed = true;
  }

  return changed;
}

const VALID_SESSION_DM_SCOPES = new Set([
  'main',
  'per-peer',
  'per-channel-peer',
  'per-account-channel-peer',
]);

export const DESKTOP_CHANNEL_DM_SCOPE_DEFAULT = 'per-channel-peer' as const;

const DM_POLICY_COMPAT_CHANNELS = new Set([
  'whatsapp',
  'telegram',
  'discord',
  'slack',
  'signal',
  'imessage',
  'bluebubbles',
  'msteams',
  'irc',
  'line',
  'googlechat',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeDmPolicy(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeAllowFromEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry ?? '').trim())
    .filter((entry) => entry.length > 0);
}

function hasAllowFromEntries(value: unknown): boolean {
  return normalizeAllowFromEntries(value).length > 0;
}

function hasAllowFromWildcard(value: unknown): boolean {
  return normalizeAllowFromEntries(value).includes('*');
}

type DmPolicySource = 'dmPolicy' | 'dm.policy';

function resolveDmPolicy(entry: Record<string, unknown>): {
  policy: string;
  source: DmPolicySource | null;
} {
  const topLevelPolicy = normalizeDmPolicy(entry.dmPolicy);
  if (topLevelPolicy) {
    return { policy: topLevelPolicy, source: 'dmPolicy' };
  }

  const dmConfig = asRecord(entry.dm);
  const nestedPolicy = normalizeDmPolicy(dmConfig?.policy);
  if (nestedPolicy) {
    return { policy: nestedPolicy, source: 'dm.policy' };
  }

  return { policy: '', source: null };
}

function resolveAllowFrom(entry: Record<string, unknown>): unknown {
  if (Array.isArray(entry.allowFrom)) return entry.allowFrom;
  const dmConfig = asRecord(entry.dm);
  if (Array.isArray(dmConfig?.allowFrom)) return dmConfig.allowFrom;
  return undefined;
}

function setDmPolicy(
  entry: Record<string, unknown>,
  source: DmPolicySource,
  policy: string,
): boolean {
  if (source === 'dm.policy') {
    const dmConfig = asRecord(entry.dm) || {};
    const changed = dmConfig.policy !== policy || entry.dm !== dmConfig;
    dmConfig.policy = policy;
    entry.dm = dmConfig;
    return changed;
  }

  if (entry.dmPolicy === policy) return false;
  entry.dmPolicy = policy;
  return true;
}

function ensureAllowFromWildcard(
  entry: Record<string, unknown>,
  source: DmPolicySource,
): boolean {
  if (source === 'dm.policy') {
    const dmConfig = asRecord(entry.dm) || {};
    const current = normalizeAllowFromEntries(dmConfig.allowFrom);
    if (current.includes('*') && entry.dm === dmConfig) return false;
    if (!current.includes('*')) current.push('*');
    dmConfig.allowFrom = current;
    entry.dm = dmConfig;
    return true;
  }

  const current = normalizeAllowFromEntries(entry.allowFrom);
  if (current.includes('*')) return false;
  current.push('*');
  entry.allowFrom = current;
  return true;
}

function hardenDmPolicyEntry(entry: Record<string, unknown>): boolean {
  let changed = false;

  const applyPolicyRule = (
    target: Record<string, unknown>,
    policyInfo: { policy: string; source: DmPolicySource | null },
    effectiveAllowFrom: unknown,
  ) => {
    if (!policyInfo.source) return;

    if (policyInfo.policy === 'allowlist' && !hasAllowFromEntries(effectiveAllowFrom)) {
      changed = setDmPolicy(target, policyInfo.source, 'pairing') || changed;
      return;
    }

    if (policyInfo.policy === 'open' && !hasAllowFromWildcard(effectiveAllowFrom)) {
      changed = ensureAllowFromWildcard(target, policyInfo.source) || changed;
    }
  };

  const topPolicy = resolveDmPolicy(entry);
  const topAllowFrom = resolveAllowFrom(entry);
  applyPolicyRule(entry, topPolicy, topAllowFrom);

  const accounts = asRecord(entry.accounts);
  if (!accounts) return changed;

  for (const rawAccount of Object.values(accounts)) {
    const account = asRecord(rawAccount);
    if (!account) continue;

    const accountPolicy = resolveDmPolicy(account);
    const effectivePolicy = accountPolicy.policy || resolveDmPolicy(entry).policy;
    const effectiveSource = accountPolicy.source || resolveDmPolicy(entry).source;
    if (!effectivePolicy || !effectiveSource) continue;

    const accountAllowFrom = resolveAllowFrom(account);
    const effectiveAllowFrom = accountAllowFrom !== undefined ? accountAllowFrom : resolveAllowFrom(entry);

    applyPolicyRule(
      accountPolicy.source ? account : entry,
      { policy: effectivePolicy, source: effectiveSource },
      effectiveAllowFrom,
    );
  }

  return changed;
}

export function enforceDesktopChannelSessionIsolation(config: Record<string, any>): boolean {
  if (!config || typeof config !== 'object') return false;

  const sessionConfig = (
    config.session && typeof config.session === 'object' && !Array.isArray(config.session)
  )
    ? config.session
    : {};

  let changed = false;
  if (sessionConfig !== config.session) {
    config.session = sessionConfig;
    changed = true;
  }

  const rawScope = typeof sessionConfig.dmScope === 'string'
    ? sessionConfig.dmScope.trim().toLowerCase()
    : '';

  if (!rawScope || rawScope === 'main' || !VALID_SESSION_DM_SCOPES.has(rawScope)) {
    if (sessionConfig.dmScope !== DESKTOP_CHANNEL_DM_SCOPE_DEFAULT) {
      sessionConfig.dmScope = DESKTOP_CHANNEL_DM_SCOPE_DEFAULT;
      changed = true;
    }
    return changed;
  }

  if (sessionConfig.dmScope !== rawScope) {
    sessionConfig.dmScope = rawScope;
    changed = true;
  }

  return changed;
}

export function hardenWhatsAppDmPolicy(config: Record<string, any>): boolean {
  const channels = asRecord(config?.channels);
  if (!channels) return false;
  let changed = false;

  // Legacy function name retained for compatibility. The hardening now applies
  // to all known DM-policy channels to avoid one invalid channel config
  // blocking unrelated channel operations.
  for (const [channelId, rawChannelConfig] of Object.entries(channels)) {
    if (!DM_POLICY_COMPAT_CHANNELS.has(String(channelId || '').toLowerCase())) continue;
    const channelConfig = asRecord(rawChannelConfig);
    if (!channelConfig) continue;
    changed = hardenDmPolicyEntry(channelConfig) || changed;
  }

  return changed;
}

// --- Gateway stack-size patching ---

/**
 * Patch ~/.openclaw/gateway.cmd to inject --stack-size=8192 into the node
 * command line.  This is the definitive fix for the AJV stack overflow on
 * Windows (exit 0xC00000FD): regardless of who starts the gateway (scheduled
 * task, `openclaw gateway start/restart`, or our runSpawn), the cmd script
 * will always include the larger stack.
 *
 * Since nodejs/node#43632 (v18.6.0) the Windows PE StackReserveSize is 8 MiB,
 * so --stack-size=8192 is safe.
 *
 * Safe to call multiple times — skips if already patched or file missing.
 */
export function patchGatewayCmdStackSize(homedir: string): void {
  try {
    const cmdPath = path.join(homedir, '.openclaw', 'gateway.cmd');
    if (!fs.existsSync(cmdPath)) return;
    let content = fs.readFileSync(cmdPath, 'utf-8');
    if (content.includes('--stack-size=')) return; // already patched
    // Inject --stack-size=8192 right after the node.exe path
    const patched = content.replace(
      /("?[^"]*node\.exe"?)\s+((?:C:|%)[^\r\n]+)/gm,
      '$1 --stack-size=8192 $2',
    );
    if (patched !== content) {
      fs.writeFileSync(cmdPath, patched, 'utf-8');
      console.log('[gateway] Patched gateway.cmd with --stack-size=8192');
    }
  } catch (err: any) {
    console.warn('[gateway] Failed to patch gateway.cmd:', err?.message || err);
  }
}

