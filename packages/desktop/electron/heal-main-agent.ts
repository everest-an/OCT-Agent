import fs from 'fs';
import os from 'os';
import path from 'path';

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

  // Persist a backup ONCE per heal so we can undo if anything goes wrong.
  try {
    const backupPath = `${configPath}.bak.heal-${Date.now()}`;
    fs.writeFileSync(backupPath, raw, 'utf8');
  } catch { /* best-effort backup */ }

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (err: any) {
    return { status: 'error', error: `write failed: ${err.message?.slice(0, 120)}` };
  }

  // Ensure the directories exist so OpenClaw doesn't crash on first read.
  try { fs.mkdirSync(main.workspace, { recursive: true }); } catch { /* ignore */ }
  try { fs.mkdirSync(main.agentDir, { recursive: true }); } catch { /* ignore */ }

  return { status: 'healed', changes };
}
