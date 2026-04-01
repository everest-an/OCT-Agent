/**
 * Unified Channel Registry — single source of truth for all channel metadata.
 *
 * Three-layer architecture:
 *   Layer 1: OpenClaw dynamic discovery (channel-catalog.json + cli-startup-metadata.json)
 *   Layer 2: AwarenessClaw enhancements (brand SVG, custom config schema, i18n)
 *   Layer 3: Runtime state (configured channels, gateway status)
 *
 * RULE: Only WeChat uses json-direct (third-party plugin).
 *       All other channels use OpenClaw CLI `channels add`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigField {
  key: string;           // config object key (e.g. 'botToken')
  label: string;         // i18n key or default English label
  placeholder?: string;
  type: 'password' | 'text' | 'file';
  hint?: string;         // i18n key or default hint
  required?: boolean;
  cliFlag: string;       // CLI flag (e.g. '--bot-token')
}

export interface ChannelDef {
  id: string;              // Frontend ID (e.g. 'wechat')
  openclawId: string;      // OpenClaw ID (e.g. 'openclaw-weixin')
  label: string;           // Default English label
  description?: string;    // Short description
  color: string;           // Brand color hex
  iconType: 'svg' | 'letter';

  // Connection UI
  connectionType: 'token' | 'multi-field' | 'one-click';
  configFields: ConfigField[];

  // Save strategy: cli = `openclaw channels add`, json-direct = write openclaw.json
  saveStrategy: 'cli' | 'json-direct';
  pluginPackage?: string;  // npm package name

  // One-click setup flow
  setupFlow?: 'qr-login' | 'add-only' | 'add-then-login';

  // Source tracking
  source: 'builtin' | 'openclaw-catalog' | 'openclaw-runtime';
  order: number;
  docsSlug?: string;       // OpenClaw docs path slug
}

// ---------------------------------------------------------------------------
// Built-in channels — all use CLI except WeChat (third-party plugin)
// ---------------------------------------------------------------------------

const BUILTIN_CHANNELS: ChannelDef[] = [
  // -- Local (desktop chat, not a real channel) --
  {
    id: 'local', openclawId: 'local', label: 'Local Chat',
    description: 'Chat directly from the desktop app',
    color: '#6366F1', iconType: 'svg',
    connectionType: 'one-click', configFields: [],
    saveStrategy: 'cli', order: 0, source: 'builtin',
  },

  // -- Single-token channels --
  {
    id: 'telegram', openclawId: 'telegram', label: 'Telegram',
    description: 'Connect via Telegram Bot API',
    color: '#26A5E4', iconType: 'svg',
    connectionType: 'token',
    configFields: [
      { key: 'token', label: 'Bot Token', placeholder: '123456:ABC-DEF1234...', type: 'password', required: true, cliFlag: '--token' },
    ],
    saveStrategy: 'cli', pluginPackage: '@openclaw/telegram',
    order: 1, source: 'builtin', docsSlug: 'telegram',
  },
  {
    id: 'discord', openclawId: 'discord', label: 'Discord',
    description: 'Connect via Discord Bot',
    color: '#5865F2', iconType: 'svg',
    connectionType: 'token',
    configFields: [
      { key: 'token', label: 'Bot Token', placeholder: 'MTIz...', type: 'password', required: true, cliFlag: '--token' },
    ],
    saveStrategy: 'cli', pluginPackage: '@openclaw/discord',
    order: 2, source: 'builtin', docsSlug: 'discord',
  },
  {
    id: 'line', openclawId: 'line', label: 'LINE',
    description: 'Connect via LINE Messaging API',
    color: '#06C755', iconType: 'svg',
    connectionType: 'token',
    configFields: [
      { key: 'token', label: 'channels.lineToken', placeholder: 'Channel Access Token', type: 'password', hint: 'channels.lineHint', required: true, cliFlag: '--token' },
    ],
    saveStrategy: 'cli', pluginPackage: '@openclaw/line',
    order: 10, source: 'builtin', docsSlug: 'line',
  },

  // -- One-click channels (QR / auto setup) --
  {
    id: 'whatsapp', openclawId: 'whatsapp', label: 'WhatsApp',
    description: 'Link WhatsApp Web via QR',
    color: '#25D366', iconType: 'svg',
    connectionType: 'one-click', configFields: [],
    saveStrategy: 'cli', pluginPackage: '@openclaw/whatsapp',
    setupFlow: 'qr-login', order: 3, source: 'builtin', docsSlug: 'whatsapp',
  },
  {
    id: 'wechat', openclawId: 'openclaw-weixin', label: 'WeChat',
    description: 'Link WeChat via QR',
    color: '#07C160', iconType: 'svg',
    connectionType: 'one-click', configFields: [],
    // ONLY exception: third-party plugin, not in OpenClaw CLI enum
    saveStrategy: 'json-direct', pluginPackage: '@tencent-weixin/openclaw-weixin',
    setupFlow: 'qr-login', order: 4, source: 'builtin',
  },
  {
    id: 'signal', openclawId: 'signal', label: 'Signal',
    description: 'Link Signal via QR',
    color: '#3A76F0', iconType: 'svg',
    connectionType: 'one-click', configFields: [],
    saveStrategy: 'cli', pluginPackage: '@openclaw/signal',
    setupFlow: 'add-then-login', order: 6, source: 'builtin', docsSlug: 'signal',
  },
  {
    id: 'imessage', openclawId: 'imessage', label: 'iMessage',
    description: 'macOS only — auto-detect Messages',
    color: '#34C759', iconType: 'svg',
    connectionType: 'one-click', configFields: [],
    saveStrategy: 'cli', pluginPackage: '@openclaw/imessage',
    setupFlow: 'add-only', order: 7, source: 'builtin', docsSlug: 'imessage',
  },

  // -- Multi-field channels (all use CLI) --
  {
    id: 'slack', openclawId: 'slack', label: 'Slack',
    description: 'Connect via Slack App',
    color: '#4A154B', iconType: 'svg',
    connectionType: 'multi-field',
    configFields: [
      { key: 'botToken', label: 'channels.slack.botToken', placeholder: 'xoxb-...', type: 'password', hint: 'channels.slackBotHint', required: true, cliFlag: '--bot-token' },
      { key: 'appToken', label: 'channels.slack.appToken', placeholder: 'xapp-...', type: 'password', hint: 'channels.slackAppHint', required: true, cliFlag: '--app-token' },
    ],
    saveStrategy: 'cli', pluginPackage: '@openclaw/slack',
    order: 5, source: 'builtin', docsSlug: 'slack',
  },
  {
    id: 'feishu', openclawId: 'feishu', label: 'Feishu / Lark',
    description: 'Connect via Feishu App',
    color: '#3370FF', iconType: 'svg',
    connectionType: 'multi-field',
    configFields: [
      { key: 'appId', label: 'channels.feishu.appId', placeholder: 'cli_xxxxxxxxxx', type: 'password', required: true, cliFlag: '--token' },
      { key: 'appSecret', label: 'channels.feishu.appSecret', placeholder: 'xxxxxxxxxxxxxxxx', type: 'password', required: true, cliFlag: '--token-file' },
    ],
    saveStrategy: 'cli', pluginPackage: '@openclaw/feishu',
    order: 8, source: 'builtin', docsSlug: 'feishu',
  },
  {
    id: 'matrix', openclawId: 'matrix', label: 'Matrix',
    description: 'Connect via Matrix homeserver',
    color: '#0DBD8B', iconType: 'svg',
    connectionType: 'multi-field',
    configFields: [
      { key: 'homeserver', label: 'channels.matrix.server', placeholder: 'https://matrix.org', type: 'text', required: true, cliFlag: '--homeserver' },
      { key: 'userId', label: 'channels.matrix.user', placeholder: '@mybot:matrix.org', type: 'text', required: true, cliFlag: '--user-id' },
      { key: 'password', label: 'channels.matrix.password', placeholder: '••••••••', type: 'password', required: true, cliFlag: '--password' },
    ],
    saveStrategy: 'cli', pluginPackage: '@openclaw/matrix',
    order: 11, source: 'builtin', docsSlug: 'matrix',
  },
  {
    id: 'google-chat', openclawId: 'googlechat', label: 'Google Chat',
    description: 'Connect via webhook URL',
    color: '#1A73E8', iconType: 'svg',
    connectionType: 'multi-field',
    configFields: [
      { key: 'webhookUrl', label: 'Webhook URL', placeholder: 'https://chat.googleapis.com/...', type: 'text', hint: 'channels.gchat.desc', required: true, cliFlag: '--webhook-url' },
    ],
    saveStrategy: 'cli', pluginPackage: '@openclaw/googlechat',
    order: 9, source: 'builtin', docsSlug: 'googlechat',
  },
];

// ---------------------------------------------------------------------------
// Index maps (built once, rebuilt on dynamic merge)
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
// Dynamic discovery — OpenClaw catalog
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  name: string;
  openclaw?: {
    channel?: {
      id: string;
      label?: string;
      blurb?: string;
      selectionLabel?: string;
      docsPath?: string;
      order?: number;
    };
    install?: { npmSpec?: string };
  };
}

/** Merge channel-catalog.json entries. Builtin channels always take precedence. */
export function mergeCatalog(entries: CatalogEntry[]): void {
  const added: ChannelDef[] = [];
  for (const entry of entries) {
    const ch = entry.openclaw?.channel;
    if (!ch?.id) continue;
    if (_byFrontendId.has(ch.id) || _byOpenclawId.has(ch.id)) continue;

    added.push({
      id: ch.id, openclawId: ch.id,
      label: ch.label || ch.id,
      description: ch.blurb || ch.selectionLabel || '',
      color: hashColor(ch.id), iconType: 'letter',
      connectionType: 'token',
      configFields: [{ key: 'token', label: 'Token', type: 'password', required: true, cliFlag: '--token' }],
      saveStrategy: 'cli',
      pluginPackage: entry.openclaw?.install?.npmSpec || `@openclaw/${ch.id}`,
      source: 'openclaw-catalog',
      order: 100 + (ch.order ?? added.length),
      docsSlug: ch.docsPath?.replace(/^\/channels\//, '') || ch.id,
    });
  }
  _dynamicChannels = added;
  _rebuildIndices();
}

/** Merge cli-startup-metadata channelOptions. Only adds IDs not already in registry. */
export function mergeChannelOptions(channelIds: string[]): void {
  const added: ChannelDef[] = [];
  for (const id of channelIds) {
    if (_byFrontendId.has(id) || _byOpenclawId.has(id)) continue;
    added.push({
      id, openclawId: id,
      label: id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' '),
      color: hashColor(id), iconType: 'letter',
      connectionType: 'token',
      configFields: [{ key: 'token', label: 'Token', type: 'password', required: true, cliFlag: '--token' }],
      saveStrategy: 'cli', pluginPackage: `@openclaw/${id}`,
      source: 'openclaw-catalog', order: 200 + added.length,
      docsSlug: id,
    });
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

/** All channels sorted by order. */
export function getAllChannels(): ChannelDef[] {
  return [...BUILTIN_CHANNELS, ..._dynamicChannels].sort((a, b) => a.order - b.order);
}

/** Builtin channels only (offline fallback). */
export function getBuiltinChannels(): ChannelDef[] {
  return [...BUILTIN_CHANNELS];
}

/** Lookup by frontend ID. */
export function getChannel(id: string): ChannelDef | undefined {
  return _byFrontendId.get(id);
}

/** Lookup by OpenClaw ID. */
export function getChannelByOpenclawId(ocId: string): ChannelDef | undefined {
  return _byOpenclawId.get(ocId);
}

/** Frontend ID → OpenClaw ID. */
export function toOpenclawId(frontendId: string): string {
  return _byFrontendId.get(frontendId)?.openclawId ?? frontendId;
}

/** OpenClaw ID → Frontend ID. */
export function toFrontendId(openclawId: string): string {
  return _byOpenclawId.get(openclawId)?.id ?? openclawId;
}

/** Is this a one-click channel? */
export function isOneClick(id: string): boolean {
  return _byFrontendId.get(id)?.connectionType === 'one-click';
}

/** Does this channel have a brand SVG icon? */
export function hasBrandIcon(id: string): boolean {
  return _byFrontendId.get(id)?.iconType === 'svg';
}

/** Build CLI flags string from config values + channel configFields. */
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

/** Serialize full registry for IPC transport (main → renderer). */
export function serializeRegistry(): ChannelDef[] {
  return getAllChannels();
}
