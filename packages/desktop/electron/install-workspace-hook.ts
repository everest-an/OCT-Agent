import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Deploy and register the AwarenessClaw "active workspace" hook into the OpenClaw
 * runtime. This hook runs `before_prompt_build` for every inbound message — channel
 * (WeChat, Telegram, …) and otherwise — and prepends a "[Project working directory: …]"
 * prefix derived from `~/.awarenessclaw/active-workspace.json`. That file is written by
 * the desktop chat workspace selector.
 *
 * Result: WeChat and other channel messages get the SAME working-directory context the
 * desktop chat already injects via register-chat-handlers.ts:416, without moving any
 * agent-scoped files (AGENTS.md / SOUL.md / MEMORY.md / USER.md stay in workspace-main).
 *
 * The hook is a tiny CommonJS module deployed to:
 *   ~/.openclaw/hooks/awareness-workspace-inject/index.cjs
 *
 * And registered in openclaw.json under hooks.internal.entries.
 *
 * Idempotent: re-deploying overwrites the script (so we can patch it) but never breaks
 * other hooks. Skips entirely if `~/.openclaw/openclaw.json` does not exist (fresh install
 * before OpenClaw has been run).
 */
export interface InstallWorkspaceHookResult {
  status: 'ok' | 'no-config' | 'deployed' | 'updated' | 'error';
  changes?: string[];
  error?: string;
}

const HOOK_NAME = 'awareness-workspace-inject';
const HOOK_VERSION = 1; // bump when index.cjs body changes meaningfully

const HOOK_SCRIPT = `// AwarenessClaw active-workspace prompt-injection hook
// version: ${HOOK_VERSION}
// Auto-deployed by AwarenessClaw — DO NOT edit manually.
//
// Reads ~/.awarenessclaw/active-workspace.json on every before_prompt_build event and
// returns prependContext that names the active project directory. Mirrors the prefix
// the desktop chat already injects via register-chat-handlers.ts so channel inbound
// messages get the same project context without moving agent-scoped files.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_PATH = path.join(os.homedir(), '.awarenessclaw', 'active-workspace.json');

function readActiveWorkspace() {
  try {
    if (!fs.existsSync(STATE_PATH)) return null;
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.path !== 'string') return null;
    if (!parsed.path.trim()) return null;
    return parsed.path;
  } catch { return null; }
}

function pathExists(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; }
}

const PREFIX_TEMPLATE = (ws) =>
  '[Project working directory: ' + ws + '] Use this directory as the default root for ' +
  'file operations in this conversation. When the user asks you to read, write, edit, or ' +
  'create project files, prefer absolute paths inside this directory or set your command ' +
  "cwd there. Do not treat this folder as the agent's home workspace; AGENTS.md, USER.md, " +
  'SOUL.md, MEMORY.md, and other agent-scoped files still follow the configured agent ' +
  'workspace.';

module.exports = {
  hooks: {
    before_prompt_build: async (event, _ctx) => {
      try {
        const ws = readActiveWorkspace();
        if (!ws) return undefined;
        if (!pathExists(ws)) return undefined;
        // Skip if the desktop chat's own prefix is already present (it injects the same
        // string via register-chat-handlers.ts; double-injecting would waste tokens).
        const body = (event && (event.body || event.content)) || '';
        if (typeof body === 'string' && body.indexOf('[Project working directory:') >= 0) {
          return undefined;
        }
        return {
          prependContext: PREFIX_TEMPLATE(ws),
        };
      } catch { return undefined; }
    },
  },
};
`;

export function installWorkspaceInjectHook(home: string = os.homedir()): InstallWorkspaceHookResult {
  const configPath = path.join(home, '.openclaw', 'openclaw.json');
  if (!fs.existsSync(configPath)) return { status: 'no-config' };

  const hookDir = path.join(home, '.openclaw', 'hooks', HOOK_NAME);
  const hookFile = path.join(hookDir, 'index.cjs');
  const stateDir = path.join(home, '.awarenessclaw');

  const changes: string[] = [];

  // 1. Ensure the awarenessclaw state dir exists so the hook can read it without errors.
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch { /* ignore */ }

  // 2. Deploy / update the hook script.
  try {
    fs.mkdirSync(hookDir, { recursive: true });
    let needWrite = true;
    if (fs.existsSync(hookFile)) {
      try {
        const existing = fs.readFileSync(hookFile, 'utf8');
        if (existing === HOOK_SCRIPT) needWrite = false;
      } catch { /* fall through and rewrite */ }
    }
    if (needWrite) {
      fs.writeFileSync(hookFile, HOOK_SCRIPT, 'utf8');
      changes.push('hook-script');
    }
  } catch (err: any) {
    return { status: 'error', error: `script deploy failed: ${err.message?.slice(0, 120)}` };
  }

  // 3. Register the hook in openclaw.json (idempotent).
  let raw: string;
  try { raw = fs.readFileSync(configPath, 'utf8'); }
  catch (err: any) { return { status: 'error', error: `read config failed: ${err.message?.slice(0, 120)}` }; }
  let config: any;
  try { config = JSON.parse(raw); }
  catch (err: any) { return { status: 'error', error: `parse config failed: ${err.message?.slice(0, 120)}` }; }

  if (!config || typeof config !== 'object') config = {};
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
  if (!config.hooks.internal || typeof config.hooks.internal !== 'object') config.hooks.internal = {};
  if (typeof config.hooks.internal.enabled !== 'boolean') config.hooks.internal.enabled = true;
  if (!config.hooks.internal.entries || typeof config.hooks.internal.entries !== 'object') {
    config.hooks.internal.entries = {};
  }

  const existingEntry = config.hooks.internal.entries[HOOK_NAME];
  const desiredEntry = {
    enabled: true,
    path: hookFile,
    description: 'AwarenessClaw: inject active project working directory into channel inbound messages',
  };
  let entryChanged = false;
  if (!existingEntry || typeof existingEntry !== 'object') {
    entryChanged = true;
  } else if (
    existingEntry.enabled !== true
    || existingEntry.path !== hookFile
    || existingEntry.description !== desiredEntry.description
  ) {
    entryChanged = true;
  }
  if (entryChanged) {
    config.hooks.internal.entries[HOOK_NAME] = desiredEntry;
    changes.push('config-entry');
    try {
      // Backup once per change so a misconfig is recoverable.
      fs.writeFileSync(`${configPath}.bak.hook-${Date.now()}`, raw, 'utf8');
    } catch { /* best-effort */ }
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch (err: any) {
      return { status: 'error', error: `write config failed: ${err.message?.slice(0, 120)}` };
    }
  }

  if (changes.length === 0) return { status: 'ok' };
  return { status: 'deployed', changes };
}

/** Read the current active workspace, or null if none set. */
export function readActiveWorkspace(home: string = os.homedir()): string | null {
  try {
    const p = path.join(home, '.awarenessclaw', 'active-workspace.json');
    if (!fs.existsSync(p)) return null;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed.path !== 'string' || !parsed.path.trim()) return null;
    return parsed.path;
  } catch { return null; }
}

/** Write the active workspace path. Empty / null clears it. */
export function writeActiveWorkspace(workspacePath: string | null, home: string = os.homedir()): void {
  const dir = path.join(home, '.awarenessclaw');
  const file = path.join(dir, 'active-workspace.json');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  if (!workspacePath || !workspacePath.trim()) {
    try { fs.unlinkSync(file); } catch { /* ignore — already gone */ }
    return;
  }
  fs.writeFileSync(file, JSON.stringify({ path: workspacePath, ts: Date.now() }, null, 2), 'utf8');
}
