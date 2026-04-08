// Doctor check: detect stale plugin overrides in ~/.openclaw/extensions/ that shadow
// bundled plugins shipped by the current OpenClaw npm package.
//
// Background: older versions of OpenClaw did not ship certain channel plugins (whatsapp,
// signal, telegram...) as bundled entries, so our installer used `openclaw plugins install`
// to drop them into ~/.openclaw/extensions/<id>/. Newer OpenClaw versions now ship those
// same plugins as bundled — but OpenClaw's plugin discovery rule (load.paths > workspace >
// global > bundled) means our old global copies keep overriding the bundled ones.
//
// This produces repeated "duplicate plugin id detected; bundled plugin will be overridden
// by global plugin" warnings on every `openclaw gateway restart`. Users don't know what
// to do with them. This check finds such stale overrides and offers a one-click cleanup.

import fs from 'fs';
import path from 'path';
import type { CheckResult, FixResult, Ctx } from './types';

interface StaleOverride {
  id: string;
  globalPath: string;
  bundledPath: string;
  globalVersion: string | null;
  bundledVersion: string | null;
}

/** Read a plugin's `package.json` version, returning null on any failure. */
function readPackageVersion(pluginDir: string): string | null {
  try {
    const pkgPath = path.join(pluginDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Resolve the bundled extensions directory for the currently installed OpenClaw package. */
function resolveBundledExtensionsDir(ctx: Ctx): string | null {
  const packageDir = ctx.openclawPackageDir;
  if (!packageDir) return null;
  const candidate = path.join(packageDir, 'dist', 'extensions');
  return fs.existsSync(candidate) ? candidate : null;
}

/** List subdirectories of a directory, returning [] on any failure. */
function listSubdirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.endsWith('.disabled'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Scan ~/.openclaw/extensions/<id>/ for entries that also exist in the bundled
 * extensions dir of the currently installed OpenClaw package.
 *
 * Returns one entry per stale override. Protected plugin ids (owned by us or
 * explicitly not bundled) are skipped.
 */
export function detectStalePluginOverrides(ctx: Ctx): StaleOverride[] {
  // Plugins we ship / manage — never flag these as stale even if OpenClaw ever bundles them.
  const PROTECTED_IDS = new Set([
    'openclaw-memory',
    'awareness-memory',
    'openclaw-weixin',
  ]);

  const globalExtensionsDir = path.join(ctx.deps.homedir, '.openclaw', 'extensions');
  if (!fs.existsSync(globalExtensionsDir)) return [];

  const bundledDir = resolveBundledExtensionsDir(ctx);
  if (!bundledDir) return [];

  const stale: StaleOverride[] = [];
  for (const id of listSubdirs(globalExtensionsDir)) {
    if (PROTECTED_IDS.has(id)) continue;

    const bundledPath = path.join(bundledDir, id);
    if (!fs.existsSync(bundledPath)) continue;

    const globalPath = path.join(globalExtensionsDir, id);
    stale.push({
      id,
      globalPath,
      bundledPath,
      globalVersion: readPackageVersion(globalPath),
      bundledVersion: readPackageVersion(bundledPath),
    });
  }
  return stale;
}

export async function checkStalePluginOverrides(ctx: Ctx): Promise<CheckResult> {
  const stale = detectStalePluginOverrides(ctx);
  if (stale.length === 0) {
    return {
      id: 'stale-plugin-overrides',
      label: 'Plugin overrides',
      status: 'pass',
      message: 'No stale plugin overrides',
      fixable: 'none',
    };
  }

  const ids = stale.map((s) => s.id).join(', ');
  const detailLines = stale.map((s) => {
    const versions = [
      s.globalVersion ? `global ${s.globalVersion}` : 'global',
      s.bundledVersion ? `bundled ${s.bundledVersion}` : 'bundled',
    ].join(' vs ');
    return `- ${s.id} (${versions})`;
  });

  return {
    id: 'stale-plugin-overrides',
    label: 'Plugin overrides',
    status: 'warn',
    message: `${stale.length} stale plugin override${stale.length > 1 ? 's' : ''} shadowing bundled plugins: ${ids}`,
    detail: detailLines.join('\n'),
    fixable: 'auto',
    fixDescription: 'Remove the stale override directories so OpenClaw uses the bundled versions',
  };
}

export async function fixRemoveStalePluginOverrides(ctx: Ctx): Promise<FixResult> {
  const stale = detectStalePluginOverrides(ctx);
  if (stale.length === 0) {
    return { id: 'stale-plugin-overrides', success: true, message: 'Nothing to clean' };
  }

  const removed: string[] = [];
  const failed: string[] = [];
  for (const entry of stale) {
    try {
      // Safety: the path must be inside ~/.openclaw/extensions/ to prevent any surprises.
      const expectedPrefix = path.join(ctx.deps.homedir, '.openclaw', 'extensions') + path.sep;
      if (!entry.globalPath.startsWith(expectedPrefix)) {
        failed.push(entry.id);
        continue;
      }
      fs.rmSync(entry.globalPath, { recursive: true, force: true });
      removed.push(entry.id);
    } catch {
      failed.push(entry.id);
    }
  }

  if (failed.length > 0 && removed.length === 0) {
    return {
      id: 'stale-plugin-overrides',
      success: false,
      message: `Failed to remove: ${failed.join(', ')}`,
    };
  }

  // Auto-restart Gateway so the change takes effect immediately. Best-effort — any
  // failure here is non-fatal; the user can restart manually if this silently fails.
  let restartedGateway = false;
  try {
    await ctx.deps.shellRun('openclaw gateway restart 2>&1', 30000);
    restartedGateway = true;
  } catch {
    /* best-effort */
  }

  const suffix = restartedGateway ? ' (Gateway restarted)' : ' — restart Gateway to take effect';
  const message = failed.length > 0
    ? `Removed ${removed.join(', ')} (failed: ${failed.join(', ')})${suffix}`
    : `Removed ${removed.join(', ')}${suffix}`;
  return { id: 'stale-plugin-overrides', success: true, message };
}
