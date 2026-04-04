import { parseJsonShellOutput } from '../openclaw-shell-output';

const INSPECT_TIMEOUT_MS = 12000;

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
