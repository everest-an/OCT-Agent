import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  getChannelInboundAgent,
  setChannelInboundAgent,
  ensureDefaultChannelBinding,
  redirectOrphanBindings,
} from '../../electron/bindings-manager';

/**
 * Unit tests for the channel-level inbound-agent routing layer introduced in the
 * 2026-04-08 refactor. Each test runs in an isolated HOME so none of them ever
 * touches the real ~/.openclaw state on the developer's machine.
 *
 * Coverage:
 *   - getChannelInboundAgent (basic read, missing file, no binding, respects peer/account filters)
 *   - setChannelInboundAgent (insert, overwrite, dedup, preserves peer/account)
 *   - ensureDefaultChannelBinding (insert on empty, kept on existing, handles no-config)
 *   - redirectOrphanBindings (redirect unknown agents, preserve known ones)
 */

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awc-bindings-test-'));
  fs.mkdirSync(path.join(dir, '.openclaw'), { recursive: true });
  return dir;
}

function writeConfig(home: string, config: any): void {
  fs.writeFileSync(
    path.join(home, '.openclaw', 'openclaw.json'),
    JSON.stringify(config, null, 2),
    'utf8',
  );
}

function readConfig(home: string): any {
  return JSON.parse(fs.readFileSync(path.join(home, '.openclaw', 'openclaw.json'), 'utf8'));
}

describe('bindings-manager', () => {
  let HOME: string;

  beforeEach(() => {
    HOME = makeTempHome();
  });

  afterEach(() => {
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── getChannelInboundAgent ─────────────────────────────────────────────

  it('getChannelInboundAgent returns null when config is missing', () => {
    expect(getChannelInboundAgent('openclaw-weixin', HOME)).toBeNull();
  });

  it('getChannelInboundAgent returns null when channel has no binding', () => {
    writeConfig(HOME, { bindings: [] });
    expect(getChannelInboundAgent('openclaw-weixin', HOME)).toBeNull();
  });

  it('getChannelInboundAgent returns the bound agent id', () => {
    writeConfig(HOME, {
      bindings: [
        { type: 'route', agentId: 'main', match: { channel: 'openclaw-weixin' } },
      ],
    });
    expect(getChannelInboundAgent('openclaw-weixin', HOME)).toBe('main');
  });

  it('getChannelInboundAgent ignores peer-level bindings (power-user rules stay hidden)', () => {
    writeConfig(HOME, {
      bindings: [
        { type: 'route', agentId: 'designer', match: { channel: 'openclaw-weixin', peer: 'wxid_abc' } },
      ],
    });
    // No plain channel-level binding → should return null, not 'designer'.
    expect(getChannelInboundAgent('openclaw-weixin', HOME)).toBeNull();
  });

  it('getChannelInboundAgent ignores accountId-level bindings', () => {
    writeConfig(HOME, {
      bindings: [
        { type: 'route', agentId: 'workagent', match: { channel: 'whatsapp', accountId: 'work' } },
      ],
    });
    expect(getChannelInboundAgent('whatsapp', HOME)).toBeNull();
  });

  // ── setChannelInboundAgent ─────────────────────────────────────────────

  it('setChannelInboundAgent inserts a new channel-level binding', () => {
    writeConfig(HOME, { bindings: [] });
    expect(setChannelInboundAgent('openclaw-weixin', 'main', HOME)).toBe(true);
    const cfg = readConfig(HOME);
    expect(cfg.bindings).toEqual([
      { type: 'route', agentId: 'main', match: { channel: 'openclaw-weixin' } },
    ]);
  });

  it('setChannelInboundAgent overwrites the existing channel-level binding (last writer wins)', () => {
    writeConfig(HOME, {
      bindings: [
        { type: 'route', agentId: 'main', match: { channel: 'openclaw-weixin' } },
      ],
    });
    expect(setChannelInboundAgent('openclaw-weixin', 'designer', HOME)).toBe(true);
    const cfg = readConfig(HOME);
    const matches = cfg.bindings.filter((b: any) => b.match?.channel === 'openclaw-weixin' && !b.match?.peer && !b.match?.accountId);
    expect(matches).toHaveLength(1);
    expect(matches[0].agentId).toBe('designer');
  });

  it('setChannelInboundAgent preserves peer-level bindings for the same channel', () => {
    writeConfig(HOME, {
      bindings: [
        { type: 'route', agentId: 'speciallist', match: { channel: 'openclaw-weixin', peer: 'wxid_boss' } },
        { type: 'route', agentId: 'main', match: { channel: 'openclaw-weixin' } },
      ],
    });
    setChannelInboundAgent('openclaw-weixin', 'designer', HOME);
    const cfg = readConfig(HOME);
    // The peer rule is still there untouched.
    const peerRules = cfg.bindings.filter((b: any) => b.match?.peer === 'wxid_boss');
    expect(peerRules).toHaveLength(1);
    expect(peerRules[0].agentId).toBe('speciallist');
    // And the channel-level rule was swapped to designer.
    const chRules = cfg.bindings.filter((b: any) => b.match?.channel === 'openclaw-weixin' && !b.match?.peer);
    expect(chRules).toHaveLength(1);
    expect(chRules[0].agentId).toBe('designer');
  });

  it('setChannelInboundAgent collapses duplicate channel-level entries to one', () => {
    writeConfig(HOME, {
      bindings: [
        { type: 'route', agentId: 'a', match: { channel: 'telegram' } },
        { type: 'route', agentId: 'b', match: { channel: 'telegram' } },
        { type: 'route', agentId: 'c', match: { channel: 'telegram' } },
      ],
    });
    setChannelInboundAgent('telegram', 'd', HOME);
    const cfg = readConfig(HOME);
    const chRules = cfg.bindings.filter((b: any) => b.match?.channel === 'telegram' && !b.match?.peer && !b.match?.accountId);
    expect(chRules).toHaveLength(1);
    expect(chRules[0].agentId).toBe('d');
  });

  it('setChannelInboundAgent returns false on invalid inputs', () => {
    writeConfig(HOME, { bindings: [] });
    expect(setChannelInboundAgent('', 'main', HOME)).toBe(false);
    expect(setChannelInboundAgent('openclaw-weixin', '', HOME)).toBe(false);
  });

  // ── ensureDefaultChannelBinding ────────────────────────────────────────

  it('ensureDefaultChannelBinding returns "no-config" when openclaw.json missing', () => {
    // No config written — helper should not throw nor create the file.
    expect(ensureDefaultChannelBinding('openclaw-weixin', 'main', HOME)).toBe('no-config');
  });

  it('ensureDefaultChannelBinding inserts a default main binding on first setup', () => {
    writeConfig(HOME, {});
    expect(ensureDefaultChannelBinding('openclaw-weixin', 'main', HOME)).toBe('inserted');
    expect(getChannelInboundAgent('openclaw-weixin', HOME)).toBe('main');
  });

  it('ensureDefaultChannelBinding respects an existing channel-level binding (no overwrite)', () => {
    writeConfig(HOME, {
      bindings: [
        { type: 'route', agentId: 'designer', match: { channel: 'openclaw-weixin' } },
      ],
    });
    expect(ensureDefaultChannelBinding('openclaw-weixin', 'main', HOME)).toBe('kept');
    // Still designer — did not flip to main.
    expect(getChannelInboundAgent('openclaw-weixin', HOME)).toBe('designer');
  });

  it('ensureDefaultChannelBinding inserts default even when peer rule exists (peer rules do not count as channel default)', () => {
    writeConfig(HOME, {
      bindings: [
        { type: 'route', agentId: 'speciallist', match: { channel: 'openclaw-weixin', peer: 'wxid_boss' } },
      ],
    });
    expect(ensureDefaultChannelBinding('openclaw-weixin', 'main', HOME)).toBe('inserted');
    expect(getChannelInboundAgent('openclaw-weixin', HOME)).toBe('main');
    // Peer rule still preserved alongside the new default.
    const cfg = readConfig(HOME);
    const peerRules = cfg.bindings.filter((b: any) => b.match?.peer === 'wxid_boss');
    expect(peerRules).toHaveLength(1);
  });

  // ── redirectOrphanBindings ─────────────────────────────────────────────

  it('redirectOrphanBindings leaves known-agent bindings alone', () => {
    writeConfig(HOME, {
      bindings: [
        { type: 'route', agentId: 'main', match: { channel: 'openclaw-weixin' } },
        { type: 'route', agentId: 'main', match: { channel: 'telegram' } },
      ],
    });
    const changes = redirectOrphanBindings(new Set(['main']), 'main', HOME);
    expect(changes).toEqual([]);
  });

  it('redirectOrphanBindings redirects orphan agents to fallback', () => {
    writeConfig(HOME, {
      bindings: [
        { type: 'route', agentId: 'deleted-agent', match: { channel: 'openclaw-weixin' } },
        { type: 'route', agentId: 'main', match: { channel: 'telegram' } },
      ],
    });
    const changes = redirectOrphanBindings(new Set(['main']), 'main', HOME);
    expect(changes).toHaveLength(1);
    expect(changes[0].channelId).toBe('openclaw-weixin');
    expect(changes[0].oldAgent).toBe('deleted-agent');
    expect(changes[0].newAgent).toBe('main');
    // Actual file updated.
    expect(getChannelInboundAgent('openclaw-weixin', HOME)).toBe('main');
  });

  it('redirectOrphanBindings records peer-rule qualifier when redirecting', () => {
    writeConfig(HOME, {
      bindings: [
        { type: 'route', agentId: 'gone', match: { channel: 'openclaw-weixin', peer: 'wxid_x' } },
      ],
    });
    const changes = redirectOrphanBindings(new Set(['main']), 'main', HOME);
    expect(changes).toHaveLength(1);
    expect(changes[0].qualifier).toBe('peer:wxid_x');
  });

  it('redirectOrphanBindings handles missing config gracefully', () => {
    expect(redirectOrphanBindings(new Set(['main']), 'main', HOME)).toEqual([]);
  });
});
