import fs from 'fs';
import os from 'os';
import path from 'path';
import { readJsonFileWithBom, safeWriteJsonFile } from './json-file';

/**
 * Channel-level default inbound-agent routing for AwarenessClaw.
 *
 * OpenClaw stores routing rules in `openclaw.json bindings[]` with first-match-wins
 * semantics:
 *
 *     bindings: [
 *       { type: "route", agentId: "main", match: { channel: "openclaw-weixin" } },
 *       { type: "route", agentId: "main", match: { channel: "feishu" } },
 *       ...
 *     ]
 *
 * Entries with a `peer` or `accountId` qualifier are higher-priority peer/account
 * routes — power-user territory, likely hand-edited in openclaw.json. This module
 * ONLY manages the coarse "who handles this channel by default?" rules (no peer,
 * no accountId). Peer/account rules are left alone: because they match more
 * specifically and OpenClaw evaluates bindings in array order, we insert our
 * channel-level defaults at the TAIL so they act as a fallback after any peer
 * rules at the head.
 *
 * Invariants enforced:
 *   - Exactly zero or one channel-level binding per channel (duplicates are dedup'd
 *     at write time, last writer wins).
 *   - Peer-level and account-level entries are preserved verbatim.
 *   - Empty `bindings: []` is a valid state; we create the array on first write.
 */

const OPENCLAW_CONFIG_REL = path.join('.openclaw', 'openclaw.json');

export interface BindingEntry {
  type?: string;
  agentId: string;
  match?: {
    channel?: string;
    accountId?: string;
    peer?: string;
  };
}

interface ConfigShape {
  bindings?: BindingEntry[];
  [key: string]: unknown;
}

function configPath(home: string = os.homedir()): string {
  return path.join(home, OPENCLAW_CONFIG_REL);
}

function readConfig(home: string): ConfigShape | null {
  const p = configPath(home);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as ConfigShape;
    return null;
  } catch {
    return null;
  }
}

function writeConfig(home: string, config: ConfigShape): boolean {
  const p = configPath(home);
  try {
    const result = safeWriteJsonFile(p, config as Record<string, any>);
    return result.written;
  } catch {
    return false;
  }
}

/** Returns true if an entry is a plain channel-level binding (no peer / accountId). */
function isChannelLevelBinding(b: BindingEntry, channelId: string): boolean {
  const m = b?.match;
  if (!m || typeof m !== 'object') return false;
  if (m.channel !== channelId) return false;
  if (m.peer) return false;
  if (m.accountId) return false;
  return true;
}

/**
 * Return the agentId that currently handles the given channel by default, or
 * `null` if no channel-level binding exists (user may have only peer-level rules,
 * in which case the inbound-agent dropdown should show "auto" / blank).
 */
export function getChannelInboundAgent(channelId: string, home: string = os.homedir()): string | null {
  if (!channelId) return null;
  const config = readConfig(home);
  if (!config) return null;
  const list = Array.isArray(config.bindings) ? config.bindings : [];
  const match = list.find((b) => isChannelLevelBinding(b, channelId));
  return match?.agentId || null;
}

/**
 * Overwrite the channel-level inbound agent for a channel. Peer/account rules
 * for the same channel are preserved untouched. Duplicate channel-level entries
 * are collapsed to a single entry with the new agentId.
 *
 * The new entry is placed at the TAIL of bindings[] so peer/account rules at
 * the head (which match more specifically) still win. OpenClaw evaluates bindings
 * in order, first match wins, but peer/account matches beat channel-only matches
 * because they describe a strict subset.
 *
 * Returns true on success, false on config read/write errors.
 */
export function setChannelInboundAgent(
  channelId: string,
  agentId: string,
  home: string = os.homedir(),
): boolean {
  if (!channelId || !agentId) return false;
  const config = readConfig(home);
  if (!config) return false;
  const list: BindingEntry[] = Array.isArray(config.bindings) ? [...config.bindings] : [];
  // Drop every existing channel-level binding for this channel (keep peer/accountId rules).
  const filtered = list.filter((b) => !isChannelLevelBinding(b, channelId));
  // Append the new channel-level binding at the tail.
  filtered.push({ type: 'route', agentId, match: { channel: channelId } });
  config.bindings = filtered;
  return writeConfig(home, config);
}

/**
 * Called right after `channel:setup` successfully connects a channel. Ensures the
 * channel has SOME channel-level routing rule by inserting `{agentId: defaultAgent,
 * match: {channel}}` if none exists. Does NOT overwrite an existing channel-level
 * binding (respects user's prior manual choice).
 *
 * Returns:
 *  - 'inserted': a new default binding was added
 *  - 'kept':     an existing channel-level binding was preserved
 *  - 'error':    config read/write failed
 *  - 'no-config': openclaw.json missing (e.g. fresh install before OpenClaw runs)
 */
export function ensureDefaultChannelBinding(
  channelId: string,
  defaultAgentId: string = 'main',
  home: string = os.homedir(),
): 'inserted' | 'kept' | 'error' | 'no-config' {
  if (!channelId) return 'error';
  const p = configPath(home);
  if (!fs.existsSync(p)) return 'no-config';
  const config = readConfig(home);
  if (!config) return 'error';
  const list: BindingEntry[] = Array.isArray(config.bindings) ? [...config.bindings] : [];
  const existing = list.find((b) => isChannelLevelBinding(b, channelId));
  if (existing) return 'kept';
  list.push({ type: 'route', agentId: defaultAgentId, match: { channel: channelId } });
  config.bindings = list;
  return writeConfig(home, config) ? 'inserted' : 'error';
}

/**
 * Migration helper: scan bindings[] for entries whose agentId no longer exists
 * (e.g. user deleted an agent that was previously the inbound agent for WeChat).
 * Redirect those orphan channel-level bindings to `fallbackAgentId` (usually main)
 * so inbound messages don't drop silently. Peer/account bindings are also
 * redirected because "agent was deleted" means the routing rule can't possibly
 * still be what the user wanted.
 *
 * Returns the list of `{ channelId, oldAgent, newAgent }` tuples that were
 * redirected (empty if no change was needed). Unknown agents are detected by
 * comparing against `knownAgentIds`.
 */
export function redirectOrphanBindings(
  knownAgentIds: Set<string>,
  fallbackAgentId: string = 'main',
  home: string = os.homedir(),
): Array<{ channelId: string; oldAgent: string; newAgent: string; qualifier: string }> {
  const config = readConfig(home);
  if (!config || !Array.isArray(config.bindings)) return [];
  const changes: Array<{ channelId: string; oldAgent: string; newAgent: string; qualifier: string }> = [];
  const next: BindingEntry[] = config.bindings.map((b) => {
    if (!b || typeof b !== 'object') return b;
    const aid = b.agentId;
    if (!aid || knownAgentIds.has(aid)) return b;
    const ch = b.match?.channel || '?';
    const qualifier = b.match?.peer
      ? `peer:${b.match.peer}`
      : b.match?.accountId
        ? `account:${b.match.accountId}`
        : 'channel';
    changes.push({ channelId: ch, oldAgent: aid, newAgent: fallbackAgentId, qualifier });
    return { ...b, agentId: fallbackAgentId };
  });
  if (changes.length === 0) return [];
  config.bindings = next;
  if (!writeConfig(home, config)) return [];
  return changes;
}
