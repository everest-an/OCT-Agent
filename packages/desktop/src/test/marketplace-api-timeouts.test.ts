/**
 * F-063 · L1-contract-level guard for marketplace API client timeouts.
 *
 * Background: 0.4.4 shipped with a 12s timeout on every marketplace call,
 * including POST /submissions. Real prod latency for submit is 10-25s
 * (LLM-backed validation + DB write + rate-limit check), so users saw
 * "timeout after 12000ms" mid-submission with no way to recover.
 *
 * This test reads the api.ts source and asserts the submit-specific
 * timeout constant stays comfortably above the worst-case prod latency.
 * It's intentionally a static-grep test rather than a network round-trip
 * because we don't want a flaky fake-server; we just want to prevent
 * "someone accidentally rolled the timeout back to 12000".
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const apiSource = readFileSync(
  resolve(dirname(__filename), '../../electron/agent-marketplace/api.ts'),
  'utf8'
);

describe('MarketplaceClient · submit timeout contract', () => {
  it('declares a SUBMIT_TIMEOUT_MS constant separate from the default', () => {
    expect(apiSource).toMatch(/const\s+SUBMIT_TIMEOUT_MS\s*=/);
  });

  it('SUBMIT_TIMEOUT_MS is at least 30s (prod submit can take 10-25s)', () => {
    const match = apiSource.match(/const\s+SUBMIT_TIMEOUT_MS\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    const value = parseInt(match![1], 10);
    // 30s floor — anything less leaves zero margin for a slow prod day.
    expect(value).toBeGreaterThanOrEqual(30000);
  });

  it('submit() passes SUBMIT_TIMEOUT_MS to postJson (not this.timeoutMs)', () => {
    // Extract the submit method body. If it accidentally reverts to
    // this.timeoutMs (the GET default) the timeout regresses.
    const submitBlock = apiSource.match(
      /submit\(payload:\s*\{[\s\S]*?\}\):\s*Promise[\s\S]*?\n  \}/
    );
    expect(submitBlock).not.toBeNull();
    expect(submitBlock![0]).toContain('SUBMIT_TIMEOUT_MS');
    expect(submitBlock![0]).not.toMatch(/this\.timeoutMs/);
  });
});
