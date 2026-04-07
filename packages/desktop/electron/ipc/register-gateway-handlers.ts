import http from 'http';
import { ipcMain } from 'electron';

// Dedup lock: only one `openclaw gateway status` CLI process at a time
let gatewayStatusInflight: Promise<{ running: boolean; output: string | null }> | null = null;

/**
 * Fast HTTP ping to Gateway (localhost:18789). Returns true if Gateway is
 * responding, false otherwise. Completes in <100ms vs 15-30s for CLI.
 */
function pingGateway(port = 18789, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume(); // drain
      resolve(res.statusCode !== undefined);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

export function registerGatewayHandlers(deps: {
  readShellOutputAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  runAsync: (cmd: string, timeoutMs?: number) => Promise<string>;
  startGatewayWithRepair: () => Promise<{ ok: boolean; error?: string }>;
  isGatewayRunningOutput: (output: string | null | undefined) => boolean;
}) {
  ipcMain.handle('gateway:status', async () => {
    // Fast path: HTTP ping Gateway directly (~50ms vs 15s CLI)
    const alive = await pingGateway();
    if (alive) return { running: true, output: 'Gateway is running (HTTP ping OK)' };

    // Slow path: CLI check with dedup lock
    if (gatewayStatusInflight) return gatewayStatusInflight;
    gatewayStatusInflight = (async () => {
      const output = await deps.readShellOutputAsync('openclaw gateway status 2>&1', 15000);
      const isRunning = deps.isGatewayRunningOutput(output);
      return { running: isRunning, output };
    })();
    gatewayStatusInflight.finally(() => { gatewayStatusInflight = null; });
    return gatewayStatusInflight;
  });

  ipcMain.handle('gateway:start', async () => {
    const result = await deps.startGatewayWithRepair();
    return result.ok
      ? { success: true, output: 'Gateway started' }
      : { success: false, error: result.error || 'Gateway failed to start' };
  });

  ipcMain.handle('gateway:stop', async () => {
    try {
      const result = await deps.runAsync('openclaw gateway stop 2>&1', 15000);
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, error: err.message?.slice(0, 300) };
    }
  });

  ipcMain.handle('gateway:restart', async () => {
    try {
      const result = await deps.runAsync('openclaw gateway restart 2>&1', 20000);
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, error: err.message?.slice(0, 300) };
    }
  });
}