import { spawn } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { ipcMain } from 'electron';
import type { GatewayClient } from '../gateway-ws';
import { getExecApprovalSettings } from '../openclaw-config';

// Extracted modules — pure copy/paste, no logic changes
import type { ChatSendOptions, MemoryCapturePolicy } from './chat-types';
import { chatState, CHAT_TIMEOUT_MS } from './chat-types';
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
import { chatSendViaCli, chatSendViaCliWithWebCompatibilityRetry } from './chat-cli-executor';

// --- Helper functions extracted to ./chat-message-builders.ts, ./gateway-event-normalizer.ts,
// --- ./chat-detection.ts, ./awareness-memory-utils.ts, ./chat-cli-executor.ts ---
// --- (pure copy/paste extraction, no logic changes) ---

export function registerChatHandlers(deps: {
  sendToRenderer: (channel: string, payload: any) => void;
  ensureGatewayRunning: () => Promise<{ ok: boolean; error?: string }>;
  prepareGatewayForChat?: () => Promise<{ ok: boolean; error?: string }>;
  prepareCliFallback?: () => Promise<void>;
  getGatewayWs: () => Promise<GatewayClient>;
  getConnectedGatewayWs: () => GatewayClient | null;
  callMcpStrict: (toolName: string, args: Record<string, any>, timeoutMs?: number) => Promise<any>;
  getEnhancedPath: () => string;
  runSpawn?: (cmd: string, args: string[], opts?: Record<string, unknown>) => ReturnType<typeof spawn>;
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

    // Agent routing is done via the session key format, not a separate agentId param.
    // Gateway session keys: agent:<agentId>:main (operator), agent:<agentId>:webchat:<id> (desktop).
    // When a non-main agent is selected, prefix the session key so Gateway routes to the right agent.
    const agentId = requestedOptions.agentId || 'main';
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
      console.warn('[chat] Gateway preflight failed, falling back to CLI:', gatewayReady.error || 'unknown error');
      send('chat:status', {
        type: 'gateway',
        message: gatewayReady.error || 'Gateway unavailable. Falling back to direct OpenClaw chat...',
      });
      try {
        await deps.prepareCliFallback?.();
      } catch (prepareErr: any) {
        const detail = prepareErr?.message || String(prepareErr);
        console.warn('[chat] CLI fallback preparation failed:', detail);
        if (/LOCAL_DAEMON_NOT_READY/i.test(detail)) {
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
        return withWorkspaceFallbackMeta(retryResult);
      }
      return withWorkspaceFallbackMeta(cliResult);
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
      const chatTimeout = setTimeout(() => {
        didTimeout = true;
        chatResolve();
      }, CHAT_TIMEOUT_MS);

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
          if (block.type === 'tool_use') {
            sawToolBlocks = true;
            const toolId = block.id || `tc-${Date.now()}`;
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

          if (block.type === 'tool_result') {
            sawToolBlocks = true;
            sawCompletedToolResult = true;
            const toolId = block.tool_use_id || '';
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
          clearTimeout(chatTimeout);
          chatResolve();
        } else if (state === 'aborted' || state === 'error') {
          send('chat:status', { type: 'error' });
          clearTimeout(chatTimeout);
          chatResolve();
        }
      };

      ws.on('event:chat', chatEventHandler);
      send('chat:status', { type: 'thinking' });

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

        try {
          await deps.prepareCliFallback?.();
        } catch (prepareErr: any) {
          console.warn('[chat] CLI compatibility retry preparation failed:', prepareErr?.message || prepareErr);
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
          try {
            await deps.prepareCliFallback?.();
          } catch (prepareErr: any) {
            console.warn('[chat] CLI compatibility retry preparation failed:', prepareErr?.message || prepareErr);
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
        try {
          await deps.prepareCliFallback?.();
        } catch (prepareErr: any) {
          console.warn('[chat] CLI fallback preparation failed:', prepareErr?.message || prepareErr);
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
          return withWorkspaceFallbackMeta(retryResult);
        }
        return withWorkspaceFallbackMeta(cliResult);
      }
      return withWorkspaceFallbackMeta({ success: false, text: '', error: errorMsg, sessionId: sid });
    }
  });
}
