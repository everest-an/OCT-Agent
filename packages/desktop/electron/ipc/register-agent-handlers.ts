import fs from 'fs';
import path from 'path';
import { ipcMain } from 'electron';
import { parseJsonShellOutput } from '../openclaw-shell-output';
import { redirectOrphanBindings } from '../bindings-manager';
import { safeWriteJsonFile } from '../json-file';

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

function isMeaningfulAgentDisplayName(name: string) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return false;
  // Require at least one letter/number in any language.
  // This blocks empty/emoji-only/punctuation-only names that would degrade to oc-<timestamp>.
  return /[\p{L}\p{N}]/u.test(trimmed);
}

function getInvalidAgentDisplayNameReason(name: string): string | null {
  const trimmed = String(name || '').trim();
  if (!trimmed || !isMeaningfulAgentDisplayName(trimmed)) {
    return 'use at least one letter or number';
  }
  if (trimmed.length > 64) {
    return 'maximum length is 64 characters';
  }

  const lowered = trimmed.toLowerCase();
  if (lowered === 'main' || lowered === 'default') {
    return 'reserved names are not allowed';
  }
  // Reject auto-generated id-like names that are easy to confuse with technical ids
  // and were observed in invalid-session-id troubleshooting.
  if (/^oc-\d{6,}$/i.test(trimmed)) {
    return 'auto-generated id style (oc-<digits>) is not allowed';
  }

  return null;
}

function isAllowedMarkdownFile(fileName: string) {
  return path.basename(fileName) === fileName && /^[A-Za-z0-9._-]+\.md$/i.test(fileName);
}

function normalizeAgentEmoji(value: unknown) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed.toLowerCase() === 'default') {
    return '';
  }

  const looksLikeEmoji = (candidate: string) => {
    if (!candidate || candidate.length > 16) {
      return false;
    }
    if (candidate.includes('://') || candidate.includes('/') || candidate.includes('.')) {
      return false;
    }

    const hasEmojiCore = /(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}])/u.test(candidate);
    if (!hasEmojiCore) {
      return false;
    }

    return /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\uFE0F|\u200D|[\u{1F1E6}-\u{1F1FF}])+$/u.test(candidate);
  };

  if (looksLikeEmoji(trimmed)) {
    return trimmed;
  }

  const leadingToken = trimmed.split(/\s+/)[0]?.replace(/[.,;:!?]+$/, '') || '';
  return looksLikeEmoji(leadingToken) ? leadingToken : '';
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
    let name = '';
    let emoji = '';

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      const cleaned = line.replace(/^\s*-\s*/, '');
      const colonIndex = cleaned.indexOf(':');
      if (colonIndex === -1) continue;

      const label = cleaned
        .slice(0, colonIndex)
        .replace(/[*_]/g, '')
        .trim()
        .toLowerCase();
      if (!label) continue;

      const value = cleaned
        .slice(colonIndex + 1)
        .trim()
        .replace(/^[*_]+|[*_]+$/g, '')
        .trim();
      if (!value) continue;

      if (!name && label === 'name') {
        name = value;
      }
      if (!emoji && label === 'emoji') {
        emoji = normalizeAgentEmoji(value);
      }

      if (name && emoji) break;
    }

    return {
      name,
      emoji,
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

let awarenessPluginRepairPromise: Promise<void> | null = null;

function hasAwarenessPluginInstalled(home: string) {
  return fs.existsSync(path.join(home, '.openclaw', 'extensions', 'openclaw-memory', 'package.json'));
}

async function ensureAwarenessPluginInstalledForAgentOps(
  deps: {
    home: string;
    runDoctorFix?: (checkId: string) => Promise<{ success: boolean; message?: string }>;
  },
  reason: string,
) {
  if (hasAwarenessPluginInstalled(deps.home)) return;
  if (!deps.runDoctorFix) return;

  if (!awarenessPluginRepairPromise) {
    awarenessPluginRepairPromise = (async () => {
      try {
        const fix = await deps.runDoctorFix?.('plugin-installed');
        if (!fix?.success) {
          console.warn(`[agents] Awareness plugin auto-heal failed (${reason}):`, fix?.message || 'unknown error');
        }
      } catch (err: any) {
        console.warn(`[agents] Awareness plugin auto-heal threw (${reason}):`, err?.message || String(err));
      }
    })().finally(() => {
      awarenessPluginRepairPromise = null;
    });
  }

  await awarenessPluginRepairPromise;

  if (!hasAwarenessPluginInstalled(deps.home)) {
    console.warn(`[agents] Awareness plugin still missing after auto-heal (${reason}); continuing in degraded mode.`);
  }
}

export function registerAgentHandlers(deps: {
  home: string;
  safeShellExecAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  readShellOutputAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  ensureGatewayRunning: () => Promise<{ ok: boolean; error?: string }>;
  runAsync: (cmd: string, timeoutMs?: number) => Promise<string>;
  runSpawnAsync: (cmd: string, args: string[], timeoutMs?: number) => Promise<string>;
  runDoctorFix?: (checkId: string) => Promise<{ success: boolean; message?: string }>;
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
      const invalidReason = getInvalidAgentDisplayNameReason(displayName);
      if (invalidReason) {
        return { success: false, error: `Invalid agent name: ${invalidReason}.` };
      }

      // Self-heal: after clean installs, openclaw-memory may be configured but not yet
      // physically installed. Repair once before agent operations to avoid slow warnings.
      await ensureAwarenessPluginInstalledForAgentOps(deps, 'agents:add');
      // Slug must be ASCII for filesystem safety.
      // Chinese/Japanese/etc names may produce an empty ASCII slug after stripping,
      // so we use a deterministic fallback with letters to avoid id-style confusion.
      const rawSlug = displayName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      const slug = rawSlug || `agent-${Date.now().toString(36)}`;
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
      // OpenClaw loads all plugins on every CLI invocation. Give enough idle timeout
      // headroom, then fall back to direct config write if CLI still stalls.
      try {
        await deps.runSpawnAsync('openclaw', spawnArgs, 120000);
      } catch (cliErr: any) {
        const raw = cliErr?.message || String(cliErr || '');
        if (/timed out|timeout/i.test(raw)) {
          const fallback = addAgentToConfigFallback(deps.home, slug, { model: safeModel || null });
          if (!fallback.success && !fallback.alreadyExists) {
            return { success: false, error: `Agent creation timed out and fallback failed: ${fallback.error || 'unknown error'}` };
          }
        } else {
          throw cliErr;
        }
      }
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
          safeWriteJsonFile(cfgPath, cfg);
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
      const healed = removeAgentFromConfigAndHealBindings(deps.home, agentId);
      return { success: true, removedFromConfig: healed.removed, redirectedBindings: healed.redirected };
    } catch (err: any) {
      return { success: false, error: err.message?.slice(0, 200) };
    }
  });

  ipcMain.handle('agents:set-identity', async (_e: any, agentId: string, name: string, emoji: string, avatar?: string, theme?: string) => {
    try {
      if (name) {
        const invalidReason = getInvalidAgentDisplayNameReason(name);
        if (invalidReason) {
          return { success: false, error: `Invalid agent name: ${invalidReason}.` };
        }
      }

      const safeEmoji = normalizeAgentEmoji(emoji);
      if (!name && !safeEmoji && !avatar && !theme) {
        return { success: false, error: 'No changes' };
      }

      // Write directly to openclaw.json — instant, no CLI spawn needed.
      // The old approach spawned `openclaw agents set-identity` which loads all
      // plugins (15-60s), pegging the CPU and freezing the entire machine.
      const result = applyAgentIdentityFallback(deps.home, agentId, {
        name: name || undefined,
        emoji: safeEmoji || undefined,
        avatar: avatar || undefined,
        theme: theme || undefined,
      });
      if (!result.success) {
        return { success: false, error: result.error || 'Failed to update identity' };
      }

      // Also update IDENTITY.md in the agent workspace so file-based readers stay in sync.
      try {
        const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const entry = (cfg?.agents?.list || []).find((a: any) => a.id === agentId);
        const agentDir = entry?.agentDir;
        if (agentDir) {
          const identityMdPath = path.join(agentDir, 'IDENTITY.md');
          const identityContent = `---\nname: ${name || agentId}\nemoji: ${safeEmoji || ''}\n${avatar ? `avatar: ${avatar}\n` : ''}${theme ? `theme: ${theme}\n` : ''}---\n`;
          fs.writeFileSync(identityMdPath, identityContent, 'utf-8');
        }
      } catch {
        // Non-critical: IDENTITY.md update is best-effort
      }

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message?.slice(0, 200) };
    }
  });

  ipcMain.handle('agents:bind', async (_e: any, agentId: string, binding: string) => {
    // OpenClaw CLI loads ALL plugins (feishu/awareness-memory/openclaw-weixin/etc.) on every
    // command, which can take 30-60s on machines with many plugins. The previous 30s idle
    // timeout was too tight: weixin plugin's "compat check" / "setWeixinRuntime" stages routinely
    // exceed 30s of stdout silence, causing "Command timed out" with no actual error.
    //
    // Idle timeout (not total): 90s gives weixin/feishu plugin loading enough headroom.
    // 'agents bind' itself (after plugins are loaded) is near-instant.
    try {
      await deps.runSpawnAsync('openclaw', ['agents', 'bind', '--agent', agentId, '--bind', binding], 90000);
      return { success: true };
    } catch (err: any) {
      const raw = err.message || String(err);
      const friendly = /timed out|timeout/i.test(raw)
        ? 'OpenClaw is still loading plugins (this can take 60-90s on first run). Please retry — if it keeps failing, try restarting OpenClaw with `openclaw gateway restart`.'
        : raw.slice(0, 240);
      return { success: false, error: friendly };
    }
  });

  ipcMain.handle('agents:unbind', async (_e: any, agentId: string, binding: string) => {
    try {
      await deps.runSpawnAsync('openclaw', ['agents', 'unbind', '--agent', agentId, '--bind', binding], 90000);
      return { success: true };
    } catch (err: any) {
      const raw = err.message || String(err);
      const friendly = /timed out|timeout/i.test(raw)
        ? 'OpenClaw is still loading plugins (this can take 60-90s on first run). Please retry — if it keeps failing, try restarting OpenClaw with `openclaw gateway restart`.'
        : raw.slice(0, 240);
      return { success: false, error: friendly };
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

function removeAgentFromConfigAndHealBindings(home: string, deletedAgentId: string): { removed: boolean; redirected: number } {
  try {
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    const list: any[] = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
    const nextList = list.filter((a) => String(a?.id || '') !== deletedAgentId);
    const removed = nextList.length !== list.length;

    if (removed) {
      cfg.agents = cfg.agents || {};
      cfg.agents.list = nextList;
      safeWriteJsonFile(configPath, cfg);
    }

    const known = new Set<string>(nextList.map((a) => String(a?.id || '')).filter(Boolean));
    known.add('main');
    const redirected = redirectOrphanBindings(known, 'main', home).length;
    return { removed, redirected };
  } catch {
    return { removed: false, redirected: 0 };
  }
}

export function addAgentToConfigFallback(
  home: string,
  agentId: string,
  options?: { model?: string | null },
): { success: boolean; error?: string; alreadyExists?: boolean } {
  try {
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    let cfg: any = {};
    if (fs.existsSync(configPath)) {
      cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }

    cfg.agents = cfg.agents || {};
    const list: any[] = Array.isArray(cfg.agents.list) ? cfg.agents.list : [];
    if (list.some((entry) => String(entry?.id || '') === agentId)) {
      return { success: false, alreadyExists: true, error: 'Agent already exists' };
    }

    const nextEntry: any = { id: agentId };
    const safeModel = String(options?.model || '').trim();
    if (safeModel) {
      nextEntry.model = safeModel;
    }

    list.push(nextEntry);
    cfg.agents.list = list;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    safeWriteJsonFile(configPath, cfg);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to update openclaw.json' };
  }
}

export function applyAgentIdentityFallback(
  home: string,
  agentId: string,
  identity: { name?: string; emoji?: string; avatar?: string; theme?: string },
): { success: boolean; error?: string } {
  try {
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(configPath)) {
      return { success: false, error: 'openclaw.json not found' };
    }

    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const list: any[] = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
    const entry = list.find((item) => String(item?.id || '') === agentId);
    if (!entry) {
      return { success: false, error: 'Agent not found in config' };
    }

    entry.identity = entry.identity || {};
    if (identity.name) entry.identity.name = identity.name;
    if (identity.emoji) entry.identity.emoji = identity.emoji;
    if (identity.avatar) entry.identity.avatar = identity.avatar;
    if (identity.theme) entry.identity.theme = identity.theme;

    safeWriteJsonFile(configPath, cfg);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to update identity in config' };
  }
}