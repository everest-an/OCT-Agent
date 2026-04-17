import { ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Per-app-launch memoization for auto-fix results.
 *
 * Pre-0.3.7 the Memory page ran this on every mount (navigate away and back
 * → React re-mounts Memory → new ref → fresh trigger → reinstall toast).
 * Users reported seeing "OpenClaw memory plugin was missing and has been
 * reinstalled" every time they clicked the Memory tab, even though the
 * plugin was actually fine — CLI detection in the Electron-packaged runtime
 * is unreliable (PATH inheritance + command timeouts) so it reported
 * false "missing" constantly.
 *
 * Now: one attempt per app launch, result cached, fs-based detection
 * instead of CLI, and the Memory page doesn't call this at all.
 */
let cachedResult: AutoFixResult | null = null;
let inflightPromise: Promise<AutoFixResult> | null = null;

interface AutoFixResult {
  needsFix: boolean;
  fixed: boolean;
  surface: 'memory_daemon' | 'openclaw_plugin' | 'openclaw_gateway' | 'healthy' | 'unknown';
  message: string;
  result?: string;
  error?: string;
  probes?: Array<{ key: string; ok: boolean; detail?: string }>;
}

/**
 * FS-based plugin presence check. Replaces the old
 * `openclaw plugins list` CLI call which:
 *   - times out under CPU pressure (false "missing")
 *   - can't find the `openclaw` binary in packaged .app PATH (false "missing")
 *   - takes 10-20s even on the happy path (openclaw CLI reloads all plugins)
 *
 * Truth source: `~/.openclaw/extensions/<slug>/package.json` exists.
 */
function isOpenClawMemoryPluginInstalled(homedir: string): boolean {
  const candidates = [
    path.join(homedir, '.openclaw', 'extensions', 'openclaw-memory', 'package.json'),
    path.join(homedir, '.openclaw', 'extensions', 'awareness-memory', 'package.json'),
  ];
  return candidates.some((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
}

export function registerFixOpenClawHandlers(deps: {
  safeShellExecAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  homedir: string;
  getLocalDaemonHealth?: (timeoutMs?: number) => Promise<any | null>;
}) {
  ipcMain.handle('openclaw:fix-plugin', async () => {
    try {
      const result = await deps.safeShellExecAsync('npm run fix-openclaw', 30000);
      // Manual fix invalidates the launch cache so a subsequent auto-fix
      // probe re-evaluates the new plugin state.
      cachedResult = null;
      return {
        success: true,
        message: 'OpenClaw plugin fix completed successfully',
        result: result || 'No output from fix script',
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to fix OpenClaw plugin: ${error.message}`,
        error: error.message,
      };
    }
  });

  ipcMain.handle('openclaw:fix-plugin-direct', async () => {
    try {
      const result = await deps.safeShellExecAsync('node ./scripts/fix-openclaw-plugin.js', 30000);
      cachedResult = null;
      return {
        success: true,
        message: 'OpenClaw plugin fix completed successfully',
        result: result || 'No output from fix script',
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to fix OpenClaw plugin: ${error.message}`,
        error: error.message,
      };
    }
  });

  // Auto-detection and repair. Cached per-app-launch so every Memory tab
  // click isn't a fresh `npm run fix-openclaw`.
  ipcMain.handle('openclaw:auto-fix-if-needed', async (_evt, opts?: { force?: boolean }): Promise<AutoFixResult> => {
    if (cachedResult && !opts?.force) return cachedResult;
    if (inflightPromise) return inflightPromise;

    inflightPromise = (async (): Promise<AutoFixResult> => {
      const probes: AutoFixResult['probes'] = [];
      try {
        // 1. Memory daemon health — only legitimate failure worth surfacing
        //    to the user. If daemon is up, memory works regardless of any
        //    OpenClaw state.
        let daemonOk = true;
        if (deps.getLocalDaemonHealth) {
          try {
            const health = await deps.getLocalDaemonHealth(3000);
            daemonOk = !!health;
          } catch {
            daemonOk = false;
          }
          probes.push({ key: 'memory_daemon', ok: daemonOk });
        } else {
          probes.push({ key: 'memory_daemon', ok: true, detail: 'probe_unavailable' });
        }

        if (!daemonOk) {
          // Daemon watchdog (separate subsystem) handles restart. We just
          // tell the renderer what's going on. Do NOT cache a down-daemon
          // result: next probe should re-check in case it recovered.
          return {
            needsFix: true,
            fixed: false,
            surface: 'memory_daemon',
            message: 'Awareness memory daemon is not responding. The watchdog is attempting to restart it in the background.',
            probes,
          };
        }

        // 2. OpenClaw plugin presence — fs-based, not CLI-based. Memory
        //    page does not depend on this; we only repair it here so the
        //    AI agent side keeps working.
        const pluginOk = isOpenClawMemoryPluginInstalled(deps.homedir);
        probes.push({ key: 'openclaw_plugin', ok: pluginOk, detail: pluginOk ? 'extension dir present' : 'extension dir missing' });

        if (!pluginOk) {
          try {
            const result = await deps.safeShellExecAsync('npm run fix-openclaw', 30000);
            // Re-check after fix so we cache the post-fix state, not a
            // "reinstalled" banner we'll repeat forever.
            const postFixOk = isOpenClawMemoryPluginInstalled(deps.homedir);
            const finalResult: AutoFixResult = {
              needsFix: true,
              fixed: postFixOk,
              surface: 'openclaw_plugin',
              message: postFixOk
                ? 'OpenClaw memory plugin was missing and has been reinstalled.'
                : 'OpenClaw memory plugin is missing and the automatic fix did not succeed. Please reinstall manually.',
              result: result || 'Auto-fix completed',
              probes,
            };
            cachedResult = finalResult;
            return finalResult;
          } catch (err: any) {
            const failResult: AutoFixResult = {
              needsFix: true,
              fixed: false,
              surface: 'openclaw_plugin',
              message: `Failed to reinstall OpenClaw memory plugin: ${err?.message || 'unknown error'}`,
              probes,
            };
            // Cache the failure too — no point retrying the same broken
            // fix script every mount.
            cachedResult = failResult;
            return failResult;
          }
        }

        // 3. Everything healthy. Cache this so the next 99 probes this
        //    launch are a pure Map lookup, no shell exec, no toast.
        const healthy: AutoFixResult = {
          needsFix: false,
          fixed: false,
          surface: 'healthy',
          message: 'Memory daemon and OpenClaw plugin are both healthy.',
          probes,
        };
        cachedResult = healthy;
        return healthy;
      } catch (error: any) {
        return {
          needsFix: true,
          fixed: false,
          surface: 'unknown',
          message: `Auto-fix check failed: ${error?.message || 'unknown error'}`,
          error: error?.message,
          probes,
        };
      } finally {
        inflightPromise = null;
      }
    })();

    return inflightPromise;
  });
}
