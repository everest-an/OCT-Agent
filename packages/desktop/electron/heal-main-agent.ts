import fs from 'fs';
import os from 'os';
import path from 'path';

import { redirectOrphanBindings } from './bindings-manager';
import { readJsonFileWithBom, safeWriteJsonFile } from './json-file';

/**
 * Self-heal the OpenClaw `main` agent if it has degraded into a "skeleton" entry
 * (no `workspace` and no `agentDir`). This is the default agent for fresh OpenClaw
 * installs and the target of every default channel binding (`{channel:"openclaw-weixin"}
 * → main`, etc.). When `workspace`/`agentDir` are missing the agent is dropped from
 * `openclaw agents list`, channel routing falls into a black hole, and bots stop
 * replying — exactly the failure mode encountered on dev machines that had multiple
 * agents created/edited over time.
 *
 * This runs ONCE at app startup, before any channel/bot worker reconnect logic. It is
 * intentionally read-mostly: if `main` already has both fields, or no `main` exists at
 * all, we leave the file untouched. We never delete or rewrite other agents, never touch
 * bindings, and never re-seed identity files.
 *
 * The OpenClaw filesystem layout we restore is the documented default:
 *   ~/.openclaw/workspace-main         (workspace files)
 *   ~/.openclaw/agents/main/agent      (agent dir for prompts/identity)
 */
export interface HealMainAgentResult {
  status: 'ok' | 'healed' | 'no-config' | 'no-main' | 'error';
  changes?: string[];
  error?: string;
}

export function healMainAgentIfNeeded(home: string = os.homedir()): HealMainAgentResult {
  const configPath = path.join(home, '.openclaw', 'openclaw.json');
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return { status: 'no-config' };
  }
  let config: any;
  try {
    config = JSON.parse(raw);
  } catch (err: any) {
    return { status: 'error', error: `parse failed: ${err.message?.slice(0, 120)}` };
  }
  const list: any[] = config?.agents?.list;
  if (!Array.isArray(list)) return { status: 'no-main' };
  const main = list.find((a) => a && a.id === 'main');
  if (!main) return { status: 'no-main' };

  const changes: string[] = [];
  const desiredWorkspace = path.join(home, '.openclaw', 'workspace-main');
  const desiredAgentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent');

  if (!main.workspace || typeof main.workspace !== 'string') {
    main.workspace = desiredWorkspace;
    changes.push('workspace');
  }
  if (!main.agentDir || typeof main.agentDir !== 'string') {
    main.agentDir = desiredAgentDir;
    changes.push('agentDir');
  }

  if (changes.length === 0) return { status: 'ok' };

  // Persist with safe write (includes backup + size-drop protection).
  try {
    const result = safeWriteJsonFile(configPath, config);
    if (!result.written) {
      return { status: 'error', error: `safe write rejected: ${result.reason}` };
    }
  } catch (err: any) {
    return { status: 'error', error: `write failed: ${err.message?.slice(0, 120)}` };
  }

  // Ensure the directories exist so OpenClaw doesn't crash on first read.
  try { fs.mkdirSync(main.workspace, { recursive: true }); } catch { /* ignore */ }
  try { fs.mkdirSync(main.agentDir, { recursive: true }); } catch { /* ignore */ }

  return { status: 'healed', changes };
}

/**
 * Scan bindings[] for entries whose agentId no longer exists (e.g. user deleted
 * an agent that was previously the "Replied by" target for WeChat), and redirect
 * them to `main` so inbound messages don't drop silently. Safe migration helper
 * for the 2026-04-08 refactor that moved binding management from the Agents page
 * to the Channels page per-channel dropdown.
 *
 * Runs immediately after healMainAgentIfNeeded at app startup so subsequent code
 * (gateway start, channel worker autoReconnect) sees a valid binding graph.
 *
 * Returns the list of redirected bindings for logging, or an empty array if no
 * change was needed.
 */
export function healOrphanBindings(home: string = os.homedir()): ReturnType<typeof redirectOrphanBindings> {
  const configPath = path.join(home, '.openclaw', 'openclaw.json');
  let config: any;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch { return []; }
  const list: any[] = config?.agents?.list;
  if (!Array.isArray(list)) return [];
  const knownAgentIds = new Set<string>(
    list.map((a) => (a && typeof a.id === 'string' ? a.id : null)).filter((x): x is string => !!x),
  );
  // Always include 'main' as a known agent (heal runs just before this and guarantees main exists).
  knownAgentIds.add('main');
  return redirectOrphanBindings(knownAgentIds, 'main', home);
}
