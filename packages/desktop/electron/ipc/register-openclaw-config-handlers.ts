import fs from 'fs';
import path from 'path';
import { ipcMain } from 'electron';
import {
  getExecApprovalSettings,
  writeExecApprovalSettings,
  type ExecApprovalAllowlistEntry,
  type ExecApprovalAsk,
  type ExecApprovalSecurity,
} from '../openclaw-config';
import { parseJsonShellOutput } from '../openclaw-shell-output';

function getConfigPath(home: string) {
  return path.join(home, '.openclaw', 'openclaw.json');
}

function readConfig(home: string) {
  const configPath = getConfigPath(home);
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(home: string, config: Record<string, any>) {
  const configPath = getConfigPath(home);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function getByPath(value: any, dotPath?: string) {
  if (!dotPath) return value;
  return dotPath.split('.').reduce((acc, part) => acc?.[part], value);
}

function buildNestedPatch(dotPath: string, value: any) {
  return dotPath.split('.').reverse().reduce((acc, part) => ({ [part]: acc }), value);
}

export function registerOpenClawConfigHandlers(deps: {
  home: string;
  safeShellExecAsync?: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  mergeOpenClawConfig?: (existing: Record<string, any>, incoming: Record<string, any>) => Record<string, any>;
}) {
  ipcMain.handle('plugins:list', async () => {
    try {
      const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const entries = config.plugins?.entries || [];
      return { success: true, entries };
    } catch (err: any) {
      return { success: false, error: err.message, entries: [] };
    }
  });

  ipcMain.handle('plugins:toggle', async (_e, name: string, enabled: boolean) => {
    try {
      const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
      let config: any = {};
      try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
      if (!config.plugins) config.plugins = {};
      if (!config.plugins.entries) config.plugins.entries = {};
      if (config.plugins.entries[name]) {
        config.plugins.entries[name].enabled = enabled;
      } else {
        config.plugins.entries[name] = { enabled };
      }
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('hooks:list', async () => {
    try {
      const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const hooks = config.hooks || {};
      return { success: true, hooks };
    } catch (err: any) {
      return { success: false, error: err.message, hooks: {} };
    }
  });

  ipcMain.handle('hooks:toggle', async (_e, hookName: string, enabled: boolean) => {
    try {
      const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
      let config: any = {};
      try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
      if (!config.hooks) config.hooks = {};
      if (config.hooks[hookName]) {
        config.hooks[hookName].enabled = enabled;
      } else {
        config.hooks[hookName] = { enabled };
      }
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('permissions:get', async () => {
    try {
      const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const tools = config.tools || {};
      const execApprovals = getExecApprovalSettings(deps.home);
      return {
        success: true,
        profile: tools.profile || 'default',
        alsoAllow: tools.alsoAllow || [],
        denied: tools.denied || [],
        execSecurity: execApprovals.security,
        execAsk: execApprovals.ask,
        execAskFallback: execApprovals.askFallback,
        execAutoAllowSkills: execApprovals.autoAllowSkills,
        execAllowlist: execApprovals.allowlist,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('permissions:update', async (_e, changes: {
    alsoAllow?: string[];
    denied?: string[];
    execSecurity?: ExecApprovalSecurity;
    execAsk?: ExecApprovalAsk;
    execAskFallback?: ExecApprovalSecurity;
    execAutoAllowSkills?: boolean;
    execAllowlist?: ExecApprovalAllowlistEntry[];
  }) => {
    try {
      const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
      let config: any = {};
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch {}
      if (!config.tools) config.tools = {};
      if (changes.alsoAllow !== undefined) config.tools.alsoAllow = changes.alsoAllow;
      if (changes.denied !== undefined) {
        if (changes.denied.length > 0) {
          config.tools.denied = changes.denied;
        } else {
          delete config.tools.denied;
        }
      }
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      if (
        changes.execSecurity !== undefined ||
        changes.execAsk !== undefined ||
        changes.execAskFallback !== undefined ||
        changes.execAutoAllowSkills !== undefined ||
        changes.execAllowlist !== undefined
      ) {
        writeExecApprovalSettings(deps.home, {
          ...(changes.execSecurity !== undefined ? { security: changes.execSecurity } : {}),
          ...(changes.execAsk !== undefined ? { ask: changes.execAsk } : {}),
          ...(changes.execAskFallback !== undefined ? { askFallback: changes.execAskFallback } : {}),
          ...(changes.execAutoAllowSkills !== undefined ? { autoAllowSkills: changes.execAutoAllowSkills } : {}),
          ...(changes.execAllowlist !== undefined ? { allowlist: changes.execAllowlist } : {}),
        });
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('openclaw-config:read', async (_e, dotPath?: string) => {
    try {
      const config = readConfig(deps.home);
      return { success: true, value: getByPath(config, dotPath) };
    } catch (err: any) {
      return { success: false, error: err.message, value: undefined };
    }
  });

  ipcMain.handle('openclaw-config:write', async (_e, dotPath: string, value: any) => {
    try {
      const existing = readConfig(deps.home);
      const merge = deps.mergeOpenClawConfig || ((current: Record<string, any>, incoming: Record<string, any>) => ({ ...current, ...incoming }));
      const incoming = buildNestedPatch(dotPath, value);
      const merged = merge(existing, incoming);
      writeConfig(deps.home, merged);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('openclaw-config:schema', async () => {
    try {
      const output = await deps.safeShellExecAsync?.('openclaw config schema 2>&1', 60000);
      const schema = parseJsonShellOutput<Record<string, any>>(output || null);
      if (!schema) {
        return { success: false, error: 'Failed to parse OpenClaw config schema.' };
      }
      return { success: true, schema };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}