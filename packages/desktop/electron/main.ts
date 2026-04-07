const electron = require('electron');
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, dialog } = electron;
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { createDaemonWatchdog } from './daemon-watchdog';
import { createDoctor } from './doctor';
import { callMcpStrict } from './memory-client';
import {
  checkDaemonHealth,
  clearAwarenessLocalNpxCache,
  forceStopLocalDaemon,
  formatDaemonSetupError,
  getLocalDaemonHealth,
  shutdownLocalDaemon,
  startLocalDaemonDetached,
  waitForLocalDaemonReady,
} from './local-daemon';
import { GatewayClient } from './gateway-ws';
import { createChannelLoginWithQR } from './ipc/channel-login-flow';
import { registerAgentHandlers } from './ipc/register-agent-handlers';
import { registerAppUtilityHandlers } from './ipc/register-app-utility-handlers';
import { registerAppRuntimeHandlers } from './ipc/register-app-runtime-handlers';
import { registerChannelConfigHandlers } from './ipc/register-channel-config-handlers';
import { registerChannelListHandlers } from './ipc/register-channel-list-handlers';
import { registerChannelSessionHandlers } from './ipc/register-channel-session-handlers';
import { registerChannelSetupHandlers } from './ipc/register-channel-setup-handlers';
import { registerChatHandlers } from './ipc/register-chat-handlers';
import { registerCloudWorkspaceHandlers } from './ipc/register-cloud-workspace-handlers';
import { registerConfigIoHandlers } from './ipc/register-config-io-handlers';
import { registerCronHandlers } from './ipc/register-cron-handlers';
import { registerWorkflowHandlers } from './ipc/register-workflow-handlers';
import { registerFileDialogHandlers } from './ipc/register-file-dialog-handlers';
import { registerGatewayHandlers } from './ipc/register-gateway-handlers';
import { registerMemoryHandlers } from './ipc/register-memory-handlers';
import { registerOpenClawConfigHandlers } from './ipc/register-openclaw-config-handlers';
import { registerRuntimeHealthHandlers } from './ipc/register-runtime-health-handlers';
import { registerSetupHandlers } from './ipc/register-setup-handlers';
import { registerSkillHandlers } from './ipc/register-skill-handlers';
import { ensureInternalHook } from './internal-hook';
import {
  hasCompletedRuntimeMigration,
  markRuntimeMigrationCompleted,
  readRuntimePreferences,
  writeRuntimePreferences,
} from './runtime-preferences';
import { createShellUtils } from './shell-utils';
import { isGatewayRunningOutput } from './openclaw-config';
import { getAgentWorkspaceDir } from './openclaw-config';
import { hasExplicitExecApprovalConfig, writeDesktopExecApprovalDefaults } from './openclaw-config';
import { resolveDashboardUrl } from './openclaw-dashboard';
import {
  applyDesktopAwarenessPluginConfig,
  DESKTOP_LEGACY_BROWSER_WEB_MIGRATION_ID,
  forceEnableDesktopBrowserAndWebCapabilities,
  mergeDesktopOpenClawConfig,
  needsDesktopLegacyBrowserWebMigration,
  persistDesktopAwarenessPluginConfig,
  redactSensitiveValues,
  sanitizeDesktopAwarenessPluginConfig,
  stripRedactedValues,
} from './desktop-openclaw-config';
import { readJsonFileWithBom } from './json-file';

const DESKTOP_LEGACY_HOST_EXEC_MIGRATION_ID = 'desktop-legacy-host-exec-defaults-2026-04-04';

let mainWindow: typeof BrowserWindow.prototype | null = null;
let tray: typeof Tray.prototype | null = null;
let isQuitting = false;
let daemonStartupPromise: Promise<{ success: boolean; alreadyRunning?: boolean; error?: string }> | null = null;
let daemonStartupLastKickoff = 0;
let gatewayWsClient: GatewayClient | null = null;
let gatewayWsConnectPromise: Promise<GatewayClient> | null = null;
let gatewayRepairPromise: Promise<{ ok: boolean; error?: string }> | null = null;
let gatewayUserSessionLastLaunchAt = 0;

const GATEWAY_USER_SESSION_RELAUNCH_COOLDOWN_MS = 15000;
const DAEMON_FOREGROUND_BOOTSTRAP_TIMEOUT_MS = 240000;
const DAEMON_WAIT_AFTER_BOOTSTRAP_MS = 90000;

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

const isDev = !app.isPackaged;
const HOME = os.homedir();

const shellUtils = createShellUtils({ home: HOME, app });
const {
  getBundledNpmBin,
  getEnhancedPath,
  getGatewayPort,
  getNodeVersion,
  readShellOutputAsync,
  resolveBundledCache,
  run,
  runAsync,
  runAsyncWithProgress,
  runSpawn,
  runSpawnAsync,
  safeShellExec,
  safeShellExecAsync,
  stripAnsi,
  wrapWindowsCommand,
} = shellUtils;

const channelLoginWithQR = createChannelLoginWithQR({
  getEnhancedPath,
  wrapWindowsCommand,
  stripAnsi,
  sendToRenderer: (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  },
});

function sendSetupDaemonStatus(key: string, detail?: string) {
  mainWindow?.webContents.send('setup:daemon-status', { key, detail });
}

function sendSetupStatus(stepKey: string, key: string, detail?: string) {
  mainWindow?.webContents.send('setup:status', { stepKey, key, detail });
}

function createWindow() {
  const builtIndexPath = path.join(__dirname, '../dist/index.html');

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173').then(() => {
      mainWindow?.webContents.openDevTools({ mode: 'detach' });
    }).catch(async (err: any) => {
      console.warn('[desktop] Dev server unavailable, falling back to built frontend:', err?.message || err);
      if (fs.existsSync(builtIndexPath) && mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadFile(builtIndexPath);
      }
    });
  } else {
    mainWindow.loadFile(builtIndexPath);
  }

  mainWindow.on('close', (e: Event) => {
    if (!isQuitting && tray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- Helpers ---

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

const applyAwarenessPluginConfig = (config: Record<string, any>, options?: { enableSlot?: boolean }) => {
  applyDesktopAwarenessPluginConfig(config, options);
};

const sanitizeAwarenessPluginConfig = (config: Record<string, any>) => {
  sanitizeDesktopAwarenessPluginConfig(config, HOME);
};

const persistAwarenessPluginConfig = (options?: { enableSlot?: boolean }) => {
  persistDesktopAwarenessPluginConfig(HOME, options);
};

const mergeOpenClawConfig = (existing: Record<string, any>, incoming: Record<string, any>) => {
  return mergeDesktopOpenClawConfig(existing, incoming, HOME);
};

function computeSha256(filePath: string) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          file.close();
          fs.unlinkSync(dest);
          downloadFile(redirectUrl, dest).then(resolve).catch(reject);
          return;
        }
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

// --- PTY Management (for embedded openclaw chat) ---

function repairOpenClawConfigFile() {
  const configDir = path.join(HOME, '.openclaw');
  const configPath = path.join(configDir, 'openclaw.json');

  try {
    if (!fs.existsSync(configPath)) return;
    const current = readJsonFileWithBom<Record<string, any>>(configPath);
    const runtimePreferences = readRuntimePreferences();
    let nextRuntimePreferences = runtimePreferences;

    const shouldMarkLegacyMigration = !hasCompletedRuntimeMigration(
      runtimePreferences,
      DESKTOP_LEGACY_BROWSER_WEB_MIGRATION_ID,
    );
    const shouldMarkLegacyHostExecMigration = !hasCompletedRuntimeMigration(
      runtimePreferences,
      DESKTOP_LEGACY_HOST_EXEC_MIGRATION_ID,
    );

    if (shouldMarkLegacyMigration && needsDesktopLegacyBrowserWebMigration(current)) {
      forceEnableDesktopBrowserAndWebCapabilities(current);
    }

    if (shouldMarkLegacyHostExecMigration && !hasExplicitExecApprovalConfig(HOME)) {
      writeDesktopExecApprovalDefaults(HOME);
    }

    sanitizeAwarenessPluginConfig(current);

    // Ensure multi-agent collaboration is enabled by default.
    // Users should not need to manually enable this from the Workflow page.
    // Verified via https://docs.openclaw.ai/tools/subagents — these are the
    // correct field names for agent-to-agent spawning in OpenClaw.
    if (!current.tools) current.tools = {};
    if (!current.tools.agentToAgent) current.tools.agentToAgent = {};
    if (!current.tools.agentToAgent.enabled) {
      current.tools.agentToAgent.enabled = true;
      current.tools.agentToAgent.allow = ['*'];
    }
    if (!current.tools.alsoAllow) current.tools.alsoAllow = [];
    for (const tool of ['sessions_spawn', 'agents_list']) {
      if (!current.tools.alsoAllow.includes(tool)) {
        current.tools.alsoAllow.push(tool);
      }
    }
    if (!current.agents) current.agents = {};
    if (!current.agents.defaults) current.agents.defaults = {};
    if (!current.agents.defaults.subagents) current.agents.defaults.subagents = {};
    if ((current.agents.defaults.subagents.maxSpawnDepth ?? 1) < 2) {
      current.agents.defaults.subagents.maxSpawnDepth = 2;
    }
    // Per-agent allowAgents must be on each agent entry (schema rejects agents.defaults)
    if (Array.isArray(current.agents?.list)) {
      for (const agent of current.agents.list) {
        if (!agent.subagents) agent.subagents = {};
        if (!agent.subagents.allowAgents) agent.subagents.allowAgents = ['*'];
      }
    }

    fs.writeFileSync(configPath, JSON.stringify(current, null, 2));

    if (shouldMarkLegacyMigration) {
      nextRuntimePreferences = markRuntimeMigrationCompleted(
        nextRuntimePreferences,
        DESKTOP_LEGACY_BROWSER_WEB_MIGRATION_ID,
      );
    }
    if (shouldMarkLegacyHostExecMigration) {
      nextRuntimePreferences = markRuntimeMigrationCompleted(
        nextRuntimePreferences,
        DESKTOP_LEGACY_HOST_EXEC_MIGRATION_ID,
      );
    }
    if (nextRuntimePreferences !== runtimePreferences) {
      writeRuntimePreferences(nextRuntimePreferences);
    }
  } catch {
    // Best-effort config repair only.
  }
}

function isWindowsGatewayServiceMissing(output: string | null) {
  if (!output || process.platform !== 'win32') return false;
  return output.includes('Scheduled Task (missing)') || output.includes('schtasks run failed');
}

function isGatewayPermissionError(output: string | null) {
  if (!output) return false;
  return /EACCES|Access is denied|permission denied|拒绝访问|schtasks create failed/i.test(output);
}

type GatewayStatusSnapshot = {
  service?: {
    runtime?: {
      status?: string;
    };
  };
  port?: {
    status?: string;
  };
  rpc?: {
    ok?: boolean;
  };
  health?: {
    healthy?: boolean;
  };
};

async function readGatewayStatusSnapshot(): Promise<GatewayStatusSnapshot | null> {
  try {
    const raw = await runSpawnAsync('openclaw', ['gateway', 'status', '--json'], 15000);
    return JSON.parse(raw) as GatewayStatusSnapshot;
  } catch {
    return null;
  }
}

function isGatewaySnapshotHealthy(snapshot: GatewayStatusSnapshot | null): boolean {
  if (!snapshot) return false;
  const runtimeRunning = snapshot.service?.runtime?.status === 'running';
  const portBusy = snapshot.port?.status === 'busy';
  return !!snapshot.rpc?.ok && !!snapshot.health?.healthy && (runtimeRunning || portBusy);
}

async function ensureLocalDaemonReadyForRuntime(send?: (ch: string, data: any) => void): Promise<boolean> {
  const daemonProjectDir = path.join(HOME, '.openclaw');

  const isDaemonHealthStable = async () => {
    if (!(await checkDaemonHealth())) return false;
    await sleep(700);
    return checkDaemonHealth();
  };

  const bootstrapDaemonInForeground = async () => {
    const daemonSpec = resolveBundledCache('awareness-sdk-local.tgz') || '@awareness-sdk/local@latest';
    const daemonArgs = ['-y', daemonSpec, 'start', '--port', '37800', '--project', daemonProjectDir, '--background'];
    const bundledNpxCli = getBundledNpmBin('npx');

    try {
      if (bundledNpxCli) {
        await runSpawnAsync(process.execPath, [bundledNpxCli, ...daemonArgs], DAEMON_FOREGROUND_BOOTSTRAP_TIMEOUT_MS);
        return true;
      }

      if (process.platform === 'win32') {
        await runSpawnAsync('cmd.exe', ['/d', '/c', 'npx', ...daemonArgs], DAEMON_FOREGROUND_BOOTSTRAP_TIMEOUT_MS);
      } else {
        await runSpawnAsync('npx', daemonArgs, DAEMON_FOREGROUND_BOOTSTRAP_TIMEOUT_MS);
      }
      return true;
    } catch {
      return false;
    }
  };

  if (await isDaemonHealthStable()) return true;

  const emit = (message: string) => send?.('chat:status', { type: 'gateway', message });

  if (!daemonStartupPromise) {
    daemonStartupLastKickoff = Date.now();
    daemonStartupPromise = (async () => {
      if (await isDaemonHealthStable()) return { success: true, alreadyRunning: true };

      emit('Preparing local memory service...');

      try {
        await startLocalDaemonDetached({
          homedir: HOME,
          resolveBundledCache,
          getBundledNpmBin,
          runSpawn,
          getEnhancedPath,
        });
      } catch (err) {
        console.warn('[gateway] Failed to launch local daemon before Gateway start:', err);
      }

      const ready = await waitForLocalDaemonReady(45000, 'setup.install.daemonStatus.waiting', {
        sendStatus: sendSetupDaemonStatus,
        sleep,
      });

      if (ready && await isDaemonHealthStable()) {
        emit('Local memory service ready');
        return { success: true };
      }

      if (ready) {
        // Health flipped immediately after first ready signal; wait one more short window.
        const warmed = await waitForLocalDaemonReady(12000, 'setup.install.daemonStatus.waiting', {
          sendStatus: sendSetupDaemonStatus,
          sleep,
        });
        if (warmed && await isDaemonHealthStable()) {
          emit('Local memory service ready');
          return { success: true };
        }
      }

      emit('Local memory service is still warming up, applying deeper repair...');
      try {
        await forceStopLocalDaemon({ sleep });
      } catch {
        // best-effort cleanup before foreground bootstrap
      }
      clearAwarenessLocalNpxCache(HOME);

      const foregroundBootstrapped = await bootstrapDaemonInForeground();
      if (foregroundBootstrapped) {
        const afterBootstrapReady = await waitForLocalDaemonReady(
          DAEMON_WAIT_AFTER_BOOTSTRAP_MS,
          'setup.install.daemonStatus.waiting',
          { sendStatus: sendSetupDaemonStatus, sleep },
        );
        if (afterBootstrapReady && await isDaemonHealthStable()) {
          emit('Local memory service ready');
          return { success: true };
        }
      }

      return { success: false, error: formatDaemonSetupError() };
    })();
  }

  try {
    const result = await daemonStartupPromise;
    return !!(result.success || result.alreadyRunning || await isDaemonHealthStable());
  } finally {
    daemonStartupPromise = null;
  }
}

function startGatewayRepairInBackground(send?: (ch: string, data: any) => void) {
  if (gatewayRepairPromise) return gatewayRepairPromise;

  gatewayRepairPromise = startGatewayWithRepair(send)
    .catch((err) => {
      console.warn('[gateway] Background repair failed:', err?.message || err);
      return { ok: false, error: err?.message || String(err) };
    })
    .finally(() => {
      gatewayRepairPromise = null;
    });

  return gatewayRepairPromise;
}

async function startGatewayInUserSession(send?: (ch: string, data: any) => void): Promise<{ ok: boolean; error?: string }> {
  send?.('chat:status', { type: 'gateway', message: 'Starting temporary Gateway...' });

  const launchRecently = (Date.now() - gatewayUserSessionLastLaunchAt) < GATEWAY_USER_SESSION_RELAUNCH_COOLDOWN_MS;

  try {
    if (process.platform === 'win32') {
      // Guard against global OpenClaw removal: avoid `start ... openclaw` popup.
      try {
        await runSpawnAsync('cmd.exe', ['/d', '/c', 'where', 'openclaw'], 5000);
      } catch {
        return {
          ok: false,
          error: 'OpenClaw command is not ready yet. Please finish Setup first, then retry.',
        };
      }

      if (!launchRecently) {
        // Spawn OpenClaw directly to avoid creating visible cmd.exe /K windows on Windows.
        const child = runSpawn('openclaw', ['gateway', 'run', '--force', '--allow-unconfigured'], {
          cwd: HOME,
          detached: true,
          windowsHide: true,
          stdio: 'ignore',
        });
        gatewayUserSessionLastLaunchAt = Date.now();
        child.unref();
      }
    } else {
      if (!launchRecently) {
        const child = runSpawn('openclaw', ['gateway', 'run', '--force', '--allow-unconfigured'], {
          cwd: HOME,
          detached: true,
          windowsHide: true,
          stdio: 'ignore',
        });
        gatewayUserSessionLastLaunchAt = Date.now();
        child.unref();
      }
    }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Could not launch the temporary Gateway process.' };
  }

  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const snapshot = await readGatewayStatusSnapshot();
    if (isGatewaySnapshotHealthy(snapshot)) {
      await sleep(1200);
      const confirmedSnapshot = await readGatewayStatusSnapshot();
      if (!isGatewaySnapshotHealthy(confirmedSnapshot)) {
        continue;
      }
      if (process.platform === 'win32') {
        writeRuntimePreferences({ ...readRuntimePreferences(), preferUserSessionGateway: true });
      }
      send?.('chat:status', { type: 'gateway', message: 'Gateway started in app session' });
      return { ok: true };
    }
  }

  if (process.platform === 'win32') {
    writeRuntimePreferences({ ...readRuntimePreferences(), preferUserSessionGateway: false });
  }

  return {
    ok: false,
    error: 'AwarenessClaw could not start the local Gateway automatically. Please check Settings → Gateway and try again.',
  };
}

async function startGatewayWithRepair(send?: (ch: string, data: any) => void): Promise<{ ok: boolean; error?: string }> {
  repairOpenClawConfigFile();

  // Fast path: HTTP probe avoids the 15-30s CLI plugin preload when the
  // gateway is already up. OpenClaw 4.5 loads all plugins on every CLI call.
  const port = getGatewayPort();
  const httpProbeOk = await new Promise<boolean>((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/healthz`, { timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
  if (httpProbeOk) return { ok: true };

  // Fallback: CLI check still handles non-default ports and older installs.
  const statusOutput = await readShellOutputAsync('openclaw gateway status 2>&1', 15000);
  if (isGatewayRunningOutput(statusOutput)) return { ok: true };

  const emit = (message: string) => send?.('chat:status', { type: 'gateway', message });
  const prefs = readRuntimePreferences();

  if (process.platform === 'win32') {
    await ensureLocalDaemonReadyForRuntime(send);
  }

  if (process.platform === 'win32' && prefs.preferUserSessionGateway) {
    emit('Starting Gateway in your Windows session...');
    const fallback = await startGatewayInUserSession(send);
    if (fallback.ok) return fallback;
  }

  let shouldInstallService = isWindowsGatewayServiceMissing(statusOutput);

  if (shouldInstallService) {
    emit('Installing local Gateway service...');
    try {
      await runAsync('openclaw gateway install 2>&1', 30000);
    } catch (err: any) {
      const message = err?.message || '';
      if (process.platform === 'win32') {
        const fallback = await startGatewayInUserSession(send);
        if (fallback.ok) return fallback;
        return {
          ok: false,
          error: isGatewayPermissionError(message)
            ? 'AwarenessClaw could not install the Windows Gateway service because administrator permission was denied, and the temporary Gateway fallback also failed. Please reopen the app as administrator once, then try again.'
            : 'AwarenessClaw could not install the Windows Gateway service automatically, and the temporary Gateway fallback also failed. Please reopen the app once and try again, or use Settings → Gateway for manual repair.',
        };
      }
      return {
        ok: false,
        error: 'The local Gateway service could not be installed automatically. Please check Settings → Gateway and try again.',
      };
    }
  }

  emit('Starting Gateway...');
  try {
    await runAsync('openclaw gateway start 2>&1', 20000);
    if (process.platform === 'win32' && prefs.preferUserSessionGateway) {
      writeRuntimePreferences({ ...prefs, preferUserSessionGateway: false });
    }
  } catch (err: any) {
    const message = err?.message || '';

    if (process.platform === 'win32' && !shouldInstallService && message.includes('schtasks run failed')) {
      shouldInstallService = true;
      emit('Repairing local Gateway service...');
      try {
        await runAsync('openclaw gateway install 2>&1', 30000);
        await runAsync('openclaw gateway start 2>&1', 20000);
      } catch (repairErr: any) {
        const repairMessage = repairErr?.message || '';
        if (process.platform === 'win32') {
          const fallback = await startGatewayInUserSession(send);
          if (fallback.ok) return fallback;
          return {
            ok: false,
            error: isGatewayPermissionError(repairMessage)
              ? 'AwarenessClaw could not repair the Windows Gateway service because administrator permission was denied, and the temporary Gateway fallback also failed. Please reopen the app as administrator once, then try again.'
              : 'AwarenessClaw could not repair the Windows Gateway service automatically, and the temporary Gateway fallback also failed. Please reopen the app once and try again, or use Settings → Gateway for manual repair.',
          };
        }
        return {
          ok: false,
          error: 'AwarenessClaw could not repair the local Gateway service automatically. Please check Settings → Gateway and try again.',
        };
      }
    } else if (/not recognized|not found|ENOENT/i.test(message)) {
      return {
        ok: false,
        error: 'OpenClaw could not be found on this computer. Please finish Setup first, or reinstall OpenClaw in Settings before chatting.',
      };
    } else {
      return {
        ok: false,
        error: 'Gateway failed to start. Please check Settings → Gateway and try again.',
      };
    }
  }

  // Poll with backoff: 1s×3, 2s×3 = ~12s max (down from 10×1s + 15s timeout each)
  for (let i = 0; i < 6; i++) {
    const delay = i < 3 ? 1000 : 2000;
    await sleep(delay);
    const check = await readShellOutputAsync('openclaw gateway status 2>&1', 8000);
    if (isGatewayRunningOutput(check)) {
      emit('Gateway started');
      return { ok: true };
    }
  }

  if (process.platform === 'win32') {
    emit('Gateway service did not stay up, switching to app session mode...');
    const fallback = await startGatewayInUserSession(send);
    if (fallback.ok) return fallback;
  }

  return {
    ok: false,
    error: 'Gateway failed to start in time. Please check Settings → Gateway and try again.',
  };
}

/**
 * Ensure Gateway is running before sending chat messages.
 * Auto-starts if stopped. Returns a user-facing error instead of crashing if
 * OpenClaw is missing or the gateway cannot be started.
 */
async function ensureGatewayRunning(): Promise<{ ok: boolean; error?: string }> {
  const send = (ch: string, data: any) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data);
  };

  try {
    const openclawVersion = await safeShellExecAsync('openclaw --version', 5000);
    if (!openclawVersion) {
      send('chat:status', { type: 'error', message: 'OpenClaw is not installed' });
      return {
        ok: false,
        error: 'OpenClaw is not installed yet. Please finish Setup first, or reinstall OpenClaw in Settings before chatting.',
      };
    }

    const started = await startGatewayWithRepair(send);
    if (!started.ok) {
      send('chat:status', { type: 'error', message: 'Gateway failed to start' });
      return started;
    }
    return started;
  } catch {
    send('chat:status', { type: 'error', message: 'Gateway check failed' });
    return {
      ok: false,
      error: 'Could not verify the OpenClaw environment. Please finish Setup first, then try again.',
    };
  }
}

async function prepareGatewayForChat(): Promise<{ ok: boolean; error?: string }> {
  const send = (ch: string, data: any) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data);
  };

  try {
    const openclawVersion = await safeShellExecAsync('openclaw --version', 5000);
    if (!openclawVersion) {
      return {
        ok: false,
        error: 'OpenClaw is not installed yet. Please finish Setup first, or reinstall OpenClaw in Settings before chatting.',
      };
    }

    if (gatewayWsClient?.isConnected) {
      return { ok: true };
    }

    const statusOutput = await readShellOutputAsync('openclaw gateway status 2>&1', 4000);
    if (isGatewayRunningOutput(statusOutput)) {
      return { ok: true };
    }

    startGatewayRepairInBackground(send);

    return {
      ok: false,
      error: 'Local Gateway is still warming up. Answering directly while background services recover.',
    };
  } catch {
    startGatewayRepairInBackground(send);
    return {
      ok: false,
      error: 'OpenClaw background services are still warming up. Answering directly for now.',
    };
  }
}

async function prepareCliFallback(): Promise<void> {
  const send = (ch: string, data: any) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data);
  };

  if (process.platform !== 'win32') return;

  const ready = await ensureLocalDaemonReadyForRuntime(send);
  if (!ready) {
    throw new Error('LOCAL_DAEMON_NOT_READY');
  }
}

// --- Channel Configuration (registry-driven) ---
// Import channel registry for dynamic channel metadata
import {
  getChannel, getChannelByOpenclawId, toOpenclawId, toFrontendId,
  buildCLIFlags, getAllChannels, serializeRegistry,
  mergeCatalog, mergeChannelOptions,
  parseChannelCapabilitiesJson, applyChannelCapabilities,
  parseCliHelp, applyCliHelp,
  type CatalogEntry,
} from './channel-registry';

// Discover channels from OpenClaw installation at startup
function discoverOpenClawChannels(): void {
  try {
    const stderrRedirect = process.platform === 'win32' ? '2>NUL' : '2>/dev/null';
    let distDir = '';

    // Strategy 0: managed runtime dist (AwarenessClaw bundled install)
    const managedCandidates = [
      path.join(HOME, '.awareness-claw', 'openclaw-runtime', 'node_modules', 'openclaw', 'dist'),
      path.join(HOME, '.awareness-claw', 'openclaw-runtime', 'lib', 'node_modules', 'openclaw', 'dist'),
    ];
    for (const candidate of managedCandidates) {
      if (fs.existsSync(candidate)) { distDir = candidate; break; }
    }

    // Strategy 1: `npm root -g` → <prefix>/lib/node_modules → append openclaw/dist
    // This is the most reliable cross-platform approach (works with nvm, custom prefix, Windows)
    try {
      const globalRoot = safeShellExec(`npm root -g ${stderrRedirect}`)?.trim();
      if (globalRoot) {
        const candidate = path.join(globalRoot, 'openclaw', 'dist');
        if (fs.existsSync(candidate)) distDir = candidate;
      }
    } catch { /* npm not in PATH */ }

    // Strategy 2: resolve `which openclaw` symlink
    if (!distDir) {
      try {
        const lookupCommand = process.platform === 'win32'
          ? `where openclaw ${stderrRedirect}`
          : `which openclaw ${stderrRedirect}`;
        const ocPath = safeShellExec(lookupCommand)?.trim();
        if (ocPath) {
          const realPath = fs.realpathSync(ocPath);
          const candidate = path.join(path.dirname(realPath), 'dist');
          if (fs.existsSync(candidate)) distDir = candidate;
        }
      } catch { /* which failed */ }
    }

    const debugLog = (msg: string) => { try { fs.appendFileSync(path.join(HOME, '.awareness-channel-debug.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch {} };
    if (!distDir) {
      debugLog('dist NOT found. managed runtime + npm-root-g + which-openclaw all failed');
      console.log('[channel-registry] OpenClaw dist not found, using builtins only');
      return;
    }
    debugLog(`dist found: ${distDir}`);
    console.log(`[channel-registry] Found OpenClaw at: ${distDir}`);

    // Load official CLI startup metadata first. This is OpenClaw's own precomputed
    // list of CLI-supported channel ids and is more stable than parsing help text.
    try {
      const metaPath = path.join(distDir, 'cli-startup-metadata.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.channelOptions) mergeChannelOptions(meta.channelOptions);
    } catch { /* metadata not found */ }

    // Load channel-catalog.json
    try {
      const catalogPath = path.join(distDir, 'channel-catalog.json');
      const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      if (catalog.entries) mergeCatalog(catalog.entries as CatalogEntry[]);
    } catch { /* catalog not found */ }
  } catch { /* openclaw not installed */ }
}

// --- Channel Conversations (Unified Inbox) ---

/**
 * Get or create a persistent Gateway WS client for channel session queries.
 * Lazy-connects on first use, auto-reconnects on disconnect.
 */
async function getGatewayWs(options?: { onPairingRepairStart?: () => void; onPairingRepair?: () => void }): Promise<GatewayClient> {
  if (!gatewayWsClient) {
    gatewayWsClient = new GatewayClient();

    // Forward real-time channel messages to renderer
    gatewayWsClient.on('event:session.message', (payload: any) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('channel:message', {
          sessionKey: payload.sessionKey || payload.key || '',
          message: payload.message || payload,
        });
      }
    });
  }

  // Already connected — fast path (most common case)
  if (gatewayWsClient.isConnected) return gatewayWsClient;

  // Connection mutex: if a connect() is already in flight, await the same promise
  // instead of creating a second WebSocket. Concurrent callers (e.g. attachSubagentListener
  // + mission:start IPC handler) would otherwise race on new WebSocket(), causing
  // "WebSocket was closed before the connection was established".
  if (gatewayWsConnectPromise) return gatewayWsConnectPromise;

  gatewayWsConnectPromise = (async () => {
    try {
      try {
        await gatewayWsClient!.connect();
      } catch (err: any) {
        const message = err?.message || '';
        if (!/pairing required/i.test(message)) throw err;

        options?.onPairingRepairStart?.();

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('chat:status', {
            type: 'gateway',
            message: 'Approving local Gateway device access...',
          });
        }

        const approvalOutput = await runAsync('openclaw devices approve --latest 2>&1', 30000).catch(() => '');
        if (!/Approved\s+/i.test(approvalOutput || '')) {
          throw err;
        }

        options?.onPairingRepair?.();
        await gatewayWsClient!.connect();
      }

      // Pre-warm write scopes so the first chatSend's ensureWriteScopes() is a no-op.
      // Without this, the scope upgrade on the first chat triggers a fresh WS reconnect
      // that can hit "pairing required" again — and that error bypasses the pairing repair
      // logic here in getGatewayWs because ensureWriteScopes calls connect() directly.
      if (!gatewayWsClient!.hasWriteScopes) {
        try {
          await gatewayWsClient!.warmUpWriteScopes();
        } catch (scopeErr: any) {
          const scopeMsg = scopeErr?.message || '';
          if (/pairing required/i.test(scopeMsg)) {
            const approvalOutput = await runAsync('openclaw devices approve --latest 2>&1', 30000).catch(() => '');
            if (/Approved\s+/i.test(approvalOutput || '')) {
              try {
                await gatewayWsClient!.warmUpWriteScopes();
              } catch {
                // Pre-warm failed even after approval; will retry on first chatSend
              }
            }
          }
          // Non-pairing scope errors are ignored — write scope pre-warm is best-effort
        }
      }

      return gatewayWsClient!;
    } finally {
      // Clear the mutex so future disconnects can reconnect normally
      gatewayWsConnectPromise = null;
    }
  })();

  return gatewayWsConnectPromise;
}

async function ensureGatewayAccessForStartup(
  sendStatus: (message: string, progress: number) => void,
): Promise<{ ok: boolean; repaired?: boolean; message?: string; error?: string }> {
  let repaired = false;

  try {
    await getGatewayWs({
      onPairingRepairStart: () => sendStatus('Approving local Gateway device access...', 97),
      onPairingRepair: () => { repaired = true; },
    });

    return {
      ok: true,
      repaired,
      message: repaired ? 'Local Gateway access was approved automatically.' : 'Local Gateway access is ready.',
    };
  } catch (err: any) {
    return {
      ok: false,
      error: repaired
        ? 'Local Gateway access was approved, but reconnect is still finishing. The app will retry automatically when you open chat.'
        : (err?.message || 'Could not prepare local Gateway access automatically.'),
    };
  }
}

/** Channel icon lookup for known channels. */
// CHANNEL_ICONS removed — frontend now uses <ChannelIcon> component with registry

const WORKSPACE_DIR = path.join(HOME, '.openclaw', 'workspace');

function readCurrentWorkspaceDir() {
  return getAgentWorkspaceDir(HOME);
}

let doctorInstance: ReturnType<typeof createDoctor> | null = null;

function getDoctor() {
  if (!doctorInstance) {
    doctorInstance = createDoctor({
      shellExec: safeShellExecAsync,
      shellRun: runAsync,
      homedir: HOME,
      platform: process.platform,
    });
  }
  return doctorInstance;
}

const doctor = {
  runAllChecks: () => getDoctor().runAllChecks(),
  runChecks: (subset?: string[]) => getDoctor().runChecks(subset),
  runChecksStreaming: (
    onCheckStart: (checkId: string) => void,
    onCheckResult: (result: any) => void,
    subset?: string[],
  ) => getDoctor().runChecksStreaming(onCheckStart, onCheckResult, subset),
  runFix: (checkId: string) => getDoctor().runFix(checkId),
};

// --- System Tray ---

function createTray() {
  const iconPath = path.join(__dirname, isDev ? '../resources/icon.png' : '../../resources/icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
    trayIcon.setTemplateImage(true); // macOS dark/light mode support
  } catch {
    return; // Skip tray if icon not found
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('AwarenessClaw');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show AwarenessClaw',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'New Chat',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('tray:new-chat');
        }
      },
    },
    {
      label: 'Open Dashboard',
      click: async () => {
        const url = await resolveDashboardUrl(readShellOutputAsync);
        shell.openExternal(url);
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      accelerator: 'CmdOrCtrl+Q',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Click tray icon to show or focus the main window.
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    } else {
      createWindow();
    }
  });
}

const daemonWatchdog = createDaemonWatchdog({
  homedir: HOME,
  getEnhancedPath,
  getLocalDaemonHealth,
});

ipcMain.handle('daemon:mark-connected', () => {
  daemonWatchdog.markConnected();
});

registerAppUtilityHandlers({
  safeShellExecAsync,
  readShellOutputAsync,
  homedir: HOME,
  getMainWindow: () => mainWindow,
});
registerAppRuntimeHandlers({
  home: HOME,
  safeShellExecAsync,
  getLocalDaemonHealth,
  runAsync,
  runAsyncWithProgress,
  getBundledNpmBin,
  shutdownLocalDaemon,
  clearAwarenessLocalNpxCache,
  doctor,
  getMainWindow: () => mainWindow,
});
registerChatHandlers({
  sendToRenderer: (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  },
  ensureGatewayRunning,
  prepareGatewayForChat,
  prepareCliFallback,
  getGatewayWs,
  getConnectedGatewayWs: () => (gatewayWsClient?.isConnected ? gatewayWsClient : null),
  callMcpStrict,
  getEnhancedPath,
  runSpawn,
  wrapWindowsCommand,
  stripAnsi,
});
registerAgentHandlers({
  home: HOME,
  safeShellExecAsync,
  readShellOutputAsync,
  ensureGatewayRunning,
  runAsync,
  runSpawnAsync,
});
registerChannelConfigHandlers({
  home: HOME,
  safeShellExecAsync,
  readShellOutputAsync,
  runAsync,
  discoverOpenClawChannels,
  parseChannelCapabilitiesJson,
  applyChannelCapabilities,
  parseCliHelp,
  applyCliHelp,
  mergeCatalog,
  mergeChannelOptions,
  getAllChannels,
  serializeRegistry,
  getChannel,
  buildCLIFlags,
  toOpenclawId,
});
registerChannelListHandlers({
  home: HOME,
  safeShellExecAsync,
  readShellOutputAsync,
  toFrontendId,
});
registerChannelSessionHandlers({
  getGatewayWs,
  toFrontendId,
});
registerChannelSetupHandlers({
  getMainWindow: () => mainWindow,
  getChannel,
  runAsync,
  safeShellExecAsync,
  readShellOutputAsync,
  channelLoginWithQR,
  ensureLocalDaemonReadyForRuntime: () => ensureLocalDaemonReadyForRuntime(),
});
registerCronHandlers({
  readShellOutputAsync,
  runSpawnAsync,
});
registerWorkflowHandlers({
  home: HOME,
  safeShellExecAsync,
  runAsync,
  runSpawnAsync,
  getGatewayWs,
  getMainWindow: () => mainWindow,
});
registerGatewayHandlers({
  readShellOutputAsync,
  runAsync,
  startGatewayWithRepair: () => startGatewayWithRepair(),
  isGatewayRunningOutput: (output) => isGatewayRunningOutput(output ?? null),
});
registerMemoryHandlers();
registerFileDialogHandlers();
const { prefetchSchema } = registerOpenClawConfigHandlers({
  home: HOME,
  safeShellExecAsync,
  readShellOutputAsync,
  mergeOpenClawConfig,
});
registerSkillHandlers({
  home: HOME,
  runAsync,
  runAsyncWithProgress,
  runSpawnAsync,
  readShellOutputAsync,
});
registerCloudWorkspaceHandlers({
  home: HOME,
  getWorkspaceDir: readCurrentWorkspaceDir,
});
registerConfigIoHandlers({
  home: HOME,
  getMainWindow: () => mainWindow,
  redactSensitiveValues,
  stripRedactedValues,
  mergeOpenClawConfig,
});
registerSetupHandlers({
  home: HOME,
  getEnhancedPath,
  getNodeVersion,
  runAsync,
  safeShellExecAsync,
  getBundledNpmBin,
  resolveBundledCache,
  downloadFile,
  sleep,
  getLocalDaemonHealth,
  checkDaemonHealth,
  waitForLocalDaemonReady,
  sendSetupDaemonStatus,
  startLocalDaemonDetached,
  runSpawn,
  forceStopLocalDaemon,
  clearAwarenessLocalNpxCache,
  formatDaemonSetupError,
  persistAwarenessPluginConfig,
  applyAwarenessPluginConfig,
  sanitizeAwarenessPluginConfig,
  mergeOpenClawConfig,
  getDaemonStartupPromise: () => daemonStartupPromise,
  setDaemonStartupPromise: (value) => { daemonStartupPromise = value; },
  getDaemonStartupLastKickoff: () => daemonStartupLastKickoff,
  setDaemonStartupLastKickoff: (value) => { daemonStartupLastKickoff = value; },
  sendSetupStatus,
});
registerRuntimeHealthHandlers({
  home: HOME,
  app,
  dirname: __dirname,
  safeShellExec,
  safeShellExecAsync,
  doctor,
  computeSha256,
  checkDaemonHealth,
  waitForLocalDaemonReady,
  sendSetupDaemonStatus,
  sleep,
  recentDaemonStartup: () => !!daemonStartupPromise || (Date.now() - daemonStartupLastKickoff < 180000),
  ensureGatewayAccess: ensureGatewayAccessForStartup,
  getMainWindow: () => mainWindow,
});

// --- App Lifecycle ---

app.whenReady().then(() => {
  // Deploy internal hook for awareness memory backup (idempotent, version-gated)
  ensureInternalHook(HOME);

  // Ensure config has required gateway defaults before anything tries to start
  repairOpenClawConfigFile();

  createWindow();
  createTray();

  // Best-effort: start Gateway early so it's ready when user sends first message
  startGatewayRepairInBackground().catch((err) => {
    console.warn('[startup] Gateway pre-start failed (will retry on first chat):', err?.message || err);
  });

  // Start watchdog after a delay (give startup flow time to connect daemon first)
  setTimeout(() => {
    if (!daemonWatchdog.isRunning()) daemonWatchdog.startDaemonWatchdog();
  }, 30_000);

  // Warm up the OpenClaw config schema cache in the background.
  // Runs after a 60 s delay so it doesn't compete with gateway / daemon startup.
  // By the time the user opens Settings → Web & Browser, the schema is usually ready.
  setTimeout(() => {
    prefetchSchema().catch(() => {});
  }, 60_000);
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  createWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
  daemonWatchdog.stopDaemonWatchdog();
  // Force-kill any shell children (e.g. hung `openclaw skills list --json`) that
  // were spawned with detached:true. Without this they survive as orphan processes.
  shellUtils.killAllTrackedShellChildren();
});

app.on('window-all-closed', () => {
  if (!isQuitting && tray) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
