import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseJsonShellOutput } from '../openclaw-shell-output';

const INSPECT_TIMEOUT_MS = 12000;

// ---------------------------------------------------------------------------
// Telegram runtime-deps fix (OpenClaw packaging bug workaround)
// ---------------------------------------------------------------------------
// OpenClaw bundles telegram's runtime deps (grammy, @grammyjs, …) inside
//   dist/extensions/telegram/node_modules/
// But the dist-level chunk files (sticker-cache-*.js, monitor-*.js, …) do
//   import "grammy" — Node resolution from dist/ goes UP to the package's
//   own node_modules/ and never looks SIDEWAYS into extensions/telegram/.
//
// Fix: copy the missing deps into <openclaw>/node_modules/ once so the
// standard resolution chain finds them.  Idempotent (no-op when already done).
// ---------------------------------------------------------------------------
function findOpenClawPackageDirQuick(): string | null {
  const home = os.homedir();
  const candidates: string[] = [];

  // Managed runtime (AwarenessClaw bundled install)
  candidates.push(
    path.join(home, '.awareness-claw', 'openclaw-runtime', 'node_modules', 'openclaw'),
    path.join(home, '.awareness-claw', 'openclaw-runtime', 'lib', 'node_modules', 'openclaw'),
  );

  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || '';
    const localappdata = process.env.LOCALAPPDATA || '';
    if (appdata) candidates.push(path.join(appdata, 'npm', 'node_modules', 'openclaw'));
    if (localappdata) {
      candidates.push(path.join(localappdata, 'pnpm', 'global', 'node_modules', 'openclaw'));
    }
  } else {
    candidates.push(
      path.join(home, '.npm-global', 'lib', 'node_modules', 'openclaw'),
      '/usr/local/lib/node_modules/openclaw',
      '/opt/homebrew/lib/node_modules/openclaw',
      '/usr/lib/node_modules/openclaw',
    );
  }

  for (const dir of candidates) {
    try { if (fs.existsSync(path.join(dir, 'package.json'))) return dir; } catch {}
  }
  return null;
}

export function ensureTelegramRuntimeDeps(): boolean {
  try {
    const openclawDir = findOpenClawPackageDirQuick();
    if (!openclawDir) {
      console.warn('[telegram-deps] cannot locate openclaw package dir');
      return false;
    }

    const telegramDepsDir = path.join(openclawDir, 'dist', 'extensions', 'telegram', 'node_modules');
    const targetDir = path.join(openclawDir, 'node_modules');

    // Already fixed?
    if (fs.existsSync(path.join(targetDir, 'grammy', 'package.json'))) return true;
    // Source deps available?
    if (!fs.existsSync(path.join(telegramDepsDir, 'grammy'))) {
      console.warn('[telegram-deps] grammy not found in bundled telegram deps');
      return false;
    }
    // Ensure target dir exists
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    // Copy all telegram runtime deps to openclaw/node_modules/
    // Scoped packages (e.g. @grammyjs) are scope directories containing
    // sub-package folders — we must iterate into them and copy each sub-package
    // individually, otherwise a pre-existing empty scope dir blocks the copy.
    const entries = fs.readdirSync(telegramDepsDir).filter(e => !e.startsWith('.'));
    let copied = 0;
    for (const entry of entries) {
      const src = path.join(telegramDepsDir, entry);
      const dst = path.join(targetDir, entry);
      try {
        if (!fs.statSync(src).isDirectory()) continue;
        if (entry.startsWith('@')) {
          // Scoped package: ensure scope dir exists, then copy each sub-package
          if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
          for (const sub of fs.readdirSync(src)) {
            const subSrc = path.join(src, sub);
            const subDst = path.join(dst, sub);
            if (!fs.existsSync(subDst) && fs.statSync(subSrc).isDirectory()) {
              fs.cpSync(subSrc, subDst, { recursive: true });
              copied++;
            }
          }
        } else if (!fs.existsSync(dst)) {
          fs.cpSync(src, dst, { recursive: true });
          copied++;
        }
      } catch (cpErr) {
        console.warn(`[telegram-deps] failed to copy ${entry}:`, cpErr);
      }
    }
    if (copied > 0) console.log(`[telegram-deps] Copied ${copied} telegram runtime deps to ${targetDir}`);
    return fs.existsSync(path.join(targetDir, 'grammy', 'package.json'));
  } catch (err) {
    console.warn('[telegram-deps] ensureTelegramRuntimeDeps failed:', err);
    return false;
  }
}

export function sanitizePluginId(value: string): string {
  return String(value || '').replace(/[^a-z0-9@/_-]/gi, '').toLowerCase();
}

export function isSafeInstallSpec(value: string): boolean {
  return /^[a-z0-9@/_:.-]+$/i.test(value);
}

export function isIgnorablePluginInstallError(rawMessage: string): boolean {
  const message = String(rawMessage || '').toLowerCase();
  return message.includes('plugin already exists') || message.includes('already installed');
}

function channelMatchesPluginId(channelDef: any, pluginId: string): boolean {
  const needle = pluginId.toLowerCase();
  const openclawId = String(channelDef?.openclawId || '').toLowerCase();
  const frontendId = String(channelDef?.id || '').toLowerCase();
  return openclawId === needle || frontendId === needle;
}

function normalizeInstallSpec(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !isSafeInstallSpec(trimmed)) return null;
  return trimmed;
}

export async function resolveChannelPluginInstallSpec(params: {
  pluginId: string;
  preferredSpec?: string | null;
  getChannel?: (channelId: string) => any;
  getChannelByOpenclawId?: (openclawId: string) => any;
  readShellOutputAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
}): Promise<string | null> {
  const preferred = normalizeInstallSpec(params.preferredSpec);
  if (preferred) return preferred;

  if (params.getChannelByOpenclawId) {
    const fromOpenclawId = params.getChannelByOpenclawId(params.pluginId);
    if (fromOpenclawId?.pluginPackage && channelMatchesPluginId(fromOpenclawId, params.pluginId)) {
      const channelSpec = normalizeInstallSpec(String(fromOpenclawId.pluginPackage));
      if (channelSpec) return channelSpec;
    }
  }

  if (params.getChannel) {
    const fromFrontendId = params.getChannel(params.pluginId);
    if (fromFrontendId?.pluginPackage && channelMatchesPluginId(fromFrontendId, params.pluginId)) {
      const channelSpec = normalizeInstallSpec(String(fromFrontendId.pluginPackage));
      if (channelSpec) return channelSpec;
    }
  }

  const safePluginId = sanitizePluginId(params.pluginId);
  if (!safePluginId) return null;

  const inspectOutput = await params.readShellOutputAsync(
    `openclaw plugins inspect "${safePluginId}" --json 2>&1`,
    INSPECT_TIMEOUT_MS,
  );
  const inspectParsed = inspectOutput ? parseJsonShellOutput<any>(inspectOutput) : null;

  return (
    normalizeInstallSpec(inspectParsed?.install?.spec)
    || normalizeInstallSpec(inspectParsed?.plugin?.install?.spec)
    || null
  );
}
