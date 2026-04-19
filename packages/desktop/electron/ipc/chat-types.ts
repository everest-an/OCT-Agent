import type { spawn } from 'child_process';

export type ChatSendOptions = {
  thinkingLevel?: string;
  reasoningDisplay?: string;
  model?: string;
  files?: string[];
  workspacePath?: string;
  agentId?: string;
  forceLocal?: boolean;
};

export type MemoryCapturePolicy = {
  autoCapture: boolean;
  blockedSources: string[];
};

export const CHAT_TIMEOUT_MS = 120000;
export const CHAT_IDLE_TIMEOUT_MS = 180000;
export const MCP_MEMORY_BOOTSTRAP_TIMEOUT_MS = 2500;
export const MEMORY_BOOTSTRAP_MAX_CHARS = 4000;

/**
 * Mutable module-level state shared across chat handler modules.
 * Kept as an object so all modules reference the same values.
 */
export const chatState = {
  activeChatChild: null as ReturnType<typeof spawn> | null,
  awarenessInitCompatibilityMode: false,
  lastAwarenessInitCompatibilityError: '',
  // Throttle gateway auth-repair attempts so repeated auth-gated requests do not loop.
  lastGatewayAuthRepairAt: 0 as number,
  // Timestamp of the most recent Gateway 1006 self-heal restart. Throttle to one
  // restart per ~60 s so a series of failed messages doesn't loop-restart Gateway
  // and create more instability than the original problem.
  lastGateway1006RestartAt: 0 as number,
};
