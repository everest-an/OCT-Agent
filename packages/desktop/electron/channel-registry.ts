/**
 * Unified Channel Registry — single source of truth for all channel metadata.
 *
 * Design principle: Only WeChat + Local are "builtin" (custom logic).
 * Everything else is dynamically discovered from OpenClaw's install directory
 * and enhanced with known overrides (brand colors, multi-field configs, one-click flows).
 *
 * Data sources:
 *   - OpenClaw dist/channel-catalog.json (labels, blurbs, npm packages)
 *   - OpenClaw dist/cli-startup-metadata.json (full channel ID list)
 *   - KNOWN_OVERRIDES below (our UX enhancements for channels we've verified)
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
// Dynamic CLI parsing — populated at runtime from `openclaw channels add --help`
// ---------------------------------------------------------------------------

let _cliSupportedChannels = new Set<string>();
// Dynamic config fields parsed from CLI help, keyed by channel ID
let _dynamicConfigFields = new Map<string, ConfigField[]>();

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

  // 1. Parse --channel enum
  const enumMatch = helpOutput.match(/--channel\s+<\w+>\s+Channel\s*\n\s*\(([^)]+)\)/);
  if (enumMatch) {
    for (const ch of enumMatch[1].split('|')) cliChannels.add(ch.trim().toLowerCase());
  }

  // 2. Parse each --flag line and map to channels
  const lines = helpOutput.split('\n');
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
  _cliSupportedChannels = cliChannels;
  _dynamicConfigFields = channelFields;
}

// Legacy exports for backward compat
export function parseCliSupportedChannels(helpOutput: string): Set<string> {
  return parseCliHelp(helpOutput).cliChannels;
}
export function setCliSupportedChannels(channels: Set<string>): void {
  _cliSupportedChannels = channels;
}
export function isCliSupported(id: string): boolean {
  return _cliSupportedChannels.has(id);
}

// ---------------------------------------------------------------------------
// KNOWN_OVERRIDES — only visual/UX overrides, NO configFields
// Config fields are now dynamically parsed from CLI --help
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

// Default single-token config field (used for most channels)
const DEFAULT_TOKEN_FIELD: ConfigField = { key: 'token', label: 'Token', placeholder: '', type: 'password', required: true, cliFlag: '--token' };

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

  // Config fields priority: dynamic CLI help > default token
  const dynamicFields = _dynamicConfigFields.get(id);
  let configFields: ConfigField[];
  let connectionType: ChannelDef['connectionType'];

  if (isOneClick) {
    configFields = [];
    connectionType = 'one-click';
  } else if (dynamicFields && dynamicFields.length > 0) {
    configFields = dynamicFields;
    connectionType = dynamicFields.length > 1 ? 'multi-field' : 'token';
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
  const added: ChannelDef[] = [];

  for (const entry of entries) {
    const ch = entry.openclaw?.channel;
    if (!ch?.id) continue;
    if (builtinIds.has(ch.id) || builtinOcIds.has(ch.id)) continue;

    added.push(buildDynamicChannel(ch.id, ch.label || ch.id, {
      description: ch.blurb || ch.selectionLabel || '',
      npmSpec: entry.openclaw?.install?.npmSpec,
      docsSlug: ch.docsPath?.replace(/^\/channels\//, '') || ch.id,
      catalogOrder: ch.order ?? added.length,
    }));
  }

  _dynamicChannels = added;
  _rebuildIndices();
}

/** Merge cli-startup-metadata channelOptions. Only adds IDs not already known. */
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
