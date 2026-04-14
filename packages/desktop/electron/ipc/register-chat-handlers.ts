import { spawn } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { ipcMain } from 'electron';
import type { GatewayClient } from '../gateway-ws';
import { getExecApprovalSettings } from '../openclaw-config';

// Extracted modules — pure copy/paste, no logic changes
import type { ChatSendOptions, MemoryCapturePolicy } from './chat-types';
import { chatState, CHAT_TIMEOUT_MS, CHAT_IDLE_TIMEOUT_MS } from './chat-types';
import {
  normalizeDesktopRole,
  normalizeContentBlocks,
  extractAssistantText,
  extractAssistantThinking,
  truncateDetail,
  extractToolDetail,
  extractToolArgs,
  extractToolOutput,
  buildToolCallsFromBlocks,
  buildDesktopMessage,
  mergeToolResultIntoAssistantMessage,
  buildDesktopHistory,
} from './chat-message-builders';
import type { NormalizedAgentEvent } from './gateway-event-normalizer';
import { normalizeAgentGatewayEvent } from './gateway-event-normalizer';
import {
  getHostOsLabel,
  looksLikePathReference,
  looksLikeFilesystemMutationRequest,
  looksLikeFilesystemToolName,
  looksLikeSuccessfulFilesystemMutationResponse,
  looksLikeWebOperationRequest,
  looksLikeSpecialUseIpWebBlock,
  extractFirstHttpUrl,
  hasMeaningfulAgentText,
  looksLikeAwarenessInitCompatibilityError,
} from './chat-detection';
import {
  parseMcpTextPayload,
  buildAwarenessInitSkipInstruction,
  buildDesktopMemoryBootstrapSection,
  buildAwarenessInitCompatibilityRetryPrompt,
  shouldRetryAfterAwarenessInitFailure,
  tryBuildDesktopMemoryBootstrapSection,
  getMemoryCapturePolicy,
  buildWebCompatibilityRetryPrompt,
} from './awareness-memory-utils';
import { chatSendViaCli, chatSendViaCliWithWebCompatibilityRetry, prepareCliFallbackWithDaemonRetry } from './chat-cli-executor';

// --- Helper functions extracted to ./chat-message-builders.ts, ./gateway-event-normalizer.ts,
// --- ./chat-detection.ts, ./awareness-memory-utils.ts, ./chat-cli-executor.ts ---
// --- (pure copy/paste extraction, no logic changes) ---

/**
 * Validate that an agentId actually exists in openclaw.json before routing chat to it.
 *
 * Why this exists:
 *   The frontend persists `selectedAgentId` in store. If the user deletes/recreates the
 *   agent, imports a different config, or upgrades across an OpenClaw breaking change
 *   (e.g. v2026.4.1+ pairing tightening, see openclaw#59428), the persisted id can become
 *   a "ghost" — present in our store but not in OpenClaw's config.
 *
 *   When that ghost id reaches Gateway, OpenClaw silently falls back to the embedded agent
 *   (`Gateway agent failed; falling back to embedded: Unknown agent id "xxx"`) and the run
 *   completes with empty assistant text. The desktop app then displays "No response" with
 *   no actionable error — reproducing the chat-failure pattern documented in CLAUDE.md.
 *
 * Strategy:
 *   - Always allow 'main' (OpenClaw's reserved default — cannot be deleted).
 *   - Read agents.list[] directly from openclaw.json (≤1ms, no CLI spawn). The CLI spawn
 *     would re-load all plugins (15-30s, see CLAUDE.md "OpenClaw CLI 超时规则").
 *   - If the requested id is missing from the config, downgrade to 'main' so the user
 *     still gets a reply and can re-pick an agent in the UI.
 *   - Never throw — config-read failures degrade gracefully to allowing the original id
 *     so we don't introduce a new failure mode if openclaw.json is briefly unreadable.
 */
/**
 * Self-heal for OpenClaw Gateway 1006 abnormal closures.
 *
 * When `chat-cli-executor` reports `gateway1006: true`, Gateway accepted the WS
 * handshake but immediately tore down the chat.send RPC. This is a half-broken
 * server state — process is up, port is listening, but the request pipeline is
 * wedged. Subsequent messages will keep hitting the slow CLI fallback path until
 * Gateway is restarted (see openclaw#46256 + observed behavior on 2026-04-07).
 *
 * Strategy:
 *   - Throttle to one restart per ~60 s via chatState.lastGateway1006RestartAt.
 *     A loop of failed messages must not become a loop of Gateway restarts.
 *   - Fire-and-forget. Restart runs in the background; the current chat already
 *     completed via CLI fallback, so the user sees their reply now and the next
 *     message benefits from the fresh server.
 *   - Notify the renderer via chat:status so the user understands what happened.
 */
/**
 * Classify raw provider/Gateway errors into user-friendly messages.
 * Keeps technical details out of the UI — small-white-user-first.
 */
function classifyProviderError(rawError: string, state: string): string {
  const lower = rawError.toLowerCase();

  // Provider internal error (Qwen, OpenAI, etc.)
  if (/internal error|internal server error|500/i.test(rawError)) {
    return 'provider_internal';
  }
  // Rate limit / quota
  if (/rate.?limit|too many requests|429|quota|exceeded|insufficient/i.test(rawError)) {
    return 'rate_limit';
  }
  // Auth / API key
  if (/unauthorized|401|403|invalid.*key|api.?key|authentication|forbidden/i.test(rawError)) {
    return 'auth_error';
  }
  // Timeout
  if (/timeout|timed?\s*out|ETIMEDOUT|ECONNABORTED/i.test(rawError)) {
    return 'timeout';
  }
  // Network
  if (/ECONNREFUSED|ENOTFOUND|network|fetch failed|ECONNRESET|socket hang up/i.test(rawError)) {
    return 'network';
  }
  // Model not found
  if (/model.*not found|does not exist|unsupported model|unknown model/i.test(rawError)) {
    return 'model_not_found';
  }
  // Context length
  if (/context.?length|too long|token limit|max.?tokens|content.?too.?large/i.test(rawError)) {
    return 'context_length';
  }
  // Aborted
  if (state === 'aborted') {
    return 'aborted';
  }
  return 'unknown';
}

function maybeSelfHealGateway1006(
  result: any,
  send: (channel: string, payload: any) => void,
  runSpawnFn: ((cmd: string, args: string[], opts?: Record<string, unknown>) => any) | undefined,
  enhancedPath: string,
  startGatewayInUserSessionFn?: () => Promise<{ ok: boolean; error?: string }>,
  runAsyncFn?: (cmd: string, timeoutMs?: number) => Promise<string>,
) {
  if (!result?.gateway1006) return;
  const now = Date.now();
  if (now - chatState.lastGateway1006RestartAt < 60_000) return;
  chatState.lastGateway1006RestartAt = now;

  console.warn('[chat] Gateway 1006 detected; scheduling background restart');
  send('chat:status', {
    type: 'gateway',
    message: 'Local Gateway dropped a request unexpectedly. Restarting it in the background...',
  });

  // On Windows, `openclaw gateway restart` re-launches via gateway.cmd which
  // may lack --stack-size=8192. Use stop + user-session start instead.
  if (process.platform === 'win32' && startGatewayInUserSessionFn && runAsyncFn) {
    (async () => {
      try {
        try { await runAsyncFn('openclaw gateway stop 2>&1', 15000); } catch { /* best-effort */ }
        await startGatewayInUserSessionFn();
      } catch (err: any) {
        console.warn('[chat] Gateway 1006 self-heal (user-session) failed:', err?.message || err);
      }
    })();
    return;
  }

  try {
    const env = { ...process.env, PATH: enhancedPath };
    // Cross-platform: prefer the injected runSpawn (which already handles
    // Win cmd.exe vs *nix bash --norc --noprofile shell wrapping per CLAUDE.md
    // shell-execution rules). Fall back to a direct spawn if not provided.
    if (runSpawnFn) {
      const child = runSpawnFn('openclaw', ['gateway', 'restart'], {
        env,
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      });
      // Detach so a slow restart does not keep the chat handler alive
      try { child.unref?.(); } catch { /* ignore */ }
    } else {
      const child = spawn('openclaw', ['gateway', 'restart'], {
        env,
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
        shell: process.platform === 'win32',
      });
      try { child.unref(); } catch { /* ignore */ }
    }
  } catch (err: any) {
    console.warn('[chat] Gateway 1006 self-heal failed to spawn restart:', err?.message || err);
  }
}

function validateAgentIdAgainstConfig(home: string, agentId: string): {
  resolvedAgentId: string;
  wasStale: boolean;
} {
  if (!agentId || agentId === 'main') {
    return { resolvedAgentId: 'main', wasStale: false };
  }
  try {
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    const list: any[] = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
    // Empty list is treated as "config is fresh / only main exists" — drop the stale id.
    if (list.length === 0) {
      return { resolvedAgentId: 'main', wasStale: true };
    }
    const knownIds = new Set<string>(list.map((a: any) => String(a?.id || '')).filter(Boolean));
    if (knownIds.has(agentId)) {
      return { resolvedAgentId: agentId, wasStale: false };
    }
    return { resolvedAgentId: 'main', wasStale: true };
  } catch {
    // Config unreadable: do not block the user. Pass the original id through and let
    // the downstream Gateway/CLI path surface any error.
    return { resolvedAgentId: agentId, wasStale: false };
  }
}

export function registerChatHandlers(deps: {
  sendToRenderer: (channel: string, payload: any) => void;
  ensureGatewayRunning: () => Promise<{ ok: boolean; error?: string }>;
  prepareGatewayForChat?: () => Promise<{ ok: boolean; error?: string }>;
  prepareCliFallback?: () => Promise<void>;
  getGatewayWs: (options?: { onPairingRepairStart?: () => void; onPairingRepair?: () => void }) => Promise<GatewayClient>;
  getConnectedGatewayWs: () => GatewayClient | null;
  callMcpStrict: (toolName: string, args: Record<string, any>, timeoutMs?: number) => Promise<any>;
  getEnhancedPath: () => string;
  runSpawn?: (cmd: string, args: string[], opts?: Record<string, unknown>) => ReturnType<typeof spawn>;
  runAsync?: (cmd: string, timeoutMs?: number) => Promise<string>;
  startGatewayInUserSession?: () => Promise<{ ok: boolean; error?: string }>;
  wrapWindowsCommand: (command: string) => string;
  stripAnsi: (output: string) => string;
  spawnChatProcess?: typeof spawn;
  readMemoryCapturePolicy?: () => MemoryCapturePolicy;
}) {
  ipcMain.handle('chat:abort', async (_e: any, sessionKey?: string) => {
    const connectedGatewayWs = deps.getConnectedGatewayWs();
    if (connectedGatewayWs?.isConnected && sessionKey) {
      try {
        await connectedGatewayWs.chatAbort(sessionKey);
        return { success: true };
      } catch {
        // Fall through to CLI kill.
      }
    }

    if (chatState.activeChatChild) {
      try { chatState.activeChatChild.kill('SIGTERM'); } catch { /* already dead */ }
      chatState.activeChatChild = null;
      return { success: true };
    }

    return { success: false, error: 'No active chat' };
  });

  ipcMain.handle('chat:approve', async (_e: any, sessionKey: string, approvalRequestId: string, decision?: 'allow-once') => {
    if (!sessionKey || !approvalRequestId) {
      return { success: false, error: 'Missing approval context' };
    }

    try {
      const ws = await deps.getGatewayWs();
      const command = `/approve ${approvalRequestId} ${decision || 'allow-once'}`;
      await ws.chatSend(sessionKey, command);
      return { success: true, command };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });

  // Load chat history from Gateway for a given session.
  // Falls back gracefully — returns empty if Gateway is unavailable.
  ipcMain.handle('chat:load-history', async (_e: any, sessionId: string) => {
    const gw = deps.getConnectedGatewayWs();
    if (!gw?.isConnected || !sessionId) {
      return { success: false, messages: [], error: 'Gateway not connected' };
    }
    try {
      const raw = await gw.chatHistory(sessionId);
      if (!raw || raw.length === 0) {
        return { success: true, messages: [] };
      }
      const messages = buildDesktopHistory(raw || []);
      return { success: true, messages };
    } catch (err: any) {
      return { success: false, messages: [], error: err?.message || String(err) };
    }
  });

  ipcMain.handle('chat:send', async (_e: any, message: string, sessionId?: string, options?: ChatSendOptions) => {
    const send = (channel: string, payload: any) => {
      deps.sendToRenderer(channel, payload);
    };

    const requestedOptions: ChatSendOptions = options ? { ...options } : {};
    const requestedModelRef = typeof requestedOptions.model === 'string'
      ? requestedOptions.model.trim()
      : '';
    const sanitizedModelRef = requestedModelRef && /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i.test(requestedModelRef)
      ? requestedModelRef
      : '';

    // Agent routing is done via the session key format, not a separate agentId param.
    // Gateway session keys: agent:<agentId>:main (operator), agent:<agentId>:webchat:<id> (desktop).
    // When a non-main agent is selected, prefix the session key so Gateway routes to the right agent.
    //
    // Pre-validate the requested agentId against openclaw.json. If the frontend sent a stale
    // id (deleted agent, failed-creation orphan, or pre-upgrade ghost), downgrade to 'main'
    // before any Gateway/CLI call. This prevents the "Unknown agent id" → silent embedded
    // fallback → empty assistant text → "No response" failure chain. See helper comment above.
    const requestedAgentId = requestedOptions.agentId || 'main';
    const validated = validateAgentIdAgainstConfig(os.homedir(), requestedAgentId);
    const agentId = validated.resolvedAgentId;
    if (validated.wasStale) {
      console.warn('[chat] Stale agentId requested by renderer; downgrading to main', {
        requestedAgentId,
        resolvedAgentId: agentId,
      });
      requestedOptions.agentId = 'main';
      deps.sendToRenderer('chat:agent-invalidated', {
        requestedAgentId,
        resolvedAgentId: 'main',
        reason: 'agent-not-in-config',
      });
      deps.sendToRenderer('chat:status', {
        type: 'gateway',
        message: `Selected agent "${requestedAgentId}" no longer exists. Switched to the default agent for this reply.`,
      });
    }
    const rawSid = sessionId || `ac-${Date.now()}`;
    const sid = agentId !== 'main'
      ? `agent:${agentId}:webchat:${rawSid}`
      : rawSid;
    let workspacePathInvalid = false;
    let workspacePathIssue: 'missing' | 'not-directory' | undefined;
    let workspacePathOriginal: string | undefined;
    const withWorkspaceFallbackMeta = <T extends Record<string, any>>(result: T): T & {
      workspacePathInvalid?: boolean;
      workspacePathIssue?: 'missing' | 'not-directory';
      workspacePathOriginal?: string;
    } => ({
      ...result,
      workspacePathInvalid: workspacePathInvalid || undefined,
      workspacePathIssue: workspacePathIssue || undefined,
      workspacePathOriginal: workspacePathOriginal || undefined,
    });

    let fullMessage = message;
    const shouldPreloadDesktopMemory = chatState.awarenessInitCompatibilityMode
      || looksLikeWebOperationRequest(message)
      || looksLikeFilesystemMutationRequest(message);

    if (shouldPreloadDesktopMemory) {
      try {
        const memoryBootstrapSection = await tryBuildDesktopMemoryBootstrapSection(deps.callMcpStrict, message);
        if (memoryBootstrapSection.trim()) {
          fullMessage = `${memoryBootstrapSection}\n\n${fullMessage}`;
        }
      } catch (memoryBootstrapErr: any) {
        const detail = memoryBootstrapErr?.message || String(memoryBootstrapErr);
        if (chatState.awarenessInitCompatibilityMode) {
          fullMessage = `${buildAwarenessInitSkipInstruction(detail)}\n\n${fullMessage}`;
        }
      }
    } else if (chatState.awarenessInitCompatibilityMode) {
      fullMessage = `${buildAwarenessInitSkipInstruction(chatState.lastAwarenessInitCompatibilityError)}\n\n${fullMessage}`;
    }

    // Bootstrap dual mechanism:
    // 1. Primary: OpenClaw Gateway injects AGENTS.md into system prompt, which instructs
    //    the LLM to read BOOTSTRAP.md and follow it. This is the native mechanism.
    // 2. Fallback: If BOOTSTRAP.md still exists when a non-main agent sends its FIRST
    //    message in this desktop session, we inject the content as a safety net for
    //    smaller models that may not follow AGENTS.md instructions reliably.
    //    After injection, we delete BOOTSTRAP.md to prevent re-triggering.
    if (agentId !== 'main') {
      try {
        const slug = agentId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        const flatWs = path.join(os.homedir(), '.openclaw', `workspace-${slug}`);
        const nestedWs = path.join(os.homedir(), '.openclaw', 'workspaces', slug);
        const agentWs = path.join(os.homedir(), '.openclaw', 'agents', slug, 'agent');
        for (const dir of [flatWs, nestedWs, agentWs]) {
          const bp = path.join(dir, 'BOOTSTRAP.md');
          if (fs.existsSync(bp)) {
            const bootstrapContent = fs.readFileSync(bp, 'utf-8').trim();
            if (bootstrapContent) {
              fullMessage = `[BOOTSTRAP — First Run Ritual]\nThis is your first conversation. Follow the bootstrap instructions below to get to know your user, then update IDENTITY.md, USER.md, and SOUL.md with what you learn.\n\n${bootstrapContent}\n\n[User's first message]\n${message}`;
              // Delete from all locations after injection — one-time only
              for (const d of [flatWs, nestedWs, agentWs]) {
                try { const f = path.join(d, 'BOOTSTRAP.md'); if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
              }
            }
            break;
          }
        }
      } catch { /* ignore */ }
    }

    const homeDir = os.homedir();
    const desktopDir = path.join(homeDir, 'Desktop');
    const documentsDir = path.join(homeDir, 'Documents');
    const downloadsDir = path.join(homeDir, 'Downloads');
    const hostOsLabel = getHostOsLabel(process.platform);
    const hostApprovals = getExecApprovalSettings(homeDir, requestedOptions.agentId || 'main');
    fullMessage = `[Local machine context] You are running inside the AwarenessClaw Desktop app on the user's own computer. When the user asks about local files or folders on this machine, do not answer with a generic safety/privacy refusal. Use the available tools (especially exec/read/write/edit when appropriate) to inspect or modify the local filesystem if the request is allowed by the current host approval policy. Common ${hostOsLabel} folders for this user are: home=${homeDir}, desktop=${desktopDir}, documents=${documentsDir}, downloads=${downloadsDir}. If the user says "桌面", "desktop", or "我的桌面", resolve that to ${desktopDir}. If the user asks what files are there, inspect the directory first and report the actual result. For any local filesystem claim, do not guess. Never claim a file or folder change succeeded unless a tool result confirms it. After creating, editing, renaming, or deleting files/folders, run a follow-up verification step (for example list the directory, read the file, or stat the target) and include that verification in your reply. If a tool call is blocked, denied, or fails, say that plainly instead of pretending the action finished.

  [Current host exec approvals] security=${hostApprovals.security}, ask=${hostApprovals.ask}, askFallback=${hostApprovals.askFallback}, autoAllowSkills=${hostApprovals.autoAllowSkills ? 'on' : 'off'}. This current host approval state is authoritative for this turn. If earlier conversation turns claimed local filesystem access was blocked by allowlist/privacy rules, do not blindly repeat that claim. Re-evaluate the request against the current approval state above and use tools when allowed.

  [Web compatibility note] If web_fetch or browser reports private/internal/special-use IP blocking for a public HTTPS domain, treat it as a VPN/DNS compatibility issue instead of a final failure. Explain that compatibility issue briefly, then continue with a safe fallback flow (for example: use web_search for discovery and exec-based HTTP retrieval for the requested public URL when host approvals allow it).

  ${fullMessage}`;
    if (requestedOptions.files && requestedOptions.files.length > 0) {
      const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
      const images: string[] = [];
      const others: string[] = [];
      for (const filePath of requestedOptions.files) {
        const ext = path.extname(filePath).toLowerCase();
        (imageExts.includes(ext) ? images : others).push(filePath);
      }
      const parts: string[] = [];
      if (images.length > 0) parts.push(`[Images to analyze: ${images.join(', ')}] (use exec tool to read or describe these image files)`);
      if (others.length > 0) parts.push(`[Attached files: ${others.join(', ')}]`);
      fullMessage = `${parts.join('\n')}\n\n${fullMessage}`;
    }

    const requestedWorkspace = requestedOptions.workspacePath?.trim();
    if (requestedWorkspace) {
      workspacePathOriginal = requestedWorkspace;
      try {
        if (!fs.statSync(requestedWorkspace).isDirectory()) {
          workspacePathInvalid = true;
          workspacePathIssue = 'not-directory';
        }
      } catch {
        workspacePathInvalid = true;
        workspacePathIssue = 'missing';
      }

      if (workspacePathInvalid) {
        requestedOptions.workspacePath = undefined;
        send('chat:status', {
          type: 'gateway',
          message: workspacePathIssue === 'not-directory'
            ? 'Selected project folder is unavailable. Continuing in normal chat mode without a project root.'
            : 'Selected project folder could not be found. Continuing in normal chat mode without a project root.',
        });
        fullMessage = `[Project folder unavailable]
The selected project folder "${requestedWorkspace}" is no longer accessible in this desktop session.
Continue helping normally.
If the user asks for project file operations in that project, ask them to choose the project folder again in the chat header before you proceed.
Do not claim project file changes were completed inside that unavailable path.

${fullMessage}`;
      } else {
        fullMessage = `[Project working directory: ${requestedWorkspace}] Use this directory as the default root for file operations in this chat. When the user asks you to read, write, edit, or create project files, prefer absolute paths inside this directory or set your command cwd there. Do not treat this folder as the agent's home workspace; AGENTS.md, USER.md, SOUL.md, MEMORY.md, and other agent-scoped files still follow the configured agent workspace.\n\n${fullMessage}`;
      }
    }

    if (fullMessage !== message) {
      fullMessage = `[Operational context metadata — do not answer this section directly]
The block below is runtime metadata for tool routing and local file safety checks. Do not acknowledge, summarize, or restate this metadata in your reply unless the user asks about it explicitly.

${fullMessage}

[User request]
${message}`;
    }

    const gatewayReady = await (deps.prepareGatewayForChat
      ? deps.prepareGatewayForChat()
      : deps.ensureGatewayRunning());
    if (!gatewayReady.ok) {
      const gatewayErrorText = String(gatewayReady.error || '');
      const authGated = /needs local authorization|device authorization|device-required|pairing required|pairing-required|scope-upgrade/i.test(gatewayErrorText);
      const now = Date.now();
      const canAttemptAuthRepair = authGated && (now - chatState.lastGatewayAuthRepairAt > 60_000);

      if (canAttemptAuthRepair) {
        chatState.lastGatewayAuthRepairAt = now;
        send('chat:status', {
          type: 'gateway',
          message: 'Local authorization required. Attempting automatic repair...',
        });
        try {
          await deps.getGatewayWs({
            onPairingRepairStart: () => send('chat:status', {
              type: 'gateway',
              message: 'Approving local Gateway access...',
            }),
            onPairingRepair: () => send('chat:status', {
              type: 'gateway',
              message: 'Local access approved. Reconnecting Gateway...',
            }),
          });
          if (deps.getConnectedGatewayWs()?.isConnected) {
            send('chat:status', {
              type: 'gateway',
              message: 'Gateway recovered. Sending this message through fast mode.',
            });
          } else {
            throw new Error('Gateway connection not established after auth repair');
          }
        } catch (repairErr: any) {
          console.warn('[chat] Gateway auth auto-repair did not recover connection:', repairErr?.message || repairErr);
        }
      }

      if (deps.getConnectedGatewayWs()?.isConnected) {
        // Recovery succeeded in the branch above; continue with normal Gateway path.
      } else {
      console.warn('[chat] Gateway preflight failed, falling back to CLI:', gatewayReady.error || 'unknown error');
      send('chat:status', {
        type: 'gateway',
        message: gatewayReady.error || 'Gateway unavailable. Falling back to direct OpenClaw chat...',
      });
      requestedOptions.forceLocal = true;
      send('chat:status', {
        type: 'gateway',
        message: authGated
          ? 'Local authorization is pending. Sending this message through local fallback mode.'
          : 'Gateway is still warming up. Sending this message through local fallback mode.',
      });
      const preparedCli = await prepareCliFallbackWithDaemonRetry(deps.prepareCliFallback, send);
      if (!preparedCli.ok) {
        const detail = preparedCli.error || 'unknown error';
        console.warn('[chat] CLI fallback preparation failed:', detail);
        if (preparedCli.daemonNotReady || /LOCAL_DAEMON_NOT_READY/i.test(detail)) {
          return withWorkspaceFallbackMeta({
            success: false,
            error: 'Local memory service is still starting. Please wait 20-60 seconds, then retry.',
            sessionId: sid,
          });
        }
      }
      const cliResult = await chatSendViaCliWithWebCompatibilityRetry({
        requestMessage: fullMessage,
        originalUserMessage: message,
        sid,
        options: requestedOptions,
        send,
        deps,
      });
      const needsRetry = cliResult?.success
        && (!cliResult.text || /^(No response|No reply from agent\.?)+$/i.test(String(cliResult.text).trim()));
      if (needsRetry && fullMessage !== message) {
        console.warn('[chat] CLI fallback returned empty response with metadata prompt; retrying with raw user message');
        const retryResult = await chatSendViaCliWithWebCompatibilityRetry({
          requestMessage: message,
          originalUserMessage: message,
          sid,
          options: requestedOptions,
          send,
          deps,
        });
        maybeSelfHealGateway1006(retryResult, send, deps.runSpawn, deps.getEnhancedPath(), deps.startGatewayInUserSession, deps.runAsync);
        return withWorkspaceFallbackMeta(retryResult);
      }
      maybeSelfHealGateway1006(cliResult, send, deps.runSpawn, deps.getEnhancedPath(), deps.startGatewayInUserSession, deps.runAsync);
      return withWorkspaceFallbackMeta(cliResult);
      }
    }

    let fullResponseText = '';
    let chatEventHandler: ((payload: any) => void) | null = null;
    let allEventsHandler: ((evt: any) => void) | null = null;
    let agentEventHandler: ((payload: any) => void) | null = null;
    let agentAssistantEventHandler: ((payload: any) => void) | null = null;
    let agentLifecycleEventHandler: ((payload: any) => void) | null = null;
    let agentToolEventHandler: ((payload: any) => void) | null = null;
    let ws: GatewayClient | null = null;

    try {
      ws = await deps.getGatewayWs();

      const { promise: chatDone, resolve: chatResolve } = (() => {
        let resolver: () => void;
        const promise = new Promise<void>((res) => { resolver = res; });
        return { promise, resolve: resolver! };
      })();
      let didTimeout = false;
      let chatTimeout: ReturnType<typeof setTimeout> | null = null;
      // Activity-based idle timeout: resets on every WS event so long
      // responses (writing large documents, multi-tool chains) don't time out.
      const resetChatIdleTimeout = () => {
        if (chatTimeout) clearTimeout(chatTimeout);
        chatTimeout = setTimeout(() => {
          didTimeout = true;
          chatResolve();
        }, CHAT_IDLE_TIMEOUT_MS);
      };
      // Absolute safety cap to prevent infinite hangs
      const absoluteChatTimeout = setTimeout(() => {
        didTimeout = true;
        chatResolve();
      }, CHAT_TIMEOUT_MS * 5); // 10 minutes absolute max
      resetChatIdleTimeout();

      const seenToolIds = new Set<string>();
      const completedToolIds = new Set<string>();
      const toolNamesById = new Map<string, string>();
      let lastThinkingText = '';
      let pendingApprovalRequestId = '';
      let pendingApprovalCommand = '';
      let pendingApprovalDetail = '';
      let sawAssistantDelta = false;
      let sawAssistantTextDelta = false;
      let sawAssistantNonTextDelta = false;
      let sawToolBlocks = false;
      let sawCompletedToolResult = false;
      let sawCompletedFilesystemToolResult = false;
      let sawThinkingBlocks = false;
      let sawFinalState = false;
      let finalAssistantText = '';
      let finalAssistantContentTypes: string[] = [];
      let awarenessInitCompatibilityIssue = false;
      let awarenessInitFailureDetail = '';

      const noteAwarenessInitCompatibilityIssue = (toolName: string | undefined, detail: string | undefined) => {
        if (toolName !== 'awareness_init') return;
        const normalizedDetail = String(detail || '').trim();
        if (!looksLikeAwarenessInitCompatibilityError(normalizedDetail)) return;
        awarenessInitCompatibilityIssue = true;
        awarenessInitFailureDetail = normalizedDetail || 'schema must be object or boolean';
        chatState.awarenessInitCompatibilityMode = true;
        chatState.lastAwarenessInitCompatibilityError = awarenessInitFailureDetail;
      };

      const processAssistantContentBlocks = (blocks: any[]) => {
        for (const block of blocks) {
          // Accept all tool-call block type variants OpenClaw / Anthropic / OpenAI-compat providers emit.
          // OpenClaw native built-in tools (exec/read/write/edit) use `tool_call`; Anthropic uses `tool_use`.
          // See OpenClaw control-ui extractors P_ / F_.
          const blockType = String(block.type || '').toLowerCase();
          const isToolUseBlock = blockType === 'tool_use' || blockType === 'tool_call' || blockType === 'tooluse' || blockType === 'toolcall';
          const isToolResultBlock = blockType === 'tool_result' || blockType === 'toolresult' || blockType === 'tool_result_block';
          if (isToolUseBlock) {
            sawToolBlocks = true;
            const toolId = block.id || block.toolCallId || block.tool_call_id || `tc-${Date.now()}`;
            toolNamesById.set(toolId, block.name || 'tool');
            send('chat:event', {
              stream: 'tool',
              phase: 'start',
              toolCallId: toolId,
              toolName: block.name || 'tool',
              args: extractToolArgs(block),
              raw: block,
            });
            if (!seenToolIds.has(toolId)) {
              seenToolIds.add(toolId);
              send('chat:status', {
                type: 'tool_call',
                tool: block.name || 'tool',
                toolStatus: 'running',
                toolId,
                detail: extractToolDetail(extractToolArgs(block)),
              });
            }
            continue;
          }

          if (isToolResultBlock) {
            sawToolBlocks = true;
            sawCompletedToolResult = true;
            const toolId = block.tool_use_id || block.tool_call_id || block.toolCallId || block.id || '';
            const toolName = toolNamesById.get(toolId) || block.name || 'tool';
            if (looksLikeFilesystemToolName(toolName)) {
              sawCompletedFilesystemToolResult = true;
            }
            const toolOutput = extractToolOutput(block);
            noteAwarenessInitCompatibilityIssue(toolName, toolOutput);
            send('chat:event', {
              stream: 'tool',
              phase: 'result',
              toolCallId: toolId,
              toolName,
              result: block.content ?? block.result ?? block,
              isError: Boolean(block.is_error || block.isError),
              raw: block,
            });
            if (toolId && !completedToolIds.has(toolId)) {
              completedToolIds.add(toolId);
              send('chat:status', {
                type: 'tool_update',
                toolId,
                toolStatus: block.is_error || block.isError ? 'failed' : 'completed',
                detail: toolOutput,
              });
            }
            continue;
          }

          if (block.type === 'thinking' || block.type === 'reasoning') {
            sawThinkingBlocks = true;
            const text = block.thinking || block.reasoning || block.text || '';
            if (text && text !== lastThinkingText) {
              lastThinkingText = text;
              send('chat:event', {
                stream: 'assistant',
                phase: 'thinking',
                thinking: text,
                raw: block,
              });
              send('chat:status', { type: 'thinking' });
              send('chat:thinking', text);
            }
          }
        }
      };

      const handleNormalizedAgentEvent = (eventName: string, payload: any) => {
        const normalizedAgentEvent = normalizeAgentGatewayEvent(eventName, payload);
        if (!normalizedAgentEvent) return;

        const sessionKey = normalizedAgentEvent.sessionKey || '';
        if (sessionKey && sessionKey !== sid) return;

        if (normalizedAgentEvent.stream === 'tool') {
          sawToolBlocks = true;
          const toolId = normalizedAgentEvent.toolCallId || '';
          const toolName = normalizedAgentEvent.toolName || (toolId ? toolNamesById.get(toolId) : undefined) || 'tool';
          if (toolId) toolNamesById.set(toolId, toolName);
          send('chat:event', {
            stream: 'tool',
            phase: normalizedAgentEvent.phase || '',
            runId: normalizedAgentEvent.runId,
            sessionKey,
            seq: normalizedAgentEvent.seq,
            toolCallId: toolId,
            toolName,
            args: normalizedAgentEvent.args,
            partialResult: normalizedAgentEvent.partialResult,
            result: normalizedAgentEvent.result,
            isError: Boolean(normalizedAgentEvent.isError),
            raw: normalizedAgentEvent.raw,
          });

          if (!toolId) return;
          if (normalizedAgentEvent.phase === 'start') {
            send('chat:status', {
              type: 'tool_call',
              tool: toolName,
              toolStatus: 'running',
              toolId,
              detail: extractToolDetail(normalizedAgentEvent.args),
            });
            return;
          }

          if (normalizedAgentEvent.phase === 'update') {
            send('chat:status', {
              type: 'tool_update',
              toolId,
              toolStatus: 'running',
              detail: extractToolDetail(normalizedAgentEvent.partialResult),
            });
            return;
          }

          if (normalizedAgentEvent.phase === 'result') {
            sawCompletedToolResult = true;
            if (looksLikeFilesystemToolName(toolName)) {
              sawCompletedFilesystemToolResult = true;
            }
            noteAwarenessInitCompatibilityIssue(toolName, extractToolDetail(normalizedAgentEvent.result));
            send('chat:status', {
              type: 'tool_update',
              toolId,
              toolStatus: normalizedAgentEvent.isError ? 'failed' : 'completed',
              detail: extractToolDetail(normalizedAgentEvent.result),
            });
            return;
          }
        }

        if (normalizedAgentEvent.stream === 'assistant') {
          const assistantText = normalizedAgentEvent.thinking || normalizedAgentEvent.text || '';
          if (!assistantText) return;
          send('chat:event', {
            stream: 'assistant',
            phase: normalizedAgentEvent.phase || 'text',
            runId: normalizedAgentEvent.runId,
            sessionKey,
            seq: normalizedAgentEvent.seq,
            text: normalizedAgentEvent.text,
            thinking: normalizedAgentEvent.thinking,
            raw: normalizedAgentEvent.raw,
          });
          if (normalizedAgentEvent.phase === 'thinking' && assistantText !== lastThinkingText) {
            lastThinkingText = assistantText;
            send('chat:status', { type: 'thinking' });
            send('chat:thinking', assistantText);
          }
          return;
        }

        if (normalizedAgentEvent.stream === 'lifecycle') {
          send('chat:event', {
            stream: 'lifecycle',
            phase: normalizedAgentEvent.phase || '',
            runId: normalizedAgentEvent.runId,
            sessionKey,
            seq: normalizedAgentEvent.seq,
            raw: normalizedAgentEvent.raw,
          });
        }
      };

      allEventsHandler = (evt: any) => {
        resetChatIdleTimeout();
        const eventName = evt?.event || 'unknown';
        const payload = evt?.payload || evt;
        const preview = JSON.stringify(payload).slice(0, 800);
        send('chat:debug', `[gw:${eventName}] ${preview}`);

        if (eventName.endsWith('.approval.requested')) {
          const request = payload?.request || {};
          const toolName = eventName.replace(/\.approval\.requested$/, '') || request.tool || 'tool';
          const detailParts: string[] = [];
          if (request.command) detailParts.push(String(request.command));
          if (request.cwd) detailParts.push(`cwd: ${request.cwd}`);
          const requestId = request.id || `approval-${toolName}-${Date.now()}`;
          const approvalCommand = `/approve ${requestId} allow-once`;
          pendingApprovalRequestId = requestId;
          pendingApprovalCommand = approvalCommand;
          pendingApprovalDetail = detailParts.join(' | ') || 'Waiting for approval';
          send('chat:status', {
            type: 'tool_approval',
            tool: toolName,
            toolStatus: 'awaiting_approval',
            toolId: requestId,
            approvalRequestId: requestId,
            approvalCommand,
            detail: pendingApprovalDetail,
          });
        }
      };
      ws.on('gateway-event', allEventsHandler);

      agentEventHandler = (payload: any) => handleNormalizedAgentEvent('agent', payload);
      agentAssistantEventHandler = (payload: any) => handleNormalizedAgentEvent('agent:assistant', payload);
      agentLifecycleEventHandler = (payload: any) => handleNormalizedAgentEvent('agent:lifecycle', payload);
      agentToolEventHandler = (payload: any) => handleNormalizedAgentEvent('agent:tool', payload);

      ws.on('event:agent', agentEventHandler);
      ws.on('event:agent:assistant', agentAssistantEventHandler);
      ws.on('event:agent:lifecycle', agentLifecycleEventHandler);
      ws.on('event:agent:tool', agentToolEventHandler);

      chatEventHandler = (payload: any) => {
        if (!payload) return;
        resetChatIdleTimeout();
        const payloadSession = payload.sessionKey || payload.key || '';
        if (payloadSession && !payloadSession.endsWith(sid) && payloadSession !== sid) return;

        const state = payload.state;
        const msg = payload.message;

        if (state === 'delta' && msg && msg.role === 'assistant') {
          sawAssistantDelta = true;
          let textContent = extractAssistantText(msg);
          if (Array.isArray(msg.content)) {
            finalAssistantContentTypes = msg.content.map((contentBlock: any) => String(contentBlock?.type || typeof contentBlock));
            sawAssistantNonTextDelta = msg.content.some((contentBlock: any) => contentBlock?.type && contentBlock.type !== 'text');
          }

          if (textContent && textContent.length > fullResponseText.length) {
            const newChunk = textContent.slice(fullResponseText.length);
            fullResponseText = textContent;
            sawAssistantTextDelta = true;
            send('chat:stream', newChunk);
            send('chat:status', { type: 'generating' });
          }

          if (Array.isArray(msg.content)) processAssistantContentBlocks(msg.content);

          if (typeof msg.content === 'string' && msg.content.startsWith('Reasoning:')) {
            const reasoningText = msg.content.replace(/^Reasoning:\s*/, '');
            if (reasoningText && reasoningText !== lastThinkingText) {
              lastThinkingText = reasoningText;
              fullResponseText = fullResponseText.replace(msg.content, '').trim();
              send('chat:thinking', reasoningText);
              send('chat:status', { type: 'thinking' });
            }
          }
        } else if (state === 'final') {
          sawFinalState = true;
          if (msg && msg.role === 'assistant') {
            finalAssistantText = extractAssistantText(msg).trim();
            if (Array.isArray(msg.content)) {
              finalAssistantContentTypes = msg.content.map((contentBlock: any) => String(contentBlock?.type || typeof contentBlock));
              processAssistantContentBlocks(msg.content);
            } else if (typeof msg.content === 'string') {
              finalAssistantContentTypes = ['string'];
            }
          }
          if (chatTimeout) clearTimeout(chatTimeout);
          clearTimeout(absoluteChatTimeout);
          chatResolve();
        } else if (state === 'aborted' || state === 'error') {
          const rawError = payload.error || payload.message?.error || '';
          const errorStr = typeof rawError === 'string' ? rawError : JSON.stringify(rawError);
          send('chat:status', { type: 'error', message: classifyProviderError(errorStr, state) });
          if (chatTimeout) clearTimeout(chatTimeout);
          clearTimeout(absoluteChatTimeout);
          chatResolve();
        }
      };

      ws.on('event:chat', chatEventHandler);
      send('chat:status', { type: 'thinking' });

      if (sanitizedModelRef) {
        // OpenClaw official flow: model switch is a session override via sessions.patch,
        // not a chat.send payload field.
        try {
          await ws.sessionPatch(sid, { model: sanitizedModelRef });
        } catch {
          // Best-effort compatibility with older Gateway builds.
          try { await ws.sessionPatch(sid, { modelRef: sanitizedModelRef }); } catch { /* best-effort */ }
        }
      }

      await ws.chatSend(sid, fullMessage, {
        thinking: requestedOptions.thinkingLevel && requestedOptions.thinkingLevel !== 'off' ? requestedOptions.thinkingLevel : undefined,
        verbose: 'full',
        reasoning: requestedOptions.reasoningDisplay && requestedOptions.reasoningDisplay !== 'off' ? requestedOptions.reasoningDisplay : 'on',
      });

      await chatDone;

      ws.removeListener('event:chat', chatEventHandler);
      ws.removeListener('gateway-event', allEventsHandler);
      if (agentEventHandler) ws.removeListener('event:agent', agentEventHandler);
      if (agentAssistantEventHandler) ws.removeListener('event:agent:assistant', agentAssistantEventHandler);
      if (agentLifecycleEventHandler) ws.removeListener('event:agent:lifecycle', agentLifecycleEventHandler);
      if (agentToolEventHandler) ws.removeListener('event:agent:tool', agentToolEventHandler);

      let finalText = fullResponseText.trim() || finalAssistantText || '';
      let shouldFlagUnverifiedLocalFileOperation = looksLikeFilesystemMutationRequest(message)
        && looksLikeSuccessfulFilesystemMutationResponse(finalText)
        && !pendingApprovalRequestId
        && !sawCompletedFilesystemToolResult;
      if (looksLikeAwarenessInitCompatibilityError(finalText)) {
        awarenessInitCompatibilityIssue = true;
        awarenessInitFailureDetail = finalText;
        chatState.awarenessInitCompatibilityMode = true;
        chatState.lastAwarenessInitCompatibilityError = finalText;
      }
      let shouldFlagVpnDnsCompatibilityIssue = looksLikeWebOperationRequest(message)
        && looksLikeSpecialUseIpWebBlock(finalText);
      let preferResultText = false;
      let usedCliCompatibilityRetry = false;

      if (shouldFlagUnverifiedLocalFileOperation) {
        console.warn('[chat] Assistant claimed a local filesystem mutation succeeded without any completed tool result', {
          sessionId: sid,
          responsePreview: finalText.slice(0, 200),
          sawToolBlocks,
          sawCompletedToolResult,
          sawCompletedFilesystemToolResult,
        });
      }

      if (awarenessInitCompatibilityIssue && !pendingApprovalRequestId && shouldRetryAfterAwarenessInitFailure(message, finalText)) {
        console.warn('[chat] Awareness memory bootstrap compatibility issue detected; retrying without awareness_init', {
          sessionId: sid,
          responsePreview: finalText.slice(0, 200),
          detail: awarenessInitFailureDetail,
        });

        send('chat:status', {
          type: 'gateway',
          message: 'Detected Awareness memory compatibility mode. Retrying without awareness_init...',
        });

        const preparedCli = await prepareCliFallbackWithDaemonRetry(deps.prepareCliFallback, send);
        if (!preparedCli.ok) {
          console.warn('[chat] CLI compatibility retry preparation failed:', preparedCli.error || 'unknown error');
        }

        const retryPrompt = buildAwarenessInitCompatibilityRetryPrompt(
          fullMessage,
          awarenessInitFailureDetail || finalText,
        );
        const retryResult = await chatSendViaCliWithWebCompatibilityRetry({
          requestMessage: retryPrompt,
          originalUserMessage: message,
          sid,
          options: requestedOptions,
          send,
          deps,
        });
        usedCliCompatibilityRetry = true;

        if (!retryResult?.success) {
          send('chat:stream-end', {});
        }

        const retryText = String(retryResult?.text || '').trim();
        if (retryResult?.success && hasMeaningfulAgentText(retryText)) {
          finalText = retryText;
          shouldFlagUnverifiedLocalFileOperation = Boolean(retryResult?.unverifiedLocalFileOperation);
          shouldFlagVpnDnsCompatibilityIssue = Boolean(retryResult?.vpnDnsCompatibilityIssue);
          preferResultText = true;
          send('chat:status', {
            type: 'gateway',
            message: 'Continued without awareness_init successfully.',
          });
        }
      }

      if (shouldFlagVpnDnsCompatibilityIssue) {
        console.warn('[chat] Web tool response indicates VPN/DNS special-use IP compatibility issue', {
          sessionId: sid,
          responsePreview: finalText.slice(0, 200),
        });

        if (!pendingApprovalRequestId) {
          send('chat:status', {
            type: 'gateway',
            message: 'Detected VPN/DNS compatibility mode. Retrying with exec-based web access...',
          });
          const preparedCli = await prepareCliFallbackWithDaemonRetry(deps.prepareCliFallback, send);
          if (!preparedCli.ok) {
            console.warn('[chat] CLI compatibility retry preparation failed:', preparedCli.error || 'unknown error');
          }

          const retryPrompt = buildWebCompatibilityRetryPrompt(message, finalText);
          const retryResult = await chatSendViaCli(retryPrompt, sid, requestedOptions, send, deps);
          usedCliCompatibilityRetry = true;

          if (!retryResult?.success) {
            send('chat:stream-end', {});
          }

          const retryText = String(retryResult?.text || '').trim();
          if (retryResult?.success && hasMeaningfulAgentText(retryText)) {
            finalText = retryText;
            shouldFlagUnverifiedLocalFileOperation = Boolean(retryResult?.unverifiedLocalFileOperation);
            shouldFlagVpnDnsCompatibilityIssue = Boolean(retryResult?.vpnDnsCompatibilityIssue);
            preferResultText = true;

            if (!shouldFlagVpnDnsCompatibilityIssue) {
              send('chat:status', {
                type: 'gateway',
                message: 'Web compatibility fallback succeeded.',
              });
            }
          }
        }
      }

      if (!usedCliCompatibilityRetry) {
        send('chat:stream-end', {});
      }

      if (!finalText && !pendingApprovalRequestId) {
        const diagnostic = {
          sessionId: sid,
          didTimeout,
          sawFinalState,
          sawAssistantDelta,
          sawAssistantTextDelta,
          sawAssistantNonTextDelta,
          sawToolBlocks,
          sawThinkingBlocks,
          finalAssistantTextPreview: finalAssistantText ? finalAssistantText.slice(0, 160) : '',
          finalAssistantContentTypes,
        };

        if (didTimeout) {
          console.warn('[chat] No response before desktop timeout; likely OpenClaw/Gateway stalled upstream', diagnostic);
        } else if (!sawAssistantTextDelta && finalAssistantText) {
          console.warn('[chat] Desktop received assistant text only in the final event and would misclassify it as No response', diagnostic);
        } else if (sawFinalState && !sawAssistantDelta && !finalAssistantText) {
          console.warn('[chat] OpenClaw/Gateway completed the run with an empty assistant response', diagnostic);
        } else if (sawAssistantDelta && !sawAssistantTextDelta && (sawAssistantNonTextDelta || sawToolBlocks || sawThinkingBlocks)) {
          console.warn('[chat] OpenClaw/Gateway returned assistant activity without text output', diagnostic);
        } else {
          console.warn('[chat] Empty response could not be classified cleanly', diagnostic);
        }

        send('chat:status', {
          type: 'gateway',
          message: 'Gateway returned an empty reply. Retrying through local CLI fallback...',
        });

        const preparedCli = await prepareCliFallbackWithDaemonRetry(deps.prepareCliFallback, send);
        if (!preparedCli.ok) {
          const detail = preparedCli.error || 'unknown error';
          console.warn('[chat] CLI fallback preparation failed after empty Gateway reply:', detail);
          if (preparedCli.daemonNotReady || /LOCAL_DAEMON_NOT_READY/i.test(detail)) {
            return withWorkspaceFallbackMeta({
              success: false,
              error: 'Local memory service is still starting. Please wait 20-60 seconds, then retry.',
              sessionId: sid,
            });
          }
        }

        const cliRecoveryResult = await chatSendViaCliWithWebCompatibilityRetry({
          requestMessage: fullMessage,
          originalUserMessage: message,
          sid,
          options: requestedOptions,
          send,
          deps,
        });
        const cliNeedsRawRetry = cliRecoveryResult?.success
          && (!cliRecoveryResult.text || /^(No response|No reply from agent\.?)+$/i.test(String(cliRecoveryResult.text).trim()));
        if (cliNeedsRawRetry && fullMessage !== message) {
          console.warn('[chat] CLI recovery after empty Gateway reply returned empty text with metadata prompt; retrying with raw user message');
          const cliRawRetryResult = await chatSendViaCliWithWebCompatibilityRetry({
            requestMessage: message,
            originalUserMessage: message,
            sid,
            options: requestedOptions,
            send,
            deps,
          });
          maybeSelfHealGateway1006(cliRawRetryResult, send, deps.runSpawn, deps.getEnhancedPath(), deps.startGatewayInUserSession, deps.runAsync);
          return withWorkspaceFallbackMeta(cliRawRetryResult);
        }

        maybeSelfHealGateway1006(cliRecoveryResult, send, deps.runSpawn, deps.getEnhancedPath(), deps.startGatewayInUserSession, deps.runAsync);
        return withWorkspaceFallbackMeta(cliRecoveryResult);
      }

      const memoryCapturePolicy = deps.readMemoryCapturePolicy?.() || getMemoryCapturePolicy(os.homedir());
      const blockedSources = new Set(
        (memoryCapturePolicy.blockedSources || []).map((item) => item.trim().toLowerCase()).filter(Boolean),
      );
      const shouldAutoCaptureDesktopMemory = memoryCapturePolicy.autoCapture !== false
        && !blockedSources.has('desktop');

      if (finalText && !shouldFlagUnverifiedLocalFileOperation && shouldAutoCaptureDesktopMemory) {
        const memoryToolId = `memory-save-${Date.now()}`;
        send('chat:status', {
          type: 'tool_call',
          tool: 'awareness_record',
          toolStatus: 'saving',
          toolId: memoryToolId,
          detail: 'Save this turn to Awareness memory',
        });

        deps.callMcpStrict('awareness_record', {
          action: 'remember',
          content: `Request: ${message}\nResult: ${finalText}`,
          event_type: 'turn_brief',
          source: 'desktop',
        }).then((result) => {
          const parsed = parseMcpTextPayload(result);
          if (parsed?.error) {
            throw new Error(parsed.error);
          }
          send('chat:status', {
            type: 'tool_update',
            toolId: memoryToolId,
            toolStatus: 'completed',
            detail: parsed?.filepath || 'Saved to Awareness memory',
          });
        }).catch((err) => {
          console.warn('[chat] Memory record failed:', err.message);
          send('chat:status', {
            type: 'tool_update',
            toolId: memoryToolId,
            toolStatus: 'failed',
            detail: err.message,
          });
          send('chat:memory-warning', {
            type: 'record-failed',
            message: err.message,
          });
        });
      }

      if (!finalText && pendingApprovalRequestId) {
        return withWorkspaceFallbackMeta({
          success: true,
          text: '',
          sessionId: sid,
          awaitingApproval: true,
          approvalRequestId: pendingApprovalRequestId,
          approvalCommand: pendingApprovalCommand,
          approvalDetail: pendingApprovalDetail,
        });
      }

      return withWorkspaceFallbackMeta({
        success: true,
        text: finalText || 'No response',
        sessionId: sid,
        unverifiedLocalFileOperation: shouldFlagUnverifiedLocalFileOperation || undefined,
        vpnDnsCompatibilityIssue: shouldFlagVpnDnsCompatibilityIssue || undefined,
        preferResultText: preferResultText || undefined,
      });
    } catch (err: any) {
      if (ws) {
        if (chatEventHandler) ws.removeListener('event:chat', chatEventHandler);
        if (allEventsHandler) ws.removeListener('gateway-event', allEventsHandler);
        if (agentEventHandler) ws.removeListener('event:agent', agentEventHandler);
        if (agentAssistantEventHandler) ws.removeListener('event:agent:assistant', agentAssistantEventHandler);
        if (agentLifecycleEventHandler) ws.removeListener('event:agent:lifecycle', agentLifecycleEventHandler);
        if (agentToolEventHandler) ws.removeListener('event:agent:tool', agentToolEventHandler);
      }
      send('chat:stream-end', {});
      const errorMsg = err?.message || String(err);
      if (errorMsg.includes('WebSocket') || errorMsg.includes('connect') || errorMsg.includes('timed out') || /pairing required/i.test(errorMsg)) {
        console.warn('[chat] WebSocket/pairing failed, falling back to CLI:', errorMsg);
        // For pairing-required failures, trigger a background reconnect+repair so the
        // next chat message goes through Gateway cleanly (write-scope pre-warm).
        if (/pairing required/i.test(errorMsg)) {
          deps.getGatewayWs().catch(() => { /* background repair — don't block fallback */ });
        }
        requestedOptions.forceLocal = true;
        send('chat:status', {
          type: 'gateway',
          message: 'Gateway connection is unstable. Sending this message through local fallback mode.',
        });
        const preparedCli = await prepareCliFallbackWithDaemonRetry(deps.prepareCliFallback, send);
        if (!preparedCli.ok) {
          const detail = preparedCli.error || 'unknown error';
          console.warn('[chat] CLI fallback preparation failed:', detail);
          if (preparedCli.daemonNotReady || /LOCAL_DAEMON_NOT_READY/i.test(detail)) {
            return withWorkspaceFallbackMeta({
              success: false,
              error: 'Local memory service is still starting. Please wait 20-60 seconds, then retry.',
              sessionId: sid,
            });
          }
        }
        const cliResult = await chatSendViaCliWithWebCompatibilityRetry({
          requestMessage: fullMessage,
          originalUserMessage: message,
          sid,
          options: requestedOptions,
          send,
          deps,
        });
        const needsRetry = cliResult?.success
          && (!cliResult.text || /^(No response|No reply from agent\.?)+$/i.test(String(cliResult.text).trim()));
        if (needsRetry && fullMessage !== message) {
          console.warn('[chat] CLI fallback returned empty response with metadata prompt; retrying with raw user message');
          const retryResult = await chatSendViaCliWithWebCompatibilityRetry({
            requestMessage: message,
            originalUserMessage: message,
            sid,
            options: requestedOptions,
            send,
            deps,
          });
          maybeSelfHealGateway1006(retryResult, send, deps.runSpawn, deps.getEnhancedPath(), deps.startGatewayInUserSession, deps.runAsync);
          return withWorkspaceFallbackMeta(retryResult);
        }
        maybeSelfHealGateway1006(cliResult, send, deps.runSpawn, deps.getEnhancedPath(), deps.startGatewayInUserSession, deps.runAsync);
        return withWorkspaceFallbackMeta(cliResult);
      }
      return withWorkspaceFallbackMeta({ success: false, text: '', error: errorMsg, sessionId: sid });
    }
  });
}
