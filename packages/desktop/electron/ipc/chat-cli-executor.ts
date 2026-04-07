// Extracted from register-chat-handlers.ts — CLI chat execution and retry wrapper.
// No logic changes, only moved.

import { spawn } from 'child_process';
import os from 'os';
import type { ChatSendOptions } from './chat-types';
import { CHAT_TIMEOUT_MS, CHAT_IDLE_TIMEOUT_MS, chatState } from './chat-types';
import {
  looksLikeFilesystemMutationRequest,
  looksLikeSuccessfulFilesystemMutationResponse,
  looksLikeWebOperationRequest,
  looksLikeSpecialUseIpWebBlock,
  hasMeaningfulAgentText,
} from './chat-detection';
import { buildWebCompatibilityRetryPrompt } from './awareness-memory-utils';

const LOCAL_DAEMON_RETRY_DELAY_MS = 8000;

export async function prepareCliFallbackWithDaemonRetry(
  prepareCliFallback: (() => Promise<void>) | undefined,
  send: (channel: string, payload: any) => void,
): Promise<{ ok: boolean; error?: string; daemonNotReady?: boolean }> {
  if (!prepareCliFallback) {
    return { ok: true };
  }

  try {
    await prepareCliFallback();
    return { ok: true };
  } catch (prepareErr: any) {
    const detail = prepareErr?.message || String(prepareErr || '');
    if (!/LOCAL_DAEMON_NOT_READY/i.test(detail)) {
      return { ok: false, error: detail };
    }

    send('chat:status', {
      type: 'gateway',
      message: 'Local memory service is still starting. Waiting a few seconds and retrying automatically...',
    });

    await new Promise((resolve) => setTimeout(resolve, LOCAL_DAEMON_RETRY_DELAY_MS));

    try {
      await prepareCliFallback();
      return { ok: true };
    } catch (retryErr: any) {
      const retryDetail = retryErr?.message || String(retryErr || '');
      return {
        ok: false,
        error: retryDetail,
        daemonNotReady: /LOCAL_DAEMON_NOT_READY/i.test(retryDetail),
      };
    }
  }
}

export async function chatSendViaCli(
  requestMessage: string,
  sid: string,
  options: ChatSendOptions | undefined,
  send: (channel: string, payload: any) => void,
  deps: {
    getEnhancedPath: () => string;
    prepareCliFallback?: () => Promise<void>;
    runSpawn?: (cmd: string, args: string[], opts?: Record<string, unknown>) => ReturnType<typeof spawn>;
    wrapWindowsCommand: (command: string) => string;
    stripAnsi: (output: string) => string;
    spawnChatProcess?: typeof spawn;
  },
): Promise<any> {
  return new Promise((resolve) => {
    let settled = false;
    const collectedLines: string[] = [];
    const rawOutputLines: string[] = [];
    let stdoutRemainder = '';
    let stderrRemainder = '';
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let absoluteTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
    // Defense-in-depth: capture "Unknown agent id" reports from OpenClaw stderr.
    // These come through as `Gateway agent failed; falling back to embedded:
    // Error: Unknown agent id "xxx". Use "openclaw agents list" to see configured agents.`
    // The line is filtered by isNoiseLine (we don't want it streamed verbatim), but we
    // still need to know it happened so we can surface a friendly error instead of
    // returning empty text → "No response" with no actionable signal to the user.
    // See CLAUDE.md "聊天 No response 防回归规则" + openclaw#17330 / openclaw#41686.
    let detectedUnknownAgentId: string | null = null;
    // Defense-in-depth (path A4): detect Gateway 1006 abnormal closures emitted by
    // OpenClaw's `agent` CLI when the Gateway WS handshake completes but the chat.send
    // RPC is dropped immediately. This usually means Gateway is in a half-broken state
    // (process up, accepting TCP, but the request pipeline is wedged — see openclaw#46256).
    // When detected, the chat IPC handler will request a one-shot Gateway restart in
    // the background so the next message has a fresh server. Detection only — actual
    // restart is wired in the IPC handler that owns the gateway client.
    let detectedGateway1006 = false;
    const finalize = (result: any) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (absoluteTimeoutHandle) {
        clearTimeout(absoluteTimeoutHandle);
        absoluteTimeoutHandle = null;
      }
      resolve(result);
    };
    const thinkingFlag = options?.thinkingLevel && options.thinkingLevel !== 'off'
      ? ` --thinking ${options.thinkingLevel}` : '';
    const sanitizedAgentId = options?.agentId && options.agentId !== 'main'
      && /^[a-z][a-z0-9-]{0,63}$/.test(options.agentId) && !options.agentId.endsWith('-')
      ? options.agentId : '';
    const agentFlag = sanitizedAgentId ? ` --agent "${sanitizedAgentId}"` : '';
    const escapedMsg = requestMessage.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\\$').replace(/`/g, '\\`');
    // Note: openclaw CLI does not support --reasoning flag; reasoning is controlled via
    // openclaw.json agents.defaults.reasoningDefault (set in syncToOpenClaw)
    const command = `openclaw agent --session-id "${sid}" -m "${escapedMsg}" --verbose full${thinkingFlag}${agentFlag}`;
    const openclawArgs = ['agent', '--session-id', sid, '-m', requestMessage, '--verbose', 'full'];
    if (options?.thinkingLevel && options.thinkingLevel !== 'off') {
      openclawArgs.push('--thinking', options.thinkingLevel);
    }
    if (sanitizedAgentId) {
      openclawArgs.push('--agent', sanitizedAgentId);
    }
    const cwd = options?.workspacePath || os.homedir();
    const spawnChatProcess = deps.spawnChatProcess || spawn;
    const child = deps.runSpawn
      ? deps.runSpawn('openclaw', openclawArgs, { cwd, stdio: 'pipe', windowsHide: true })
      : (() => {
          const enhancedPath = deps.getEnhancedPath();
          return process.platform === 'win32'
            ? spawnChatProcess(deps.wrapWindowsCommand(command), [], { cwd, shell: 'cmd.exe', env: { ...process.env, PATH: enhancedPath, NO_COLOR: '1', FORCE_COLOR: '0' } })
            : spawnChatProcess('/bin/bash', ['--norc', '--noprofile', '-c', `export PATH="${enhancedPath}"; ${command}`], { cwd, env: { ...process.env, PATH: enhancedPath } });
        })();

    const isNoiseLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (trimmed.startsWith('[')) return true;
      if (/^at\s+ChildProcess\._handle\.onexit\b/i.test(trimmed)) return true;
      if (/^at\s+onErrorNT\b/i.test(trimmed)) return true;
      if (/^at\s+process\.processTicksAndRejections\b/i.test(trimmed)) return true;
      if (/^at\s+.*\(node:internal\//i.test(trimmed)) return true;
      if (trimmed.startsWith('Config')) return true;
      if (trimmed.startsWith('Registered ')) return true;
      // Tightened: previously `trimmed.includes('plugin')` matched ANY line containing
      // the word "plugin", which silently swallows legitimate assistant text such as
      // "the Telegram plugin requires a bot token...". This produced an empty `clean`
      // string and the desktop UI fell back to "No response" even though OpenClaw had
      // generated a real reply. Restrict to OpenClaw's actual plugin-loader prefixes
      // (always at line start, always followed by a colon or whitespace marker).
      if (/^(\[plugins\]|plugins?\s*[:>]|Plugin\s+\S+\s+(loaded|registered|disabled|skipped))/.test(trimmed)) return true;
      if (/^gateway connect failed:/i.test(trimmed)) return true;
      if (/^Gateway agent failed; falling back to embedded:/i.test(trimmed)) return true;
      if (/^Gateway target:/i.test(trimmed)) return true;
      if (/^Source:/i.test(trimmed)) return true;
      if (/^Bind:/i.test(trimmed)) return true;
      if (/^Config:\s+/i.test(trimmed)) return true;
      return false;
    };

    const rememberRawLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      rawOutputLines.push(trimmed);
    };

    const flushChunk = (chunk: string, fromStderr: boolean) => {
      const normalized = deps.stripAnsi(chunk).replace(/\r/g, '');
      const current = fromStderr ? stderrRemainder : stdoutRemainder;
      const merged = `${current}${normalized}`;
      const lines = merged.split('\n');
      const trailing = lines.pop() ?? '';
      if (fromStderr) stderrRemainder = trailing;
      else stdoutRemainder = trailing;

      for (const line of lines) {
        const trimmed = line.trim();
        rememberRawLine(trimmed);
        if (!detectedUnknownAgentId) {
          const m = trimmed.match(/Unknown agent id\s+"([^"]+)"/i);
          if (m) detectedUnknownAgentId = m[1];
        }
        if (!detectedGateway1006 && /gateway closed\s*\(\s*1006\b/i.test(trimmed)) {
          detectedGateway1006 = true;
        }
        if (!isNoiseLine(trimmed)) {
          collectedLines.push(trimmed);
          send('chat:stream', `${trimmed}\n`);
        }
      }
    };

    const flushRemainder = (fromStderr: boolean) => {
      const line = (fromStderr ? stderrRemainder : stdoutRemainder).trim();
      if (fromStderr) stderrRemainder = '';
      else stdoutRemainder = '';
      if (!line) return;
      rememberRawLine(line);
      if (!isNoiseLine(line)) {
        collectedLines.push(line);
        send('chat:stream', `${line}\n`);
      }
    };

    chatState.activeChatChild = child;

    // Activity-based (idle) timeout: resets every time stdout/stderr emits data.
    // This lets long responses (e.g. writing a 5000-word document) complete without
    // hitting a fixed wall, while still catching truly stalled processes.
    const resetIdleTimeout = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(() => {
        try { child.kill(); } catch {}
        finalize({ success: false, error: 'The agent took too long to respond. This usually happens when the system is still loading. Please try sending your message again.', sessionId: sid });
      }, CHAT_IDLE_TIMEOUT_MS);
    };
    // Absolute safety cap: even with activity, don't let a single chat run forever
    absoluteTimeoutHandle = setTimeout(() => {
      try { child.kill(); } catch {}
      finalize({ success: false, error: 'The agent took too long to respond. This usually happens when the system is still loading. Please try sending your message again.', sessionId: sid });
    }, CHAT_TIMEOUT_MS * 5); // 10 minutes absolute max

    child.stdout?.on('data', (data: Buffer) => {
      resetIdleTimeout();
      flushChunk(data.toString(), false);
    });
    child.stderr?.on('data', (data: Buffer) => {
      resetIdleTimeout();
      flushChunk(data.toString(), true);
    });
    child.on('exit', (code: number | null) => {
      chatState.activeChatChild = null;
      flushRemainder(false);
      flushRemainder(true);
      send('chat:stream-end', {});
      const clean = collectedLines.join('\n').trim();
      const rawCombined = rawOutputLines.join('\n');

      if (code !== 0) {
        if (/spawn\s+npx(?:\.cmd)?\s+ENOENT/i.test(`${rawCombined}\n${clean}`)) {
          finalize({
            success: false,
            error: 'OpenClaw could not start the local helper runtime. Please rerun Setup to repair your runtime, then retry.',
            sessionId: sid,
            localRuntimeMissing: true,
          });
          return;
        }

        finalize({
          success: false,
          error: clean || `OpenClaw exited with code ${code ?? 'unknown'}`,
          sessionId: sid,
        });
        return;
      }

      // If OpenClaw reported an unknown agent id and the run produced no usable
      // assistant text, surface a friendly, actionable error instead of "No response".
      // Empty text + detected ghost agent id == 100% reproducible silent failure
      // mode caught by openclaw#17330 / openclaw#41686. We must not swallow it.
      if (detectedUnknownAgentId && !clean) {
        finalize({
          success: false,
          error: `The selected agent "${detectedUnknownAgentId}" no longer exists in OpenClaw. Please pick a different agent (or "main") in the chat header and try again.`,
          sessionId: sid,
          unknownAgentId: detectedUnknownAgentId,
        });
        return;
      }

      const shouldFlagUnverifiedLocalFileOperation = looksLikeFilesystemMutationRequest(requestMessage)
        && looksLikeSuccessfulFilesystemMutationResponse(clean);
      const shouldFlagVpnDnsCompatibilityIssue = looksLikeWebOperationRequest(requestMessage)
        && looksLikeSpecialUseIpWebBlock(clean);
      if (shouldFlagUnverifiedLocalFileOperation) {
        console.warn('[chat] CLI fallback produced an unverified local filesystem success claim', {
          sessionId: sid,
          responsePreview: clean.slice(0, 200),
        });
      }
      if (shouldFlagVpnDnsCompatibilityIssue) {
        console.warn('[chat] CLI fallback indicates VPN/DNS special-use IP compatibility issue', {
          sessionId: sid,
          responsePreview: clean.slice(0, 200),
        });
      }
      finalize({
        success: true,
        text: clean || 'No response',
        sessionId: sid,
        unverifiedLocalFileOperation: shouldFlagUnverifiedLocalFileOperation || undefined,
        vpnDnsCompatibilityIssue: shouldFlagVpnDnsCompatibilityIssue || undefined,
        gateway1006: detectedGateway1006 || undefined,
      });
    });
    child.on('error', (err) => {
      const message = String(err);
      if (/spawn\s+npx(?:\.cmd)?\s+ENOENT/i.test(message)) {
        finalize({
          success: false,
          error: 'OpenClaw could not start the local helper runtime. Please rerun Setup to repair your runtime, then retry.',
          sessionId: sid,
          localRuntimeMissing: true,
        });
        return;
      }
      finalize({ success: false, error: message, sessionId: sid });
    });
    // Start the initial idle timer (will be reset on first data)
    resetIdleTimeout();
  });
}

export async function chatSendViaCliWithWebCompatibilityRetry(params: {
  requestMessage: string;
  originalUserMessage: string;
  sid: string;
  options: ChatSendOptions | undefined;
  send: (channel: string, payload: any) => void;
  deps: {
    getEnhancedPath: () => string;
    prepareCliFallback?: () => Promise<void>;
    runSpawn?: (cmd: string, args: string[], opts?: Record<string, unknown>) => ReturnType<typeof spawn>;
    wrapWindowsCommand: (command: string) => string;
    stripAnsi: (output: string) => string;
    spawnChatProcess?: typeof spawn;
  };
}): Promise<any> {
  const { requestMessage, originalUserMessage, sid, options, send, deps } = params;
  const first = await chatSendViaCli(requestMessage, sid, options, send, deps);

  if (first?.localRuntimeMissing && deps.prepareCliFallback) {
    send('chat:status', {
      type: 'gateway',
      message: 'Local memory service is recovering. Retrying automatically...',
    });

    const prepared = await prepareCliFallbackWithDaemonRetry(deps.prepareCliFallback, send);
    if (!prepared.ok) {
      if (prepared.daemonNotReady || /LOCAL_DAEMON_NOT_READY/i.test(prepared.error || '')) {
        return {
          success: false,
          error: 'Local memory service is still starting. Please wait 20-60 seconds, then retry.',
          sessionId: sid,
        };
      }
      return {
        success: false,
        error: 'OpenClaw could not start the local helper runtime automatically. Please rerun Setup to repair your runtime, then retry.',
        sessionId: sid,
      };
    }

    const repairedRetry = await chatSendViaCli(requestMessage, sid, options, send, deps);
    if (repairedRetry?.success) {
      send('chat:status', {
        type: 'gateway',
        message: 'Local memory service recovered. Continuing your request.',
      });
    }
    return repairedRetry;
  }

  if (!first?.vpnDnsCompatibilityIssue) {
    return first;
  }

  send('chat:status', {
    type: 'gateway',
    message: 'Detected VPN/DNS compatibility mode. Retrying with exec-based web access...',
  });

  const retryPrompt = buildWebCompatibilityRetryPrompt(
    originalUserMessage || requestMessage,
    String(first?.text || ''),
  );
  const retry = await chatSendViaCli(retryPrompt, sid, options, send, deps);
  if (!retry?.success) {
    send('chat:stream-end', {});
  }
  const retryText = String(retry?.text || '').trim();

  if (retry?.success && hasMeaningfulAgentText(retryText)) {
    return {
      ...retry,
      preferResultText: true,
    };
  }

  return first;
}
