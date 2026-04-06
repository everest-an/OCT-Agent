/**
 * IPC handlers for Task Center — tasks (sub-agent spawn) + workflows (Lobster).
 *
 * Every task maps to an OpenClaw sub-agent run.
 * Every workflow maps to a Lobster YAML pipeline.
 * We never reinvent scheduling/routing — OpenClaw does it all.
 */

import fs from 'fs';
import path from 'path';
import { ipcMain, BrowserWindow, dialog } from 'electron';
import type { GatewayClient } from '../gateway-ws';
import { readJsonFileWithBom } from '../json-file';

// ---------------------------------------------------------------------------
// Deps injected from main.ts
// ---------------------------------------------------------------------------

interface WorkflowHandlerDeps {
  home: string;
  safeShellExecAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  runAsync: (cmd: string, timeoutMs?: number) => Promise<string>;
  getGatewayWs: () => Promise<GatewayClient>;
  getMainWindow: () => BrowserWindow | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openclawConfigPath(home: string): string {
  return path.join(home, '.openclaw', 'openclaw.json');
}

function tasksCachePath(home: string): string {
  const dir = path.join(home, '.openclaw', 'awarenessclaw');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'tasks.json');
}

function workflowsDir(home: string): string {
  const dir = path.join(home, '.openclaw', 'awarenessclaw', 'workflows');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Read subagent config from openclaw.json. */
function readSubagentConfig(home: string): {
  maxSpawnDepth: number;
  maxChildrenPerAgent: number;
  agentToAgentEnabled: boolean;
} {
  try {
    const cfg = readJsonFileWithBom<Record<string, any>>(openclawConfigPath(home));
    const defaults = cfg?.agents?.defaults?.subagents || {};
    const a2a = cfg?.tools?.agentToAgent || {};
    return {
      maxSpawnDepth: defaults.maxSpawnDepth ?? 1,
      maxChildrenPerAgent: defaults.maxChildrenPerAgent ?? 5,
      agentToAgentEnabled: a2a.enabled ?? false,
    };
  } catch {
    return { maxSpawnDepth: 1, maxChildrenPerAgent: 5, agentToAgentEnabled: false };
  }
}

/** Write subagent config into openclaw.json (immutable merge).
 *
 * Key setup steps for multi-agent spawn to work:
 * 1. agents.defaults.subagents.maxSpawnDepth >= 2
 * 2. tools.agentToAgent.enabled = true
 * 3. tools.agentToAgent.allow = ["*"]
 * 4. tools.alsoAllow includes "sessions_spawn"
 * 5. main agent's agents.list[].subagents.allowAgents = ["*"]
 *    (per-agent allow list — agents.defaults.subagents.allowAgents is rejected by schema)
 */
function writeSubagentConfig(
  home: string,
  patch: { maxSpawnDepth?: number; agentToAgentEnabled?: boolean },
): boolean {
  try {
    const cfgPath = openclawConfigPath(home);
    const cfg = readJsonFileWithBom<Record<string, any>>(cfgPath) || {};

    if (patch.maxSpawnDepth !== undefined) {
      if (!cfg.agents) cfg.agents = {};
      if (!cfg.agents.defaults) cfg.agents.defaults = {};
      if (!cfg.agents.defaults.subagents) cfg.agents.defaults.subagents = {};
      cfg.agents.defaults.subagents.maxSpawnDepth = patch.maxSpawnDepth;
    }

    if (patch.agentToAgentEnabled !== undefined) {
      if (!cfg.tools) cfg.tools = {};
      if (!cfg.tools.agentToAgent) cfg.tools.agentToAgent = {};
      cfg.tools.agentToAgent.enabled = patch.agentToAgentEnabled;
      cfg.tools.agentToAgent.allow = ['*'];

      // Ensure sessions_spawn is in alsoAllow
      if (!cfg.tools.alsoAllow) cfg.tools.alsoAllow = [];
      if (!cfg.tools.alsoAllow.includes('sessions_spawn')) {
        cfg.tools.alsoAllow.push('sessions_spawn');
      }

      // Set allowAgents=["*"] on every agent in agents.list
      // (must be per-agent, NOT agents.defaults — schema rejects it there)
      if (Array.isArray(cfg.agents?.list)) {
        for (const agent of cfg.agents.list) {
          if (!agent.subagents) agent.subagents = {};
          agent.subagents.allowAgents = ['*'];
        }
      }
    }

    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sub-agent event listener (attaches to GatewayClient once)
// ---------------------------------------------------------------------------

let subagentListenerAttached = false;

function attachSubagentListener(deps: WorkflowHandlerDeps) {
  if (subagentListenerAttached) return;
  subagentListenerAttached = true;

  // We attach lazily when the first task operation happens.
  // The listener forwards sub-agent lifecycle events to the renderer.
  //
  // OpenClaw Gateway event structure (verified via source code):
  //
  //   Event "agent" — carries ALL agent lifecycle/tool/assistant events:
  //     payload.stream = "lifecycle" | "tool" | "assistant" | "error"
  //     payload.data.phase = "start" | "end" | "error"  (for lifecycle stream)
  //     payload.runId, payload.sessionKey
  //
  //   Event "chat" — chat completion events:
  //     payload.state = "delta" | "final" | "aborted" | "error"
  //     payload.runId, payload.sessionKey
  //     payload.message?.content (for final)
  //
  //   Note: "sessions.changed" does NOT exist as a Gateway event (verified via
  //   GitHub source + Issue #38966). Sub-agent tracking must use event:agent
  //   with sessionKey containing "subagent:" segment instead.
  //
  //   Event ordering: lifecycle:end fires BEFORE chat:final.
  //   runId is always present (required field on AgentEventPayload).
  //   Sub-agent sessionKey format: agent:<id>:subagent:<uuid>
  //
  deps.getGatewayWs().then((ws) => {
    // Helper: check if a sessionKey belongs to a sub-agent (format: agent:<id>:subagent:<uuid>)
    const isSubagentSession = (key: string | undefined): boolean =>
      typeof key === 'string' && key.includes(':subagent:');

    // 1. Agent lifecycle events (stream=lifecycle, data.phase=start/end/error)
    //    CRITICAL: Only process sub-agent events. Main agent events (e.g. processing
    //    the /subagents spawn command) must be ignored — otherwise the spawn confirmation
    //    is misinterpreted as task completion.
    ws.on('event:agent', (payload: any) => {
      const win = deps.getMainWindow();
      if (!win || win.isDestroyed()) return;

      const sessionKey: string = payload?.sessionKey || '';

      // For sub-agent events: forward lifecycle to renderer
      if (isSubagentSession(sessionKey)) {
        // Support TWO payload formats (verified via Web Search):
        //   New: payload.stream = "lifecycle", payload.data.phase = "start"|"end"|"error"
        //   Old: payload.event = "subagent.spawned"|"agent.finished"|"agent.step_started"
        const stream: string = payload?.stream || '';
        const phase: string = payload?.data?.phase || '';
        const eventName: string = payload?.event || payload?.state || '';
        const status: string = payload?.status || payload?.data?.status || '';

        let taskEvent: string | null = null;

        // New format (AgentEventPayload from src/infra/agent-events.ts)
        if (stream === 'lifecycle') {
          if (phase === 'start') taskEvent = 'started';
          else if (phase === 'end') taskEvent = 'completed';
          else if (phase === 'error') taskEvent = 'failed';
        } else if (stream === 'error') {
          taskEvent = 'failed';
        }

        // Old format (event name strings from OpenClaw docs)
        if (!taskEvent) {
          if (eventName === 'subagent.spawned' || eventName === 'agent.step_started') taskEvent = 'started';
          else if (eventName === 'agent.finished') {
            taskEvent = (status === 'failed' || status === 'timeout') ? 'failed' : 'completed';
          }
        }

        if (!taskEvent) return;

        const resultText = payload?.data?.error || payload?.result || payload?.data?.result || '';

        win.webContents.send('task:status-update', {
          event: taskEvent,
          runId: payload?.runId || '',
          agentId: payload?.agentId || '',
          status: taskEvent,
          result: typeof resultText === 'string' ? resultText : '',
          sessionKey,
        });
        return;
      }

      // For main agent events: check if spawn response contains sub-agent info.
      // Main agent's chat response to /subagents spawn includes:
      //   "Spawned subagent <name> (session agent:<id>:subagent:<uuid>, run <runId>)."
      // We parse this to link the task to the actual sub-agent session.
      if (payload?.stream === 'assistant') {
        const text: string = payload?.data?.text || '';
        const spawnMatch = text.match(/session\s+(agent:\S+:subagent:\S+),\s+run\s+(\S+)\)/);
        if (spawnMatch) {
          win.webContents.send('task:subagent-linked', {
            parentRunId: payload?.runId || '',
            parentSessionKey: sessionKey,
            subagentSessionKey: spawnMatch[1],
            subagentRunId: spawnMatch[2].replace(/[).]$/, ''),
          });
        }
      }
    });

    // 2. Chat completion events (state=final/error/aborted)
    //    CRITICAL: Only process sub-agent chat events. Main agent's chat:final
    //    for the spawn command must NOT mark the task as completed.
    ws.on('event:chat', (payload: any) => {
      const win = deps.getMainWindow();
      if (!win || win.isDestroyed()) return;

      const sessionKey: string = payload?.sessionKey || '';

      // Only process sub-agent chat completions
      if (!isSubagentSession(sessionKey)) return;

      const state: string = payload?.state || '';
      let taskEvent: string | null = null;
      if (state === 'final') taskEvent = 'completed';
      else if (state === 'error') taskEvent = 'failed';
      else if (state === 'aborted') taskEvent = 'failed';

      if (!taskEvent) return;

      // Extract result text from chat final message
      const message = payload?.message;
      const resultText = Array.isArray(message?.content)
        ? message.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('')
        : (typeof message?.content === 'string' ? message.content : '');

      win.webContents.send('task:status-update', {
        event: taskEvent,
        runId: payload?.runId || '',
        agentId: '',
        status: taskEvent,
        result: resultText || payload?.errorMessage || '',
        sessionKey,
      });
    });
  }).catch(() => {
    // Gateway not available — listener will be re-attempted on next operation.
    subagentListenerAttached = false;
  });
}

// ---------------------------------------------------------------------------
// Register IPC handlers
// ---------------------------------------------------------------------------

export function registerWorkflowHandlers(deps: WorkflowHandlerDeps) {
  const { home, safeShellExecAsync, runAsync, getMainWindow } = deps;

  // ---- Configuration ----

  /** Read current subagent/workflow config. */
  ipcMain.handle('workflow:config', async () => {
    return readSubagentConfig(home);
  });

  /** Enable multi-agent collaboration (set maxSpawnDepth=2, agentToAgent=true). */
  ipcMain.handle('workflow:enable-collaboration', async () => {
    const current = readSubagentConfig(home);
    const success = writeSubagentConfig(home, {
      maxSpawnDepth: Math.max(current.maxSpawnDepth, 2),
      agentToAgentEnabled: true,
    });
    if (!success) {
      return { success: false, error: 'Failed to write openclaw.json', config: readSubagentConfig(home) };
    }
    // Restart gateway so config takes effect.
    // Windows: gateway restart may timeout (known issue #49871) — use stop+start instead.
    // If restart fails, config is still saved and will take effect on next gateway start.
    let gatewayRestarted = false;
    try {
      await safeShellExecAsync('openclaw gateway stop', 10000);
      await safeShellExecAsync('openclaw gateway start', 15000);
      gatewayRestarted = true;
    } catch {
      // Best-effort — config is persisted regardless
    }
    return { success: true, gatewayRestarted, config: readSubagentConfig(home) };
  });

  /** Check if Lobster plugin is installed. Fast file check first, CLI fallback. */
  ipcMain.handle('workflow:check-lobster', async () => {
    // 1. Fast: check common file paths (no CLI overhead)
    const possiblePaths = [
      path.join(home, '.npm-global', 'lib', 'node_modules', 'openclaw', 'dist', 'extensions', 'lobster', 'index.js'),
      path.join(home, '.openclaw', 'extensions', 'lobster', 'index.js'),
      path.join(home, '.openclaw', 'extensions', 'lobster', 'index.ts'),
      // Windows: %APPDATA%/npm/node_modules/openclaw/dist/extensions/lobster/index.js
      path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'dist', 'extensions', 'lobster', 'index.js'),
    ];
    for (const p of possiblePaths) {
      if (p && fs.existsSync(p)) {
        return { installed: true, enabled: true };
      }
    }

    // 2. Try finding openclaw install path dynamically
    try {
      const whichOutput = await safeShellExecAsync(
        process.platform === 'win32' ? 'where openclaw 2>nul' : 'which openclaw 2>/dev/null',
        5000,
      );
      if (whichOutput) {
        const openclawBin = whichOutput.trim().split('\n')[0];
        // Resolve symlinks to find actual install dir
        const resolved = fs.realpathSync(openclawBin);
        const distDir = path.dirname(path.dirname(resolved)); // up from bin/openclaw
        const lobsterPath = path.join(distDir, 'extensions', 'lobster', 'index.js');
        if (fs.existsSync(lobsterPath)) {
          return { installed: true, enabled: true };
        }
      }
    } catch { /* fallback to CLI */ }

    // 3. Slowest: CLI check (15s+ due to plugin loading)
    try {
      const output = await safeShellExecAsync('openclaw plugins list 2>&1', 20000);
      if (output) {
        const lower = output.toLowerCase();
        const hasLobster = lower.includes('lobster');
        const isEnabled = hasLobster && (lower.includes('loaded') || lower.includes('enabled'));
        return { installed: hasLobster, enabled: isEnabled };
      }
    } catch { /* timeout or error */ }

    return { installed: false, enabled: false };
  });

  /** Install Lobster plugin. Returns detailed status for UI feedback. */
  ipcMain.handle('workflow:install-lobster', async () => {
    try {
      // openclaw plugins install works cross-platform (Windows/macOS/Linux)
      await runAsync('openclaw plugins install lobster', 120000);

      // Verify installation
      const checkOutput = await safeShellExecAsync('openclaw plugins list 2>&1', 15000);
      const verified = checkOutput?.toLowerCase().includes('lobster') ?? false;

      if (!verified) {
        return { success: false, error: 'Installation completed but Lobster not found in plugins list. Try restarting OpenClaw.' };
      }

      return { success: true };
    } catch (err: any) {
      const msg = err?.message || '';
      // Friendly error messages
      if (msg.includes('EACCES') || msg.includes('permission') || msg.includes('denied')) {
        return { success: false, error: 'Permission denied. Try running as administrator or check npm permissions.' };
      }
      if (msg.includes('timed out') || msg.includes('timeout')) {
        return { success: false, error: 'Installation timed out. Please check your network connection and try again.' };
      }
      if (msg.includes('ENOTFOUND') || msg.includes('network')) {
        return { success: false, error: 'Network error. Please check your internet connection.' };
      }
      return { success: false, error: msg.slice(0, 300) || 'Installation failed' };
    }
  });

  // ---- Task CRUD (sub-agent facade) ----

  /**
   * Create & spawn a sub-agent task.
   * We send `/subagents spawn <agentId> "<task>"` as a user message
   * via Gateway chat.send to the main agent's session.
   * This ensures OpenClaw handles all spawn logic natively.
   */
  ipcMain.handle(
    'task:create',
    async (
      _e,
      params: {
        title: string;
        agentId: string;
        model?: string;
        thinking?: string;
        timeoutSeconds?: number;
        sessionKey?: string;
        workDir?: string;
      },
    ) => {
      // Ensure sub-agent listener is attached
      attachSubagentListener(deps);

      // Build the spawn command.
      // If workDir is specified, prepend a working directory instruction so the agent knows where to operate.
      const rawDesc = params.workDir
        ? `Working directory: ${params.workDir}\n\n${params.title}`
        : params.title;
      const escaped = rawDesc.replace(/"/g, '\\"');
      let spawnCmd = `/subagents spawn ${params.agentId} "${escaped}"`;
      if (params.model) spawnCmd += ` --model ${params.model}`;
      if (params.thinking) spawnCmd += ` --thinking ${params.thinking}`;

      try {
        const ws = await deps.getGatewayWs();
        // Send spawn command to the main agent session
        const sessionKey = params.sessionKey || 'main';
        const result = await ws.chatSend(sessionKey, spawnCmd, {
          thinking: 'off', // No thinking needed for the spawn command itself
        });

        return {
          success: true,
          runId: result?.runId || '',
          sessionKey,
        };
      } catch (err: any) {
        // Fallback to CLI
        try {
          const escaped2 = params.title.replace(/"/g, '\\"').replace(/'/g, "'\\''");
          let cliCmd = `openclaw agent --session-id "ac-task-${Date.now()}" -m '/subagents spawn ${params.agentId} "${escaped2}"'`;
          if (params.model) cliCmd += ` --model ${params.model}`;
          const output = await runAsync(cliCmd, params.timeoutSeconds ? params.timeoutSeconds * 1000 : 120000);
          return { success: true, output, fallback: 'cli' };
        } catch (cliErr: any) {
          return { success: false, error: cliErr?.message?.slice(0, 300) || 'Spawn failed' };
        }
      }
    },
  );

  /** Send a follow-up message to a sub-agent session (task continuation). */
  ipcMain.handle('task:send-message', async (_e, sessionKey: string, message: string) => {
    try {
      const ws = await deps.getGatewayWs();
      await ws.chatSend(sessionKey, message);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message?.slice(0, 200) || 'Send failed' };
    }
  });

  /** Cancel a running task (abort the sub-agent session). */
  ipcMain.handle('task:cancel', async (_e, sessionKey: string) => {
    try {
      const ws = await deps.getGatewayWs();
      await ws.chatAbort(sessionKey);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message?.slice(0, 200) || 'Cancel failed' };
    }
  });

  /** Get sub-agent session history (task detail). */
  ipcMain.handle('task:detail', async (_e, sessionKey: string) => {
    try {
      const ws = await deps.getGatewayWs();
      const messages = await ws.chatHistory(sessionKey);
      return { success: true, messages };
    } catch (err: any) {
      return { success: false, error: err?.message?.slice(0, 200) || 'Failed to load history' };
    }
  });

  // ---- Workflow CRUD (Lobster facade) ----

  /** Parse minimal YAML info from a workflow file (no js-yaml dependency). */
  function parseWorkflowYaml(content: string) {
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const name = nameMatch ? nameMatch[1].trim() : '';

    // Extract first comment line as description
    const descMatch = content.match(/^#\s*(.+)$/m);
    const description = descMatch ? descMatch[1].trim() : '';

    // Extract args (simple top-level keys under `args:`)
    const args: Array<{ name: string; required: boolean; default?: string }> = [];
    const argsBlock = content.match(/^args:\s*\n((?:  \S[^\n]*\n?)*)/m);
    if (argsBlock) {
      const argLines = argsBlock[1].matchAll(/^  (\w+):/gm);
      for (const m of argLines) {
        const argName = m[1];
        const defaultMatch = content.match(new RegExp(`^  ${argName}:[\\s\\S]*?default:\\s*"?([^"\\n]*)"?`, 'm'));
        args.push({
          name: argName,
          required: !defaultMatch,
          default: defaultMatch ? defaultMatch[1].trim() : undefined,
        });
      }
    }

    // Extract steps (id + type + approval)
    const steps: Array<{ id: string; type: string; approval?: boolean }> = [];
    const stepMatches = content.matchAll(/^\s+- id:\s*(\S+)/gm);
    for (const sm of stepMatches) {
      const stepId = sm[1];
      // Look ahead for step type
      const afterId = content.substring(sm.index! + sm[0].length, sm.index! + sm[0].length + 500);
      const hasApproval = /^\s+approval:/m.test(afterId);
      const hasRun = /^\s+run:/m.test(afterId);
      const hasPipeline = /^\s+pipeline:/m.test(afterId);
      const hasCommand = /^\s+command:/m.test(afterId);
      const type = hasApproval ? 'approval' : hasPipeline ? 'pipeline' : (hasRun || hasCommand) ? 'command' : 'unknown';
      steps.push({ id: stepId, type, approval: hasApproval || undefined });
    }

    return { name, description, args, steps };
  }

  /** List available workflow templates (builtin + custom). */
  ipcMain.handle('workflow:list', async () => {
    const workflows: Array<{
      id: string;
      name: string;
      description: string;
      icon: string;
      yamlPath: string;
      isBuiltin: boolean;
      args: Array<{ name: string; required: boolean; default?: string }>;
      steps: Array<{ id: string; type: string; approval?: boolean }>;
    }> = [];

    // Builtin templates — try multiple paths (dev / packaged / asar)
    const possibleBuiltinDirs = [
      path.join(__dirname, '..', 'workflows'),           // dev: dist-electron/../workflows
      path.join(__dirname, '..', '..', 'workflows'),     // packaged: app.asar/dist-electron/../../workflows
      path.join(__dirname, 'workflows'),                  // adjacent
      path.join(process.resourcesPath || '', 'workflows'), // Electron resources dir
      path.join(home, '.openclaw', 'awarenessclaw', 'builtin-workflows'), // user-level copy
    ];
    for (const builtinDir of possibleBuiltinDirs) {
      if (!fs.existsSync(builtinDir)) continue;
      for (const file of fs.readdirSync(builtinDir)) {
        if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
        try {
          const filePath = path.join(builtinDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const parsed = parseWorkflowYaml(content);
          workflows.push({
            id: `builtin-${path.basename(file, path.extname(file))}`,
            name: parsed.name || path.basename(file, path.extname(file)),
            description: parsed.description,
            icon: 'workflow',
            yamlPath: filePath,
            isBuiltin: true,
            args: parsed.args,
            steps: parsed.steps,
          });
        } catch { /* skip malformed files */ }
      }
      break; // Use only the first valid dir
    }

    // Custom workflows
    const customDir = workflowsDir(home);
    if (fs.existsSync(customDir)) {
      for (const file of fs.readdirSync(customDir)) {
        if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
        try {
          const filePath = path.join(customDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const parsed = parseWorkflowYaml(content);
          workflows.push({
            id: `custom-${path.basename(file, path.extname(file))}`,
            name: parsed.name || path.basename(file, path.extname(file)),
            description: parsed.description,
            icon: 'workflow',
            yamlPath: filePath,
            isBuiltin: false,
            args: parsed.args,
            steps: parsed.steps,
          });
        } catch { /* skip */ }
      }
    }

    return { workflows };
  });

  /** Execute a workflow via Lobster CLI. Cross-platform safe. */
  ipcMain.handle(
    'workflow:run',
    async (_e, yamlPath: string, args: Record<string, string>) => {
      try {
        // Cross-platform: use double quotes for JSON args (Windows cmd.exe doesn't support single quotes)
        const argsJson = JSON.stringify(args).replace(/"/g, '\\"');
        const cmd = `openclaw lobster run "${yamlPath}" --args-json "${argsJson}"`;
        const output = await runAsync(cmd, 600000); // 10 min timeout

        // Parse Lobster JSON envelope
        try {
          const jsonStart = output.indexOf('{');
          if (jsonStart >= 0) {
            const parsed = JSON.parse(output.substring(jsonStart));
            return { success: true, ...parsed };
          }
        } catch { /* not JSON */ }

        return { success: true, output };
      } catch (err: any) {
        const msg = err?.message || '';
        if (msg.includes('lobster') && (msg.includes('not found') || msg.includes('not recognized'))) {
          return { success: false, error: 'Lobster is not installed. Please install it from the Workflows tab.' };
        }
        return { success: false, error: msg.slice(0, 300) || 'Workflow execution failed' };
      }
    },
  );

  /** Approve/reject a workflow approval gate. Cross-platform safe. */
  ipcMain.handle(
    'workflow:approve',
    async (_e, resumeToken: string, approve: boolean) => {
      try {
        const payload = JSON.stringify({ action: 'resume', token: resumeToken, approve });
        // Cross-platform: avoid Unix-only echo pipe. Use --stdin-json flag if available,
        // otherwise write to temp file and pipe (works on both Windows and Unix).
        const isWin = process.platform === 'win32';
        let cmd: string;
        if (isWin) {
          // Windows: use PowerShell for stdin piping
          const escaped = payload.replace(/"/g, '\\"');
          cmd = `powershell -Command "echo '${escaped}' | openclaw lobster resume"`;
        } else {
          const escaped = payload.replace(/'/g, "'\\''");
          cmd = `echo '${escaped}' | openclaw lobster resume`;
        }
        const output = await runAsync(cmd, 30000);
        return { success: true, output };
      } catch (err: any) {
        return { success: false, error: err?.message?.slice(0, 200) || 'Approve failed' };
      }
    },
  );

  /** Save a custom workflow YAML. */
  ipcMain.handle('workflow:save', async (_e, fileName: string, content: string) => {
    try {
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '-');
      const filePath = path.join(workflowsDir(home), safeName.endsWith('.yaml') ? safeName : `${safeName}.yaml`);
      fs.writeFileSync(filePath, content, 'utf-8');
      return { success: true, path: filePath };
    } catch (err: any) {
      return { success: false, error: err?.message?.slice(0, 200) || 'Save failed' };
    }
  });

  /** Delete a custom workflow YAML. */
  ipcMain.handle('workflow:delete', async (_e, yamlPath: string) => {
    try {
      // Safety: only allow deleting from our custom workflows directory
      const customDir = workflowsDir(home);
      if (!yamlPath.startsWith(customDir)) {
        return { success: false, error: 'Cannot delete builtin workflows' };
      }
      fs.unlinkSync(yamlPath);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message?.slice(0, 200) || 'Delete failed' };
    }
  });

  /** Pick a directory via native dialog (for workspace selection). */
  ipcMain.handle('task:pick-directory', async () => {
    const win = getMainWindow();
    if (!win) return { cancelled: true };
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select working directory',
    });
    if (result.canceled || !result.filePaths.length) {
      return { cancelled: true };
    }
    return { cancelled: false, path: result.filePaths[0] };
  });

  /** Check task completion by polling session history (fallback for missed events). */
  ipcMain.handle('task:poll-status', async (_e, sessionKey: string) => {
    try {
      const ws = await deps.getGatewayWs();
      const messages = await ws.chatHistory(sessionKey);
      if (!messages || messages.length === 0) return { status: 'unknown' };

      // Check the last message — if it's from agent and has no pending tool calls, likely done
      const last = messages[messages.length - 1];
      const role = last?.role || last?.type || '';
      const hasToolCalls = messages.some((m: any) =>
        m.role === 'tool' || m.type === 'tool_result' || m.type === 'tool_use');

      if (role === 'assistant' && !last?.tool_use) {
        // Has assistant response with no pending tools — likely completed
        const text = last?.content || last?.text || '';
        return { status: 'completed', result: typeof text === 'string' ? text.slice(0, 500) : '' };
      }

      return { status: 'running' };
    } catch {
      return { status: 'unknown' };
    }
  });

  // =========================================================================
  // Mission execution engine — AI-orchestrated multi-agent workflow
  // =========================================================================
  //
  // The main agent is the orchestrator:
  // 1. User submits a goal + workspace
  // 2. We send ONE message to main agent with the goal + available agents list
  // 3. Main agent decides which sub-agents to spawn and does it
  // 4. We track sub-agent spawns + completions via Gateway events
  // 5. Frontend dynamically shows steps as sub-agents are spawned
  //
  // This aligns with OpenClaw's design: agents are autonomous, main agent
  // orchestrates via /subagents spawn.

  /** In-flight missions tracked by sessionKey (main agent session for this mission). */
  const activeMissions = new Map<string, {
    missionId: string;
    cancelled: boolean;
    sessionKey: string;   // dedicated session for this mission
    spawnedAgents: Map<string, { agentId: string; agentName: string; sessionKey: string }>;
  }>();

  /** Extract text content from a message. */
  function extractMsgText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((c: any) => c?.type === 'text')
        .map((c: any) => c.text || '')
        .join('');
    }
    return '';
  }

  /** Send progress update to renderer. */
  function sendMissionProgress(
    missionId: string,
    update: Record<string, unknown>,
  ) {
    const win = deps.getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send('mission:progress', { missionId, ...update });
  }

  /** Start a mission: send goal to main agent and let it orchestrate. */
  ipcMain.handle(
    'mission:start',
    async (
      _e,
      params: {
        missionId: string;
        goal: string;
        workDir?: string;
        agents: Array<{ id: string; name?: string; emoji?: string }>;
      },
    ) => {
      attachSubagentListener(deps);

      try {
        const ws = await deps.getGatewayWs();

        // Use a dedicated session for this mission
        const missionSessionKey = `ac-mission-${Date.now()}`;

        // Register mission
        activeMissions.set(params.missionId, {
          missionId: params.missionId,
          cancelled: false,
          sessionKey: missionSessionKey,
          spawnedAgents: new Map(),
        });

        // Build /subagents spawn commands for each relevant agent.
        // We use slash commands directly (proven to work via E2E test)
        // instead of asking the LLM to call sessions_spawn tool (which fails
        // with "schema must be object or boolean" due to plugin tool schema conflicts).
        //
        // Filter to relevant agents only (skip main — it's the orchestrator)
        const nonMainAgents = params.agents.filter(a => a.id !== 'main');
        const agentsToSpawn = nonMainAgents.length > 0 ? nonMainAgents : [params.agents[0] || { id: 'main', name: 'Main' }];

        const workDirPrefix = params.workDir ? `Working directory: ${params.workDir}. ` : '';

        // CRITICAL: Register event listeners BEFORE sending the message.
        // Gateway events fire immediately and we must not miss deltas.
        // (This mirrors the working pattern in register-chat-handlers.ts)

        // Track cumulative text for delta extraction (delta events carry FULL text, not chunks)
        let lastMainText = '';
        let lastStreamTime = 0;
        const STREAM_THROTTLE_MS = 150;
        const detectedSpawnKeys = new Set<string>();

        /** Detect spawn confirmations in text and update pending steps with real sessionKey */
        function detectSpawnInText(
          text: string,
          missionParams: { missionId: string; agents: Array<{ id: string; name?: string; emoji?: string }> },
          missionState: { spawnedAgents: Map<string, any> },
        ) {
          const regex = /(?:Spawned subagent\s+)?(\S+)\s+\(session\s+(agent:(\S+):subagent:\S+),\s+run\s+(\S+)\)/g;
          let match;
          while ((match = regex.exec(text)) !== null) {
            const subSessionKey = match[2];
            if (detectedSpawnKeys.has(subSessionKey)) continue;
            detectedSpawnKeys.add(subSessionKey);

            const agentId = match[3];
            const agent = missionParams.agents.find(a => a.id === agentId);
            const pendingKey = `pending-${agentId}`;

            // Register the real sessionKey
            missionState.spawnedAgents.set(subSessionKey, {
              agentId,
              agentName: agent?.name || agentId,
              sessionKey: subSessionKey,
            });

            // Update the pending step's sessionKey + status (if it exists)
            if (missionState.spawnedAgents.has(pendingKey)) {
              missionState.spawnedAgents.delete(pendingKey);
              // Update existing step: match by agentId (most reliable) and set real sessionKey
              sendMissionProgress(missionParams.missionId, {
                stepUpdate: {
                  agentId,                          // match by agentId (frontend fallback)
                  sessionKey: pendingKey,            // match by old sessionKey
                  status: 'running',
                  startedAt: new Date().toISOString(),
                  newSessionKey: subSessionKey,      // replace with real sessionKey
                },
              });
            } else {
              // No pending step — create a new one
              sendMissionProgress(missionParams.missionId, {
                newStep: {
                  agentId,
                  agentName: agent?.name || agentId,
                  agentEmoji: agent?.emoji,
                  sessionKey: subSessionKey,
                  status: 'running',
                  startedAt: new Date().toISOString(),
                },
              });
            }
          }
        }

        const chatListener = (payload: any) => {
          const mission = activeMissions.get(params.missionId);
          if (!mission || mission.cancelled) return;

          const key = payload?.sessionKey || '';
          const state = payload?.state || '';

          // Reset idle timeout on any activity
          resetIdleTimer();

          // --- Main agent events ---
          if (key === missionSessionKey) {
            // Streaming delta — extract new text portion and forward
            if (state === 'delta') {
              const fullText = extractMsgText(payload?.message?.content);
              if (fullText && fullText.length > lastMainText.length) {
                const newChunk = fullText.slice(lastMainText.length);
                lastMainText = fullText;
                const now = Date.now();
                if (now - lastStreamTime >= STREAM_THROTTLE_MS) {
                  lastStreamTime = now;
                  sendMissionProgress(params.missionId, { streamDelta: newChunk });
                }
              }
              // Also check delta text for spawn confirmations
              // (spawn confirmation may arrive as delta before final)
              if (fullText) {
                detectSpawnInText(fullText, params, mission);
              }
              return;
            }

            // Main agent chat:final — could be spawn confirmation OR real completion
            if (state === 'final') {
              const result = extractMsgText(payload?.message?.content);
              // Check for spawn confirmations first
              detectSpawnInText(result, params, mission);

              // If text contains "Spawned subagent", this is a spawn confirmation,
              // NOT mission completion. The mission continues while sub-agents work.
              if (result.includes('Spawned subagent')) {
                // Reset streaming text (spawn confirmation is not content to show)
                lastMainText = '';
                sendMissionProgress(params.missionId, { streamDelta: null });
                return; // Don't mark mission as done
              }

              // Real completion (main agent's final response after all sub-agents done)
              sendMissionProgress(params.missionId, {
                streamDelta: null,
                missionPatch: {
                  status: 'done',
                  completedAt: new Date().toISOString(),
                  result: result.slice(0, 3000),
                },
              });
              activeMissions.delete(params.missionId);
              return;
            }

            if (state === 'error' || state === 'aborted') {
              sendMissionProgress(params.missionId, {
                streamDelta: null,
                missionPatch: {
                  status: 'failed',
                  completedAt: new Date().toISOString(),
                  error: payload?.errorMessage || 'Mission failed',
                },
              });
              activeMissions.delete(params.missionId);
              return;
            }
          }

          // --- Sub-agent events ---
          if (key.includes(':subagent:') && mission.spawnedAgents.has(key)) {
            const spawnedInfo = mission.spawnedAgents.get(key);

            // Sub-agent streaming
            if (state === 'delta') {
              const text = extractMsgText(payload?.message?.content);
              if (text) {
                sendMissionProgress(params.missionId, {
                  stepStream: { sessionKey: key, agentId: spawnedInfo?.agentId, delta: text },
                });
              }
              return;
            }

            if (state === 'final') {
              const text = extractMsgText(payload?.message?.content);
              sendMissionProgress(params.missionId, {
                stepUpdate: {
                  sessionKey: key,
                  agentId: spawnedInfo?.agentId,
                  status: 'done',
                  result: text.slice(0, 2000),
                  completedAt: new Date().toISOString(),
                },
              });
            } else if (state === 'error' || state === 'aborted') {
              sendMissionProgress(params.missionId, {
                stepUpdate: {
                  sessionKey: key,
                  agentId: spawnedInfo?.agentId,
                  status: 'failed',
                  error: payload?.errorMessage || 'Step failed',
                  completedAt: new Date().toISOString(),
                },
              });
            }

            // Check if ALL subagents are done — if so, mark mission complete
            if (state === 'final' || state === 'error' || state === 'aborted') {
              const realKeys = Array.from(mission.spawnedAgents.keys())
                .filter(k => !k.startsWith('pending-'));
              // We'll let the main agent's final event handle mission completion
            }
          }
        };

        // Sub-agent spawn detection
        const agentListener = (payload: any) => {
          const mission = activeMissions.get(params.missionId);
          if (!mission || mission.cancelled) return;

          // Detect spawn confirmation from main agent's assistant stream
          if (payload?.stream === 'assistant' && payload?.sessionKey === missionSessionKey) {
            const text = payload?.data?.text || '';
            const spawnMatch = text.match(/session\s+(agent:(\S+):subagent:\S+),\s+run\s+(\S+)\)/);
            if (spawnMatch) {
              const subSessionKey = spawnMatch[1];
              const agentId = spawnMatch[2];
              const agent = params.agents.find(a => a.id === agentId);

              mission.spawnedAgents.set(subSessionKey, {
                agentId,
                agentName: agent?.name || agentId,
                sessionKey: subSessionKey,
              });

              // Tell frontend a new step was added
              sendMissionProgress(params.missionId, {
                newStep: {
                  agentId,
                  agentName: agent?.name || agentId,
                  agentEmoji: agent?.emoji,
                  sessionKey: subSessionKey,
                  status: 'running',
                  startedAt: new Date().toISOString(),
                },
              });
            }
          }
        };

        ws.on('event:chat', chatListener);
        ws.on('event:agent', agentListener);

        // NOW send spawn commands (after listeners are registered)
        sendMissionProgress(params.missionId, {
          missionPatch: {
            status: 'running',
            startedAt: new Date().toISOString(),
            sessionKey: missionSessionKey,
          },
          streamDelta: `Spawning ${agentsToSpawn.length} agent(s)...`,
        });

        // Show all agents as pending steps immediately
        const missionRef = activeMissions.get(params.missionId)!;
        for (const agent of agentsToSpawn) {
          const pendingKey = `pending-${agent.id}`;
          missionRef.spawnedAgents.set(pendingKey, {
            agentId: agent.id,
            agentName: agent.name || agent.id,
            sessionKey: pendingKey,
          });
          sendMissionProgress(params.missionId, {
            newStep: {
              agentId: agent.id,
              agentName: agent.name || agent.id,
              agentEmoji: (agent as any).emoji,
              sessionKey: pendingKey,
              status: 'waiting',
            },
          });
        }

        // Spawn all agents sequentially (each spawn uses the same mission session)
        // Each agent gets a separate spawn command with a 2s gap to avoid overwhelming Gateway
        const spawnAll = async () => {
          for (const agent of agentsToSpawn) {
            const taskDesc = `${workDirPrefix}${params.goal}`.replace(/"/g, '\\"');
            const cmd = `/subagents spawn ${agent.id} "${taskDesc}"`;
            try {
              await ws.chatSend(missionSessionKey, cmd);
            } catch { /* individual spawn failure handled by event listener */ }
            // Wait 2s between spawns to let Gateway process
            if (agentsToSpawn.indexOf(agent) < agentsToSpawn.length - 1) {
              await new Promise(r => setTimeout(r, 2000));
            }
          }
        };

        spawnAll().catch((err: Error) => {
          sendMissionProgress(params.missionId, {
            streamDelta: null,
            missionPatch: {
              status: 'failed',
              completedAt: new Date().toISOString(),
              error: `Gateway error: ${err?.message?.slice(0, 200) || 'Send failed'}`,
            },
          });
          activeMissions.delete(params.missionId);
        });

        // Idle timeout: only fail if no events received for 5 minutes
        // (not total time — a long task running for 1 hour is fine as long as it's active)
        let lastActivityTime = Date.now();
        const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min idle = timeout
        const idleCheck = setInterval(() => {
          const m = activeMissions.get(params.missionId);
          if (!m || m.cancelled) { clearInterval(idleCheck); return; }
          if (Date.now() - lastActivityTime > IDLE_TIMEOUT_MS) {
            clearInterval(idleCheck);
            sendMissionProgress(params.missionId, {
              missionPatch: {
                status: 'failed',
                completedAt: new Date().toISOString(),
                error: 'No activity for 5 minutes — mission stopped',
              },
            });
            activeMissions.delete(params.missionId);
          }
        }, 30000); // check every 30s

        // Reset idle timer whenever we get any event (called from chatListener)
        const resetIdleTimer = () => { lastActivityTime = Date.now(); };

        return { success: true, sessionKey: missionSessionKey };
      } catch (err: any) {
        activeMissions.delete(params.missionId);
        return { success: false, error: err?.message?.slice(0, 300) || 'Failed to start mission' };
      }
    },
  );

  /** Cancel a running mission. */
  ipcMain.handle('mission:cancel', async (_e, missionId: string) => {
    const mission = activeMissions.get(missionId);
    if (mission) {
      mission.cancelled = true;
      // Try to abort the main agent session
      try {
        const ws = await deps.getGatewayWs();
        await ws.chatAbort(mission.sessionKey);
      } catch { /* best-effort */ }
      activeMissions.delete(missionId);
    }
  });
}
