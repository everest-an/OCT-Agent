import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseJsonShellOutput } from '../openclaw-shell-output';

const INSPECT_TIMEOUT_MS = 12000;

// ---------------------------------------------------------------------------
// Channel runtime-deps fix (OpenClaw packaging bug workaround)
// ---------------------------------------------------------------------------
// OpenClaw bundles channel runtime deps inside
//   dist/extensions/<channel>/node_modules/
// But the dist-level chunk files do `import "<dep>"` — Node resolution from
// dist/ goes UP to the package's own node_modules/ and never looks SIDEWAYS
// into extensions/<channel>/.
//
// Fix: dynamically detect any channel that ships a local node_modules/ and
// copy the missing deps into <openclaw>/node_modules/ so the standard
// resolution chain finds them.  Fully automatic — no hardcoded channel list.
// Idempotent (no-op when deps already present in target).
// ---------------------------------------------------------------------------

/** Cache: channelId → true once deps have been ensured this session */
const _depsEnsuredThisSession = new Set<string>();
const _manifestMetadataEnsuredThisSession = new Set<string>();

function findOpenClawPackageDirQuick(): string | null {
  const home = os.homedir();
  const candidates: string[] = [];

  // Managed runtime (OCT bundled install)
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

export function ensureChannelRuntimeDeps(channelId: string): boolean {
  // Skip if already handled this session (avoids redundant fs scans)
  if (_depsEnsuredThisSession.has(channelId)) return true;

  const tag = `[${channelId}-deps]`;
  try {
    const openclawDir = findOpenClawPackageDirQuick();
    if (!openclawDir) {
      console.warn(`${tag} cannot locate openclaw package dir`);
      return false;
    }

    const channelDepsDir = path.join(openclawDir, 'dist', 'extensions', channelId, 'node_modules');

    // No bundled node_modules for this channel — nothing to do
    if (!fs.existsSync(channelDepsDir)) {
      _depsEnsuredThisSession.add(channelId);
      return true;
    }

    const targetDir = path.join(openclawDir, 'node_modules');
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    // Copy all channel runtime deps to openclaw/node_modules/
    // Scoped packages (e.g. @grammyjs) are scope directories containing
    // sub-package folders — we must iterate into them and copy each sub-package
    // individually, otherwise a pre-existing empty scope dir blocks the copy.
    const entries = fs.readdirSync(channelDepsDir).filter(e => !e.startsWith('.'));
    let copied = 0;
    for (const entry of entries) {
      const src = path.join(channelDepsDir, entry);
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
        console.warn(`${tag} failed to copy ${entry}:`, cpErr);
      }
    }
    if (copied > 0) console.log(`${tag} Copied ${copied} ${channelId} runtime deps to ${targetDir}`);
    _depsEnsuredThisSession.add(channelId);
    return true;
  } catch (err) {
    console.warn(`${tag} ensureChannelRuntimeDeps failed:`, err);
    return false;
  }
}

export function ensureChannelManifestMetadata(channelId: string, homedir = os.homedir()): boolean {
  const normalizedChannelId = sanitizePluginId(channelId);
  if (!normalizedChannelId) return false;

  const manifestPath = path.join(homedir, '.openclaw', 'extensions', normalizedChannelId, 'openclaw.plugin.json');
  const cacheKey = `${normalizedChannelId}:${manifestPath}`;
  if (_manifestMetadataEnsuredThisSession.has(cacheKey)) return true;
  try {
    if (!fs.existsSync(manifestPath)) {
      return true;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object') return false;

    const declaredChannels = Array.isArray(manifest.channels)
      ? manifest.channels.map((value: unknown) => String(value || '').trim()).filter(Boolean)
      : [];
    if (!declaredChannels.includes(normalizedChannelId)) {
      _manifestMetadataEnsuredThisSession.add(cacheKey);
      return true;
    }

    if (!manifest.channelConfigs || typeof manifest.channelConfigs !== 'object' || Array.isArray(manifest.channelConfigs)) {
      manifest.channelConfigs = {};
    }
    if (manifest.channelConfigs[normalizedChannelId]) {
      _manifestMetadataEnsuredThisSession.add(cacheKey);
      return true;
    }

    const baseSchema =
      manifest.configSchema && typeof manifest.configSchema === 'object' && !Array.isArray(manifest.configSchema)
        ? manifest.configSchema
        : { type: 'object', additionalProperties: false, properties: {} };
    const baseProperties =
      baseSchema.properties && typeof baseSchema.properties === 'object' && !Array.isArray(baseSchema.properties)
        ? baseSchema.properties
        : {};

    manifest.channelConfigs[normalizedChannelId] = {
      schema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        ...baseSchema,
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          ...baseProperties,
        },
      },
      label: normalizedChannelId === 'openclaw-weixin' ? 'WeChat' : normalizedChannelId,
    };

    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    _manifestMetadataEnsuredThisSession.add(cacheKey);
    return true;
  } catch (err) {
    console.warn(`[${normalizedChannelId}-manifest] ensureChannelManifestMetadata failed:`, err);
    return false;
  }
}

/** @deprecated Use ensureChannelRuntimeDeps('telegram') instead */
export function ensureTelegramRuntimeDeps(): boolean {
  return ensureChannelRuntimeDeps('telegram');
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
