import { ipcMain } from 'electron';

export function registerFixOpenClawHandlers(deps: {
  safeShellExecAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  homedir: string;
  getLocalDaemonHealth?: (timeoutMs?: number) => Promise<any | null>;
}) {
  ipcMain.handle('openclaw:fix-plugin', async () => {
    try {
      const result = await deps.safeShellExecAsync('npm run fix-openclaw', 30000);
      return {
        success: true,
        message: 'OpenClaw plugin fix completed successfully',
        result: result || 'No output from fix script',
      };
    } catch (error: any) {
      console.error('Error fixing OpenClaw plugin:', error);
      return {
        success: false,
        message: `Failed to fix OpenClaw plugin: ${error.message}`,
        error: error.message,
      };
    }
  });

  ipcMain.handle('openclaw:fix-plugin-direct', async () => {
    try {
      const scriptPath = './scripts/fix-openclaw-plugin.js';
      const result = await deps.safeShellExecAsync(`node ${scriptPath}`, 30000);
      return {
        success: true,
        message: 'OpenClaw plugin fix completed successfully',
        result: result || 'No output from fix script',
      };
    } catch (error: any) {
      console.error('Error fixing OpenClaw plugin:', error);
      return {
        success: false,
        message: `Failed to fix OpenClaw plugin: ${error.message}`,
        error: error.message,
      };
    }
  });

  // Auto-detection and repair handler.
  //
  // Pre-0.7.2 this always claimed "Checking for OpenClaw plugin issues..." and
  // ran `npm run fix-openclaw`, even when the real culprit was the Awareness
  // local daemon (port 37800) being down. That produced misleading toast copy
  // and never fixed the daemon. Now we triage first: memory daemon health is
  // a separate concern from OpenClaw plugin installation, and we only touch
  // the surface that's actually broken.
  ipcMain.handle('openclaw:auto-fix-if-needed', async () => {
    const probes: Array<{ key: string; ok: boolean; detail?: string }> = [];
    try {
      // 1. Memory daemon health — if healthy, memory UI works regardless of
      //    OpenClaw plugin state. Skip noisy plugin checks entirely.
      let daemonOk = false;
      if (deps.getLocalDaemonHealth) {
        try {
          const health = await deps.getLocalDaemonHealth(2000);
          daemonOk = !!health;
        } catch {
          daemonOk = false;
        }
        probes.push({ key: 'memory_daemon', ok: daemonOk });
      } else {
        probes.push({ key: 'memory_daemon', ok: true, detail: 'probe_unavailable' });
        daemonOk = true;
      }

      if (!daemonOk) {
        // Daemon is the failing surface — watchdog restarts it on its own
        // cadence with orphan-kill + backoff. The renderer should get a clear
        // message rather than a false OpenClaw claim.
        return {
          needsFix: true,
          fixed: false,
          surface: 'memory_daemon',
          message: 'Awareness memory daemon is not responding. The watchdog is attempting to restart it in the background.',
          probes,
        };
      }

      // 2. OpenClaw plugin presence — only relevant if user uses OpenClaw.
      let pluginOk = true;
      let pluginDetail = '';
      try {
        const pluginCheckResult = await deps.safeShellExecAsync('openclaw plugins list', 10000);
        if (!pluginCheckResult || !pluginCheckResult.includes('openclaw-memory')) {
          pluginOk = false;
          pluginDetail = 'openclaw-memory plugin not installed';
        }
      } catch (err: any) {
        pluginOk = false;
        pluginDetail = `plugin list failed: ${err?.message || 'unknown'}`;
      }
      probes.push({ key: 'openclaw_plugin', ok: pluginOk, detail: pluginDetail });

      if (!pluginOk) {
        console.log('[auto-fix] OpenClaw plugin missing, running fix-openclaw');
        try {
          const result = await deps.safeShellExecAsync('npm run fix-openclaw', 30000);
          return {
            needsFix: true,
            fixed: true,
            surface: 'openclaw_plugin',
            message: 'OpenClaw memory plugin was missing and has been reinstalled.',
            result: result || 'Auto-fix completed',
            probes,
          };
        } catch (err: any) {
          return {
            needsFix: true,
            fixed: false,
            surface: 'openclaw_plugin',
            message: `Failed to reinstall OpenClaw memory plugin: ${err?.message || 'unknown error'}`,
            probes,
          };
        }
      }

      // 3. OpenClaw gateway health (best-effort — non-critical).
      try {
        const gatewayStatus = await deps.safeShellExecAsync('openclaw gateway status', 10000);
        const needsRestart = gatewayStatus && (gatewayStatus.includes('not running') || gatewayStatus.includes('not found'));
        probes.push({ key: 'openclaw_gateway', ok: !needsRestart });
        if (needsRestart) {
          const startResult = await deps.safeShellExecAsync('openclaw gateway start', 15000);
          return {
            needsFix: true,
            fixed: true,
            surface: 'openclaw_gateway',
            message: 'OpenClaw gateway was not running and has been restarted.',
            result: startResult || 'Gateway restart completed',
            probes,
          };
        }
      } catch (err: any) {
        probes.push({ key: 'openclaw_gateway', ok: false, detail: err?.message });
      }

      return {
        needsFix: false,
        fixed: false,
        surface: 'healthy',
        message: 'Memory daemon and OpenClaw plugin are both healthy.',
        probes,
      };
    } catch (error: any) {
      console.error('Error during auto-fix check:', error);
      return {
        needsFix: true,
        fixed: false,
        surface: 'unknown',
        message: `Auto-fix check failed: ${error?.message || 'unknown error'}`,
        error: error?.message,
        probes,
      };
    }
  });
}
