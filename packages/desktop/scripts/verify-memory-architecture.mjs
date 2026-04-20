#!/usr/bin/env node
/**
 * L1 Contract Guard: memory architecture invariants for the Awareness × OpenClaw
 * dual-memory setup.
 *
 * Locks in the "append, don't replace" model so a future refactor can't silently
 * break either half of the architecture:
 *
 *   - Awareness tools (awareness_init / recall / record / lookup) must be ADDED to
 *     tools.alsoAllow, never used to REPLACE the underlying OpenClaw tool profile.
 *   - The openclaw-memory plugin must be force-enabled with localUrl pointing at
 *     the local daemon (127.0.0.1:37800).
 *   - The local daemon must be launched via the `@awareness-sdk/local` package
 *     (not OpenClaw's own memory backend), and must have a watchdog + project-dir
 *     isolation header.
 *   - Both workspace hooks (awareness-memory-backup, awareness-workspace-inject)
 *     must be installable.
 *
 * Failure exit code 1, prints file:line for every violation.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const electronDir = resolve(__dirname, '../electron');

let errors = 0;

function fail(file, msg, line) {
  errors++;
  const loc = line ? `${file}:${line}` : file;
  console.error(`[L1 FAIL] ${loc}  ${msg}`);
}

function readOrFail(relPath) {
  const full = resolve(electronDir, relPath);
  if (!existsSync(full)) {
    fail(relPath, 'file missing');
    return null;
  }
  return { path: relPath, src: readFileSync(full, 'utf-8') };
}

function lineOf(src, needle) {
  const idx = src.indexOf(needle);
  if (idx === -1) return null;
  return src.slice(0, idx).split('\n').length;
}

// ---------- Check 1: desktop-openclaw-config.ts ----------
const cfg = readOrFail('desktop-openclaw-config.ts');
if (cfg) {
  const required = [
    'awareness_init',
    'awareness_recall',
    'awareness_lookup',
    'awareness_record',
    'awareness_get_agent_prompt',
  ];
  const allowMatch = cfg.src.match(/DESKTOP_DEFAULT_ALLOWED_TOOLS\s*=\s*\[([^\]]+)\]/);
  if (!allowMatch) {
    fail(cfg.path, 'DESKTOP_DEFAULT_ALLOWED_TOOLS constant not found');
  } else {
    for (const tool of required) {
      if (!allowMatch[1].includes(`'${tool}'`)) {
        fail(cfg.path, `DESKTOP_DEFAULT_ALLOWED_TOOLS missing "${tool}"`, lineOf(cfg.src, 'DESKTOP_DEFAULT_ALLOWED_TOOLS'));
      }
    }
  }

  // Must use Set-add, not reassign (proves "append, not replace")
  if (!/existingAllow\.add\(tool\)/.test(cfg.src)) {
    fail(cfg.path, 'ensureDesktopDefaultToolPermissions must append via Set.add (not replace alsoAllow)');
  }
  if (/config\.tools\.alsoAllow\s*=\s*DESKTOP_DEFAULT_ALLOWED_TOOLS/.test(cfg.src)) {
    fail(cfg.path, 'DESKTOP_DEFAULT_ALLOWED_TOOLS must not be assigned directly to alsoAllow (would drop user tools)');
  }

  // openclaw-memory plugin must be force-enabled with correct local daemon URL
  if (!cfg.src.includes(`config.plugins.entries['openclaw-memory']`)) {
    fail(cfg.path, 'openclaw-memory plugin entry not applied');
  }
  if (!/localUrl:\s*['"]http:\/\/127\.0\.0\.1:37800['"]/.test(cfg.src)) {
    fail(cfg.path, 'openclaw-memory config.localUrl must be http://127.0.0.1:37800');
  }
  if (!/baseUrl:\s*['"]https:\/\/awareness\.market\/api\/v1['"]/.test(cfg.src)) {
    fail(cfg.path, 'openclaw-memory config.baseUrl must be https://awareness.market/api/v1');
  }
  if (!/DESKTOP_REQUIRED_PLUGINS\s*=\s*\[[^\]]*'openclaw-memory'/.test(cfg.src)) {
    fail(cfg.path, 'DESKTOP_REQUIRED_PLUGINS must include "openclaw-memory"');
  }
}

// ---------- Check 2: memory-client.ts ----------
const client = readOrFail('memory-client.ts');
if (client) {
  if (!client.src.includes(`'http://127.0.0.1:37800/mcp'`)) {
    fail(client.path, 'callMcp must target http://127.0.0.1:37800/mcp');
  }
  // Project-dir isolation header is the mechanism that keeps workspaces separate.
  if (!/X-Awareness-Project-Dir/.test(client.src)) {
    fail(client.path, 'project-dir isolation header (X-Awareness-Project-Dir) missing');
  }
  if (!/applyProjectDirHeader\(/.test(client.src)) {
    fail(client.path, 'applyProjectDirHeader helper missing — workspaces will bleed into each other');
  }
}

// ---------- Check 3: local-daemon.ts ----------
const daemon = readOrFail('local-daemon.ts');
if (daemon) {
  if (!/@awareness-sdk\/local/.test(daemon.src)) {
    fail(daemon.path, 'local daemon must be launched via @awareness-sdk/local');
  }
  if (!/--port\s+37800|port[=\s]+37800|'37800'/.test(daemon.src)) {
    fail(daemon.path, 'local daemon must run on port 37800 (matches memory-client)');
  }
}

// ---------- Check 4: daemon watchdog exists (protects against crashes) ----------
if (!existsSync(resolve(electronDir, 'daemon-watchdog.ts'))) {
  fail('daemon-watchdog.ts', 'daemon watchdog module missing — a daemon crash will silently kill memory');
}

// ---------- Check 5: workspace hooks deployed ----------
const wsHook = readOrFail('install-workspace-hook.ts');
if (wsHook) {
  if (!/awareness-workspace-inject/.test(wsHook.src)) {
    fail(wsHook.path, 'awareness-workspace-inject hook name not referenced');
  }
  if (!/before_prompt_build|hooks\/awareness-workspace-inject/.test(wsHook.src)) {
    fail(wsHook.path, 'workspace-inject hook must be installed into ~/.openclaw/hooks/');
  }
}
const intHook = readOrFail('internal-hook.ts');
if (intHook) {
  if (!/awareness-memory-backup/.test(intHook.src)) {
    fail(intHook.path, 'awareness-memory-backup hook name not referenced');
  }
}

// ---------- Check 6: coding profile preserved (we don't disable OpenClaw native memory) ----------
if (cfg) {
  // We explicitly keep tools.profile = 'coding' so OpenClaw native tools stay enabled.
  // This check fails if someone tries to switch to a restricted profile in a way
  // that would disable OpenClaw's native memory_search / memory_get.
  if (/profile:\s*['"](?!coding)([a-z_-]+)['"]/i.test(cfg.src)) {
    const m = cfg.src.match(/profile:\s*['"]((?!coding)[a-z_-]+)['"]/i);
    fail(cfg.path, `tools.profile changed to "${m[1]}" — this disables OpenClaw native memory; use 'coding' or add an explicit ADR`);
  }
}

// ---------- Report ----------
if (errors === 0) {
  console.log('[L1 OK] memory-architecture invariants hold');
  console.log('  - awareness_* tools APPENDED to alsoAllow (not replacing)');
  console.log('  - openclaw-memory plugin force-enabled with localUrl=127.0.0.1:37800');
  console.log('  - local daemon via @awareness-sdk/local with watchdog');
  console.log('  - project-dir isolation header in memory-client');
  console.log('  - both workspace hooks (backup + inject) referenced');
  console.log('  - tools.profile=coding preserved (OpenClaw native memory stays on)');
  process.exit(0);
}

console.error(`\n[L1 FAIL] ${errors} memory-architecture violation(s)`);
process.exit(1);
