import { ipcMain } from 'electron';

export function registerCronHandlers(deps: {
  safeShellExecAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
}) {
  ipcMain.handle('cron:list', async () => {
    const jsonOutput = await deps.safeShellExecAsync('openclaw cron list --json 2>/dev/null', 10000);
    if (jsonOutput) {
      try {
        const jsonStart = jsonOutput.indexOf('{');
        if (jsonStart >= 0) {
          const parsed = JSON.parse(jsonOutput.substring(jsonStart));
          const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs || []);
          return { jobs };
        }
      } catch {
        // Fall through to plain text mode.
      }
    }

    const plainOutput = await deps.safeShellExecAsync('openclaw cron list 2>/dev/null', 10000);
    if (!plainOutput) return { jobs: [], error: 'OpenClaw not available' };

    const lines = plainOutput.split('\n').filter((line) => line.trim());
    return { jobs: lines, raw: true };
  });

  ipcMain.handle('cron:add', async (_e, expression: string, command: string) => {
    const result = await deps.safeShellExecAsync(`openclaw cron add "${expression}" "${command}"`, 10000);
    return { success: !!result, output: result };
  });

  ipcMain.handle('cron:remove', async (_e, id: string) => {
    const result = await deps.safeShellExecAsync(`openclaw cron remove "${id}"`, 10000);
    return { success: !!result, output: result };
  });
}