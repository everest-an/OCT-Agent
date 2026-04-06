/**
 * App Doctor — automatic diagnostics and repair for AwarenessClaw.
 *
 * Checks: node, openclaw, version conflicts, gateway, plugin, daemon, bindings, permissions.
 * Each check returns a user-friendly result; fixable items can be auto-repaired.
 *
 * Structure:
 *   types.ts          — shared interfaces (CheckResult, Ctx, etc.)
 *   utils.ts          — shared constants and utility functions
 *   context.ts        — buildContext, context cache
 *   checks-openclaw.ts — Node.js and OpenClaw checks
 *   checks-infra.ts   — Gateway, Daemon, LaunchAgent, plugin, config, npm, DNS checks
 *   checks-channels.ts — channel routing / agent bindings
 *   index.ts          — check registry, run order, public API (this file)
 */

import type { CheckResult, CheckStatus, Fixability, FixResult, DoctorDeps, DoctorReport } from './types';
import { buildContext, invalidateCtxCache } from './context';

export { invalidateCtxCache };
import {
  checkNodeInstalled,
  checkOpenclawInstalled, fixOpenclawInstall,
  checkOpenclawCommandHealth, fixOpenclawCommandHealth,
  checkOpenclawVersion, fixOpenclawUpdate,
  checkMultiVersionConflicts,
} from './checks-openclaw';
import {
  checkLaunchAgentPath, fixLaunchAgentPath,
  checkGatewayRunning, fixGatewayStart,
  checkPluginInstalled, fixPluginInstall,
  checkDaemonRunning, fixDaemonStart,
  checkConfigPermissions, fixConfigPermissions,
  checkNpmPrefixWritable,
  checkWebDnsCompatibility,
} from './checks-infra';
import {
  checkChannelCompatibility,
  fixChannelCompatibility,
} from './checks-channel-compatibility';
import { checkChannelBindings, fixChannelBindings } from './checks-channels';

// Re-export types for callers
export type { CheckStatus, Fixability, CheckResult, DoctorReport, FixResult, DoctorDeps };

// --- Check registry ---

const CHECK_REGISTRY: Record<string, { check: (ctx: any) => Promise<CheckResult>; fix?: (ctx: any) => Promise<FixResult> }> = {
  'node-installed': { check: checkNodeInstalled },
  'openclaw-installed': { check: checkOpenclawInstalled, fix: fixOpenclawInstall },
  'openclaw-command-health': { check: checkOpenclawCommandHealth, fix: fixOpenclawCommandHealth },
  'openclaw-version': { check: checkOpenclawVersion, fix: fixOpenclawUpdate },
  'openclaw-conflicts': { check: checkMultiVersionConflicts },
  'launchagent-path': { check: checkLaunchAgentPath, fix: fixLaunchAgentPath },
  'gateway-running': { check: checkGatewayRunning, fix: fixGatewayStart },
  'web-dns-compat': { check: checkWebDnsCompatibility },
  'plugin-installed': { check: checkPluginInstalled, fix: fixPluginInstall },
  'channel-compatibility': { check: checkChannelCompatibility, fix: fixChannelCompatibility },
  'daemon-running': { check: checkDaemonRunning, fix: fixDaemonStart },
  'channel-bindings': { check: checkChannelBindings, fix: fixChannelBindings },
  'config-permissions': { check: checkConfigPermissions, fix: fixConfigPermissions },
  'npm-prefix-writable': { check: checkNpmPrefixWritable },
};

const CHECK_ORDER = [
  'node-installed', 'openclaw-installed', 'openclaw-command-health', 'openclaw-version', 'openclaw-conflicts',
  'launchagent-path', 'gateway-running', 'plugin-installed', 'daemon-running',
  'web-dns-compat',
  'channel-compatibility',
  'channel-bindings', 'config-permissions', 'npm-prefix-writable',
];

// --- Public API ---

export function createDoctor(deps: DoctorDeps) {
  async function runChecks(subset?: string[]): Promise<DoctorReport> {
    const ctx = await buildContext(deps);
    const order = subset || CHECK_ORDER;
    const entries = order
      .map((id) => ({ id, entry: CHECK_REGISTRY[id] }))
      .filter((e) => e.entry);

    // Run checks sequentially to avoid spawning multiple openclaw processes at once.
    // Each openclaw CLI call reloads all installed plugins (15-30 s), so running them
    // in parallel saturates CPU/IO and freezes the machine.
    const checks: CheckResult[] = [];
    for (const { id, entry } of entries) {
      try {
        checks.push(await entry!.check(ctx));
      } catch {
        checks.push({ id, label: id, status: 'fail' as CheckStatus, message: 'Check failed unexpectedly', fixable: 'none' as Fixability });
      }
    }

    const summary = { pass: 0, warn: 0, fail: 0, skipped: 0 };
    for (const c of checks) summary[c.status]++;
    return { timestamp: Date.now(), checks, summary };
  }

  async function runAllChecks(): Promise<DoctorReport> {
    return runChecks();
  }

  async function runFix(checkId: string): Promise<FixResult> {
    const entry = CHECK_REGISTRY[checkId];
    if (!entry?.fix) return { id: checkId, success: false, message: 'No auto-fix available' };
    // Invalidate cache before fix — state is about to change
    invalidateCtxCache();
    const ctx = await buildContext(deps);
    try {
      const result = await entry.fix(ctx);
      // Invalidate again after fix — ensure next check sees new state
      invalidateCtxCache();
      return result;
    } catch (err: any) {
      invalidateCtxCache();
      return { id: checkId, success: false, message: err.message?.slice(0, 200) || 'Fix failed' };
    }
  }

  return { runAllChecks, runChecks, runFix };
}
