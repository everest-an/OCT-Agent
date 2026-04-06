// Extracted from register-chat-handlers.ts — CLI chat execution and retry wrapper.
// No logic changes, only moved.

import { spawn } from 'child_process';
import os from 'os';
import type { ChatSendOptions } from './chat-types';
import { CHAT_TIMEOUT_MS, chatState } from './chat-types';
import {
  looksLikeFilesystemMutationRequest,
  looksLikeSuccessfulFilesystemMutationResponse,
  looksLikeWebOperationRequest,
  looksLikeSpecialUseIpWebBlock,
  hasMeaningfulAgentText,
} from './chat-detection';
import { buildWebCompatibilityRetryPrompt } from './awareness-memory-utils';

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
    const finalize = (result: any) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
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
      if (trimmed.startsWith('Registered')) return true;
      if (trimmed.includes('plugin')) return true;
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
    child.stdout?.on('data', (data: Buffer) => {
      flushChunk(data.toString(), false);
    });
    child.stderr?.on('data', (data: Buffer) => {
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
    timeoutHandle = setTimeout(() => {
      try { child.kill(); } catch {}
      finalize({ success: false, error: 'Response timeout', sessionId: sid });
    }, CHAT_TIMEOUT_MS);
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

    try {
      await deps.prepareCliFallback?.();
    } catch (prepareErr: any) {
      const detail = prepareErr?.message || String(prepareErr || '');
      if (/LOCAL_DAEMON_NOT_READY/i.test(detail)) {
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
