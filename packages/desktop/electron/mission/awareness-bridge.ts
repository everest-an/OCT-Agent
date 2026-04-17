/**
 * awareness-bridge · pulls past-experience context from the local Awareness
 * daemon and formats it for Planner / Worker prompts.
 *
 * Design intent (see 01-DESIGN.md §三·D5 + 06-RESEARCH.md §五·补·4):
 *   - Awareness memory plugin is already auto-registered inside OpenClaw with
 *     autoCapture=true, so we do NOT need to explicitly record step outputs
 *     here — the plugin grabs them.
 *   - We DO need to **recall** past experience before Planner and before each
 *     Worker step, so the agent can avoid repeating mistakes / respect prior
 *     decisions.
 *   - Must be fail-safe: daemon down / timeout / malformed result returns an
 *     empty string so the mission still runs, just without past-experience
 *     injection. Never throws.
 *
 * Single-parameter MCP (F-053 Phase 2):
 *   awareness_recall({ query: "...", token_budget?, limit? })
 *   → { content: [{ type:'text', text:'...' }], ... }
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AwarenessClient {
  /**
   * Call a tool on the local Awareness daemon. Should resolve with the raw
   * JSON-RPC result — or { error } on failure. Must not throw.
   */
  callTool(toolName: string, args: Record<string, any>): Promise<any>;
}

export interface RecallForPlannerInput {
  readonly goal: string;
  readonly agents?: readonly { readonly id: string; readonly role?: string }[];
  readonly limit?: number;
  readonly tokenBudget?: number;
}

export interface RecallForStepInput {
  readonly missionGoal: string;
  readonly stepTitle: string;
  readonly role?: string;
  readonly limit?: number;
  readonly tokenBudget?: number;
}

export interface AwarenessBridgeOptions {
  /** Max markdown chars per `recallFor*` return (defense against huge recall results). */
  readonly maxFormattedChars?: number;
  /** Ceiling on tokens injected per recall (passed to the daemon). */
  readonly defaultTokenBudget?: number;
  /** Ceiling on items fetched. */
  readonly defaultLimit?: number;
  /** If true, silently return '' on any failure. Default true. */
  readonly failSilent?: boolean;
  /** Logger for warnings (defaults to console.warn). */
  readonly logWarn?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Public class
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHARS = 3000;
const DEFAULT_TOKEN_BUDGET = 2000;
const DEFAULT_LIMIT = 5;

export class AwarenessBridge {
  private readonly client: AwarenessClient;
  private readonly opts: Required<Omit<AwarenessBridgeOptions, 'logWarn'>> & { logWarn: (m: string) => void };

  constructor(client: AwarenessClient, opts: AwarenessBridgeOptions = {}) {
    this.client = client;
    this.opts = {
      maxFormattedChars: opts.maxFormattedChars ?? DEFAULT_MAX_CHARS,
      defaultTokenBudget: opts.defaultTokenBudget ?? DEFAULT_TOKEN_BUDGET,
      defaultLimit: opts.defaultLimit ?? DEFAULT_LIMIT,
      failSilent: opts.failSilent ?? true,
      logWarn: opts.logWarn ?? ((m: string) => console.warn(`[awareness-bridge] ${m}`)),
    };
  }

  /**
   * Build a focused query for the Planner and recall. Returns an empty string
   * if recall fails or yields nothing.
   */
  async recallForPlanner(input: RecallForPlannerInput): Promise<string> {
    const roles = (input.agents || [])
      .map((a) => a.role || a.id)
      .filter((s) => s && s.length > 0)
      .slice(0, 5)
      .join(', ');
    const query = roles
      ? `planning a mission: ${input.goal}. Team roles: ${roles}`
      : `planning a mission: ${input.goal}`;
    return this.recallFormatted(query, {
      limit: input.limit ?? this.opts.defaultLimit,
      tokenBudget: input.tokenBudget ?? this.opts.defaultTokenBudget,
    });
  }

  async recallForStep(input: RecallForStepInput): Promise<string> {
    const rolePart = input.role ? ` (${input.role})` : '';
    const query = `${input.stepTitle}${rolePart} — context: ${input.missionGoal}`;
    return this.recallFormatted(query, {
      limit: input.limit ?? this.opts.defaultLimit,
      tokenBudget: input.tokenBudget ?? this.opts.defaultTokenBudget,
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async recallFormatted(
    query: string,
    params: { limit: number; tokenBudget: number },
  ): Promise<string> {
    const q = query.trim();
    if (q.length === 0) return '';

    let raw: any;
    try {
      raw = await this.client.callTool('awareness_recall', {
        query: q,
        limit: params.limit,
        token_budget: params.tokenBudget,
      });
    } catch (err) {
      return this.failure(`recall threw: ${errMsg(err)}`);
    }

    if (!raw || typeof raw !== 'object') {
      return this.failure(`recall returned non-object`);
    }
    if (raw.error) {
      return this.failure(`recall error: ${String(raw.error)}`);
    }

    const text = extractRecallText(raw);
    if (!text) return '';
    return truncate(text, this.opts.maxFormattedChars);
  }

  private failure(msg: string): string {
    if (this.opts.failSilent) {
      this.opts.logWarn(msg);
      return '';
    }
    throw new Error(msg);
  }
}

// ---------------------------------------------------------------------------
// Response parsing — defensive against multiple shapes the daemon might use
// ---------------------------------------------------------------------------

/**
 * Extract human-readable text from an awareness_recall result. Tries:
 *   a) MCP-style `result.content[].text`   (standard JSON-RPC tools/call)
 *   b) `result.text`                       (older plain shape)
 *   c) `result.cards[]`                    (structured cards array)
 *   d) `result.results[]`                  (cascade search)
 *
 * Always returns a trimmed markdown string, or '' if nothing usable.
 */
export function extractRecallText(raw: any): string {
  if (!raw) return '';

  // a) MCP content array
  const mcpContent = raw.result?.content ?? raw.content;
  if (Array.isArray(mcpContent)) {
    const joined = mcpContent
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n\n')
      .trim();
    if (joined) return joined;
  }

  // b) plain text
  if (typeof raw.text === 'string') return raw.text.trim();

  // c) cards array
  const cards = Array.isArray(raw.cards) ? raw.cards
    : (Array.isArray(raw.result?.cards) ? raw.result.cards : null);
  if (cards && cards.length > 0) {
    const formatted = cards
      .map((c: any) => formatCard(c))
      .filter((s: string) => s.length > 0)
      .join('\n\n');
    if (formatted) return formatted;
  }

  // d) generic results array with .summary / .title fields
  const results = Array.isArray(raw.results) ? raw.results
    : (Array.isArray(raw.result?.results) ? raw.result.results : null);
  if (results && results.length > 0) {
    const formatted = results
      .map((r: any) => formatCard(r))
      .filter((s: string) => s.length > 0)
      .join('\n\n');
    if (formatted) return formatted;
  }

  return '';
}

function formatCard(c: any): string {
  if (!c || typeof c !== 'object') return '';
  const title = typeof c.title === 'string' ? c.title.trim() : '';
  const summary = typeof c.summary === 'string' ? c.summary.trim()
    : (typeof c.text === 'string' ? c.text.trim() : '');
  if (!title && !summary) return '';
  if (title && summary) return `- **${title}**: ${summary}`;
  return `- ${title || summary}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n[… truncated ${text.length - maxChars} chars to fit recall budget …]`;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}

// ---------------------------------------------------------------------------
// Production factory (wraps electron/memory-client.ts callMcp)
// ---------------------------------------------------------------------------

/**
 * Build an `AwarenessClient` backed by the existing `callMcp` helper. Kept as
 * a thin factory so unit tests can drop in a mock implementation instead.
 *
 * Usage:
 *   import { callMcp } from '../memory-client';
 *   const bridge = new AwarenessBridge(createAwarenessClientFromCallMcp(callMcp));
 */
export function createAwarenessClientFromCallMcp(
  callMcp: (tool: string, args: Record<string, any>) => Promise<any>,
): AwarenessClient {
  return {
    async callTool(toolName, args) {
      return callMcp(toolName, args);
    },
  };
}
