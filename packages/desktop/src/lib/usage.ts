/**
 * Lightweight local usage tracker — estimates token usage and cost from message lengths.
 * Stored in localStorage. No backend IPC needed.
 */

const USAGE_KEY = 'awareness-claw-usage';

export interface UsageEntry {
  timestamp: number;
  provider: string;
  model: string;
  inputChars: number;
  outputChars: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

export interface UsageStats {
  totalMessages: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  todayMessages: number;
  todayInputTokens: number;
  todayOutputTokens: number;
  byModel: Record<string, { messages: number; inputTokens: number; outputTokens: number }>;
}

/** Rough token estimation: ~4 chars/token for English, ~1.5 for CJK.
 *  We use ~3 as a blended average. */
function estimateTokens(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uF900-\uFAFF]/g) || []).length;
  const otherChars = text.length - cjkChars;
  return Math.ceil(cjkChars / 1.5 + otherChars / 4);
}

function loadEntries(): UsageEntry[] {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveEntries(entries: UsageEntry[]) {
  // Keep last 30 days of data (~5000 entries max)
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const trimmed = entries.filter(e => e.timestamp > cutoff).slice(-5000);
  localStorage.setItem(USAGE_KEY, JSON.stringify(trimmed));
}

export function trackUsage(provider: string, model: string, inputText: string, outputText: string) {
  const entries = loadEntries();
  entries.push({
    timestamp: Date.now(),
    provider,
    model,
    inputChars: inputText.length,
    outputChars: outputText.length,
    estimatedInputTokens: estimateTokens(inputText),
    estimatedOutputTokens: estimateTokens(outputText),
  });
  saveEntries(entries);
}

export function getUsageStats(): UsageStats {
  const entries = loadEntries();
  const now = Date.now();
  const todayStart = new Date().setHours(0, 0, 0, 0);

  const stats: UsageStats = {
    totalMessages: entries.length,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    todayMessages: 0,
    todayInputTokens: 0,
    todayOutputTokens: 0,
    byModel: {},
  };

  for (const e of entries) {
    stats.totalInputTokens += e.estimatedInputTokens;
    stats.totalOutputTokens += e.estimatedOutputTokens;

    if (e.timestamp >= todayStart) {
      stats.todayMessages++;
      stats.todayInputTokens += e.estimatedInputTokens;
      stats.todayOutputTokens += e.estimatedOutputTokens;
    }

    const key = `${e.provider}/${e.model}`;
    if (!stats.byModel[key]) stats.byModel[key] = { messages: 0, inputTokens: 0, outputTokens: 0 };
    stats.byModel[key].messages++;
    stats.byModel[key].inputTokens += e.estimatedInputTokens;
    stats.byModel[key].outputTokens += e.estimatedOutputTokens;
  }

  return stats;
}

export function clearUsage() {
  localStorage.removeItem(USAGE_KEY);
}
