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
  runSpawnAsync: (cmd: string, args: string[], timeoutMs?: number) => Promise<string>;
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

function buildSubagentSpawnCommand(params: {
  title: string;
  agentId: string;
  model?: string;
  thinking?: string;
  workDir?: string;
}): string {
  const rawDesc = params.workDir
    ? `Working directory: ${params.workDir}\n\n${params.title}`
    : params.title;
  const escaped = rawDesc.replace(/"/g, '\\"');
  let spawnCmd = `/subagents spawn ${params.agentId} "${escaped}"`;
  if (params.model) spawnCmd += ` --model ${params.model}`;
  if (params.thinking) spawnCmd += ` --thinking ${params.thinking}`;
  return spawnCmd;
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

      // Ensure sessions_spawn + agents_list are in alsoAllow
      if (!cfg.tools.alsoAllow) cfg.tools.alsoAllow = [];
      for (const tool of ['sessions_spawn', 'agents_list'] as const) {
        if (!cfg.tools.alsoAllow.includes(tool)) {
          cfg.tools.alsoAllow.push(tool);
        }
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

      const spawnCmd = buildSubagentSpawnCommand(params);

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
          const output = await deps.runSpawnAsync(
            'openclaw',
            ['agent', '--session-id', `ac-task-${Date.now()}`, '--thinking', 'off', '-m', spawnCmd],
            params.timeoutSeconds ? params.timeoutSeconds * 1000 : 120000,
          );
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
    spawnedAgents: Map<string, { agentId: string; agentName: string; sessionKey: string; runId?: string }>;
    // Secondary index: runId → sessionKey (for reliable event matching)
    runIdToKey: Map<string, string>;
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

        // Register mission
        activeMissions.set(params.missionId, {
          missionId: params.missionId,
          cancelled: false,
          sessionKey: params.missionId,
          spawnedAgents: new Map(),
          runIdToKey: new Map(),
        });

        // Direct per-agent routing: create a dedicated webchat session for each agent.
        // Gateway session key format: agent:<agentId>:webchat:<rawSid>
        // This routes the task directly to the specified agent — no LLM orchestration needed.
        // (The /subagents spawn approach was removed: Gateway has no sessions.spawn RPC and
        //  sessions_spawn is not in alsoAllow, so the main-agent-orchestration approach never worked.)
        // Resolve agents: if frontend only passed main (state was empty), read from config
        let resolvedAgents = params.agents;
        if (resolvedAgents.length === 0 || (resolvedAgents.length === 1 && resolvedAgents[0].id === 'main')) {
          try {
            const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
            const raw = fs.readFileSync(configPath, 'utf-8');
            const cfg = JSON.parse(raw);
            const agentList: any[] = cfg?.agents?.list || [];
            if (agentList.length > 0) {
              resolvedAgents = agentList.map((a: any) => ({
                id: a.id || 'main',
                name: (a.identity?.name || a.name || a.id) as string,
                emoji: (a.identity?.emoji || '') as string,
              }));
            }
          } catch { /* keep params.agents */ }
        }
        const nonMainAgents = resolvedAgents.filter(a => a.id !== 'main');
        const agentsToSpawn = nonMainAgents.length > 0 ? nonMainAgents
          : resolvedAgents.length > 0 ? resolvedAgents
          : [{ id: 'main', name: 'Main', emoji: '' }];

        const workDirPrefix = params.workDir ? `Working directory: ${params.workDir}. Task: ` : '';
        const taskMessage = `${workDirPrefix}${params.goal}`;

        // Per-agent stream state (delta events carry cumulative text, not incremental chunks)
        const agentLastText = new Map<string, string>();
        const agentLastStreamTime = new Map<string, number>();
        const STREAM_THROTTLE_MS = 150;
        let finishedCount = 0;

        // Idle timeout state — declared before chatListener so the closure captures correctly
        let lastActivityTime = Date.now();
        const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
        const resetIdleTimer = () => { lastActivityTime = Date.now(); };
        let idleCheckHandle: ReturnType<typeof setInterval> | null = null;

        const chatListener = (payload: any) => {
          const mission = activeMissions.get(params.missionId);
          if (!mission || mission.cancelled) return;

          const key = payload?.sessionKey || '';
          const state = payload?.state || '';
          const eventRunId = payload?.runId || '';

          // Diagnostic: log ALL incoming chat events for this mission window
          console.log(`[mission:chat-event] missionId=${params.missionId} key=${key} runId=${eventRunId} state=${state} registeredRunIds=${JSON.stringify([...mission.runIdToKey.keys()])} registeredKeys=${JSON.stringify([...mission.spawnedAgents.keys()])}`);

          // Match priority: 1) runId (most reliable), 2) exact sessionKey, 3) endsWith
          let matchedKey: string | null = null;
          if (eventRunId && mission.runIdToKey.has(eventRunId)) {
            matchedKey = mission.runIdToKey.get(eventRunId)!;
          } else if (mission.spawnedAgents.has(key)) {
            matchedKey = key;
          } else if (key) {
            for (const [k] of mission.spawnedAgents) {
              if (k.endsWith(key) || key.endsWith(k)) {
                matchedKey = k;
                break;
              }
            }
          }
          if (!matchedKey) return;

          // Reset idle timeout on activity from any registered agent
          resetIdleTimer();

          const spawnedInfo = mission.spawnedAgents.get(matchedKey)!;

          if (state === 'delta') {
            const fullText = extractMsgText(payload?.message?.content);
            const lastText = agentLastText.get(matchedKey) || '';
            if (fullText && fullText.length > lastText.length) {
              const newChunk = fullText.slice(lastText.length);
              const isFirstChunk = lastText === '';
              agentLastText.set(matchedKey, fullText);
              const now = Date.now();
              const lastTime = agentLastStreamTime.get(matchedKey) || 0;
              if (now - lastTime >= STREAM_THROTTLE_MS) {
                agentLastStreamTime.set(matchedKey, now);
                // Prefix with agent name on first chunk when multiple agents are running
                const prefix = agentsToSpawn.length > 1 && isFirstChunk
                  ? `\n\n**${spawnedInfo.agentName}:**\n`
                  : '';
                sendMissionProgress(params.missionId, {
                  streamDelta: prefix + newChunk,
                });
              }
            }
            return;
          }

          if (state === 'final') {
            const text = extractMsgText(payload?.message?.content);
            sendMissionProgress(params.missionId, {
              stepUpdate: {
                sessionKey: matchedKey,
                agentId: spawnedInfo.agentId,
                status: 'done',
                result: text.slice(0, 2000),
                completedAt: new Date().toISOString(),
              },
            });
            finishedCount++;
          } else if (state === 'error' || state === 'aborted') {
            sendMissionProgress(params.missionId, {
              stepUpdate: {
                sessionKey: matchedKey,
                agentId: spawnedInfo.agentId,
                status: 'failed',
                error: payload?.errorMessage || 'Step failed',
                completedAt: new Date().toISOString(),
              },
            });
            finishedCount++;
          }

          // Mark mission done when all agents finish
          if ((state === 'final' || state === 'error' || state === 'aborted') && finishedCount >= agentsToSpawn.length) {
            if (idleCheckHandle) clearInterval(idleCheckHandle);
            ws.off('event:chat', chatListener);
            sendMissionProgress(params.missionId, {
              streamDelta: null,
              missionPatch: {
                status: 'done',
                completedAt: new Date().toISOString(),
              },
            });
            activeMissions.delete(params.missionId);
          }
        };

        ws.on('event:chat', chatListener);

        // Notify frontend: mission is now running
        sendMissionProgress(params.missionId, {
          missionPatch: {
            status: 'running',
            startedAt: new Date().toISOString(),
            sessionKey: params.missionId,
          },
          streamDelta: `Starting ${agentsToSpawn.length} agent(s)...`,
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

        // Send task to each agent via its own dedicated webchat session.
        // Gateway routes to the correct agent based on session key format.
        const spawnAll = async () => {
          const mRef = activeMissions.get(params.missionId)!;
          for (let i = 0; i < agentsToSpawn.length; i++) {
            const agent = agentsToSpawn[i];
            const pendingKey = `pending-${agent.id}`;
            // Unique session key — Gateway routes to this specific agent.
            // For the main agent, use a plain key (no agent: prefix) to match
            // how regular chat sessions work (regular chat: sid = rawSid for main).
            // For non-main agents, use the full webchat format.
            const agentSessionKey = agent.id !== 'main'
              ? `agent:${agent.id}:webchat:m${params.missionId.slice(-6)}-${i}`
              : `m${params.missionId.slice(-6)}-${i}`;

            // Register real session key BEFORE chatSend so listener can match incoming events
            mRef.spawnedAgents.delete(pendingKey);
            mRef.spawnedAgents.set(agentSessionKey, {
              agentId: agent.id,
              agentName: agent.name || agent.id,
              sessionKey: agentSessionKey,
            });

            // Transition step: waiting → running with real sessionKey.
            // Also update the mission-level sessionKey on the first agent so
            // "View Full Chat" navigates to a real Gateway session (not the
            // synthetic missionId which Gateway doesn't know about).
            const missionPatchForFirstAgent = i === 0
              ? { sessionKey: agentSessionKey }
              : undefined;
            sendMissionProgress(params.missionId, {
              stepUpdate: {
                sessionKey: pendingKey,
                agentId: agent.id,
                status: 'running',
                startedAt: new Date().toISOString(),
                newSessionKey: agentSessionKey,
              },
              ...(missionPatchForFirstAgent ? { missionPatch: missionPatchForFirstAgent } : {}),
            });

            try {
              console.log(`[mission:chatSend] sending to agentSessionKey=${agentSessionKey} agent=${agent.id}`);
              const sendResult = await ws.chatSend(agentSessionKey, taskMessage);
              const actualRunId: string = sendResult?.runId || '';
              console.log(`[mission:chatSend] success agentSessionKey=${agentSessionKey} runId=${actualRunId} result=${JSON.stringify(sendResult)?.slice(0, 200)}`);
              // Register runId → sessionKey mapping for reliable event matching
              if (actualRunId) {
                const mRef2 = activeMissions.get(params.missionId);
                if (mRef2) {
                  mRef2.runIdToKey.set(actualRunId, agentSessionKey);
                  // Also store runId on the agent entry
                  const agentEntry = mRef2.spawnedAgents.get(agentSessionKey);
                  if (agentEntry) agentEntry.runId = actualRunId;
                }
              }
            } catch (err: any) {
              console.error(`[mission:chatSend] ERROR agentSessionKey=${agentSessionKey}:`, err?.message);
              // Immediately mark this agent failed if send fails
              sendMissionProgress(params.missionId, {
                stepUpdate: {
                  sessionKey: agentSessionKey,
                  agentId: agent.id,
                  status: 'failed',
                  error: err?.message?.slice(0, 200) || 'Failed to send task',
                  completedAt: new Date().toISOString(),
                },
              });
              finishedCount++;
            }

            // Small gap between sends to avoid overwhelming Gateway
            if (i < agentsToSpawn.length - 1) {
              await new Promise(r => setTimeout(r, 500));
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

        // Idle timeout: fail if no events received for 5 minutes
        idleCheckHandle = setInterval(() => {
          const m = activeMissions.get(params.missionId);
          if (!m || m.cancelled) { if (idleCheckHandle) clearInterval(idleCheckHandle); return; }
          if (Date.now() - lastActivityTime > IDLE_TIMEOUT_MS) {
            if (idleCheckHandle) clearInterval(idleCheckHandle);
            sendMissionProgress(params.missionId, {
              missionPatch: {
                status: 'failed',
                completedAt: new Date().toISOString(),
                error: 'No activity for 5 minutes — mission stopped',
              },
            });
            activeMissions.delete(params.missionId);
          }
        }, 30000);

        return { success: true, sessionKey: params.missionId };
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
      // Abort all running agent sessions (best-effort)
      try {
        const ws = await deps.getGatewayWs();
        for (const [key] of mission.spawnedAgents) {
          if (!key.startsWith('pending-')) {
            ws.chatAbort(key).catch(() => { /* best-effort per-agent abort */ });
          }
        }
      } catch { /* best-effort */ }
      activeMissions.delete(missionId);
    }
  });
}
