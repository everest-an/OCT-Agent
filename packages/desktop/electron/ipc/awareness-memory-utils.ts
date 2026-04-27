// Extracted from register-chat-handlers.ts — Awareness memory bootstrap utilities.
// No logic changes, only moved.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { readJsonFileWithBom } from '../json-file';
import { buildMemoryInitArgs } from '../memory-protocol';
import { truncateDetail } from './chat-message-builders';
import {
  extractFirstHttpUrl,
  looksLikeWebOperationRequest,
  looksLikeFilesystemMutationRequest,
  looksLikeSpecialUseIpWebBlock,
} from './chat-detection';
import { MEMORY_BOOTSTRAP_MAX_CHARS, MCP_MEMORY_BOOTSTRAP_TIMEOUT_MS, chatState } from './chat-types';
import type { MemoryCapturePolicy } from './chat-types';

export function parseMcpTextPayload(mcpResponse: any) {
  const textPayload = mcpResponse?.result?.content?.[0]?.text;
  if (!textPayload || typeof textPayload !== 'string') return {};
  try {
    return JSON.parse(textPayload);
  } catch {
    return {};
  }
}

// ----------------------------------------------------------------------------
// Pending extraction relay
//
// The local Awareness daemon emits `_extraction_instruction` on every
// `awareness_record(action="remember")` response when the caller didn't pass
// pre-extracted insights. The instruction is a plain-text prompt asking the
// host LLM to produce a JSON object of knowledge_cards / risks / action_items
// and submit it back via `awareness_record(action="submit_insights", insights={...})`.
//
// Desktop's chat path is fire-and-forget for memory saves, so we cannot block
// the current turn waiting for an extra LLM round-trip. Instead we stash the
// instruction on disk and re-inject it into the *next* turn's bootstrap
// section so the host LLM acts on it during normal conversation. If the user
// never starts another turn the instruction is dropped on TTL (30 min) — the
// cloud backend's fallback loop will still re-emit the request later.
//
// File: ~/.awareness-claw/pending-extraction.json (single-slot — newest wins).
// ----------------------------------------------------------------------------
const PENDING_EXTRACTION_TTL_MS = 30 * 60 * 1000;
const PENDING_EXTRACTION_MAX_CHARS = 6000;

function pendingExtractionFile(homeDir: string): string {
  return path.join(homeDir, '.awareness-claw', 'pending-extraction.json');
}

interface PendingExtraction {
  instruction: string;
  recorded_at: number;
  memory_id?: string;
  session_id?: string;
}

export function writePendingExtraction(homeDir: string, payload: PendingExtraction): void {
  try {
    const file = pendingExtractionFile(homeDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload), { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    console.warn('[awareness] writePendingExtraction failed:', (err as Error).message);
  }
}

export function consumePendingExtraction(homeDir: string): PendingExtraction | null {
  try {
    const file = pendingExtractionFile(homeDir);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf-8');
    fs.unlinkSync(file); // one-shot — delete on read so we don't loop forever
    const parsed = JSON.parse(raw) as PendingExtraction;
    if (!parsed?.instruction) return null;
    if (typeof parsed.recorded_at === 'number' && Date.now() - parsed.recorded_at > PENDING_EXTRACTION_TTL_MS) {
      return null; // stale — drop
    }
    return parsed;
  } catch {
    return null;
  }
}

export function buildPendingExtractionSection(pending: PendingExtraction): string {
  const trimmed = truncateDetail(pending.instruction, PENDING_EXTRACTION_MAX_CHARS);
  return [
    '[Pending insight extraction from previous turn]',
    'The Awareness daemon could not extract structured insights from the previous',
    'turn because no host LLM was available at write-time. Before responding to',
    'the user this turn, follow the instruction below to produce a JSON object',
    'with knowledge_cards / action_items / risks / skills, then submit it via:',
    '  awareness_record(action="submit_insights", insights=<your_json_object>)',
    'Then continue with the user\'s actual request.',
    '',
    trimmed,
  ].join('\n');
}

export function buildAwarenessInitSkipInstruction(errorDetail?: string): string {
  const summary = errorDetail ? `Latest compatibility failure: ${truncateDetail(errorDetail, 240)}` : '';
  return [
    '[Awareness memory compatibility note]',
    'Desktop has already detected that awareness_init can fail in the current OpenClaw wrapper path.',
    'Do not call awareness_init for this turn unless the user explicitly asks you to refresh memory bootstrap state.',
    'Continue with the main task even if Awareness memory bootstrap is unavailable.',
    'If you need targeted memory, use awareness_recall or awareness_lookup instead of awareness_init.',
    summary,
  ].filter(Boolean).join('\n');
}

export function buildDesktopMemoryBootstrapSummary(memoryPayload: Record<string, any>): string {
  const renderedContext = typeof memoryPayload?.rendered_context === 'string'
    ? memoryPayload.rendered_context.trim()
    : '';
  if (renderedContext) {
    return truncateDetail(renderedContext, MEMORY_BOOTSTRAP_MAX_CHARS);
  }

  const sections: string[] = [];
  const knowledgeCards = Array.isArray(memoryPayload?.knowledge_cards)
    ? memoryPayload.knowledge_cards.slice(0, 5)
    : [];
  if (knowledgeCards.length > 0) {
    sections.push([
      'Knowledge cards:',
      ...knowledgeCards.map((card: any) => `- ${String(card?.title || card?.summary || card?.content || '').trim()}`),
    ].join('\n'));
  }

  const openTasks = Array.isArray(memoryPayload?.open_tasks)
    ? memoryPayload.open_tasks.slice(0, 5)
    : [];
  if (openTasks.length > 0) {
    sections.push([
      'Open tasks:',
      ...openTasks.map((task: any) => `- ${String(task?.title || task?.summary || task?.content || '').trim()}`),
    ].join('\n'));
  }

  const recentSessions = Array.isArray(memoryPayload?.recent_sessions)
    ? memoryPayload.recent_sessions.slice(0, 3)
    : [];
  if (recentSessions.length > 0) {
    sections.push([
      'Recent sessions:',
      ...recentSessions.map((entry: any) => `- ${String(entry?.summary || entry?.title || entry?.content || '').trim()}`),
    ].join('\n'));
  }

  return truncateDetail(sections.filter(Boolean).join('\n\n'), MEMORY_BOOTSTRAP_MAX_CHARS);
}

export function buildDesktopMemoryBootstrapSection(memoryPayload: Record<string, any>, compatibilityError?: string): string {
  const contextSummary = buildDesktopMemoryBootstrapSummary(memoryPayload);
  const sections = [
    compatibilityError ? buildAwarenessInitSkipInstruction(compatibilityError) : '',
    [
      '[Awareness memory bootstrap loaded by Desktop]',
      'Desktop already loaded the current Awareness memory context for this turn.',
      'Treat the block below as the result of awareness_init and do not call awareness_init again on this turn.',
      'If more memory is needed, use awareness_recall or awareness_lookup instead.',
      contextSummary,
    ].filter(Boolean).join('\n'),
  ].filter(Boolean);
  return sections.join('\n\n');
}

export function buildAwarenessInitCompatibilityRetryPrompt(runtimeMessage: string, failureDetail: string): string {
  return [
    '[Automatic compatibility retry]',
    'Previous attempt hit the known Awareness memory bootstrap compatibility failure in awareness_init.',
    'Do not call awareness_init on this retry.',
    'Continue with the main task directly. If memory is needed, rely on the preloaded desktop memory context already present in the runtime metadata or use awareness_recall / awareness_lookup instead.',
    `Compatibility failure: ${truncateDetail(failureDetail, 400)}`,
    '',
    '[Original runtime message]',
    runtimeMessage,
  ].join('\n');
}

export function shouldRetryAfterAwarenessInitFailure(originalRequest: string, finalText: string): boolean {
  if (looksLikeWebOperationRequest(originalRequest) || looksLikeFilesystemMutationRequest(originalRequest)) {
    return true;
  }

  const trimmed = finalText.trim();
  if (!trimmed) return true;
  if (/^BROWSER_UNAVAILABLE$/i.test(trimmed)) return true;
  if (/^INIT_FAILED$/i.test(trimmed)) return true;
  if (/^No response$/i.test(trimmed)) return true;
  return false;
}

export async function tryBuildDesktopMemoryBootstrapSection(
  callMcpStrict: (toolName: string, args: Record<string, any>, timeoutMs?: number) => Promise<any>,
  userMessage: string,
  homeDir: string = os.homedir(),
): Promise<string> {
  const mcpResponse = await callMcpStrict(
    'awareness_init',
    buildMemoryInitArgs(userMessage),
    MCP_MEMORY_BOOTSTRAP_TIMEOUT_MS,
  );
  const memoryPayload = parseMcpTextPayload(mcpResponse);
  const baseSection = buildDesktopMemoryBootstrapSection(memoryPayload, chatState.awarenessInitCompatibilityMode ? chatState.lastAwarenessInitCompatibilityError : undefined);

  // Re-inject any pending extraction instruction stashed by the previous
  // turn's fire-and-forget memory save (see fireAndForgetMemorySave below).
  const pending = consumePendingExtraction(homeDir);
  if (!pending) return baseSection;
  return [baseSection, buildPendingExtractionSection(pending)].filter(Boolean).join('\n\n');
}

export function getMemoryCapturePolicy(homeDir: string): MemoryCapturePolicy {
  const defaultPolicy: MemoryCapturePolicy = { autoCapture: true, blockedSources: [] };

  try {
    const configPath = path.join(homeDir, '.openclaw', 'openclaw.json');
    const config = readJsonFileWithBom<Record<string, any>>(configPath) || {};
    const memoryConfig = config?.plugins?.entries?.['openclaw-memory']?.config || {};

    const blockedSources = Array.isArray(memoryConfig?.blockedSources)
      ? memoryConfig.blockedSources
        .filter((item: unknown): item is string => typeof item === 'string')
        .map((item: string) => item.trim())
        .filter(Boolean)
      : [];

    return {
      autoCapture: memoryConfig?.autoCapture !== false,
      blockedSources,
    };
  } catch {
    return defaultPolicy;
  }
}

/**
 * Fire-and-forget memory save — extracted so both Gateway and CLI fallback paths
 * can call it. Returns void; errors are caught internally and surfaced via IPC.
 */
export function fireAndForgetMemorySave(params: {
  message: string;
  responseText: string;
  send: (channel: string, payload: any) => void;
  callMcpStrict: (toolName: string, args: Record<string, any>, timeoutMs?: number) => Promise<any>;
  readMemoryCapturePolicy?: () => MemoryCapturePolicy;
  homeDir: string;
  skipIfUnverifiedFileOp?: boolean;
}): void {
  const { message, responseText, send, callMcpStrict, readMemoryCapturePolicy, homeDir, skipIfUnverifiedFileOp } = params;

  if (!responseText || skipIfUnverifiedFileOp) return;

  const memoryCapturePolicy = readMemoryCapturePolicy?.() || getMemoryCapturePolicy(homeDir);
  const blockedSources = new Set(
    (memoryCapturePolicy.blockedSources || []).map((item) => item.trim().toLowerCase()).filter(Boolean),
  );
  const shouldAutoCaptureDesktopMemory = memoryCapturePolicy.autoCapture !== false
    && !blockedSources.has('desktop');

  if (!shouldAutoCaptureDesktopMemory) return;

  const memoryToolId = `memory-save-${Date.now()}`;
  send('chat:status', {
    type: 'tool_call',
    tool: 'awareness_record',
    toolStatus: 'saving',
    toolId: memoryToolId,
    detail: 'Save this turn to Awareness memory',
  });

  callMcpStrict('awareness_record', {
    action: 'remember',
    content: `Request: ${message}\nResult: ${responseText}`,
    event_type: 'turn_brief',
    source: 'desktop',
  }).then((result) => {
    const parsed = parseMcpTextPayload(result);
    if (parsed?.error) {
      throw new Error(parsed.error);
    }

    // Stash any extraction instruction the daemon emitted so the next
    // chat turn's bootstrap section can ask the host LLM to act on it.
    // This closes the historical gap where Desktop captured events but
    // never produced knowledge_cards because the LLM never saw the
    // extraction prompt.
    const instruction = parsed?._extraction_instruction || parsed?.extraction_request;
    if (typeof instruction === 'string' && instruction.trim().length > 0) {
      writePendingExtraction(homeDir, {
        instruction: instruction,
        recorded_at: Date.now(),
        memory_id: parsed?.memory_id,
        session_id: parsed?.session_id,
      });
    }

    send('chat:status', {
      type: 'tool_update',
      toolId: memoryToolId,
      toolStatus: 'completed',
      detail: parsed?.filepath || 'Saved to Awareness memory',
    });
  }).catch((err) => {
    console.warn('[chat] Memory record failed:', err.message);
    try {
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
    } catch { /* window may be closed — safe to ignore */ }
  });
}

export function buildWebCompatibilityRetryPrompt(originalRequest: string, blockedResponse: string): string {
  const targetUrl = extractFirstHttpUrl(originalRequest);
  const urlHint = targetUrl ? `Target public URL: ${targetUrl}` : '';

  return `[Automatic compatibility retry]
Previous attempt was blocked because web_fetch/browser treated the resolved address as private/internal/special-use (common with VPN DNS hijack/split routing).

Retry this request without using web_fetch or browser.
- Use web_search for discovery when needed.
- For public URL retrieval, use exec-based HTTP commands.
- On Windows, prefer Invoke-WebRequest with -UseBasicParsing.
- On macOS/Linux, prefer curl -L.
- If the user requested download/save, verify file existence and size after writing.

${urlHint}
Original request:
${originalRequest}

Previous blocked response:
${blockedResponse}`;
}
