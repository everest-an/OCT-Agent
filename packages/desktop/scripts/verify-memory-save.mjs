#!/usr/bin/env node
/**
 * L1 Contract Guard: verify that every successful CLI fallback return path
 * in register-chat-handlers.ts calls saveMemoryForCliResult() before returning.
 *
 * Rules:
 * - Every `return withWorkspaceFallbackMeta(cliResult)` or similar CLI result
 *   must be preceded by `saveMemoryForCliResult(...)` within 3 lines.
 * - The Gateway path must call `fireAndForgetMemorySave(...)`.
 * - Error returns (success: false) are exempt.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const filePath = resolve(__dirname, '../electron/ipc/register-chat-handlers.ts');
const src = readFileSync(filePath, 'utf-8');
const lines = src.split('\n');

let errors = 0;

// Check 1: Every `return withWorkspaceFallbackMeta(cliResult)` or CLI-named result
// must have saveMemoryForCliResult within 3 preceding lines, unless it's an error return.
const cliReturnPattern = /return\s+withWorkspaceFallbackMeta\((cli\w*|retryResult)\)/;
const errorReturnPattern = /success:\s*false|error:|awaitingApproval/;
const memorySavePattern = /saveMemoryForCliResult\(/;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!cliReturnPattern.test(line)) continue;

  // Check if this is inside a block that's clearly an error return
  const context5 = lines.slice(Math.max(0, i - 5), i + 1).join('\n');
  if (errorReturnPattern.test(context5) && /success:\s*false/.test(context5)) continue;

  // Check preceding 3 lines for saveMemoryForCliResult
  const preceding = lines.slice(Math.max(0, i - 3), i).join('\n');
  if (!memorySavePattern.test(preceding)) {
    errors++;
    console.error(`[L1 FAIL] Line ${i + 1}: CLI fallback return missing saveMemoryForCliResult()`);
    console.error(`  ${line.trim()}`);
  }
}

// Check 2: Gateway path must use fireAndForgetMemorySave
if (!src.includes('fireAndForgetMemorySave(')) {
  errors++;
  console.error('[L1 FAIL] fireAndForgetMemorySave() not found in register-chat-handlers.ts');
}

// Check 3: No inline awareness_record calls should remain (all should go through fireAndForgetMemorySave)
const inlineRecordCalls = lines.filter((l, i) =>
  l.includes("callMcpStrict('awareness_record'") && !l.includes('//'));
if (inlineRecordCalls.length > 0) {
  errors++;
  console.error(`[L1 FAIL] Found ${inlineRecordCalls.length} inline awareness_record call(s) — should use fireAndForgetMemorySave()`);
  inlineRecordCalls.forEach(l => console.error(`  ${l.trim()}`));
}

if (errors === 0) {
  console.log('[L1 PASS] All CLI fallback return paths have memory save coverage');
  console.log('[L1 PASS] Gateway path uses fireAndForgetMemorySave()');
  console.log('[L1 PASS] No inline awareness_record calls found');
} else {
  process.exit(1);
}
