import { ipcMain } from 'electron';

export function registerGatewayHandlers(deps: {
  readShellOutputAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  runAsync: (cmd: string, timeoutMs?: number) => Promise<string>;
  startGatewayWithRepair: () => Promise<{ ok: boolean; error?: string }>;
  isGatewayRunningOutput: (output: string | null | undefined) => boolean;
}) {
  ipcMain.handle('gateway:status', async () => {
    const output = await deps.readShellOutputAsync('openclaw gateway status 2>&1', 15000);
    const isRunning = deps.isGatewayRunningOutput(output);
    return { running: isRunning, output };
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