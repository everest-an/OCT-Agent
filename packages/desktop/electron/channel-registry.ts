/**
 * Unified Channel Registry — single source of truth for all channel metadata.
 *
 * Design principle: Only WeChat + Local are "builtin" (custom logic).
 * Everything else is dynamically discovered from OpenClaw's install directory
 * and enhanced with known overrides (brand colors, multi-field configs, one-click flows).
 *
 * Data sources:
 *   - OpenClaw dist/channel-catalog.json (labels, blurbs, npm packages)
 *   - OpenClaw dist/cli-startup-metadata.json (official CLI-supported channel ids)
 *   - openclaw channels capabilities --channel all --json (setup credentials)
 *   - KNOWN_OVERRIDES below (small UX-only overrides for verified channels)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigField {
  key: string;
  label: string;
  placeholder?: string;
  type: 'password' | 'text' | 'file';
  hint?: string;
  required?: boolean;
  cliFlag: string;
  configPath?: string;
}

export interface ChannelDef {
  id: string;
  openclawId: string;
  label: string;
  description?: string;
  color: string;
  iconType: 'svg' | 'letter';
  connectionType: 'token' | 'multi-field' | 'one-click';
  configFields: ConfigField[];
  saveStrategy: 'cli' | 'json-direct';
  pluginPackage?: string;
  setupFlow?: 'qr-login' | 'add-only' | 'add-then-login';
  source: 'builtin' | 'openclaw-dynamic';
  order: number;
  docsSlug?: string;
}

// ---------------------------------------------------------------------------
// Only 2 true builtins: local (not a channel) + wechat (third-party plugin)
// ---------------------------------------------------------------------------

const BUILTIN_CHANNELS: ChannelDef[] = [
  {
    id: 'local', openclawId: 'local', label: 'Local Chat',
    description: 'Chat directly from the desktop app',
    color: '#6366F1', iconType: 'svg',
    connectionType: 'one-click', configFields: [],
    saveStrategy: 'cli', order: 0, source: 'builtin',
  },
  {
    id: 'wechat', openclawId: 'openclaw-weixin', label: 'WeChat',
    description: 'Link WeChat via QR',
    color: '#07C160', iconType: 'svg',
    connectionType: 'one-click', configFields: [],
    saveStrategy: 'json-direct', pluginPackage: '@tencent-weixin/openclaw-weixin',
    setupFlow: 'qr-login', order: 4, source: 'builtin',
  },
];

// ---------------------------------------------------------------------------
// Known overrides — UX enhancements for channels we've verified
// Applied on top of OpenClaw dynamic discovery
// ---------------------------------------------------------------------------

interface KnownOverride {
  label?: string;
  color?: string;
  iconType?: 'svg';
  connectionType?: 'one-click';  // only for QR/auto-setup channels
  setupFlow?: 'qr-login' | 'add-only' | 'add-then-login';
  order?: number;
  // Note: configFields are now 100% dynamic from CLI --help parsing
  // Note: saveStrategy is dynamic from CLI --channel enum detection
}

// ---------------------------------------------------------------------------
// Official runtime metadata — populated from OpenClaw metadata/capabilities
// ---------------------------------------------------------------------------

let _cliSupportedChannels = new Set<string>();
// Dynamic config fields parsed from official metadata, keyed by channel ID
let _dynamicConfigFields = new Map<string, ConfigField[]>();

type ChannelCapabilityCredential = {
  inputKey?: unknown;
  credentialLabel?: unknown;
  preferredEnvVar?: unknown;
  inputPrompt?: unknown;
};

type JsonSchemaNode = {
  type?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: JsonSchemaNode | boolean;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
};

type ChannelCapabilitiesResponse = {
  channels?: Array<{
    plugin?: {
      id?: unknown;
      [key: string]: unknown;
      setupWizard?: {
        credentials?: ChannelCapabilityCredential[];
      };
    };
    [key: string]: unknown;
  }>;
};

/** Known channel name aliases in CLI help descriptions → channel ID */
const CHANNEL_NAME_ALIASES: Record<string, string> = {
  'telegram': 'telegram', 'discord': 'discord', 'slack': 'slack',
  'whatsapp': 'whatsapp', 'signal': 'signal', 'imessage': 'imessage',
  'matrix': 'matrix', 'google chat': 'googlechat', 'googlechat': 'googlechat',
  'tlon': 'tlon', 'nostr': 'nostr', 'bluebubbles': 'bluebubbles',
  'irc': 'irc', 'line': 'line', 'feishu': 'feishu', 'msteams': 'msteams',
  'microsoft teams': 'msteams', 'teams': 'msteams',
};

/** Flags to skip (generic, boolean, or advanced/optional) */
const SKIP_FLAGS = new Set([
  '--channel', '--account', '--name', '--use-env', '--no-auto-discover-channels',
  '--auto-discover-channels', '--help', '-h',
  // Advanced/optional — users rarely need these
  '--auth-dir', '--cli-path', '--device-name', '--dm-allowlist',
  '--group-channels', '--initial-sync-limit', '--region', '--service',
  '--http-host', '--http-port', '--relay-urls', '--token-file',
  '--audience', '--audience-type',
]);

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function extractJsonPayload(raw: string): string {
  const cleaned = stripAnsi(raw).trim();
  for (let start = 0; start < cleaned.length; start += 1) {
    const opener = cleaned[start];
    if (opener !== '{' && opener !== '[') continue;

    const stack: string[] = [opener];
    let inString = false;
    let escaped = false;

    for (let end = start + 1; end < cleaned.length; end += 1) {
      const ch = cleaned[end];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{' || ch === '[') {
        stack.push(ch);
        continue;
      }

      if (ch === '}' || ch === ']') {
        const expected = ch === '}' ? '{' : '[';
        if (stack[stack.length - 1] !== expected) break;
        stack.pop();
        if (stack.length === 0) {
          const candidate = cleaned.slice(start, end + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new Error('No JSON payload found');
}

function normalizeCliFlagFromKey(key: string): string {
  return `--${key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase()}`;
}

function inferFieldType(parts: string[]): 'password' | 'text' {
  return parts.some((part) => /token|password|secret|key/i.test(part)) ? 'password' : 'text';
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getAccountsPropertySchema(candidate: unknown): Record<string, JsonSchemaNode> | null {
  if (!isPlainRecord(candidate)) return null;

  const directAccounts = isPlainRecord(candidate.accounts) ? candidate.accounts as JsonSchemaNode : null;
  const nestedAccounts = isPlainRecord(candidate.properties?.accounts) ? candidate.properties.accounts as JsonSchemaNode : null;
  const accountsNode = directAccounts || nestedAccounts;
  if (!accountsNode || !isPlainRecord(accountsNode.additionalProperties)) return null;

  const properties = accountsNode.additionalProperties.properties;
  return isPlainRecord(properties) ? properties as Record<string, JsonSchemaNode> : null;
}

function findAccountsPropertySchema(candidate: unknown, seen = new Set<object>()): Record<string, JsonSchemaNode> | null {
  if (!isPlainRecord(candidate)) return null;
  if (seen.has(candidate)) return null;
  seen.add(candidate);

  const direct = getAccountsPropertySchema(candidate);
  if (direct) return direct;

  for (const value of Object.values(candidate)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findAccountsPropertySchema(item, seen);
        if (found) return found;
      }
      continue;
    }

    const found = findAccountsPropertySchema(value, seen);
    if (found) return found;
  }

  return null;
}

function isAccountCredentialKey(key: string, properties: Record<string, JsonSchemaNode>): boolean {
  if (key === 'enabled' || key === 'name') return false;
  if (/token|secret|password|webhook|private.?key/i.test(key)) return true;
  if (key === 'appId') return true;

  if (/id$/i.test(key)) {
    const base = key.replace(/id$/i, '').toLowerCase();
    return Object.keys(properties).some((otherKey) => {
      if (otherKey === key) return false;
      const lower = otherKey.toLowerCase();
      return lower.startsWith(base) && /(secret|token|password|key)/i.test(otherKey);
    });
  }

  return false;
}

function getPreferredAccountCredentialKeys(channelId: string): string[] | null {
  switch (channelId) {
    case 'feishu':
      return ['appId', 'appSecret'];
    default:
      return null;
  }
}

function extractAccountScopedCredentialFields(channelId: string, candidate: unknown): ConfigField[] {
  const accountProperties = findAccountsPropertySchema(candidate);
  if (!accountProperties) return [];

  const preferredKeys = getPreferredAccountCredentialKeys(channelId);
  if (preferredKeys) {
    return preferredKeys
      .filter((key) => key in accountProperties)
      .map((key) => ({
        key,
        label: key,
        type: inferFieldType([key]),
        required: true,
        cliFlag: normalizeCliFlagFromKey(key),
        configPath: 'accounts.default',
      }));
  }

  const fields: ConfigField[] = [];
  for (const [key] of Object.entries(accountProperties)) {
    if (!isAccountCredentialKey(key, accountProperties)) continue;
    fields.push({
      key,
      label: key,
      type: inferFieldType([key]),
      required: true,
      cliFlag: normalizeCliFlagFromKey(key),
      configPath: 'accounts.default',
    });
  }

  return fields;
}

function mergeDynamicConfigFields(
  nextFields: Map<string, ConfigField[]>,
  options?: { preferExisting?: boolean },
): void {
  const merged = new Map<string, ConfigField[]>();

  const addFrom = (source: Map<string, ConfigField[]>) => {
    for (const [channelId, fields] of source.entries()) {
      if (!Array.isArray(fields) || fields.length === 0) continue;
      if (!merged.has(channelId)) {
        merged.set(channelId, fields);
      }
    }
  };

  if (options?.preferExisting) {
    addFrom(_dynamicConfigFields);
    addFrom(nextFields);
  } else {
    addFrom(nextFields);
    addFrom(_dynamicConfigFields);
  }

  _dynamicConfigFields = merged;
}

function addCliSupportedChannels(channelIds: Iterable<string>): void {
  for (const rawId of channelIds) {
    const normalized = String(rawId || '').trim().toLowerCase();
    if (normalized) {
      _cliSupportedChannels.add(normalized);
    }
  }

  refreshDynamicChannels();
}

function refreshDynamicChannels(): void {
  if (_dynamicChannels.length > 0) {
    _dynamicChannels = _dynamicChannels.map((channel) => (
      channel.connectionType === 'one-click'
        ? {
            ...channel,
            configFields: [],
            saveStrategy: _cliSupportedChannels.has(channel.id) ? 'cli' : 'json-direct',
          }
        : {
            ...channel,
            configFields: _dynamicConfigFields.get(channel.id)?.length
              ? _dynamicConfigFields.get(channel.id)!
              : (getFallbackConfigFields(channel.id).length > 0 ? getFallbackConfigFields(channel.id) : [{ ...DEFAULT_TOKEN_FIELD }]),
            connectionType: _dynamicConfigFields.get(channel.id)?.length
              ? (_dynamicConfigFields.get(channel.id)!.length > 1 ? 'multi-field' : 'token')
              : (getFallbackConfigFields(channel.id).length > 1 ? 'multi-field' : 'token'),
            saveStrategy: _cliSupportedChannels.has(channel.id) ? 'cli' : 'json-direct',
          }
    ));
    _rebuildIndices();
  }
}

export function parseChannelCapabilitiesJson(capabilitiesOutput: string): {
  channelFields: Map<string, ConfigField[]>;
} {
  const parsed = JSON.parse(extractJsonPayload(capabilitiesOutput)) as ChannelCapabilitiesResponse;
  const channelFields = new Map<string, ConfigField[]>();
  const channels = Array.isArray(parsed?.channels) ? parsed.channels : [];

  for (const entry of channels) {
    const channelId = typeof entry?.plugin?.id === 'string' ? entry.plugin.id.trim().toLowerCase() : '';
    if (!channelId) continue;

    const credentials = Array.isArray(entry?.plugin?.setupWizard?.credentials)
      ? entry.plugin.setupWizard.credentials
      : [];
    const fields: ConfigField[] = [];

    for (const credential of credentials) {
      const key = typeof credential?.inputKey === 'string' ? credential.inputKey.trim() : '';
      if (!key) continue;

      const label = typeof credential?.credentialLabel === 'string' && credential.credentialLabel.trim()
        ? credential.credentialLabel.trim()
        : key;
      const preferredEnvVar = typeof credential?.preferredEnvVar === 'string' ? credential.preferredEnvVar.trim() : '';
      const inputPrompt = typeof credential?.inputPrompt === 'string' ? credential.inputPrompt.trim() : '';
      const placeholder = preferredEnvVar || inputPrompt || '';

      fields.push({
        key,
        label,
        placeholder,
        type: inferFieldType([key, label, preferredEnvVar, inputPrompt]),
        required: true,
        cliFlag: normalizeCliFlagFromKey(key),
      });
    }

    if (fields.length === 0) {
      fields.push(...extractAccountScopedCredentialFields(channelId, entry?.plugin || entry));
    }

    if (fields.length > 0) {
      channelFields.set(channelId, fields);
    }
  }

  return { channelFields };
}

export function applyChannelCapabilities(channelFields: Map<string, ConfigField[]>): void {
  mergeDynamicConfigFields(channelFields, { preferExisting: false });
  refreshDynamicChannels();
}

/**
 * Parse `openclaw channels add --help` output to extract:
 * 1. CLI-supported channel enum (--channel choices)
 * 2. Per-channel config fields (flag → channel mapping from descriptions)
 */
export function parseCliHelp(helpOutput: string): {
  cliChannels: Set<string>;
  channelFields: Map<string, ConfigField[]>;
} {
  const cliChannels = new Set<string>();
  const channelFields = new Map<string, ConfigField[]>();
  const lines = helpOutput.split('\n');

  // 1. Parse --channel enum
  let enumRaw = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/--channel\s+<[^>]+>/i.test(line)) continue;

    const joined = `${line.trim()} ${(lines[i + 1] || '').trim()}`;
    const inlineMatch = joined.match(/\(([^)]+)\)/);
    if (inlineMatch?.[1]) {
      enumRaw = inlineMatch[1];
      break;
    }
  }

  if (!enumRaw) {
    const fallbackMatch = helpOutput.match(/--channel\s+<[^>]+>[\s\S]*?\(([^)\n]+(?:\|[^)\n]+)+)\)/i);
    if (fallbackMatch?.[1]) enumRaw = fallbackMatch[1];
  }

  if (enumRaw) {
    for (const ch of enumRaw.split('|')) {
      const normalized = ch.trim().toLowerCase();
      if (normalized) cliChannels.add(normalized);
    }
  }

  // 2. Parse each --flag line and map to channels
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const m = line.match(/^(--[\w-]+)\s+(?:<(\w+)>)?\s*(.*)/);
    if (!m) continue;

    const [, flag, typeHint = '', descStart] = m;
    if (SKIP_FLAGS.has(flag)) continue;

    // Multi-line descriptions: join continuation lines
    let desc = descStart;
    while (i + 1 < lines.length && lines[i + 1].match(/^\s{20,}/)) {
      desc += ' ' + lines[++i].trim();
    }
    const descLower = desc.toLowerCase();

    // Match channel names in description
    const matchedChannels: string[] = [];
    for (const [name, chId] of Object.entries(CHANNEL_NAME_ALIASES)) {
      if (descLower.includes(name)) matchedChannels.push(chId);
    }
    // Generic "Bot token (Telegram/Discord)" → split on /
    if (matchedChannels.length === 0 && descLower.includes('bot token')) {
      const slashMatch = desc.match(/\(([^)]+)\)/);
      if (slashMatch) {
        for (const part of slashMatch[1].split('/')) {
          const alias = CHANNEL_NAME_ALIASES[part.trim().toLowerCase()];
          if (alias) matchedChannels.push(alias);
        }
      }
    }
    if (matchedChannels.length === 0) continue;

    // Deduplicate
    const uniqueChannels = [...new Set(matchedChannels)];

    // Determine field type
    const isSecret = ['token', 'password', 'key', 'secret'].includes(typeHint)
      || /password|secret|token|key/i.test(desc);
    const fieldType: 'password' | 'text' = isSecret ? 'password' : 'text';

    // Extract placeholder from parentheses
    const phMatch = desc.match(/\(([^)]+)\)/);
    const placeholder = phMatch ? phMatch[1] : '';

    // Generate camelCase key from flag name
    const key = flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());

    // Clean label: remove channel name prefix and parenthetical
    let label = desc.split('(')[0].trim();

    const field: ConfigField = { key, label, placeholder, type: fieldType, required: true, cliFlag: flag };

    for (const ch of uniqueChannels) {
      if (!channelFields.has(ch)) channelFields.set(ch, []);
      channelFields.get(ch)!.push(field);
    }
  }

  return { cliChannels, channelFields };
}

/** Apply parsed CLI help data to the registry */
export function applyCliHelp(cliChannels: Set<string>, channelFields: Map<string, ConfigField[]>): void {
  addCliSupportedChannels(cliChannels);
  mergeDynamicConfigFields(channelFields, { preferExisting: true });
}

// Legacy exports for backward compat
export function parseCliSupportedChannels(helpOutput: string): Set<string> {
  return parseCliHelp(helpOutput).cliChannels;
}
export function setCliSupportedChannels(channels: Set<string>): void {
  _cliSupportedChannels = new Set<string>();
  addCliSupportedChannels(channels);
}
export function isCliSupported(id: string): boolean {
  return _cliSupportedChannels.has(id);
}

// ---------------------------------------------------------------------------
// KNOWN_OVERRIDES — only visual/UX overrides, NO configFields
// Config fields are now dynamically parsed from official metadata/capabilities
// ---------------------------------------------------------------------------

const KNOWN_OVERRIDES: Record<string, KnownOverride> = {
  // One-click channels (QR / auto setup)
  whatsapp: { color: '#25D366', iconType: 'svg', connectionType: 'one-click', setupFlow: 'qr-login', order: 3 },
  signal:   { color: '#3A76F0', iconType: 'svg', connectionType: 'one-click', setupFlow: 'add-then-login', order: 6 },
  imessage: { color: '#34C759', iconType: 'svg', connectionType: 'one-click', setupFlow: 'add-only', order: 7 },

  // Brand colors + SVG icons + sort order
  telegram: { color: '#26A5E4', iconType: 'svg', order: 1 },
  discord:  { color: '#5865F2', iconType: 'svg', order: 2 },
  slack:    { color: '#4A154B', iconType: 'svg', order: 5 },
  feishu:   { color: '#3370FF', iconType: 'svg', order: 8 },
  googlechat: { label: 'Google Chat', color: '#1A73E8', iconType: 'svg', order: 9 },
  line:     { color: '#06C755', iconType: 'svg', order: 10 },
  matrix:   { color: '#0DBD8B', iconType: 'svg', order: 11 },

  // Friendly labels for channels with non-obvious IDs
  msteams:  { label: 'Microsoft Teams' },
};

const VERIFIED_FALLBACK_CONFIG_FIELDS: Record<string, ConfigField[]> = {
  feishu: [
    {
      key: 'appId',
      label: 'appId',
      placeholder: '',
      type: 'text',
      required: true,
      cliFlag: '--app-id',
      configPath: 'accounts.default',
    },
    {
      key: 'appSecret',
      label: 'appSecret',
      placeholder: '',
      type: 'password',
      required: true,
      cliFlag: '--app-secret',
      configPath: 'accounts.default',
    },
  ],
};

// Default single-token config field (used for most channels)
const DEFAULT_TOKEN_FIELD: ConfigField = { key: 'token', label: 'Token', placeholder: '', type: 'password', required: true, cliFlag: '--token' };

function getFallbackConfigFields(channelId: string): ConfigField[] {
  const fields = VERIFIED_FALLBACK_CONFIG_FIELDS[channelId];
  return Array.isArray(fields) ? fields.map((field) => ({ ...field })) : [];
}

// ---------------------------------------------------------------------------
// Index maps
// ---------------------------------------------------------------------------

const _byFrontendId = new Map<string, ChannelDef>();
const _byOpenclawId = new Map<string, ChannelDef>();
let _dynamicChannels: ChannelDef[] = [];

function _rebuildIndices() {
  _byFrontendId.clear();
  _byOpenclawId.clear();
  for (const ch of BUILTIN_CHANNELS) {
    _byFrontendId.set(ch.id, ch);
    _byOpenclawId.set(ch.openclawId, ch);
  }
  for (const ch of _dynamicChannels) {
    if (!_byFrontendId.has(ch.id)) _byFrontendId.set(ch.id, ch);
    if (!_byOpenclawId.has(ch.openclawId)) _byOpenclawId.set(ch.openclawId, ch);
  }
}

_rebuildIndices();

// ---------------------------------------------------------------------------
// Deterministic color from string hash
// ---------------------------------------------------------------------------

const PALETTE = [
  '#6366F1', '#EC4899', '#F59E0B', '#10B981', '#3B82F6',
  '#8B5CF6', '#EF4444', '#14B8A6', '#F97316', '#06B6D4',
  '#84CC16', '#E879F9', '#22D3EE', '#A78BFA', '#FB923C',
];

function hashColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

// ---------------------------------------------------------------------------
// Build a ChannelDef from OpenClaw data + known overrides
// ---------------------------------------------------------------------------

function buildDynamicChannel(id: string, label: string, opts: {
  description?: string; npmSpec?: string; docsSlug?: string; catalogOrder?: number;
}): ChannelDef {
  const override = KNOWN_OVERRIDES[id];
  const isOneClick = override?.connectionType === 'one-click';

  // Config fields priority: official capabilities > CLI help fallback > default token
  const dynamicFields = _dynamicConfigFields.get(id);
  const fallbackFields = getFallbackConfigFields(id);
  let configFields: ConfigField[];
  let connectionType: ChannelDef['connectionType'];

  if (isOneClick) {
    configFields = [];
    connectionType = 'one-click';
  } else if (dynamicFields && dynamicFields.length > 0) {
    configFields = dynamicFields;
    connectionType = dynamicFields.length > 1 ? 'multi-field' : 'token';
  } else if (fallbackFields.length > 0) {
    configFields = fallbackFields;
    connectionType = fallbackFields.length > 1 ? 'multi-field' : 'token';
  } else {
    configFields = [{ ...DEFAULT_TOKEN_FIELD }];
    connectionType = 'token';
  }

  return {
    id,
    openclawId: id,
    label: override?.label || label,
    description: opts.description || '',
    color: override?.color || hashColor(id),
    iconType: override?.iconType || 'letter',
    connectionType,
    configFields,
    saveStrategy: _cliSupportedChannels.has(id) ? 'cli' : 'json-direct',
    pluginPackage: opts.npmSpec || `@openclaw/${id}`,
    setupFlow: override?.setupFlow,
    source: 'openclaw-dynamic',
    order: override?.order ?? (100 + (opts.catalogOrder ?? 0)),
    docsSlug: opts.docsSlug || id,
  };
}

// ---------------------------------------------------------------------------
// Dynamic discovery
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  name: string;
  openclaw?: {
    channel?: { id: string; label?: string; blurb?: string; selectionLabel?: string; docsPath?: string; order?: number };
    install?: { npmSpec?: string };
  };
}

/** Merge channel-catalog.json entries. Builtin channels (local, wechat) are never overridden. */
export function mergeCatalog(entries: CatalogEntry[]): void {
  const builtinIds = new Set(BUILTIN_CHANNELS.map(c => c.id));
  const builtinOcIds = new Set(BUILTIN_CHANNELS.map(c => c.openclawId));
  const merged = new Map<string, ChannelDef>();
  let catalogIndex = 0;

  for (const channel of _dynamicChannels) {
    if (builtinIds.has(channel.id) || builtinOcIds.has(channel.openclawId)) continue;
    merged.set(channel.id, channel);
  }

  for (const entry of entries) {
    const ch = entry.openclaw?.channel;
    if (!ch?.id) continue;
    if (builtinIds.has(ch.id) || builtinOcIds.has(ch.id)) continue;

    merged.set(ch.id, buildDynamicChannel(ch.id, ch.label || ch.id, {
      description: ch.blurb || ch.selectionLabel || '',
      npmSpec: entry.openclaw?.install?.npmSpec,
      docsSlug: ch.docsPath?.replace(/^\/channels\//, '') || ch.id,
      catalogOrder: ch.order ?? catalogIndex++,
    }));
  }

  _dynamicChannels = [...merged.values()];
  _rebuildIndices();
}

/** Merge official startup metadata channel IDs. Only adds IDs not already known. */
export function mergeChannelOptions(channelIds: string[]): void {
  const added: ChannelDef[] = [];
  for (const id of channelIds) {
    if (_byFrontendId.has(id) || _byOpenclawId.has(id)) continue;
    const label = id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ');
    added.push(buildDynamicChannel(id, label, { catalogOrder: 200 + added.length }));
  }
  if (added.length > 0) {
    _dynamicChannels.push(...added);
    _rebuildIndices();
  }
}

/** Initialize from serialized data (renderer side, after IPC). */
export function loadFromSerialized(channels: ChannelDef[]): void {
  _dynamicChannels = channels.filter(c => c.source !== 'builtin');
  _rebuildIndices();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getAllChannels(): ChannelDef[] {
  return [...BUILTIN_CHANNELS, ..._dynamicChannels].sort((a, b) => a.order - b.order);
}

export function getBuiltinChannels(): ChannelDef[] {
  return [...BUILTIN_CHANNELS];
}

export function getChannel(id: string): ChannelDef | undefined {
  return _byFrontendId.get(id);
}

export function getChannelByOpenclawId(ocId: string): ChannelDef | undefined {
  return _byOpenclawId.get(ocId);
}

export function toOpenclawId(frontendId: string): string {
  return _byFrontendId.get(frontendId)?.openclawId ?? frontendId;
}

export function toFrontendId(openclawId: string): string {
  return _byOpenclawId.get(openclawId)?.id ?? openclawId;
}

export function isOneClick(id: string): boolean {
  return _byFrontendId.get(id)?.connectionType === 'one-click';
}

export function hasBrandIcon(id: string): boolean {
  return _byFrontendId.get(id)?.iconType === 'svg';
}

export function buildCLIFlags(channelDef: ChannelDef, config: Record<string, string>): string {
  const parts: string[] = [];
  for (const field of channelDef.configFields) {
    const val = config[field.key];
    if (val) {
      const escaped = val.replace(/"/g, '\\"');
      parts.push(`${field.cliFlag} "${escaped}"`);
    }
  }
  return parts.join(' ');
}

export function serializeRegistry(): ChannelDef[] {
  return getAllChannels();
}
