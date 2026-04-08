import fs from 'fs';
import os from 'os';
import path from 'path';
import { ipcMain } from 'electron';
import { parseJsonShellOutput } from '../openclaw-shell-output';
import {
  enforceDesktopChannelSessionIsolation,
  hardenWhatsAppDmPolicy,
  migrateLegacyChannelConfig,
  patchGatewayCmdStackSize,
} from '../openclaw-config';
import {
  isIgnorablePluginInstallError,
  resolveChannelPluginInstallSpec,
  sanitizePluginId,
} from './channel-plugin-spec';
import { clearChannelStatusCache } from './register-channel-list-handlers';
import { acquireChannelLoginLock, dedupedChannelsList, killStaleChannelLogins } from '../openclaw-process-guard';

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
  const CHANNEL_PLUGIN_INSTALL_IDLE_TIMEOUT_MS = 120000;
  const CHANNEL_PLUGIN_UNINSTALL_IDLE_TIMEOUT_MS = 30000;
  const CHANNEL_ADD_IDLE_TIMEOUT_MS = 45000;
  const CHANNEL_BIND_IDLE_TIMEOUT_MS = 30000;
  const CHANNEL_LOGOUT_IDLE_TIMEOUT_MS = 30000;
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

  const isStackOverflowLike = (message: string) => {
    const lower = (message || '').toLowerCase();
    return lower.includes('maximum call stack size exceeded')
      || lower.includes('rangeerror')
      || lower.includes('stack overflow')
      || lower.includes('0xc00000fd')
      || lower.includes('3221225725')
      || lower.includes('crashed while loading plugins');
  };

  const isNpxEnoentLike = (message: string) => /spawn\s+npx(?:\.cmd)?\s+enoent/i.test(message || '');

  // Transient OpenClaw failures that almost always succeed on a second attempt:
  // - timeout: first attempt absorbs the 15-30s plugin load tax, second hits warm cache
  // - AbortError: upstream regression where plugin init is aborted by handshake timeout
  // - handshake timeout: gateway-cli DEFAULT_HANDSHAKE_TIMEOUT_MS is hardcoded to 3000ms
  // Reference: github.com/openclaw/openclaw/issues/46256
  const isTransientLoginFailure = (message: string) => {
    if (!message) return false;
    if (isTimeoutLike(message)) return true;
    if (/AbortError/i.test(message)) return true;
    if (/This operation was aborted/i.test(message)) return true;
    if (/handshake timeout/i.test(message)) return true;
    return false;
  };

  // Known-broken WeChat plugin versions that throw AbortError on init.
  // 2.1.3 is the canonical bad version reported upstream; downgrade to 2.0.1 + allowUnsigned
  // is the official workaround until @tencent-weixin/openclaw-weixin ships a fix.
  // Reference: github.com/openclaw/openclaw/issues/52341
  const KNOWN_BROKEN_WECHAT_VERSIONS = new Set(['2.1.3']);
  const SAFE_WECHAT_VERSION = '2.0.1';

  const ensureWeChatPluginCompatible = async (sendStatus: (msg: string) => void): Promise<boolean> => {
    try {
      const pkgJsonPath = path.join(os.homedir(), '.openclaw', 'extensions', 'openclaw-weixin', 'package.json');
      if (!fs.existsSync(pkgJsonPath)) return false;
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const version = String(pkg?.version || '');
      if (!KNOWN_BROKEN_WECHAT_VERSIONS.has(version)) return false;

      sendStatus('channels.status.fixingWechatVersion');
      try {
        await deps.runAsync(
          `openclaw plugins install "@tencent-weixin/openclaw-weixin@${SAFE_WECHAT_VERSION}" --force 2>&1`,
          CHANNEL_PLUGIN_INSTALL_IDLE_TIMEOUT_MS,
        );
      } catch (err: unknown) {
        const msg = toErrorMessage(err);
        if (!isIgnorablePluginInstallError(msg)) return false;
      }

      // Allow unsigned: 2.0.1 predates current signature scheme so OpenClaw rejects it by default.
      try {
        const cfgRaw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
        const cfg = JSON.parse(cfgRaw);
        if (cfg && typeof cfg === 'object') {
          if (!isPlainRecord(cfg.plugins)) cfg.plugins = {};
          if (!isPlainRecord(cfg.plugins.entries)) cfg.plugins.entries = {};
          if (!isPlainRecord(cfg.plugins.entries['openclaw-weixin'])) cfg.plugins.entries['openclaw-weixin'] = {};
          cfg.plugins.entries['openclaw-weixin'].allowUnsigned = true;
          fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(cfg, null, 2));
        }
      } catch { /* non-fatal — install itself succeeded */ }

      return true;
    } catch {
      return false;
    }
  };

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
    if (isStackOverflowLike(message)) {
      return `${channelLabel} plugin hit a stack overflow while loading. This is not a credential issue. Please retry once.`;
    }
    if (/Unknown channel/i.test(message)) {
      return `OpenClaw does not recognize channel "${openclawId}" yet. Please reinstall the channel plugin and retry.`;
    }
    // WeChat plugin SDK incompatibility (OpenClaw 2026.4.2+ API break)
    if (/resolvePreferredOpenClawTmpDir is not a function/i.test(message)) {
      return `${channelLabel} plugin is incompatible with your current OpenClaw version (internal API changed). ` +
        'Please run this command in a terminal to update the plugin: ' +
        'openclaw plugins install @tencent-weixin/openclaw-weixin --force';
    }
    // WeChat / WhatsApp AbortError — full plugin preload causing AbortController timeout (upstream regression)
    if (/AbortError/i.test(message) || /This operation was aborted/i.test(message)) {
      return `${channelLabel} initialization was interrupted (the plugin loaded too slowly on this OpenClaw version). ` +
        'Please try connecting again — it usually succeeds on the second attempt. ' +
        `If it keeps failing, run: openclaw plugins install @tencent-weixin/openclaw-weixin --force`;
    }
    if (/PluginLoadFailureError|plugin load failed|Cannot find module/i.test(message)) {
      return `${channelLabel} setup was blocked because another enabled plugin failed to load. ` +
        'AwarenessClaw will retry with isolated channel loading automatically. ' +
        'If it still fails, disable unrelated channels/plugins in Settings and retry.';
    }
    return message.slice(0, 300) || `Channel setup failed for "${openclawId}".`;
  };

  const extractPluginLoadFailures = (rawText: string) => {
    const text = rawText || '';
    const pluginIds = new Set<string>();

    const patterns = [
      /\[plugins\]\s+([a-z0-9@/_-]+)\s+failed to load/gi,
      /PluginLoadFailureError:\s*([a-z0-9@/_-]+)\s+failed to load/gi,
      /PluginLoadFailureError:\s*plugin load failed:\s*([a-z0-9@/_-]+)/gi,
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

  const hasNonTargetPluginLoadFailure = (rawFailure: string, targetPluginId: string) => {
    if (!rawFailure) return false;
    const target = (targetPluginId || '').toLowerCase();
    return extractPluginLoadFailures(rawFailure)
      .some((pluginId) => pluginId && pluginId !== target);
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

  const wrapOpenclawConfigPathCommand = (command: string, scopedConfigPath: string) => {
    if (process.platform === 'win32') {
      const escapedPath = scopedConfigPath.replace(/"/g, '""');
      return `set "OPENCLAW_CONFIG_PATH=${escapedPath}" && ${command}`;
    }
    const escapedPath = scopedConfigPath.replace(/"/g, '\\"');
    return `OPENCLAW_CONFIG_PATH="${escapedPath}" ${command}`;
  };

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

  const isolateLoginToChannelPlugin = (config: Record<string, any>, pluginId: string) => {
    if (!pluginId) return false;
    if (!isPlainRecord(config.plugins)) config.plugins = {};
    const plugins = config.plugins as Record<string, any>;

    let changed = false;
    if (!Array.isArray(plugins.allow) || plugins.allow.length !== 1 || plugins.allow[0] !== pluginId) {
      plugins.allow = [pluginId];
      changed = true;
    }

    if (!isPlainRecord(plugins.entries)) {
      plugins.entries = {};
      changed = true;
    }

    const entries = plugins.entries as Record<string, any>;
    for (const [entryId, entryRaw] of Object.entries(entries)) {
      const entry = isPlainRecord(entryRaw) ? { ...entryRaw } : {};
      if (entryId === pluginId) {
        if (entry.enabled !== true) {
          entry.enabled = true;
          entries[entryId] = entry;
          changed = true;
        }
        continue;
      }
      if (entry.enabled !== false) {
        entry.enabled = false;
        entries[entryId] = entry;
        changed = true;
      }
    }

    if (!isPlainRecord(entries[pluginId])) {
      entries[pluginId] = { enabled: true };
      changed = true;
    }

    if (isPlainRecord(plugins.slots) && plugins.slots.memory) {
      delete plugins.slots.memory;
      changed = true;
      if (Object.keys(plugins.slots).length === 0) {
        delete plugins.slots;
      }
    }

    return changed;
  };

  const runLoginWithScopedConfig = async (
    loginCmd: string,
    timeoutMs: number,
    options?: { isolateToPluginId?: string; extraEnv?: Record<string, string> },
  ) => {
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
      const changed = options?.isolateToPluginId
        ? isolateLoginToChannelPlugin(isolated, options.isolateToPluginId)
        : disableOpenClawMemoryPlugin(isolated);
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
        result: await deps.channelLoginWithQR(loginCmd, timeoutMs, {
          OPENCLAW_CONFIG_PATH: tempConfigPath,
          ...(options?.extraEnv || {}),
        }),
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

  const runCommandWithScopedConfig = async (command: string, timeoutMs: number) => {
    let tempConfigPath: string | null = null;
    try {
      const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (!isPlainRecord(parsed)) {
        return {
          usedScopedConfig: false,
          output: null as string | null,
          error: null as string | null,
        };
      }

      const isolated = JSON.parse(JSON.stringify(parsed));
      const changed = disableOpenClawMemoryPlugin(isolated);
      if (!changed) {
        return {
          usedScopedConfig: false,
          output: null as string | null,
          error: null as string | null,
        };
      }

      tempConfigPath = path.join(
        os.tmpdir(),
        `awarenessclaw-channel-cmd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );
      fs.writeFileSync(tempConfigPath, JSON.stringify(isolated, null, 2));

      try {
        const output = await deps.runAsync(wrapOpenclawConfigPathCommand(command, tempConfigPath), timeoutMs);
        return {
          usedScopedConfig: true,
          output,
          error: null as string | null,
        };
      } catch (scopedErr: unknown) {
        return {
          usedScopedConfig: true,
          output: null as string | null,
          error: toErrorMessage(scopedErr),
        };
      }
    } catch {
      return {
        usedScopedConfig: false,
        output: null as string | null,
        error: null as string | null,
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

  // Fast path: read openclaw.json directly instead of spawning `openclaw channels list`.
  // This avoids the 15-20 s full plugin preload triggered by every CLI invocation (upstream
  // issue tracked in OpenClaw PR #59713). Returns true as soon as channels[id].enabled is set.
  const isChannelLinkedInFile = (openclawId: string): boolean => {
    try {
      const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
      const cfg = JSON.parse(raw);
      const channelCfg = cfg?.channels?.[openclawId];
      return channelCfg?.enabled === true;
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
    // Fast path: check the config file directly — no CLI spawn, no plugin preload.
    // By the time we reach this function we have already written enabled:true for the
    // channel, so a successful QR-login will almost always return true here immediately.
    if (isChannelLinkedInFile(openclawId)) return true;

    // Slow path: fall back to `openclaw channels list` for channels whose configuration
    // is written asynchronously by the OpenClaw daemon (e.g. after OAuth callback).
    const attempts = [12000, 8000, 8000];

    for (let index = 0; index < attempts.length; index += 1) {
      sendStatus(`channels.status.confirming::${label}`);
      const output = await dedupedChannelsList(deps.readShellOutputAsync, attempts[index]);
      if (isChannelLinked(output, openclawId)) {
        return true;
      }
      // Re-check the file after each CLI call in case OpenClaw wrote it in the meantime.
      if (isChannelLinkedInFile(openclawId)) return true;

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
        if (process.platform === 'win32') patchGatewayCmdStackSize(os.homedir());
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
    // Mirror fallback: use npmmirror.com when the default npm registry is unreachable or slow.
    // npm respects npm_config_registry as an env var, which openclaw passes through to npm install.
    const pluginInstallCmdMirror = `npm_config_registry=https://registry.npmmirror.com openclaw plugins install "${pluginPkg}" 2>&1`;

    // Fast path: if the plugin is already installed locally, skip the install command entirely.
    // openclaw plugins install loads ALL plugins before checking, wasting 15-30s even when already installed.
    const pluginLocalDir = path.join(os.homedir(), '.openclaw', 'extensions', openclawId, 'package.json');
    const pluginAlreadyInstalled = fs.existsSync(pluginLocalDir);

    sendStatus(`channels.status.configuring::${channelLabel}`);
    if (pluginAlreadyInstalled) {
      // Plugin is present on disk — skip install and go straight to login.
    } else try {
      await deps.runAsync(pluginInstallCmd, CHANNEL_PLUGIN_INSTALL_IDLE_TIMEOUT_MS);
    } catch (pluginErr: unknown) {
      const pluginMsg = toErrorMessage(pluginErr);
      if (isIgnorablePluginInstallError(pluginMsg)) {
        // Already installed / duplicate install metadata — continue setup.
      } else if (isTimeoutLike(pluginMsg)) {
        // First attempt timed out — retry with Chinese npm mirror (npmmirror.com).
        // This fixes WeChat plugin install failures caused by slow access to registry.npmjs.org.
        sendStatus(`channels.status.configuring::${channelLabel}`);
        try {
          await deps.runAsync(pluginInstallCmdMirror, CHANNEL_PLUGIN_INSTALL_IDLE_TIMEOUT_MS);
        } catch (retryInstallErr: unknown) {
          const retryMsg = toErrorMessage(retryInstallErr);
          if (!isIgnorablePluginInstallError(retryMsg)) {
            return { success: false, error: formatSetupError(openclawId, channelLabel, retryMsg) };
          }
        }
      } else if (process.platform === 'win32' && isNpxEnoentLike(pluginMsg)) {
        // Keep official OpenClaw behavior intact; only this command uses an isolated
        // config that disables memory plugin auto-start to avoid cross-plugin ENOENT.
        const scopedInstall = await runCommandWithScopedConfig(pluginInstallCmd, CHANNEL_PLUGIN_INSTALL_IDLE_TIMEOUT_MS);
        if (!scopedInstall.usedScopedConfig) {
          return { success: false, error: formatSetupError(openclawId, channelLabel, pluginMsg) };
        }

        if (scopedInstall.error) {
          if (!isIgnorablePluginInstallError(scopedInstall.error)) {
            return { success: false, error: formatSetupError(openclawId, channelLabel, scopedInstall.error) };
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

    // WeChat-specific pre-flight: detect known-broken plugin versions and auto-pin to a safe one.
    if (openclawId === 'openclaw-weixin') {
      await ensureWeChatPluginCompatible(sendStatus);
    }

    // JS-level login mutex. If a previous channel:setup is still inside its login
    // attempt, this caller waits in queue (no spawn yet, no extra OpenClaw process).
    // The lock is purely in-process: zero powershell, zero added latency on the
    // happy path. When the queue is empty, acquire returns immediately.
    //
    // Kill leftover login wrappers from PRIOR app sessions (orphans) BEFORE
    // spawning the new child. We MUST await this: killStaleChannelLogins captures
    // safe PIDs synchronously at call time. If we fire-and-forget, PowerShell runs
    // concurrently with channelLoginWithQR → the newly spawned child's PID is NOT
    // in the safe list (it didn't exist yet) → Stop-Process -Force kills it →
    // TerminateProcess(handle, -1) → exit code 0xFFFFFFFF = 4294967295.
    const releaseLoginLock = await acquireChannelLoginLock();
    await killStaleChannelLogins().catch(() => { /* best-effort */ });

    // CRITICAL: every code path below must release the lock — including early
    // returns and uncaught throws. We use a try/finally wrapper around the entire
    // handler body to guarantee release. The release is idempotent, so the explicit
    // release at the end of the login retry chain is also safe.
    try {

    sendStatus(`channels.status.connecting::${channelLabel}`);
    const loginCmd = `openclaw channels login --channel ${openclawId} --verbose`;
    let result = await deps.channelLoginWithQR(loginCmd, CHANNEL_LOGIN_IDLE_TIMEOUT_MS);
    let rawFailure = [result.error || '', result.output || ''].join('\n').trim();

    if (!result.success && process.platform === 'win32' && isStackOverflowLike(rawFailure)) {
      // Retry once with a larger V8 stack budget for plugin-heavy channels (notably WeChat).
      sendStatus(`channels.status.autoRetrying::${channelLabel}`);
      result = await deps.channelLoginWithQR(loginCmd, CHANNEL_LOGIN_IDLE_TIMEOUT_MS, {
        AWARENESS_OPENCLAW_STACK_SIZE_KB: '12288',
      });
      rawFailure = [result.error || '', result.output || ''].join('\n').trim();
    }

    if (!result.success && openclawId === 'openclaw-weixin' && isStackOverflowLike(rawFailure)) {
      // Upstream 2026.4.5 regression: unrelated plugins can crash during global preload.
      // Retry once with a scoped config that only enables the target channel plugin.
      sendStatus(`channels.status.autoRetrying::${channelLabel}`);
      const scoped = await runLoginWithScopedConfig(loginCmd, CHANNEL_LOGIN_IDLE_TIMEOUT_MS, {
        isolateToPluginId: openclawId,
        extraEnv: process.platform === 'win32'
          ? { AWARENESS_OPENCLAW_STACK_SIZE_KB: '12288' }
          : undefined,
      });
      if (scoped.usedScopedConfig) {
        result = scoped.result;
        rawFailure = [result.error || '', result.output || ''].join('\n').trim();
      }
    }

    if (!result.success && openclawId === 'openclaw-weixin') {
      const lowerFailure = (rawFailure || '').toLowerCase();
      const shouldForceRelink = isTimeoutLike(rawFailure)
        || lowerFailure.includes('qr code expired')
        || lowerFailure.includes('logged out')
        || lowerFailure.includes('session');

      // Keep the existing session when it's still healthy. If WeChat relink fails,
      // clear stale auth once and retry so users changing accounts can move to a new session.
      if (shouldForceRelink) {
        sendStatus(`channels.status.autoRetrying::${channelLabel}`);
        try {
          await deps.runAsync(`openclaw channels logout --channel ${openclawId} 2>&1`, CHANNEL_LOGOUT_IDLE_TIMEOUT_MS);
        } catch {
          // Best-effort cleanup; retry login even if logout fails.
        }
        result = await deps.channelLoginWithQR(loginCmd, CHANNEL_LOGIN_IDLE_TIMEOUT_MS, process.platform === 'win32'
          ? { AWARENESS_OPENCLAW_STACK_SIZE_KB: '12288' }
          : undefined);
        rawFailure = [result.error || '', result.output || ''].join('\n').trim();
      }
    }

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

    if (!result.success && hasNonTargetPluginLoadFailure(rawFailure, openclawId)) {
      // Product-level guard: OpenClaw CLI currently preloads all enabled plugins.
      // If an unrelated plugin (e.g. feishu) is broken, it can block the target
      // channel setup (e.g. wechat). Retry once with a command-scoped config that
      // isolates to the target plugin so customers can still connect channels.
      sendStatus(`channels.status.autoRetrying::${channelLabel}`);
      const scoped = await runLoginWithScopedConfig(loginCmd, CHANNEL_LOGIN_IDLE_TIMEOUT_MS, {
        isolateToPluginId: openclawId,
        extraEnv: process.platform === 'win32'
          ? { AWARENESS_OPENCLAW_STACK_SIZE_KB: '12288' }
          : undefined,
      });
      if (scoped.usedScopedConfig) {
        result = scoped.result;
        rawFailure = [result.error || '', result.output || ''].join('\n').trim();
      }
    }

    // Auto-retry once on transient failures (timeout / AbortError / handshake timeout).
    // The first attempt warms OpenClaw's plugin cache; the second usually succeeds without
    // forcing the user to click "Retry" manually. Only retries if we haven't already retried
    // via the plugin-repair path above.
    if (!result.success && isTransientLoginFailure(rawFailure)) {
      // Last-resort WeChat downgrade: if the first attempt failed with AbortError on a
      // version we don't have in KNOWN_BROKEN_WECHAT_VERSIONS yet, try the safe version.
      if (openclawId === 'openclaw-weixin' && /AbortError|This operation was aborted/i.test(rawFailure)) {
        sendStatus('channels.status.fixingWechatVersion');
        try {
          await deps.runAsync(
            `openclaw plugins install "@tencent-weixin/openclaw-weixin@${SAFE_WECHAT_VERSION}" --force 2>&1`,
            CHANNEL_PLUGIN_INSTALL_IDLE_TIMEOUT_MS,
          );
          try {
            const cfgRaw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
            const cfg = JSON.parse(cfgRaw);
            if (cfg && typeof cfg === 'object') {
              if (!isPlainRecord(cfg.plugins)) cfg.plugins = {};
              if (!isPlainRecord(cfg.plugins.entries)) cfg.plugins.entries = {};
              if (!isPlainRecord(cfg.plugins.entries['openclaw-weixin'])) cfg.plugins.entries['openclaw-weixin'] = {};
              cfg.plugins.entries['openclaw-weixin'].allowUnsigned = true;
              fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(cfg, null, 2));
            }
          } catch {}
        } catch { /* fall through to plain retry */ }
      }

      sendStatus(`channels.status.autoRetrying::${channelLabel}`);
      await sleep(2000);
      result = await deps.channelLoginWithQR(loginCmd, CHANNEL_LOGIN_IDLE_TIMEOUT_MS);
      rawFailure = [result.error || '', result.output || ''].join('\n').trim();
    }

    // Release the JS-level mutex now that all login attempts (incl. auto-retry) are
    // done. Subsequent steps (config write, agent bind, confirmation polling) don't
    // spawn another `channels login`, so they're safe outside the lock.
    releaseLoginLock();

    if (!result.success) {
      return {
        success: false,
        error: formatSetupError(openclawId, channelLabel, rawFailure || result.error || result.output || ''),
      };
    }

    if (result.success) {
      sanitizeLegacyChannelConfigFile(openclawId);

      // Ensure enabled:true is written to openclaw.json for all QR-login channels.
      // - For json-direct channels (WeChat) this is always needed: OpenClaw CLI never
      //   writes the flag for them.
      // - For cli-strategy channels (WhatsApp, Signal) `channels add` should already have
      //   set it, but we write defensively in case the CLI omitted it or wrote a different
      //   key structure. This is safe (idempotent) and cheap.
      try {
        const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
        const cfg = JSON.parse(raw);
        if (cfg && typeof cfg === 'object') {
          if (!cfg.channels) cfg.channels = {};
          if (!cfg.channels[openclawId]) cfg.channels[openclawId] = {};
          if (!cfg.channels[openclawId].enabled) {
            cfg.channels[openclawId].enabled = true;
            fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(cfg, null, 2));
          }
        }
      } catch { /* non-fatal — channel list still works via CLI fallback */ }

      // Flush the channel list cache so the next call returns fresh data.
      clearChannelStatusCache();

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

    } finally {
      // Failsafe release. The explicit releaseLoginLock() at the end of the login
      // retry chain has already fired on the happy path; this finally is the safety
      // net for any throw/early-return that bypassed it. release is idempotent so
      // double-release is a no-op.
      releaseLoginLock();
    }
  });
}