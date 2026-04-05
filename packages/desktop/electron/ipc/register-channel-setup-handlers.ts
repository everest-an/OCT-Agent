import fs from 'fs';
import os from 'os';
import path from 'path';
import { ipcMain } from 'electron';
import { parseJsonShellOutput } from '../openclaw-shell-output';
import {
  enforceDesktopChannelSessionIsolation,
  hardenWhatsAppDmPolicy,
  migrateLegacyChannelConfig,
} from '../openclaw-config';
import {
  isIgnorablePluginInstallError,
  resolveChannelPluginInstallSpec,
  sanitizePluginId,
} from './channel-plugin-spec';

export function registerChannelSetupHandlers(deps: {
  getMainWindow: () => typeof Electron.BrowserWindow.prototype | null;
  getChannel: (channelId: string) => any;
  getChannelByOpenclawId?: (openclawId: string) => any;
  runAsync: (cmd: string, timeoutMs?: number) => Promise<string>;
  safeShellExecAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  readShellOutputAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  channelLoginWithQR: (loginCmd: string, timeoutMs?: number, extraEnv?: Record<string, string>) => Promise<{ success: boolean; output?: string; error?: string }>;
  ensureLocalDaemonReadyForRuntime?: () => Promise<boolean>;
}) {
  const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const CHANNEL_LOGIN_IDLE_TIMEOUT_MS = 180000;
  const CHANNEL_PLUGIN_INSTALL_IDLE_TIMEOUT_MS = 60000;
  const CHANNEL_PLUGIN_UNINSTALL_IDLE_TIMEOUT_MS = 30000;
  const CHANNEL_ADD_IDLE_TIMEOUT_MS = 45000;
  const CHANNEL_BIND_IDLE_TIMEOUT_MS = 30000;
  const GATEWAY_RESTART_IDLE_TIMEOUT_MS = 30000;

  const OFFICIAL_ADD_BEFORE_LOGIN_CHANNELS = new Set(['whatsapp', 'signal', 'imessage']);

  const toErrorMessage = (err: unknown) => {
    if (err instanceof Error) return err.message || String(err);
    return String(err || '');
  };

  const isTimeoutLike = (message: string) => {
    const lower = (message || '').toLowerCase();
    return lower.includes('timed out') || lower.includes('timeout');
  };

  const isNpxEnoentLike = (message: string) => /spawn\s+npx(?:\.cmd)?\s+enoent/i.test(message || '');

  const formatSetupError = (openclawId: string, channelLabel: string, rawError: string) => {
    const message = (rawError || '').trim();
    if (isTimeoutLike(message)) {
      if (openclawId === 'telegram') {
        return 'OpenClaw is still loading Telegram or waiting for pairing confirmation. Wait 20-60 seconds, approve any pending pairing code, then retry.';
      }
      return `OpenClaw is still loading ${channelLabel}. Please wait 20-60 seconds, then retry.`;
    }
    if (isNpxEnoentLike(message)) {
      return 'OpenClaw could not launch required helper tools (npx not found in runtime PATH). Please rerun Setup to repair runtime tools, then retry.';
    }
    if (/Unknown channel/i.test(message)) {
      return `OpenClaw does not recognize channel "${openclawId}" yet. Please reinstall the channel plugin and retry.`;
    }
    return message.slice(0, 300) || `Channel setup failed for "${openclawId}".`;
  };

  const extractPluginLoadFailures = (rawText: string) => {
    const text = rawText || '';
    const pluginIds = new Set<string>();

    const patterns = [
      /\[plugins\]\s+([a-z0-9@/_-]+)\s+failed to load/gi,
      /PluginLoadFailureError:\s*([a-z0-9@/_-]+)\s+failed to load/gi,
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const pluginId = (match[1] || '').trim().toLowerCase();
        if (pluginId) pluginIds.add(pluginId);
      }
    }

    return [...pluginIds];
  };

  const repairBlockingPlugins = async (rawFailure: string, sendStatus: (msg: string) => void) => {
    const failingPlugins = extractPluginLoadFailures(rawFailure);
    if (failingPlugins.length === 0) return false;

    let repairedAny = false;
    for (const pluginId of failingPlugins) {
      const packageSpec = await resolveChannelPluginInstallSpec({
        pluginId,
        getChannel: deps.getChannel,
        getChannelByOpenclawId: deps.getChannelByOpenclawId,
        readShellOutputAsync: deps.readShellOutputAsync,
      });
      if (!packageSpec) continue;

      const safePluginId = sanitizePluginId(pluginId);
      if (!safePluginId) continue;

      sendStatus(`channels.status.repairingPlugin::${safePluginId}`);

      try {
        await deps.runAsync(`openclaw plugins uninstall --force "${safePluginId}" 2>&1`, CHANNEL_PLUGIN_UNINSTALL_IDLE_TIMEOUT_MS);
      } catch {
        // Ignore uninstall failures and continue with a clean install attempt.
      }

      try {
        await deps.runAsync(`openclaw plugins install "${packageSpec}" 2>&1`, CHANNEL_PLUGIN_INSTALL_IDLE_TIMEOUT_MS);
        repairedAny = true;
      } catch (installErr: unknown) {
        const installMessage = toErrorMessage(installErr);
        if (isIgnorablePluginInstallError(installMessage)) {
          repairedAny = true;
          continue;
        }
        return false;
      }
    }

    return repairedAny;
  };

  const isLinkedStatus = (value: string | null | undefined) => /configured|linked|active|enabled/i.test(value || '');

  const shouldPrepareWithChannelsAdd = (openclawId: string, saveStrategy: string, setupFlow: string) => {
    if (setupFlow === 'add-only' || saveStrategy !== 'cli') return false;
    if (OFFICIAL_ADD_BEFORE_LOGIN_CHANNELS.has(openclawId)) return true;
    return setupFlow === 'add-then-login';
  };

  const isPlainRecord = (value: unknown): value is Record<string, any> => (
    !!value && typeof value === 'object' && !Array.isArray(value)
  );

  const disableOpenClawMemoryPlugin = (config: Record<string, any>) => {
    const plugins = isPlainRecord(config.plugins) ? config.plugins : null;
    if (!plugins) return false;

    let changed = false;
    const entries = isPlainRecord(plugins.entries) ? plugins.entries : null;
    const memoryEntry = entries && isPlainRecord(entries['openclaw-memory'])
      ? entries['openclaw-memory']
      : null;
    if (entries && memoryEntry && memoryEntry.enabled !== false) {
      entries['openclaw-memory'] = {
        ...memoryEntry,
        enabled: false,
      };
      changed = true;
    }

    if (Array.isArray(plugins.allow)) {
      const nextAllow = plugins.allow.filter((id: unknown) => String(id || '') !== 'openclaw-memory');
      if (nextAllow.length !== plugins.allow.length) {
        plugins.allow = nextAllow;
        changed = true;
      }
    }

    if (isPlainRecord(plugins.slots) && plugins.slots.memory === 'openclaw-memory') {
      delete plugins.slots.memory;
      changed = true;
      if (Object.keys(plugins.slots).length === 0) {
        delete plugins.slots;
      }
    }

    return changed;
  };

  const runLoginWithScopedConfig = async (loginCmd: string, timeoutMs: number) => {
    let tempConfigPath: string | null = null;
    try {
      const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (!isPlainRecord(parsed)) {
        return {
          usedScopedConfig: false,
          result: await deps.channelLoginWithQR(loginCmd, timeoutMs),
        };
      }

      const isolated = JSON.parse(JSON.stringify(parsed));
      const changed = disableOpenClawMemoryPlugin(isolated);
      if (!changed) {
        return {
          usedScopedConfig: false,
          result: await deps.channelLoginWithQR(loginCmd, timeoutMs),
        };
      }

      tempConfigPath = path.join(
        os.tmpdir(),
        `awarenessclaw-channel-login-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );
      fs.writeFileSync(tempConfigPath, JSON.stringify(isolated, null, 2));

      return {
        usedScopedConfig: true,
        result: await deps.channelLoginWithQR(loginCmd, timeoutMs, { OPENCLAW_CONFIG_PATH: tempConfigPath }),
      };
    } catch {
      return {
        usedScopedConfig: false,
        result: await deps.channelLoginWithQR(loginCmd, timeoutMs),
      };
    } finally {
      if (tempConfigPath) {
        try { fs.rmSync(tempConfigPath, { force: true }); } catch {}
      }
    }
  };

  const sanitizeLegacyChannelConfigFile = (openclawId?: string) => {
    void openclawId;
    try {
      const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
      const config = JSON.parse(raw);
      let changed = migrateLegacyChannelConfig(config);
      changed = enforceDesktopChannelSessionIsolation(config) || changed;
      changed = hardenWhatsAppDmPolicy(config) || changed;
      if (!changed) return false;

      fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2));
      return true;
    } catch {
      return false;
    }
  };

  const isChannelLinked = (output: string | null, openclawId: string) => {
    if (!output) return false;

    const parsed = parseJsonShellOutput<any>(output);
    if (parsed) {
      const channels = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.channels)
          ? parsed.channels
          : Array.isArray(parsed.items)
            ? parsed.items
            : [];

      if (channels.some((channel: any) => {
        const id = String(channel?.id || channel?.name || '').toLowerCase();
        const status = String(channel?.status || channel?.state || channel?.mode || '');
        return id === openclawId.toLowerCase() && isLinkedStatus(status);
      })) {
        return true;
      }
    }

    const needle = openclawId.toLowerCase();
    return output
      .split('\n')
      .some((line) => {
        const lower = line.toLowerCase();
        if (!lower.includes(needle)) return false;
        return /(configured|linked|active|enabled)/i.test(line);
      });
  };

  const waitForChannelConfirmation = async (openclawId: string, label: string, sendStatus: (msg: string) => void) => {
    const attempts = [12000, 8000, 8000];

    for (let index = 0; index < attempts.length; index += 1) {
      sendStatus(`channels.status.confirming::${label}`);
      const output = await deps.readShellOutputAsync('openclaw channels list 2>&1', attempts[index]);
      if (isChannelLinked(output, openclawId)) {
        return true;
      }

      if (index < attempts.length - 1) {
        await sleep(1500);
      }
    }

    return false;
  };

  ipcMain.handle('channel:setup', async (_e: any, channelId: string) => {
    const safeChannelId = channelId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeChannelId || safeChannelId !== channelId) {
      return { success: false, error: `Invalid channel ID: ${channelId}` };
    }

    const channelDef = deps.getChannel(safeChannelId);
    const openclawId = channelDef?.openclawId || safeChannelId;
    const channelLabel = channelDef?.label || safeChannelId;
    const setupFlow = channelDef?.setupFlow || 'qr-login';
    const saveStrategy = channelDef?.saveStrategy || 'cli';

    sanitizeLegacyChannelConfigFile(openclawId);

    const sendStatus = (msg: string) => {
      const mainWindow = deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('channel:status', msg);
    };

    const bindToMainAgent = async (bindId: string) => {
      const bindCmd = `openclaw agents bind --agent main --bind ${bindId} 2>&1`;
      sendStatus('channels.status.binding');
      try {
        await deps.runAsync(bindCmd, CHANNEL_BIND_IDLE_TIMEOUT_MS);
      } catch (firstBindErr: unknown) {
        const firstBindMessage = toErrorMessage(firstBindErr);
        if (!isTimeoutLike(firstBindMessage)) throw firstBindErr;
        try { await deps.runAsync('openclaw gateway restart 2>&1', GATEWAY_RESTART_IDLE_TIMEOUT_MS); } catch {}
        sendStatus('channels.status.binding');
        await deps.runAsync(bindCmd, CHANNEL_BIND_IDLE_TIMEOUT_MS);
      }
    };

    const pluginPkg = (
      await resolveChannelPluginInstallSpec({
        pluginId: openclawId,
        preferredSpec: channelDef?.pluginPackage || null,
        getChannel: deps.getChannel,
        getChannelByOpenclawId: deps.getChannelByOpenclawId,
        readShellOutputAsync: deps.readShellOutputAsync,
      })
    ) || channelDef?.pluginPackage || `@openclaw/${openclawId}`;
    const pluginInstallCmd = `openclaw plugins install "${pluginPkg}" 2>&1`;

    sendStatus(`channels.status.configuring::${channelLabel}`);
    try {
      await deps.runAsync(pluginInstallCmd, CHANNEL_PLUGIN_INSTALL_IDLE_TIMEOUT_MS);
    } catch (pluginErr: unknown) {
      const pluginMsg = toErrorMessage(pluginErr);
      if (isIgnorablePluginInstallError(pluginMsg)) {
        // Already installed / duplicate install metadata — continue setup.
      } else if (isTimeoutLike(pluginMsg)) {
        try {
          await deps.runAsync(pluginInstallCmd, CHANNEL_PLUGIN_INSTALL_IDLE_TIMEOUT_MS);
        } catch (retryInstallErr: unknown) {
          const retryMsg = toErrorMessage(retryInstallErr);
          if (!isIgnorablePluginInstallError(retryMsg)) {
            return { success: false, error: formatSetupError(openclawId, channelLabel, retryMsg) };
          }
        }
      } else {
        return { success: false, error: formatSetupError(openclawId, channelLabel, pluginMsg) };
      }
    }

    if (setupFlow === 'add-only') {
      try {
        await deps.runAsync(`openclaw channels add --channel ${openclawId} 2>&1`, CHANNEL_ADD_IDLE_TIMEOUT_MS);
        await bindToMainAgent(openclawId);
        return { success: true, output: `${channelLabel} connected.` };
      } catch (err: any) {
        return { success: false, error: formatSetupError(openclawId, channelLabel, err?.message || String(err)) };
      }
    }

    if (shouldPrepareWithChannelsAdd(openclawId, saveStrategy, setupFlow)) {
      try { await deps.runAsync(`openclaw channels add --channel ${openclawId} 2>&1`, CHANNEL_ADD_IDLE_TIMEOUT_MS); } catch {}
    }

    if (process.platform === 'win32' && setupFlow !== 'add-only' && deps.ensureLocalDaemonReadyForRuntime) {
      sendStatus('channels.status.startingMemory');
      let daemonReady = await deps.ensureLocalDaemonReadyForRuntime();
      if (!daemonReady) {
        await sleep(1500);
        sendStatus('channels.status.startingMemory');
        daemonReady = await deps.ensureLocalDaemonReadyForRuntime();
      }
      if (!daemonReady) {
        return {
          success: false,
          error: 'Local memory service is still starting. Please wait a few seconds, then retry WeChat connection.',
        };
      }
    }

    sendStatus(`channels.status.connecting::${channelLabel}`);
    const loginCmd = `openclaw channels login --channel ${openclawId} --verbose`;
    let result = await deps.channelLoginWithQR(loginCmd, CHANNEL_LOGIN_IDLE_TIMEOUT_MS);
    let rawFailure = [result.error || '', result.output || ''].join('\n').trim();

    if (!result.success && process.platform === 'win32' && isNpxEnoentLike(rawFailure) && deps.ensureLocalDaemonReadyForRuntime) {
      // Plugin may still attempt its own auto-start path; force a second daemon preflight and retry once.
      sendStatus('channels.status.startingMemory');
      const daemonReady = await deps.ensureLocalDaemonReadyForRuntime();
      if (daemonReady) {
        sendStatus(`channels.status.connecting::${channelLabel}`);
        result = await deps.channelLoginWithQR(loginCmd, CHANNEL_LOGIN_IDLE_TIMEOUT_MS);
        rawFailure = [result.error || '', result.output || ''].join('\n').trim();
      }
    }

    if (!result.success && process.platform === 'win32' && isNpxEnoentLike(rawFailure)) {
      // OpenClaw loads all enabled plugins for login. If memory plugin auto-start
      // crashes in this environment, retry with a command-scoped config that
      // disables only openclaw-memory to avoid cross-channel interruption.
      sendStatus(`channels.status.connecting::${channelLabel}`);
      const scoped = await runLoginWithScopedConfig(loginCmd, CHANNEL_LOGIN_IDLE_TIMEOUT_MS);
      if (scoped.usedScopedConfig) {
        result = scoped.result;
        rawFailure = [result.error || '', result.output || ''].join('\n').trim();
      }
    }

    if (!result.success) {
      const repaired = await repairBlockingPlugins(rawFailure, sendStatus);
      if (repaired) {
        sendStatus(`channels.status.connecting::${channelLabel}`);
        result = await deps.channelLoginWithQR(loginCmd, CHANNEL_LOGIN_IDLE_TIMEOUT_MS);
        rawFailure = [result.error || '', result.output || ''].join('\n').trim();
      }
    }

    if (!result.success) {
      return {
        success: false,
        error: formatSetupError(openclawId, channelLabel, rawFailure || result.error || result.output || ''),
      };
    }

    if (result.success) {
      sanitizeLegacyChannelConfigFile(openclawId);

      try {
        await bindToMainAgent(openclawId);
      } catch (bindErr: any) {
        return { success: false, error: formatSetupError(openclawId, channelLabel, bindErr?.message || String(bindErr)) };
      }
      const confirmed = await waitForChannelConfirmation(openclawId, channelLabel, sendStatus);
      if (!confirmed) {
        sendStatus(`channels.status.awaitingConfirmation::${channelLabel}`);
        return {
          success: true,
          pendingConfirmation: true,
          output: 'Login completed. OpenClaw is still confirming the channel.',
        };
      }
    }
    return result;
  });
}