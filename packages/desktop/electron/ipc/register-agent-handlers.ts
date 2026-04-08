import fs from 'fs';
import path from 'path';
import { ipcMain } from 'electron';
import { parseJsonShellOutput } from '../openclaw-shell-output';

const DEFAULT_AGENT_IDS = new Set(['main', 'default']);
const PREFERRED_MARKDOWN_ORDER = [
  'AGENTS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  'MEMORY.md',
  'SOUL.md',
  'TOOLS.md',
  'USER.md',
];

function toAgentSlug(agentId: string) {
  return agentId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function isAllowedMarkdownFile(fileName: string) {
  return path.basename(fileName) === fileName && /^[A-Za-z0-9._-]+\.md$/i.test(fileName);
}

function normalizeAgentEmoji(value: unknown) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.toLowerCase() === 'default' ? '' : trimmed;
}

function hasLegacyDefaultEmoji(value: unknown) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'default';
}

function sanitizeLegacyIdentityMarkdown(content: string) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  let changed = false;
  const nextLines = content.split(/\r?\n/).map((line) => {
    const updated = line
      .replace(/^(\s*-\s*\*\*emoji\*\*:\s*)default(\s*)$/i, '$1$2')
      .replace(/^(\s*-\s*\*\*emoji:\*\*\s*)default(\s*)$/i, '$1$2')
      .replace(/^(\s*\*\*emoji\*\*:\s*)default(\s*)$/i, '$1$2')
      .replace(/^(\s*\*\*emoji:\*\*\s*)default(\s*)$/i, '$1$2');
    if (updated !== line) changed = true;
    return updated;
  });
  return changed ? nextLines.join(newline) : content;
}

function migrateLegacyDefaultIdentityFiles(home: string, agentId: string) {
  const seen = new Set<string>();
  const identityPaths = getAgentReadDirectories(home, agentId)
    .map((directory) => path.join(directory, 'IDENTITY.md'));

  for (const filePath of identityPaths) {
    if (seen.has(filePath) || !fs.existsSync(filePath)) continue;
    seen.add(filePath);
    try {
      const current = fs.readFileSync(filePath, 'utf-8');
      const updated = sanitizeLegacyIdentityMarkdown(current);
      if (updated !== current) {
        fs.writeFileSync(filePath, updated, 'utf-8');
      }
    } catch {
      // Best-effort migration only; listing agents should still succeed.
    }
  }
}

function getAgentReadDirectories(home: string, agentId: string) {
  const slug = toAgentSlug(agentId);
  const globalWorkspaceDir = path.join(home, '.openclaw', 'workspace');
  const agentDir = path.join(home, '.openclaw', 'agents', slug, 'agent');
  if (DEFAULT_AGENT_IDS.has(agentId)) return [globalWorkspaceDir, agentDir];
  // OpenClaw uses two possible workspace paths depending on how the agent was created:
  // - ~/.openclaw/workspaces/<slug> (if --workspace was passed)
  // - ~/.openclaw/workspace-<slug> (OpenClaw's default when no --workspace is passed)
  // Check both, prefer whichever actually exists.
  const nestedWsDir = path.join(home, '.openclaw', 'workspaces', slug);
  const flatWsDir = path.join(home, '.openclaw', `workspace-${slug}`);
  const wsDir = fs.existsSync(flatWsDir) ? flatWsDir : nestedWsDir;
  return [wsDir, agentDir];
}

function listMarkdownFilesFromDirectories(directories: string[]) {
  const discovered = new Set<string>();
  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!isAllowedMarkdownFile(entry.name)) continue;
      discovered.add(entry.name);
    }
  }
  return Array.from(discovered).sort((left, right) => {
    const leftIndex = PREFERRED_MARKDOWN_ORDER.indexOf(left);
    const rightIndex = PREFERRED_MARKDOWN_ORDER.indexOf(right);
    if (leftIndex !== -1 || rightIndex !== -1) {
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    }
    return left.localeCompare(right);
  });
}

/**
 * Parse Name/Emoji fields from an IDENTITY.md file.
 * Handles both `- **Name:** Claw` and `- **Name: ** Claw` variants.
 */
function readIdentityFromMarkdown(filePath: string): { name: string; emoji: string } {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const nameMatch = content.match(/\*\*Name[:\*]+\s*(.*)/i);
    const emojiMatch = content.match(/\*\*Emoji[:\*]+\s*(.*)/i);
    return {
      name: nameMatch?.[1]?.trim() || '',
      emoji: normalizeAgentEmoji(emojiMatch?.[1]?.trim()),
    };
  } catch {
    return { name: '', emoji: '' };
  }
}

/**
 * Fallback: read agent list directly from openclaw.json when CLI fails
 * (e.g. after OpenClaw upgrade introduces config schema changes).
 */
function readAgentsFromConfig(home: string): { success: boolean; agents: any[] } {
  try {
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    const agentList: any[] = cfg?.agents?.list || [];
    if (agentList.length === 0) {
      return { success: true, agents: [{ id: 'main', name: 'Main Agent', emoji: '', isDefault: true, bindings: [] }] };
    }
    const agents = agentList.map((a: any) => {
      let name: string = a.identity?.name || a.name || '';
      let emoji: string = normalizeAgentEmoji(a.identity?.emoji);
      // openclaw.json often stores main agent without an identity block.
      // Fall back to reading IDENTITY.md from the agent workspace directory.
      if (!name || !emoji) {
        const dirs = getAgentReadDirectories(home, a.id || 'main');
        for (const dir of dirs) {
          const mdPath = path.join(dir, 'IDENTITY.md');
          if (fs.existsSync(mdPath)) {
            const md = readIdentityFromMarkdown(mdPath);
            if (!name && md.name) name = md.name;
            if (!emoji && md.emoji) emoji = md.emoji;
            if (name && emoji) break;
          }
        }
      }
      return {
        id: a.id || 'main',
        name: name || a.id || 'main',
        emoji,
        model: a.model || null,
        bindings: Array.isArray(a.bindings) ? a.bindings : [],
        isDefault: a.id === 'main',
        workspace: a.workspace || null,
        routes: Array.isArray(a.routes) ? a.routes : [],
      };
    });
    for (const agent of agentList) {
      const agentId = agent?.id || 'main';
      if (hasLegacyDefaultEmoji(agent?.identity?.emoji)) {
        // Run file migration off the main thread — never block an IPC response with sync I/O
        setImmediate(() => migrateLegacyDefaultIdentityFiles(home, agentId));
      }
    }
    return { success: true, agents };
  } catch {
    return { success: true, agents: [{ id: 'main', name: 'Main Agent', emoji: '', isDefault: true, bindings: [] }] };
  }
}

export function registerAgentHandlers(deps: {
  home: string;
  safeShellExecAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  readShellOutputAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  ensureGatewayRunning: () => Promise<{ ok: boolean; error?: string }>;
  runAsync: (cmd: string, timeoutMs?: number) => Promise<string>;
  runSpawnAsync: (cmd: string, args: string[], timeoutMs?: number) => Promise<string>;
}) {
  ipcMain.handle('agents:list', async () => {
    // Fast path: read agent list directly from openclaw.json (< 1ms, no CLI spawn).
    // Spawning the OpenClaw CLI here loads all plugins and takes 15-30 seconds,
    // which pegs the CPU and freezes the Electron renderer (macOS spawn lock-up).
    // openclaw.json is the authoritative config — identity, bindings, and workspace
    // paths are all stored there after any `agents add/bind/set-identity` call.
    const fastResult = readAgentsFromConfig(deps.home);
    if (fastResult.success && fastResult.agents.length > 0) {
      return fastResult;
    }

    // Config was empty or unreadable — fall back to CLI as last resort.
    try {
      const output = await deps.readShellOutputAsync('openclaw agents list --json --bindings', 15000);
      if (output) {
        try {
          const parsed = parseJsonShellOutput<any>(output);
          if (!parsed) {
            throw new Error('Could not parse agents JSON');
          }
          let list: any[] = [];
          if (Array.isArray(parsed)) {
            list = parsed;
          } else if (Array.isArray(parsed.agents)) {
            list = parsed.agents;
          } else if (Array.isArray(parsed.data)) {
            list = parsed.data;
          } else if (parsed && typeof parsed === 'object' && (parsed.id || parsed.name)) {
            list = [parsed];
          }
          if (list.length > 0) {
            for (const agent of list) {
              const agentId = agent?.id || agent?.name || 'main';
              if (hasLegacyDefaultEmoji(agent?.identityEmoji || agent?.emoji || '')) {
                setImmediate(() => migrateLegacyDefaultIdentityFiles(deps.home, agentId));
              }
            }
            const agents = list.map((a: any) => ({
              id: a.id || a.name || 'main',
              name: a.identityName || a.displayName || a.name || a.id,
              emoji: normalizeAgentEmoji(a.identityEmoji || a.emoji || ''),
              model: a.model || a.defaultModel || null,
              bindings: Array.isArray(a.bindingDetails) ? a.bindingDetails : Array.isArray(a.bindings) ? a.bindings : [],
              isDefault: a.isDefault === true || a.default === true || a.id === 'main',
              workspace: a.workspace || a.workspacePath || null,
              routes: a.routes || a.channels || [],
            }));
            return { success: true, agents };
          }
        } catch {}
      }
      return readAgentsFromConfig(deps.home);
    } catch {
      return readAgentsFromConfig(deps.home);
    }
  });

  ipcMain.handle('agents:add', async (_e: any, name: string, model?: string, systemPrompt?: string) => {
    try {
      // Allow Unicode display names (Chinese, Japanese, etc.) — only strip shell-unsafe chars
      const displayName = name.replace(/["\\\n\r]/g, '').trim();
      if (!displayName) return { success: false, error: 'Invalid agent name' };
      await deps.ensureGatewayRunning();
      // Slug must be ASCII for filesystem safety.
      // Chinese/Japanese/etc names produce empty slug after stripping, so we use oc-<timestamp>.
      // We also prefix with "oc-" to avoid OpenClaw reserved names like "main".
      const rawSlug = displayName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      const slug = rawSlug || `oc-${Date.now()}`;
      // Use OpenClaw's default workspace path format: ~/.openclaw/workspace-<slug>
      // NOT ~/.openclaw/workspaces/<slug> which is our old convention.
      // --non-interactive requires --workspace, and OpenClaw seeds workspace files
      // (AGENTS.md, BOOTSTRAP.md, SOUL.md, etc.) only when the dir does NOT exist.
      //
      // CRITICAL: Pass the ASCII slug as the agent name to `openclaw agents add`, NOT the
      // Unicode displayName. OpenClaw normalizes non-ASCII names by stripping all non-ASCII
      // chars, which for pure Chinese names produces "" → fallback to "main" → rejected as
      // reserved. The display name is set afterwards via `agents set-identity`.
      const wsDir = path.join(deps.home, '.openclaw', `workspace-${slug}`);
      const spawnArgs = ['agents', 'add', slug, '--non-interactive', '--workspace', wsDir];
      const safeModel = model ? model.replace(/[^a-zA-Z0-9/_:.-]/g, '') : '';
      if (safeModel) { spawnArgs.push('--model', safeModel); }
      // OpenClaw loads all plugins on every CLI invocation (15-20s), so 45s timeout is needed
      await deps.runSpawnAsync('openclaw', spawnArgs, 45000);
      // Strip the auto-generated `workspace` field that `openclaw agents add`
      // wrote into openclaw.json. When that field is set, OpenClaw's write/exec
      // tools refuse to operate outside ~/.openclaw/workspace-<slug>, so users
      // get "I can't save the file" hallucinations when asking the sub-agent
      // to write into ~/Documents/anywhere. main agent has no such field and
      // works fine — we make sub-agents match.
      // We still need --workspace on the CLI invocation above so OpenClaw seeds
      // SOUL.md / AGENTS.md / BOOTSTRAP.md etc. into the slug dir; we just don't
      // want the field to persist in the config afterwards.
      try {
        const cfgPath = path.join(deps.home, '.openclaw', 'openclaw.json');
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        const list: any[] = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
        const entry = list.find((a) => a?.id === slug);
        if (entry && entry.workspace === wsDir) {
          delete entry.workspace;
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        }
      } catch {
        // Non-fatal: sanitize on next app start will catch it.
      }
      if (systemPrompt) {
        const agentDir = path.join(deps.home, '.openclaw', 'agents', slug, 'agent');
        fs.mkdirSync(wsDir, { recursive: true });
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(wsDir, 'SOUL.md'), systemPrompt, 'utf-8');
        fs.writeFileSync(path.join(agentDir, 'SOUL.md'), systemPrompt, 'utf-8');
      }
      return { success: true, agentId: slug };
    } catch (err: any) {
      return { success: false, error: err.message?.slice(0, 200) };
    }
  });

  ipcMain.handle('agents:delete', async (_e: any, agentId: string) => {
    if (agentId === 'main') return { success: false, error: 'Cannot delete default agent' };
    try {
      // OpenClaw loads all plugins (15-20s), so 45s timeout is needed
      try {
        await deps.runSpawnAsync('openclaw', ['agents', 'delete', agentId, '--force'], 45000);
      } catch (cliErr: any) {
        // Agent may not be registered in OpenClaw (orphan from failed creation).
        // Fall through to manual cleanup below.
        const msg = cliErr?.message || '';
        if (!/not found|does not exist/i.test(msg) && !/timed? ?out/i.test(msg)) {
          throw cliErr;
        }
      }
      // Manual cleanup of workspace + agent directories (handles orphan agents too)
      const slug = toAgentSlug(agentId);
      const dirsToClean = [
        path.join(deps.home, '.openclaw', 'workspaces', slug),
        path.join(deps.home, '.openclaw', `workspace-${slug}`),
        path.join(deps.home, '.openclaw', 'agents', slug),
      ];
      for (const dir of dirsToClean) {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message?.slice(0, 200) };
    }
  });

  ipcMain.handle('agents:set-identity', async (_e: any, agentId: string, name: string, emoji: string, avatar?: string, theme?: string) => {
    try {
      const args = ['agents', 'set-identity', '--agent', agentId];
      if (name) { args.push('--name', name); }
      if (emoji) { args.push('--emoji', emoji); }
      if (avatar) { args.push('--avatar', avatar); }
      if (theme) { args.push('--theme', theme); }
      if (args.length <= 4) return { success: false, error: 'No changes' };
      await deps.runSpawnAsync('openclaw', args, 30000);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message?.slice(0, 200) };
    }
  });

  ipcMain.handle('agents:bind', async (_e: any, agentId: string, binding: string) => {
    try {
      await deps.runSpawnAsync('openclaw', ['agents', 'bind', '--agent', agentId, '--bind', binding], 30000);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message?.slice(0, 200) };
    }
  });

  ipcMain.handle('agents:unbind', async (_e: any, agentId: string, binding: string) => {
    try {
      await deps.runSpawnAsync('openclaw', ['agents', 'unbind', '--agent', agentId, '--bind', binding], 30000);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message?.slice(0, 200) };
    }
  });

  ipcMain.handle('agents:list-files', async (_e: any, agentId: string) => {
    try {
      const directories = getAgentReadDirectories(deps.home, agentId);
      return { success: true, files: listMarkdownFilesFromDirectories(directories) };
    } catch (err: any) {
      return { success: false, error: err.message?.slice(0, 200), files: [] };
    }
  });

  ipcMain.handle('agents:read-file', async (_e: any, agentId: string, fileName: string) => {
    if (!isAllowedMarkdownFile(fileName)) return { success: false, error: 'File not allowed' };
    try {
      const candidates = getAgentReadDirectories(deps.home, agentId).map((directory) => path.join(directory, fileName));
      for (const fp of candidates) {
        if (fs.existsSync(fp)) {
          return { success: true, content: fs.readFileSync(fp, 'utf-8'), path: fp };
        }
      }
      return { success: true, content: '', path: candidates[0] };
    } catch (err: any) {
      return { success: false, error: err.message?.slice(0, 200) };
    }
  });

  ipcMain.handle('agents:write-file', async (_e: any, agentId: string, fileName: string, content: string) => {
    if (!isAllowedMarkdownFile(fileName)) return { success: false, error: 'File not allowed' };
    try {
      // Use getAgentReadDirectories which already handles both workspace path formats
      const targets = getAgentReadDirectories(deps.home, agentId);
      for (const dir of targets) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, fileName), content, 'utf-8');
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message?.slice(0, 200) };
    }
  });

  // Delete a workspace file (e.g. BOOTSTRAP.md after first-run wizard completes)
  ipcMain.handle('agents:delete-file', async (_e: any, agentId: string, fileName: string) => {
    if (!isAllowedMarkdownFile(fileName)) return { success: false, error: 'File not allowed' };
    try {
      // Use getAgentReadDirectories which handles both workspace path formats
      const targets = getAgentReadDirectories(deps.home, agentId);
      let deleted = false;
      for (const dir of targets) {
        const fp = path.join(dir, fileName);
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          deleted = true;
        }
      }
      return { success: true, deleted };
    } catch (err: any) {
      return { success: false, error: err.message?.slice(0, 200) };
    }
  });
}