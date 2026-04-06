// Doctor context — builds and caches the shared Ctx object used by all checks.

import fs from 'fs';
import path from 'path';
import type { Ctx, DoctorDeps } from './types';
import { readJsonFileWithBom } from '../json-file';

// --- Context-local helpers (only used by buildContext) ---

function pickFirstCommandPath(output: string | null): string | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines[0] || null;
}

function parseCommandPaths(output: string | null): string[] {
  if (!output) return [];
  return Array.from(new Set(output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)));
}

function normalizeWindowsCommandCandidates(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const candidate of paths) {
    const parsed = path.parse(candidate);
    const normalizedKey = path.join(parsed.dir.toLowerCase(), parsed.name.toLowerCase());
    if (seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    normalized.push(candidate);
  }

  return normalized;
}

// --- Context cache ---

let _ctxCache: { ctx: Ctx; ts: number } | null = null;
const CTX_CACHE_TTL_MS = 30_000; // 30s — fresh enough for startup, invalidated by fixes

export function invalidateCtxCache() { _ctxCache = null; }

export async function buildContext(deps: DoctorDeps): Promise<Ctx> {
  // Return cached context if fresh
  if (_ctxCache && Date.now() - _ctxCache.ts < CTX_CACHE_TTL_MS) {
    // Always re-read config (cheap, local file) but keep shell results cached
    const configPath = path.join(deps.homedir, '.openclaw', 'openclaw.json');
    let config: any = null;
    try { config = readJsonFileWithBom(configPath); } catch {}
    return { ..._ctxCache.ctx, config, deps };
  }

  const configPath = path.join(deps.homedir, '.openclaw', 'openclaw.json');
  let config: any = null;
  try { config = readJsonFileWithBom(configPath); } catch {}

  const findCommand = deps.platform === 'win32' ? 'where' : 'which -a';

  // Run all independent shell lookups in parallel
  const [nodeLookup, openclawLookup, npmRoot, npmPrefix] = await Promise.all([
    deps.shellExec(`${findCommand} node`, 3000),
    deps.shellExec(`${findCommand} openclaw`, 3000),
    deps.shellExec('npm root -g', 5000),
    deps.shellExec('npm config get prefix', 5000),
  ]);

  const nodePath = pickFirstCommandPath(nodeLookup);
  // node --version is fast and depends on nodePath, run separately
  const nodeVersion = nodePath ? await deps.shellExec('node --version', 3000) : null;

  const openclawCandidatesRaw = parseCommandPaths(openclawLookup);
  const openclawCandidates = deps.platform === 'win32'
    ? normalizeWindowsCommandCandidates(openclawCandidatesRaw)
    : openclawCandidatesRaw;
  const openclawPath = openclawCandidates[0] || null;
  const openclawPackageDir = npmRoot
    ? path.join(npmRoot.trim(), 'openclaw')
    : null;
  const hasOpenClawPackage = !!openclawPackageDir && fs.existsSync(path.join(openclawPackageDir, 'package.json'));

  // Fast path: read openclaw version from package.json directly (avoids 8-15s CLI
  // plugin preload that openclaw --version triggers on every invocation).
  // Falls back to CLI only when package.json is unavailable.
  let openclawVersion: string | null = null;
  if (hasOpenClawPackage) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(openclawPackageDir!, 'package.json'), 'utf8'));
      if (pkg?.version) openclawVersion = `OpenClaw ${pkg.version}`;
    } catch {}
  }
  if (!openclawVersion && openclawPath) {
    openclawVersion = await deps.shellExec('openclaw --version', 8000);
  }

  const ctx: Ctx = {
    nodeVersion: nodeVersion?.trim() || null,
    nodePath: nodePath?.trim() || null,
    openclawVersion: openclawVersion?.trim() || null,
    openclawPath: openclawPath?.trim() || null,
    openclawPackageDir: hasOpenClawPackage ? openclawPackageDir : null,
    openclawCandidates,
    npmPrefix: npmPrefix?.trim() || null,
    configPath, config, deps,
  };

  _ctxCache = { ctx, ts: Date.now() };
  return ctx;
}
