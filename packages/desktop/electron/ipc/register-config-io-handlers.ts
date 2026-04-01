import fs from 'fs';
import path from 'path';
import { dialog, ipcMain, shell } from 'electron';

export function registerConfigIoHandlers(deps: {
  home: string;
  getMainWindow: () => any;
  redactSensitiveValues: (value: any) => any;
  stripRedactedValues: (value: any) => any;
  mergeOpenClawConfig: (existing: Record<string, any>, incoming: Record<string, any>) => Record<string, any>;
}) {
  ipcMain.handle('config:export', async () => {
    const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(configPath)) return { success: false, error: 'No config found' };

    const exportChoice = await dialog.showMessageBox(deps.getMainWindow(), {
      type: 'warning',
      buttons: ['Export with secrets', 'Export safe copy', 'Cancel'],
      cancelId: 2,
      defaultId: 1,
      title: 'Export Configuration',
      message: 'This file may contain API keys, tokens, and other private settings.',
      detail: 'Choose "Export safe copy" to hide sensitive values before saving.',
    });

    if (exportChoice.response === 2) return { success: false, error: 'Cancelled' };
    const redactSecrets = exportChoice.response === 1;

    const result = await dialog.showSaveDialog(deps.getMainWindow(), {
      title: 'Export Configuration',
      defaultPath: 'awareness-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (result.canceled || !result.filePath) return { success: false, error: 'Cancelled' };

    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const exportData = {
        _exportVersion: 1,
        _exportDate: new Date().toISOString(),
        _redacted: redactSecrets,
        openclawConfig: redactSecrets ? deps.redactSensitiveValues(config) : config,
      };
      fs.writeFileSync(result.filePath, JSON.stringify(exportData, null, 2));
      shell.showItemInFolder(result.filePath);
      return { success: true, path: result.filePath, redacted: redactSecrets };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('config:import', async () => {
    const result = await dialog.showOpenDialog(deps.getMainWindow(), {
      title: 'Import Configuration',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });

    if (result.canceled || !result.filePaths[0]) return { success: false, error: 'Cancelled' };

    try {
      const raw = fs.readFileSync(result.filePaths[0], 'utf8');
      const data = JSON.parse(raw);
      if (!data.openclawConfig) return { success: false, error: 'Invalid config file format' };

      const configDir = path.join(deps.home, '.openclaw');
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, 'openclaw.json');

      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}

      const sanitizedImport = deps.stripRedactedValues(data.openclawConfig || {});
      const merged = deps.mergeOpenClawConfig(existing as Record<string, any>, sanitizedImport as Record<string, any>);

      fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
      return { success: true, config: sanitizedImport, redactedImport: !!data._redacted };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}