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

// In-process schema cache — keyed by openclaw version string so an upgrade auto-invalidates.
// Loading the schema via CLI takes 30-120 s (plugin init), so we cache aggressively.
let _schemaCacheVersion: string | null = null;
let _schemaCache: Record<string, any> | null = null;
let _schemaInflightPromise: Promise<Record<string, any> | null> | null = null;

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
  readShellOutputAsync?: (cmd: string, timeoutMs?: number) => Promise<string | null>;
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

  // Shared fetch logic: runs CLI, parses output, updates cache.
  async function fetchSchemaFromCli(openclawVersion: string): Promise<Record<string, any> | null> {
    // Deduplicate concurrent fetches — only one CLI process at a time.
    if (_schemaInflightPromise) return _schemaInflightPromise;

    _schemaInflightPromise = (async () => {
      try {
        // Use readShellOutputAsync (collects stdout+stderr, ignores exit code) so that
        // config warnings printed to stderr don't cause the JSON to be discarded.
        // openclaw config schema loads all plugins → can take 60-120 s on slow machines.
        const shellFn = deps.readShellOutputAsync ?? deps.safeShellExecAsync;
        const output = await shellFn?.('openclaw config schema 2>&1', 120000);
        const schema = parseJsonShellOutput<Record<string, any>>(output || null);
        if (schema) {
          _schemaCacheVersion = openclawVersion;
          _schemaCache = schema;
        }
        return schema;
      } finally {
        _schemaInflightPromise = null;
      }
    })();

    return _schemaInflightPromise;
  }

  ipcMain.handle('openclaw-config:schema', async () => {
    try {
      // Detect current openclaw version for cache invalidation.
      const versionRaw = await deps.safeShellExecAsync?.('openclaw --version 2>&1', 8000);
      const version = (versionRaw || '').match(/(\d+\.\d+\.\d+)/)?.[1] ?? versionRaw ?? 'unknown';

      // Return cached schema if the version hasn't changed.
      if (_schemaCache && _schemaCacheVersion === version) {
        return { success: true, schema: _schemaCache, cached: true };
      }

      const schema = await fetchSchemaFromCli(version);
      if (!schema) {
        return { success: false, error: 'Failed to parse OpenClaw config schema.' };
      }
      return { success: true, schema };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Background prefetch: call this after app startup so the schema is warm
  // before the user opens Settings → Web & Browser.
  async function prefetchSchema() {
    try {
      const versionRaw = await deps.safeShellExecAsync?.('openclaw --version 2>&1', 8000);
      const version = (versionRaw || '').match(/(\d+\.\d+\.\d+)/)?.[1] ?? versionRaw ?? 'unknown';
      if (_schemaCache && _schemaCacheVersion === version) return;
      await fetchSchemaFromCli(version);
    } catch {}
  }

  return { prefetchSchema };
}