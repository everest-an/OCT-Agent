import type { spawn } from 'child_process';

export type ChatSendOptions = {
  thinkingLevel?: string;
  reasoningDisplay?: string;
  model?: string;
  files?: string[];
  workspacePath?: string;
  agentId?: string;
};

export type MemoryCapturePolicy = {
  autoCapture: boolean;
  blockedSources: string[];
};

export const CHAT_TIMEOUT_MS = 120000;
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
};
