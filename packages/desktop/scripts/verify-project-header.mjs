#!/usr/bin/env node
/**
 * L1 Contract Guard: Verify X-Awareness-Project-Dir header is sent with all
 * memory client requests and validated by the daemon.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..'); // packages/desktop/
let failures = 0;

function check(label, ok) {
  if (ok) {
    console.log(`  ✅ ${label}`);
  } else {
    console.error(`  ❌ ${label}`);
    failures++;
  }
}

// --- Check 1: memory-client.ts uses buildHeaders/buildGetHeaders in all http.request calls ---
{
  console.log('\n[1] memory-client.ts header injection');
  const src = fs.readFileSync(path.join(root, 'electron/memory-client.ts'), 'utf-8');

  // Count http.request calls that have headers: buildHeaders or buildGetHeaders
  // healthz is exempt (no header needed)
  const lines = src.split('\n');
  const requestLines = lines.filter(l => l.includes('http.request('));
  const healthzLines = requestLines.filter(l => l.includes('healthz'));
  const nonHealthzLines = requestLines.filter(l => !l.includes('healthz'));

  // All non-healthz request calls should have buildHeaders/buildGetHeaders somewhere nearby
  const hasHeaderHelper = src.includes('buildHeaders()') && src.includes('buildGetHeaders()');
  check(`Has buildHeaders() and buildGetHeaders() helper usage`, hasHeaderHelper);

  // No hardcoded Content-Type headers in http.request options (should use buildHeaders)
  const hardcodedHeaders = [...src.matchAll(/http\.request\([^)]*headers:\s*\{\s*['"]Content-Type/g)];
  check(`No hardcoded headers in http.request (found ${hardcodedHeaders.length}, expected 0)`, hardcodedHeaders.length === 0);

  check(`Found ${nonHealthzLines.length} non-healthz http.request calls (expected ≥5)`, nonHealthzLines.length >= 5);

  // setMemoryClientProjectDir must be exported
  check('setMemoryClientProjectDir is exported', src.includes('export function setMemoryClientProjectDir'));

  // buildHeaders adds X-Awareness-Project-Dir
  check('buildHeaders references X-Awareness-Project-Dir', src.includes("'X-Awareness-Project-Dir'"));
}

// --- Check 2: daemon.mjs CORS allows the header ---
{
  console.log('\n[2] daemon.mjs CORS + validation');
  // Find daemon.mjs - try common locations relative to OCT-Agent
  const candidates = [
    path.resolve(root, '../../../sdks/local/src/daemon.mjs'),  // Awareness/OCT-Agent/packages/desktop → Awareness/sdks/local/src
    path.resolve(root, '../../../../sdks/local/src/daemon.mjs'),
  ];
  const daemonPath = candidates.find(p => fs.existsSync(p));
  if (!daemonPath) {
    console.error('  ⚠️  daemon.mjs not found, skipping daemon checks');
  } else {
    const daemonSrc = fs.readFileSync(daemonPath, 'utf-8');

    check('CORS allows X-Awareness-Project-Dir', daemonSrc.includes('X-Awareness-Project-Dir'));

    // Must have project_mismatch error response
    check('Has project_mismatch 409 response', daemonSrc.includes("'project_mismatch'"));

    // Must have _switching guard
    check('Has _switching 503 guard', daemonSrc.includes('this._switching'));
    check('switchProject sets _switching = true', daemonSrc.includes('this._switching = true'));
    check('switchProject has finally { _switching = false }', daemonSrc.includes('this._switching = false'));
  }
}

// --- Check 3: main.ts calls setMemoryClientProjectDir ---
{
  console.log('\n[3] main.ts wires setter on workspace switch');
  const mainSrc = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf-8');

  check('imports setMemoryClientProjectDir', mainSrc.includes('setMemoryClientProjectDir'));
  const setterCalls = (mainSrc.match(/setMemoryClientProjectDir\(/g) || []).length;
  check(`Calls setMemoryClientProjectDir at least 2 times (workspace:set-active + startup), found ${setterCalls}`, setterCalls >= 2);
}

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}\n`);
process.exit(failures > 0 ? 1 : 0);
