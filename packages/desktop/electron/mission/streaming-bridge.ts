/**
 * streaming-bridge · thin adapter between gateway-ws.ts and mission-runner.ts.
 *
 * MissionRunner depends on an abstract `GatewayAdapter` interface so it can be
 * unit-tested without a real WebSocket. In production this bridge wraps the
 * existing GatewayClient (electron/gateway-ws.ts) into that interface.
 *
 * Responsibilities:
 *   1. `sendChat({agentId, prompt, sessionKey?})` → forwards to ws.chatSend
 *      (caller decides the session-key routing; for worker spawns the IPC
 *      layer will have already issued `/subagents spawn` earlier).
 *   2. `abort(sessionKey, runId?)` → ws.chatAbort
 *   3. `subscribe(sessionKey, handler)` → attaches an `event:chat` listener
 *      scoped to that session key, normalizes the payload into the
 *      MissionRunner's `GatewayChatEvent` shape, returns an unsubscribe fn.
 *
 * Deliberately narrow — no reconnect logic, no spawn-string parsing, no IPC
 * emit. Those live in register-mission-handlers (future) / gateway-ws.
 *
 * Reference:
 *   docs/features/team-tasks/01-DESIGN.md §一·补 "GatewayAdapter"
 *   docs/features/team-tasks/03-ACCEPTANCE.md L3.9-L3.13 (streaming failures)
 */

import type { GatewayAdapter, GatewayChatEvent } from './mission-runner';

// ---------------------------------------------------------------------------
// Minimal surface we need from GatewayClient — lets tests pass a tiny mock
// without importing the Electron-only file.
// ---------------------------------------------------------------------------

export interface MinimalGatewayWs {
  chatSend(sessionKey: string, text: string, options?: {
    thinking?: string;
    verbose?: string;
    reasoning?: string;
    attachments?: any[];
  }): Promise<any>;
  chatAbort(sessionKey: string, runId?: string): Promise<void>;
  on(event: string, handler: (payload: any) => void): unknown;
  off(event: string, handler: (payload: any) => void): unknown;
}

export interface CreateGatewayAdapterOptions {
  /**
   * How to derive a fresh session key when the caller doesn't supply one.
   * Default: `agent:<agentId>:main` (so planner-stage chats route to the
   * main agent). For worker sub-agents the caller must pass the sub-agent
   * session key explicitly (obtained from `/subagents spawn`'s parse).
   */
  readonly deriveSessionKey?: (agentId: string) => string;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createGatewayAdapter(
  ws: MinimalGatewayWs,
  opts: CreateGatewayAdapterOptions = {},
): GatewayAdapter {
  const derive = opts.deriveSessionKey ?? ((agentId: string) => `agent:${agentId}:main`);

  return {
    async sendChat({ agentId, prompt, sessionKey, model, thinking }) {
      const key = sessionKey || derive(agentId);
      // Note: Gateway's chat.send is additionalProperties:false — we cannot
      // pass `model` or `agentId` through this RPC. Model selection is a
      // per-agent config in openclaw.json; caller arranges that upstream.
      // (Planner-prompt already encodes the desired model per-step in the
      // worker prompt's "<OutputSchema>" example — the actual binding
      // happens when register-mission-handlers issues sessions_spawn.)
      void model; // intentionally unused — see comment above
      const result = await ws.chatSend(key, prompt, {
        thinking: thinking || 'off',
      });
      const runId: string = (result && typeof result.runId === 'string') ? result.runId : '';
      return { sessionKey: key, runId };
    },

    async abort(sessionKey, runId) {
      await ws.chatAbort(sessionKey, runId);
    },

    subscribe(sessionKey, handler) {
      const onChat = (payload: any) => {
        if (!payload || payload.sessionKey !== sessionKey) return;
        const event = normalizeChatPayload(payload);
        if (event) handler(event);
      };
      ws.on('event:chat', onChat);
      return () => {
        ws.off('event:chat', onChat);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Payload normalization
// ---------------------------------------------------------------------------

/**
 * Convert a raw `event:chat` payload from Gateway into MissionRunner's
 * `GatewayChatEvent`. Returns null if the payload is a shape we don't care
 * about (e.g. a progress heartbeat with no content).
 *
 * Gateway payload shapes (verified in register-workflow-handlers.ts comments):
 *   delta   : { state:'delta',   sessionKey, runId, delta:"..."           }
 *             { state:'delta',   sessionKey, runId, delta:{content:"..."} }
 *             { state:'delta',   sessionKey, runId, message:{content:[…]} }
 *   final   : { state:'final',   sessionKey, runId, message:{content:[…]} }
 *             { state:'final',   sessionKey, runId, text:"..." }
 *   error   : { state:'error',   sessionKey, runId, errorMessage:"..." }
 *   aborted : { state:'aborted', sessionKey, runId, errorMessage?:"..." }
 */
export function normalizeChatPayload(payload: any): GatewayChatEvent | null {
  const state: string = payload?.state || '';
  if (state === 'delta') {
    const chunk = extractDeltaText(payload);
    if (!chunk) return null;
    return { state: 'delta', chunk };
  }
  if (state === 'final') {
    return { state: 'final', text: extractFinalText(payload) };
  }
  if (state === 'error') {
    return {
      state: 'error',
      errorMessage: typeof payload?.errorMessage === 'string' ? payload.errorMessage : undefined,
    };
  }
  if (state === 'aborted') {
    return {
      state: 'aborted',
      errorMessage: typeof payload?.errorMessage === 'string' ? payload.errorMessage : undefined,
    };
  }
  return null;
}

export function extractDeltaText(payload: any): string {
  if (!payload) return '';
  if (typeof payload.delta === 'string') return payload.delta;
  if (payload.delta && typeof payload.delta === 'object') {
    if (typeof payload.delta.content === 'string') return payload.delta.content;
    if (typeof payload.delta.text === 'string') return payload.delta.text;
  }
  const content = payload?.message?.content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('');
  }
  if (typeof content === 'string') return content;
  return '';
}

export function extractFinalText(payload: any): string {
  if (typeof payload?.text === 'string' && payload.text.length > 0) return payload.text;
  const content = payload?.message?.content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('');
  }
  if (typeof content === 'string') return content;
  return '';
}
