import fs from 'fs';
import path from 'path';
import type { CheckResult, FixResult, Ctx } from './types';
import { normalizePluginAllow } from '../openclaw-config';
import { readJsonFileWithBom } from '../json-file';

type ManualCompatibilityIssue = {
  severity: 'warn' | 'fail';
  summary: string;
};

type ChannelCompatibilityPlan = {
  enabledChannels: Set<string>;
  missingAllow: string[];
  disabledEntries: string[];
  staleAllow: string[];
  staleEntries: string[];
  manualIssues: ManualCompatibilityIssue[];
};

const KNOWN_CHANNEL_PLUGIN_IDS = new Set([
  'bluebubbles',
  'discord',
  'feishu',
  'googlechat',
  'imessage',
  'irc',
  'line',
  'matrix',
  'mattermost',
  'msteams',
  'nextcloud-talk',
  'nostr',
  'openclaw-weixin',
  'qqbot',
  'signal',
  'slack',
  'synology-chat',
  'telegram',
  'tlon',
  'twitch',
  'whatsapp',
  'zalo',
  'zalouser',
]);

function asRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, any>;
}

function getEnabledChannels(config: any | null): Set<string> {
  const channels = asRecord(config?.channels);
  if (!channels) return new Set<string>();

  return new Set(
    Object.entries(channels)
      .filter(([, value]) => asRecord(value)?.enabled)
      .map(([channelId]) => channelId),
  );
}

function hasInstalledExtension(homedir: string, pluginId: string): boolean {
  return fs.existsSync(path.join(homedir, '.openclaw', 'extensions', pluginId, 'package.json'));
}

function quoteShellArg(value: string): string {
  return `"${String(value || '').replace(/"/g, '\\"')}"`;
}

async function commandLooksAvailable(ctx: Ctx, command: string, timeout = 6000): Promise<boolean> {
  const output = await ctx.deps.shellExec(command, timeout);
  if (!output) return false;

  return !/not recognized|not found|no such file|cannot find|enoent|is not recognized/i.test(output);
}

function collectPluginPlan(ctx: Ctx): Omit<ChannelCompatibilityPlan, 'manualIssues'> {
  const enabledChannels = getEnabledChannels(ctx.config);
  const pluginAllow = normalizePluginAllow(ctx.config?.plugins?.allow) || [];
  const pluginAllowSet = new Set(pluginAllow);
  const entries = asRecord(ctx.config?.plugins?.entries) || {};

  const missingAllow: string[] = [];
  const disabledEntries: string[] = [];

  for (const channelId of enabledChannels) {
    if (!KNOWN_CHANNEL_PLUGIN_IDS.has(channelId)) continue;

    if (pluginAllow.length > 0 && !pluginAllowSet.has(channelId)) {
      missingAllow.push(channelId);
    }

    const entry = asRecord(entries[channelId]);
    if (entry && entry.enabled === false) {
      disabledEntries.push(channelId);
    }
  }

  const staleAllow: string[] = [];
  for (const pluginId of pluginAllowSet) {
    if (!KNOWN_CHANNEL_PLUGIN_IDS.has(pluginId)) continue;
    if (enabledChannels.has(pluginId)) continue;
    if (hasInstalledExtension(ctx.deps.homedir, pluginId)) continue;
    staleAllow.push(pluginId);
  }

  const staleEntries: string[] = [];
  for (const [pluginId, rawEntry] of Object.entries(entries)) {
    if (!KNOWN_CHANNEL_PLUGIN_IDS.has(pluginId)) continue;
    const entry = asRecord(rawEntry);
    if (!entry || entry.enabled === false) continue;
    if (enabledChannels.has(pluginId)) continue;
    if (hasInstalledExtension(ctx.deps.homedir, pluginId)) continue;
    staleEntries.push(pluginId);
  }

  return {
    enabledChannels,
    missingAllow,
    disabledEntries,
    staleAllow,
    staleEntries,
  };
}

async function collectManualIssues(ctx: Ctx, enabledChannels: Set<string>): Promise<ManualCompatibilityIssue[]> {
  const issues: ManualCompatibilityIssue[] = [];
  const channels = asRecord(ctx.config?.channels) || {};

  if (enabledChannels.has('line')) {
    issues.push({
      severity: 'warn',
      summary: 'LINE needs a public HTTPS webhook endpoint. A local desktop install works only if you expose the gateway through a tunnel or reverse proxy.',
    });
  }

  if (enabledChannels.has('imessage')) {
    if (ctx.deps.platform !== 'darwin') {
      issues.push({
        severity: 'fail',
        summary: 'iMessage (imsg) only runs on macOS. For new deployments, OpenClaw recommends BlueBubbles instead of the legacy imessage channel.',
      });
    } else {
      const imessageConfig = asRecord(channels.imessage) || {};
      const cliPath = typeof imessageConfig.cliPath === 'string' && imessageConfig.cliPath.trim()
        ? imessageConfig.cliPath.trim()
        : 'imsg';
      const imsgAvailable = await commandLooksAvailable(ctx, `${quoteShellArg(cliPath)} rpc --help 2>&1`);
      if (!imsgAvailable) {
        issues.push({
          severity: 'fail',
          summary: 'iMessage is enabled but imsg is not available for this macOS user session. Install it and grant Messages permissions before using the channel.',
        });
      } else {
        issues.push({
          severity: 'warn',
          summary: 'iMessage uses OpenClaw\'s legacy imsg integration and may be removed upstream. Prefer BlueBubbles for new customer deployments.',
        });
      }
    }
  }

  if (enabledChannels.has('signal')) {
    const signalConfig = asRecord(channels.signal) || {};
    const externalDaemonUrl = typeof signalConfig.httpUrl === 'string' ? signalConfig.httpUrl.trim() : '';
    if (!externalDaemonUrl) {
      const cliPath = typeof signalConfig.cliPath === 'string' && signalConfig.cliPath.trim()
        ? signalConfig.cliPath.trim()
        : 'signal-cli';
      const signalCliAvailable = await commandLooksAvailable(ctx, `${quoteShellArg(cliPath)} --version 2>&1`);
      if (!signalCliAvailable) {
        issues.push({
          severity: 'fail',
          summary: 'Signal is enabled but signal-cli is not installed on this host. Install signal-cli locally or point channels.signal.httpUrl to an external Signal daemon.',
        });
      }
    }
  }

  return issues;
}

async function buildCompatibilityPlan(ctx: Ctx): Promise<ChannelCompatibilityPlan> {
  const pluginPlan = collectPluginPlan(ctx);
  const manualIssues = await collectManualIssues(ctx, pluginPlan.enabledChannels);
  return { ...pluginPlan, manualIssues };
}

function summarizeDetail(plan: ChannelCompatibilityPlan): string | undefined {
  const details: string[] = [];

  if (plan.missingAllow.length > 0) {
    details.push(`Restore plugins.allow for active channels: ${plan.missingAllow.join(', ')}`);
  }
  if (plan.disabledEntries.length > 0) {
    details.push(`Re-enable active channel plugin entries: ${plan.disabledEntries.join(', ')}`);
  }
  if (plan.staleAllow.length > 0) {
    details.push(`Remove stale plugins.allow entries: ${plan.staleAllow.join(', ')}`);
  }
  if (plan.staleEntries.length > 0) {
    details.push(`Remove stale enabled plugin entries: ${plan.staleEntries.join(', ')}`);
  }
  for (const issue of plan.manualIssues) {
    details.push(issue.summary);
  }

  return details.length > 0 ? details.join(' | ') : undefined;
}

export async function checkChannelCompatibility(ctx: Ctx): Promise<CheckResult> {
  if (!ctx.config) {
    return {
      id: 'channel-compatibility',
      label: 'Channel compatibility',
      status: 'skipped',
      message: 'Skipped (OpenClaw config not found)',
      fixable: 'none',
    };
  }

  const plan = await buildCompatibilityPlan(ctx);
  const autoIssueCount = plan.missingAllow.length + plan.disabledEntries.length + plan.staleAllow.length + plan.staleEntries.length;
  const manualIssueCount = plan.manualIssues.length;
  const hasHardFailure = autoIssueCount > 0 || plan.manualIssues.some((issue) => issue.severity === 'fail');
  const hasAnyIssue = hasHardFailure || manualIssueCount > 0;

  if (!hasAnyIssue) {
    return {
      id: 'channel-compatibility',
      label: 'Channel compatibility',
      status: 'pass',
      message: plan.enabledChannels.size > 0
        ? 'No upgrade-related channel compatibility risks detected'
        : 'No configured channels need compatibility checks',
      fixable: 'none',
    };
  }

  const detail = summarizeDetail(plan);
  if (autoIssueCount > 0) {
    return {
      id: 'channel-compatibility',
      label: 'Channel compatibility',
      status: hasHardFailure ? 'fail' : 'warn',
      message: manualIssueCount > 0
        ? `Found ${autoIssueCount} auto-repair and ${manualIssueCount} manual channel compatibility issue(s)`
        : `Found ${autoIssueCount} channel compatibility issue(s) that can be repaired automatically`,
      fixable: 'auto',
      fixDescription: 'Repair stale channel plugin config and restore active channel plugin allowlist.',
      detail,
    };
  }

  return {
    id: 'channel-compatibility',
    label: 'Channel compatibility',
    status: hasHardFailure ? 'fail' : 'warn',
    message: manualIssueCount === 1
      ? plan.manualIssues[0].summary
      : `Found ${manualIssueCount} channel compatibility issue(s) that need manual action`,
    fixable: 'manual',
    fixDescription: 'Review the channel requirements and move the channel to a compatible host or expose the required webhook endpoint.',
    detail,
  };
}

export async function fixChannelCompatibility(ctx: Ctx): Promise<FixResult> {
  const plan = await buildCompatibilityPlan(ctx);
  const autoIssueCount = plan.missingAllow.length + plan.disabledEntries.length + plan.staleAllow.length + plan.staleEntries.length;
  if (autoIssueCount === 0) {
    return {
      id: 'channel-compatibility',
      success: true,
      message: 'No automatic channel compatibility repairs were needed',
    };
  }

  const config = readJsonFileWithBom<Record<string, any>>(ctx.configPath) || {};
  config.plugins = asRecord(config.plugins) || {};

  const entries = { ...(asRecord(config.plugins.entries) || {}) };
  const allowSet = new Set(normalizePluginAllow(config.plugins.allow) || []);

  for (const channelId of plan.missingAllow) {
    allowSet.add(channelId);
  }

  for (const channelId of plan.disabledEntries) {
    const entry = asRecord(entries[channelId]) || {};
    entries[channelId] = { ...entry, enabled: true };
  }

  const stalePluginIds = new Set([...plan.staleAllow, ...plan.staleEntries]);
  for (const channelId of stalePluginIds) {
    allowSet.delete(channelId);
    delete entries[channelId];
  }

  if (Object.keys(entries).length > 0) {
    config.plugins.entries = entries;
  } else {
    delete config.plugins.entries;
  }

  if (allowSet.size > 0) {
    config.plugins.allow = Array.from(allowSet);
  } else {
    delete config.plugins.allow;
  }

  if (Object.keys(config.plugins).length === 0) {
    delete config.plugins;
  }

  fs.writeFileSync(ctx.configPath, JSON.stringify(config, null, 2), 'utf8');

  const repaired: string[] = [];
  if (plan.missingAllow.length > 0) repaired.push(`restored allowlist for ${plan.missingAllow.join(', ')}`);
  if (plan.disabledEntries.length > 0) repaired.push(`re-enabled ${plan.disabledEntries.join(', ')}`);
  if (stalePluginIds.size > 0) repaired.push(`removed stale channel plugins ${Array.from(stalePluginIds).join(', ')}`);

  return {
    id: 'channel-compatibility',
    success: true,
    message: `Channel compatibility repaired: ${repaired.join('; ')}`,
  };
}