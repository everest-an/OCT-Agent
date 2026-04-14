const electron = require('electron');
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, dialog } = electron;
import path from 'path';
import fs from 'fs';
import os from 'os';
import net from 'net';
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
import {
  getChannelInboundAgent,
  setChannelInboundAgent,
} from './bindings-manager';
import { healMainAgentIfNeeded, healOrphanBindings } from './heal-main-agent';
import { installWorkspaceInjectHook, readActiveWorkspace, writeActiveWorkspace } from './install-workspace-hook';
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
import { isGatewayRunningOutput, getAgentWorkspaceDir, hasExplicitExecApprovalConfig, writeDesktopExecApprovalDefaults, patchGatewayCmdStackSize } from './openclaw-config';
import { dedupedChannelsList, killAllActiveLogins, killAllOrphanProcesses, killAllStaleChannelOps, detectRunningChannelLoginWorkers, getTrackedLoginPid, killOrphanWorkerForChannel } from './openclaw-process-guard';
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
let openclawInstallInProgress = false;
let upgradeInProgress = false;

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
  rewriteOpenClawShellCommand,
  wrapWindowsCommand,
} = shellUtils;

const channelLoginWithQR = createChannelLoginWithQR({
  runSpawn,
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

// patchGatewayCmdStackSize is now imported from './openclaw-config'

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
    icon: path.join(
      __dirname,
      '..',
      'resources',
      process.platform === 'win32' ? 'icon.ico' : process.platform === 'darwin' ? 'icon.icns' : 'icon.png'
    ),
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

  const showUpgradeLeaveBlockedDialog = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    void dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Upgrade In Progress',
      message: 'AwarenessClaw is upgrading components right now.',
      detail: 'Please keep this window open until the upgrade finishes. Leaving now can interrupt the upgrade and corrupt runtime files.',
      buttons: ['OK'],
      defaultId: 0,
      noLink: true,
    });
  };

  mainWindow.on('close', (e: Event) => {
    if (upgradeInProgress) {
      e.preventDefault();
      showUpgradeLeaveBlockedDialog();
      return;
    }
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
  // `health.healthy` can be false-positive in stale-PID edge cases even when
  // RPC is reachable. Treat RPC reachability as the source of truth.
  return !!snapshot.rpc?.ok && (runtimeRunning || portBusy);
}

/**
 * List all gateway process PIDs (command line matches `gateway run`).
 * Used by isGatewayProcessAlive and killZombieGatewayProcesses.
 */
async function listGatewayProcessPids(): Promise<number[]> {
  try {
    if (process.platform === 'win32') {
      const output = await readShellOutputAsync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -match \'gateway.*run\' } | Select-Object -ExpandProperty ProcessId" 2>NUL',
        8000,
      );
      return (output || '').split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
    }
    const output = await readShellOutputAsync('pgrep -af "gateway.*run" 2>/dev/null || true', 5000);
    const pids: number[] = [];
    for (const line of (output || '').split('\n')) {
      if (!line.trim() || line.includes('pgrep')) continue;
      const match = line.match(/^(\d+)\s/);
      if (match) pids.push(parseInt(match[1], 10));
    }
    return pids;
  } catch {
    return [];
  }
}

/**
 * Check whether a given PID is bound to port 18789 (the gateway loopback port).
 * A gateway process that exists but doesn't listen on 18789 is a zombie.
 */
async function isPidListeningOnGatewayPort(pid: number): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      // netstat -ano | findstr :18789 → lines end with the PID
      const output = await readShellOutputAsync('netstat -ano -p TCP | findstr "LISTENING" | findstr ":18789"', 5000);
      const pattern = new RegExp(`\\s${pid}\\s*$`, 'm');
      return pattern.test(output || '');
    }
    // lsof -iTCP:18789 -sTCP:LISTEN -P -n -a -p <pid>
    const output = await readShellOutputAsync(
      `lsof -iTCP:18789 -sTCP:LISTEN -P -n -a -p ${pid} 2>/dev/null || true`,
      5000,
    );
    return (output || '').includes(`:18789`);
  } catch {
    return false;
  }
}

/**
 * Kill zombie gateway processes: processes matching `gateway run` in cmdline
 * but NOT listening on port 18789. These happen when a previous gateway
 * crashed mid-startup or was orphaned by a failed upgrade/restart.
 *
 * Returns the list of zombie PIDs killed.
 */
async function killZombieGatewayProcesses(): Promise<number[]> {
  const pids = await listGatewayProcessPids();
  if (pids.length === 0) return [];
  const zombies: number[] = [];
  for (const pid of pids) {
    const listening = await isPidListeningOnGatewayPort(pid);
    if (!listening) zombies.push(pid);
  }
  for (const pid of zombies) {
    try {
      if (process.platform === 'win32') {
        await readShellOutputAsync(`taskkill /F /PID ${pid} 2>NUL`, 5000);
      } else {
        process.kill(pid, 'SIGKILL');
      }
      console.log(`[gateway] Killed zombie gateway pid=${pid} (not listening on 18789)`);
    } catch (err) {
      console.warn(`[gateway] Failed to kill zombie gateway pid=${pid}:`, err);
    }
  }
  return zombies;
}

/**
 * Detect whether a HEALTHY OpenClaw gateway process is already running on this machine.
 * Healthy = matching `gateway run` cmdline AND listening on port 18789 (or in plugin-load
 * phase on a recently-started PID).
 *
 * Zombie processes (matching cmdline but not bound to port) are killed as a side effect
 * so the next spawn attempt gets a clean slate.
 */
async function isGatewayProcessAlive(): Promise<boolean> {
  try {
    const pids = await listGatewayProcessPids();
    if (pids.length === 0) return false;
    // If any PID is listening on the gateway port, treat as healthy and skip spawn.
    for (const pid of pids) {
      if (await isPidListeningOnGatewayPort(pid)) return true;
    }
    // No listeners — all matching processes are zombies. Clean them up so the
    // caller can spawn a fresh gateway without the dual-instance conflict.
    await killZombieGatewayProcesses();
    return false;
  } catch {
    return false;
  }
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

  // Before spawning, check if a gateway process is already running (e.g. from
  // Windows Scheduled Task, a previous app session, or Doctor auto-fix).
  // Spawning a second `gateway run --force` while one is loading plugins causes
  // the two processes to fight each other (both --force → mutual kill loop).
  const existingGateway = !launchRecently && await isGatewayProcessAlive();
  if (existingGateway) {
    console.log('[gateway] Existing gateway process detected — skipping spawn to avoid dual-instance conflict');
    send?.('chat:status', { type: 'gateway', message: 'Waiting for existing Gateway to finish loading...' });
  }

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

      if (!launchRecently && !existingGateway) {
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
      if (!launchRecently && !existingGateway) {
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
    // Fast pre-filter: skip the expensive CLI snapshot (15s plugin load) when
    // the port is clearly not listening yet.  tcpProbeGatewayPort is ~10ms.
    if (!(await tcpProbeGatewayPort())) continue;
    const snapshot = await readGatewayStatusSnapshot();
    if (isGatewaySnapshotHealthy(snapshot)) {
      await sleep(1200);
      const confirmedSnapshot = await readGatewayStatusSnapshot();
      if (!isGatewaySnapshotHealthy(confirmedSnapshot)) {
        continue;
      }
      if (process.platform === 'win32') {
        writeRuntimePreferences({ ...readRuntimePreferences(), preferUserSessionGateway: true, gatewayHasStackSize: true });
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
  const isAuthGatedGatewayStatus = (output: string | null | undefined): boolean => {
    const lower = String(output || '').toLowerCase();
    return lower.includes('device-required')
      || lower.includes('pairing-required')
      || lower.includes('pairing required')
      || lower.includes('scope-upgrade');
  };

  const authGatedGatewayMessage =
    'Local Gateway is running, but this device needs local authorization. Please open Settings → Gateway and approve local access, then retry.';

  repairOpenClawConfigFile();

  // Fast path: HTTP probe avoids the 15-30s CLI plugin preload when the
  // gateway is already up. OpenClaw loads all plugins on every CLI call.
  // Retry once after 3s to cover the gateway startup window (plugin loading
  // takes 15-30s — a single probe during that window always fails, causing
  // unnecessary CLI fallback that spawns another ~500 MB process).
  const port = getGatewayPort();
  const httpProbe = (): Promise<boolean> => new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/healthz`, { timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });

  // On Windows, the scheduled task starts a gateway without --stack-size,
  // causing AJV stack overflow on plugin load.  We track whether **we**
  // launched the current gateway with the fix via a runtime-preference flag.
  // If the flag is absent (scheduled-task / old version) we must restart.
  const prefs = readRuntimePreferences();
  const needsStackSizeRestart = process.platform === 'win32' && !prefs.gatewayHasStackSize;

  if (await httpProbe()) {
    if (needsStackSizeRestart) {
      console.warn('[gateway] Running gateway may lack --stack-size, restarting with proper flags...');
      send?.('chat:status', { type: 'gateway', message: 'Upgrading Gateway with improved stability...' });
      try { await runAsync('openclaw gateway stop 2>&1', 15000); } catch { /* best-effort */ }
      await sleep(1500);
      // Fall through to start a new gateway with --stack-size (handled below)
    } else {
      return { ok: true };
    }
  }
  // Gateway may be booting (plugin load window) — wait 3s and retry once.
  if (!needsStackSizeRestart) {
    await sleep(3000);
    if (await httpProbe()) return { ok: true };
  }

  // Slow fallback: CLI check handles non-default ports and older installs.
  const statusOutput = await readShellOutputAsync('openclaw gateway status 2>&1', 15000);
  if (isGatewayRunningOutput(statusOutput)) return { ok: true };

  const emit = (message: string) => send?.('chat:status', { type: 'gateway', message });

  // Windows stale-listener recovery: port may stay occupied by a dead/half-ready
  // gateway process (busy port + runtime stopped + rpc timeout). Clear it before
  // normal start/install attempts so auto-start does not enter a retry loop.
  if (process.platform === 'win32') {
    const snapshot = await readGatewayStatusSnapshot();
    const looksStaleBusy = snapshot?.service?.runtime?.status !== 'running'
      && snapshot?.port?.status === 'busy'
      && !snapshot?.rpc?.ok;
    if (looksStaleBusy) {
      emit('Clearing stale Gateway listener...');
      try {
        await runAsync('openclaw gateway stop 2>&1', 15000);
      } catch {
        // Best-effort only; start/install logic below still runs.
      }
      await sleep(1200);
    }
  }

  if (process.platform === 'win32') {
    await ensureLocalDaemonReadyForRuntime(send);
  }

  // On Windows, always prefer user-session gateway. The scheduled task path
  // spawns a child process we can't control (no --stack-size flag), causing
  // AJV stack overflow on plugin load. User session mode uses runSpawn which
  // now includes --stack-size=8192.
  if (process.platform === 'win32') {
    // Re-probe: the previous CLI check + stale recovery + daemon bootstrap took
    // 15-45s — long enough for a scheduled-task gateway to finish plugin loading.
    // A quick HTTP probe here avoids spawning a redundant second instance.
    if (await httpProbe()) return { ok: true };

    emit('Starting Gateway in your Windows session...');
    const fallback = await startGatewayInUserSession(send);
    if (fallback.ok) {
      // Gateway is running — but if the scheduled task is missing, the user
      // won't have a gateway after reboot (they'd need to open the app every
      // time).  Fire-and-forget install so next boot auto-starts the gateway.
      if (isWindowsGatewayServiceMissing(statusOutput)) {
        (async () => {
          try {
            console.log('[gateway] Scheduled task missing — installing in background');
            await runAsync('openclaw gateway install 2>&1', 45000);
            patchGatewayCmdStackSize(HOME);
            console.log('[gateway] Scheduled task installed successfully');
          } catch (installErr: any) {
            console.warn('[gateway] Background scheduled task install failed:', installErr?.message || installErr);
          }
        })();
      }
      return fallback;
    }
  }

  let shouldInstallService = isWindowsGatewayServiceMissing(statusOutput);

  if (shouldInstallService) {
    emit('Installing local Gateway service...');
    try {
      await runAsync('openclaw gateway install 2>&1', 30000);
      patchGatewayCmdStackSize(HOME); // re-patch after install regenerates gateway.cmd
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
    if (process.platform === 'win32') {
      const latestPrefs = readRuntimePreferences();
      if (latestPrefs.preferUserSessionGateway) {
        writeRuntimePreferences({ ...latestPrefs, preferUserSessionGateway: false });
      }
    }
  } catch (err: any) {
    const message = err?.message || '';

    if (process.platform === 'win32' && !shouldInstallService && message.includes('schtasks run failed')) {
      shouldInstallService = true;
      emit('Repairing local Gateway service...');
      try {
        await runAsync('openclaw gateway install 2>&1', 30000);
        patchGatewayCmdStackSize(HOME); // re-patch after install regenerates gateway.cmd
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
    } else if (isAuthGatedGatewayStatus(message)) {
      return {
        ok: false,
        error: authGatedGatewayMessage,
      };
    } else {
      return {
        ok: false,
        error: 'Gateway failed to start. Please check Settings → Gateway and try again.',
      };
    }
  }

  // Poll with HTTP probe instead of CLI (each CLI call loads all plugins = ~500 MB).
  // Backoff: 2s×3, 3s×3 = ~15s max — enough for gateway to finish plugin loading.
  for (let i = 0; i < 6; i++) {
    const delay = i < 3 ? 2000 : 3000;
    await sleep(delay);
    if (await httpProbe()) {
      emit('Gateway started');
      return { ok: true };
    }
  }

  if (process.platform === 'win32') {
    emit('Gateway service did not stay up, switching to app session mode...');
    const fallback = await startGatewayInUserSession(send);
    if (fallback.ok) return fallback;
  }

  // Last-chance classification: distinguish auth-gated running Gateway from a
  // true startup failure so UI does not report a misleading "not running" state.
  const finalStatusOutput = await readShellOutputAsync('openclaw gateway status 2>&1', 15000);
  if (isAuthGatedGatewayStatus(finalStatusOutput)) {
    return {
      ok: false,
      error: authGatedGatewayMessage,
    };
  }

  return {
    ok: false,
    error: 'Gateway failed to start in time. Please check Settings → Gateway and try again.',
  };
}

/**
 * Fast openclaw installation check using file existence before falling back
 * to shell command. Avoids process-spawn timeouts in packaged Electron apps.
 */
async function checkOpenclawInstalled(): Promise<boolean> {
  // Fast path: check known binary locations (no process spawn needed)
  const binaryPaths = [
    path.join(HOME, '.npm-global', 'bin', 'openclaw'),
    '/usr/local/bin/openclaw',
    '/opt/homebrew/bin/openclaw',
    path.join(HOME, '.local', 'bin', 'openclaw'),
  ];
  const packageEntryPaths = [
    path.join(HOME, '.npm-global', 'lib', 'node_modules', 'openclaw', 'openclaw.mjs'),
    '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
    '/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs',
  ];
  if (binaryPaths.some(p => fs.existsSync(p)) || packageEntryPaths.some(p => fs.existsSync(p))) {
    return true;
  }
  // Fallback: shell command (may be slow in packaged Electron env)
  const version = await safeShellExecAsync('openclaw --version', 8000);
  return !!version;
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
    const installed = await checkOpenclawInstalled();
    if (!installed) {
      if (openclawInstallInProgress) {
        send('chat:status', { type: 'info', message: 'OpenClaw is being installed' });
        return {
          ok: false,
          error: 'OpenClaw is being installed right now. Please wait a moment and try again.',
        };
      }
      send('chat:status', { type: 'error', message: 'OpenClaw is not installed' });
      return {
        ok: false,
        error: 'OpenClaw is not installed yet. Please finish Setup first, or reinstall OpenClaw in Settings before chatting.',
      };
    }

    const started = await startGatewayWithRepair(send);
    if (!started.ok) {
      const authGated = /needs local authorization|approve local access/i.test(started.error || '');
      send('chat:status', {
        type: 'error',
        message: authGated ? 'Gateway access requires local authorization' : 'Gateway failed to start',
      });
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

/**
 * Fast TCP probe — does the Gateway port accept connections right now?
 *
 * Why this exists: every `openclaw gateway status` invocation reloads OpenClaw's
 * full plugin runtime (15-30 s on a typical machine — see CLAUDE.md "OpenClaw CLI
 * 超时规则" and openclaw#28587 / #62051). Using that command as a liveness check
 * inside chat:send guarantees the user pays the plugin reload tax on every send.
 *
 * A loopback TCP connect to port 18789 returns within ~10 ms when the Gateway
 * process is listening, regardless of plugin load state. That gives chat:send
 * a way to ask "is Gateway alive?" without spawning OpenClaw at all.
 *
 * Scope is intentionally minimal: a successful probe only proves the listener
 * is up, not that the Gateway WebSocket handshake will succeed. We use it as a
 * **gate** before the slower WS handshake — never as a replacement for it.
 */
async function tcpProbeGatewayPort(timeoutMs = 800): Promise<boolean> {
  const port = getGatewayPort() || 18789;
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, '127.0.0.1');
    } catch {
      finish(false);
    }
  });
}

async function prepareGatewayForChat(): Promise<{ ok: boolean; error?: string }> {
  const send = (ch: string, data: any) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data);
  };
  const isAuthGatedGatewayError = (input: string | null | undefined): boolean => {
    const lower = String(input || '').toLowerCase();
    return lower.includes('device-required')
      || lower.includes('pairing-required')
      || lower.includes('pairing required')
      || lower.includes('scope-upgrade')
      || lower.includes('needs local authorization');
  };

  try {
    const installed = await checkOpenclawInstalled();
    if (!installed) {
      if (openclawInstallInProgress) {
        return {
          ok: false,
          error: 'OpenClaw is being installed right now. Please wait a moment and try again.',
        };
      }
      return {
        ok: false,
        error: 'OpenClaw is not installed yet. Please finish Setup first, or reinstall OpenClaw in Settings before chatting.',
      };
    }

    // Fast path: WS already connected from a prior chat or startup pre-warm.
    // This is the steady-state path after the first successful connection.
    if (gatewayWsClient?.isConnected) {
      return { ok: true };
    }

    // Liveness check: TCP probe (<=800ms) instead of `openclaw gateway status`
    // (4-30s plugin reload). When the listener is up, actively complete the WS
    // handshake instead of dropping to the CLI fallback. The CLI fallback also
    // pays the plugin reload tax, so falling back during normal startup means
    // the user waits for plugin loading TWICE (once for status, once for `agent`).
    const portOpen = await tcpProbeGatewayPort();
    if (portOpen) {
      send('chat:status', {
        type: 'gateway',
        message: 'Connecting to local Gateway...',
      });
      try {
        // getGatewayWs internally handles concurrent callers via gatewayWsConnectPromise
        // mutex, has a 10s connect timeout, and pre-warms write scopes. Once this
        // succeeds, gatewayWsClient.isConnected stays true for the lifetime of the
        // process — every subsequent chat hits the fast path above with no delay.
        await getGatewayWs();
        if (gatewayWsClient?.isConnected) {
          return { ok: true };
        }
      } catch (err: any) {
        const detail = err?.message || String(err || '');
        if (isAuthGatedGatewayError(detail)) {
          return {
            ok: false,
            error: 'Local Gateway requires one-time device authorization before desktop chat can use Gateway mode.',
          };
        }
        // WS connect failed despite the port being open. This usually means
        // Gateway is mid-startup and not yet accepting protocol-level connects
        // (handshake races plugin loader — see openclaw#46256). Fall through to
        // CLI fallback so the user still gets an answer, and kick a background
        // repair so the next message will likely hit the fast path.
        console.warn('[chat] Gateway WS connect failed despite open port:', detail);
      }
    }

    // Gateway is not reachable via TCP, or the WS handshake failed. Trigger a
    // background repair (idempotent — no-op if one is already running) and tell
    // the chat path to use CLI fallback for this single message.
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

function parseLatestPairingSelection(raw: string): { requestId?: string; approveCommand?: string } {
  const text = String(raw || '').trim();
  if (!text) return {};

  const jsonStart = text.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart));
      return {
        requestId: parsed?.selected?.requestId,
        approveCommand: parsed?.approveCommand,
      };
    } catch {
      // Fall through to plain-text parsing.
    }
  }

  const plainMatch = text.match(/Selected pending device request\s+([a-f0-9-]{20,})/i);
  return { requestId: plainMatch?.[1] };
}

function looksLikePairingAuthError(message: string): boolean {
  return /pairing required|pairing-required|device-required|needs local authorization|device authorization|scope-upgrade/i.test(String(message || ''));
}

async function tryRepairGatewayPairing(): Promise<boolean> {
  const latestRaw = await runAsync('openclaw devices approve --latest --json 2>&1', 30000).catch(() => '');
  const latest = parseLatestPairingSelection(latestRaw);

  if (latest.approveCommand) {
    const output = await runAsync(`${latest.approveCommand} 2>&1`, 30000).catch(() => '');
    if (/Approved\s+/i.test(output || '')) return true;
  }

  if (latest.requestId) {
    const output = await runAsync(`openclaw devices approve ${latest.requestId} 2>&1`, 30000).catch(() => '');
    if (/Approved\s+/i.test(output || '')) return true;
  }

  const legacyOutput = await runAsync('openclaw devices approve --latest 2>&1', 30000).catch(() => '');
  return /Approved\s+/i.test(legacyOutput || '');
}

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
        if (!looksLikePairingAuthError(message)) throw err;

        options?.onPairingRepairStart?.();

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('chat:status', {
            type: 'gateway',
            message: 'Approving local Gateway device access...',
          });
        }

        const repaired = await tryRepairGatewayPairing();
        if (!repaired) {
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
          if (looksLikePairingAuthError(scopeMsg)) {
            const repaired = await tryRepairGatewayPairing();
            if (repaired) {
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
        if (upgradeInProgress) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            void dialog.showMessageBox(mainWindow, {
              type: 'warning',
              title: 'Upgrade In Progress',
              message: 'AwarenessClaw is upgrading components right now.',
              detail: 'Please wait for the upgrade to complete before quitting.',
              buttons: ['OK'],
              defaultId: 0,
              noLink: true,
            });
          }
          return;
        }
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

// Active project workspace — persisted to ~/.awarenessclaw/active-workspace.json so the
// before_prompt_build hook (deployed to ~/.openclaw/hooks/awareness-workspace-inject) can
// read it and prepend the project context to channel inbound messages. This is the
// channel-side counterpart of the desktop-chat workspace prefix injection.
ipcMain.handle('workspace:get-active', () => {
  try { return { success: true, path: readActiveWorkspace(HOME) }; }
  catch (err: any) { return { success: false, error: err?.message?.slice(0, 200) }; }
});

ipcMain.handle('workspace:set-active', async (_e: unknown, workspacePath: string | null) => {
  try {
    writeActiveWorkspace(workspacePath, HOME);
    // Tell the Awareness daemon to switch its projectDir so that the Memory
    // wiki reflects the same workspace as the chat. Empty/null falls back to
    // the OpenClaw global workspace (~/.openclaw) — the daemon's default.
    const daemonTarget = workspacePath && workspacePath.trim()
      ? workspacePath
      : path.join(HOME, '.openclaw');
    const switchResult = await switchDaemonWorkspace(daemonTarget);
    // Broadcast to all renderers so Memory.tsx can reload.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('workspace:changed', {
        path: workspacePath || null,
        daemonProjectDir: daemonTarget,
        daemonSwitched: switchResult.ok,
        daemonError: switchResult.error || null,
      });
    }
    return { success: true, daemonSwitched: switchResult.ok, daemonError: switchResult.error || null };
  } catch (err: any) {
    return { success: false, error: err?.message?.slice(0, 200) };
  }
});

/**
 * Call the local Awareness daemon's POST /workspace/switch API to hot-swap
 * its project directory. Returns { ok: true } on success, { ok: false, error }
 * when the daemon is unreachable or rejects the path. Never throws.
 */
async function switchDaemonWorkspace(
  projectDir: string,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ project_dir: projectDir });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: 37800,
        path: '/api/v1/workspace/switch',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10_000,
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true });
          } else {
            let detail = `HTTP ${res.statusCode}`;
            try {
              const parsed = JSON.parse(chunks);
              if (parsed?.error) detail = String(parsed.error).slice(0, 200);
            } catch { /* ignore parse error */ }
            resolve({ ok: false, error: detail });
          }
        });
      },
    );
    req.on('error', (err) => {
      resolve({ ok: false, error: err?.message?.slice(0, 200) || 'daemon unreachable' });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'daemon switch timeout' });
    });
    req.write(body);
    req.end();
  });
}

// Channel-level inbound agent routing (simple default "which agent answers this
// channel" dropdown on the Channels page). Backed by bindings-manager which
// writes channel-only entries into openclaw.json bindings[], leaving peer/
// account-level rules untouched for power users.
ipcMain.handle('channel:get-inbound-agent', (_e: unknown, channelId: string) => {
  try {
    return { success: true, agentId: getChannelInboundAgent(channelId, HOME) };
  } catch (err: any) {
    return { success: false, error: err?.message?.slice(0, 200) };
  }
});

ipcMain.handle('channel:set-inbound-agent', (_e: unknown, channelId: string, agentId: string) => {
  try {
    const ok = setChannelInboundAgent(channelId, agentId, HOME);
    return ok ? { success: true } : { success: false, error: 'Failed to write openclaw.json' };
  } catch (err: any) {
    return { success: false, error: err?.message?.slice(0, 200) };
  }
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
  onUpgradeRunningChange: (running: boolean) => {
    upgradeInProgress = running;
    if (running && mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  },
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
  runAsync,
  startGatewayInUserSession: () => startGatewayInUserSession(),
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
  runDoctorFix: (checkId: string) => getDoctor().runFix(checkId),
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
  startGatewayInUserSession: () => startGatewayInUserSession(),
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
  setOpenclawInstalling: (v) => { openclawInstallInProgress = v; },
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
  setOpenclawInstalling: (v) => { openclawInstallInProgress = v; },
});

// --- App Lifecycle ---

// ---------------------------------------------------------------------------
// Auto-reconnect channel login workers
//
// Channels with persistent login workers (WeChat, WhatsApp, Signal) need their
// `openclaw channels login --channel <id> --verbose` process to be running
// continuously. When the app restarts (or the previous session crashed), these
// workers are gone but the channel is still configured+enabled in openclaw.json.
// This function detects which enabled channels are missing a worker and spawns
// one silently. For channels like WeChat, the session is cached locally so the
// worker reconnects without re-scanning a QR code.
//
// openclawIds that use a persistent `channels login` worker:
const CHANNELS_NEEDING_LOGIN_WORKER: Set<string> = new Set([
  'openclaw-weixin',  // WeChat
  'whatsapp',         // WhatsApp
  'signal',           // Signal
]);

async function autoReconnectChannelWorkers(): Promise<void> {
  try {
    const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(configPath)) return;

    const config = readJsonFileWithBom<Record<string, any>>(configPath);
    const channels = config?.channels;
    if (!channels || typeof channels !== 'object') return;

    // Find enabled channels that need a login worker.
    const enabledLoginChannels: string[] = [];
    for (const [ocId, chConfig] of Object.entries(channels)) {
      if (
        CHANNELS_NEEDING_LOGIN_WORKER.has(ocId) &&
        chConfig && typeof chConfig === 'object' &&
        (chConfig as any).enabled === true
      ) {
        enabledLoginChannels.push(ocId);
      }
    }

    if (enabledLoginChannels.length === 0) {
      console.log('[auto-reconnect] No enabled channels need login workers.');
      return;
    }

    // Detect OS-level workers (includes both tracked and untracked orphans).
    const runningWorkers = await detectRunningChannelLoginWorkers();

    // For each enabled channel, determine what to do:
    //   - Already tracked by us (in activeLogins) → skip, it's managed
    //   - OS process exists but untracked (orphan from prior session) →
    //     MUST replace with a tracked one, otherwise killStaleChannelLogins()
    //     will kill the orphan later and nobody will reconnect it
    //   - No worker at all → spawn a new tracked one
    const needSpawn: string[] = [];
    for (const ocId of enabledLoginChannels) {
      const trackedPid = getTrackedLoginPid(ocId);
      if (trackedPid > 0) {
        console.log(`[auto-reconnect] ${ocId}: already tracked (PID ${trackedPid}), skipping.`);
        continue;
      }
      if (runningWorkers.has(ocId)) {
        console.log(`[auto-reconnect] ${ocId}: untracked orphan found, will replace with tracked worker.`);
      } else {
        console.log(`[auto-reconnect] ${ocId}: no worker found, will spawn.`);
      }
      needSpawn.push(ocId);
    }

    if (needSpawn.length === 0) {
      console.log('[auto-reconnect] All channel workers are tracked and running.');
      return;
    }

    console.log('[auto-reconnect] Spawning tracked workers for:', needSpawn.join(', '));

    // Spawn workers sequentially (each loads all plugins ~800MB, don't spawn all at once).
    // For channels with untracked orphans, kill the orphan first so two workers
    // don't compete for the same messaging session (e.g. WeChat only allows one
    // active login). channelLoginWithQR → registerActiveLogin handles tracked
    // replacements, but orphans aren't in the map.
    for (const ocId of needSpawn) {
      // Kill any untracked orphan worker for this specific channel before spawning.
      if (runningWorkers.has(ocId)) {
        console.log(`[auto-reconnect] ${ocId}: killing untracked orphan before spawn...`);
        await killOrphanWorkerForChannel(ocId);
        // Brief pause for process cleanup.
        await sleep(1000);
      }

      const loginCmd = `openclaw channels login --channel ${ocId} --verbose`;
      console.log(`[auto-reconnect] Starting worker: ${loginCmd}`);
      // Fire-and-forget — channelLoginWithQR handles its own PID registration,
      // idle timeout, output parsing, and error handling. It resolves when the
      // worker exits (which for a healthy bot = never, until app quits).
      // Use a very long idle timeout (24h) since this is a persistent worker.
      channelLoginWithQR(loginCmd, 24 * 60 * 60 * 1000).then((result) => {
        if (result.success) {
          console.log(`[auto-reconnect] Worker for ${ocId} exited successfully.`);
        } else {
          console.warn(`[auto-reconnect] Worker for ${ocId} exited with error:`, result.error || result.output);
        }
      }).catch((err: any) => {
        console.warn(`[auto-reconnect] Worker for ${ocId} failed:`, err?.message || err);
      });
      // Stagger spawns by 5s so plugin loading doesn't overwhelm the system.
      await sleep(5000);
    }
  } catch (err: any) {
    console.warn('[auto-reconnect] Failed (non-fatal):', err?.message || err);
  }
}

app.whenReady().then(() => {
  // Deploy internal hook for awareness memory backup (idempotent, version-gated)
  ensureInternalHook(HOME);

  // Self-heal the OpenClaw `main` agent if it has degraded into a skeleton entry
  // (no workspace / agentDir). This is the default agent that every channel binding
  // routes to. If main is broken, channels accept messages but never produce replies
  // because the routing target has no workspace and gets dropped from `agents list`.
  try {
    const heal = healMainAgentIfNeeded(HOME);
    if (heal.status === 'healed') {
      console.log(`[main-heal] healed main agent: added ${heal.changes?.join(', ')}`);
    } else if (heal.status === 'error') {
      console.warn('[main-heal] error:', heal.error);
    }
  } catch (err) {
    console.warn('[main-heal] unexpected error:', err);
  }

  // Redirect orphan bindings (user deleted an agent that was previously the inbound
  // target for a channel) to `main` so inbound messages do not drop silently. Runs
  // after healMainAgentIfNeeded so main is guaranteed to be a valid fallback target.
  try {
    const orphans = healOrphanBindings(HOME);
    if (orphans.length > 0) {
      console.log(`[bindings-heal] redirected ${orphans.length} orphan binding(s) to main:`,
        orphans.map((o) => `${o.channelId}(${o.qualifier}) was ${o.oldAgent}`).join(', '));
    }
  } catch (err) {
    console.warn('[bindings-heal] unexpected error:', err);
  }

  // Install the workspace-injection hook so channel inbound messages get the same
  // "[Project working directory: …]" prefix the desktop chat uses. Idempotent — only
  // writes if the hook script body or config entry is missing/changed.
  try {
    const hookResult = installWorkspaceInjectHook(HOME);
    if (hookResult.status === 'deployed') {
      console.log(`[workspace-hook] deployed: ${hookResult.changes?.join(', ')}`);
    } else if (hookResult.status === 'error') {
      console.warn('[workspace-hook] error:', hookResult.error);
    }
  } catch (err) {
    console.warn('[workspace-hook] unexpected error:', err);
  }

  // Ensure config has required gateway defaults before anything tries to start
  repairOpenClawConfigFile();

  // Patch gateway.cmd to include --stack-size=8192 so that ANY gateway start
  // mechanism (scheduled task, `openclaw gateway start/restart`, manual) will
  // have the AJV stack overflow fix.  Must run before any gateway start attempt.
  if (process.platform === 'win32') {
    patchGatewayCmdStackSize(HOME);
  }

  // Reset the gatewayHasStackSize flag on every app launch.  The Windows
  // scheduled task may have started a new gateway (without --stack-size)
  // since we last ran.  Clearing the flag forces startGatewayWithRepair to
  // verify once per session and restart the gateway if needed.
  if (process.platform === 'win32') {
    const prefs = readRuntimePreferences();
    if (prefs.gatewayHasStackSize) {
      writeRuntimePreferences({ ...prefs, gatewayHasStackSize: false });
    }
  }

  createWindow();
  createTray();

  // Fire-and-forget: on app startup, sync the persisted active workspace to
  // the Awareness daemon so that Memory / Wiki data reflects the workspace the
  // user last chose in the chat header. Without this, the daemon would stay at
  // its autostart default (~/.openclaw) even though chat messages are being
  // written against a user-selected project directory. Retries for up to 30s
  // because the daemon may still be spinning up at app launch.
  void (async () => {
    const persisted = readActiveWorkspace(HOME);
    const target = persisted && persisted.trim() ? persisted : path.join(HOME, '.openclaw');
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await switchDaemonWorkspace(target);
      if (result.ok) {
        console.log(`[startup] daemon workspace synced to: ${target}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('workspace:changed', {
            path: persisted || null,
            daemonProjectDir: target,
            daemonSwitched: true,
            daemonError: null,
          });
        }
        return;
      }
      // Daemon probably not up yet — wait and retry.
      await sleep(5000);
    }
    console.warn('[startup] daemon workspace sync gave up after 30s — Memory may show stale workspace until user triggers set-active');
  })();

  // Best-effort: start Gateway early so it's ready when user sends first message.
  // Once that completes, also pre-warm the Gateway WebSocket connection in the
  // background so the user's first chat:send hits the fast path (no plugin reload,
  // no CLI fallback). Without this pre-warm, the first message after launch pays
  // a 30-60s tax even when Gateway is healthy — see CLAUDE.md "OpenClaw CLI 超时
  // 规则" and openclaw#28587 / #46256. The retry loop tolerates Gateway taking up
  // to ~60 seconds to finish loading plugins after the process starts.
  //
  // Path A3 — early visible signal: emit a chat:status banner immediately so the
  // user sees "engine warming up" the moment they open Chat, rather than silence
  // while plugins load. CLAUDE.md "用人话说话": telling the user "首次启动约需 30
  // 秒" turns a perceived freeze into a visible progress indicator. This message
  // is replaced by the success / failure log lines below as warmup progresses.
  const sendStartupGatewayBanner = (msg: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat:status', { type: 'gateway', message: msg });
    }
  };
  // Delay slightly so the renderer has a chance to mount its onChatStatus listener.
  setTimeout(() => {
    if (!gatewayWsClient?.isConnected) {
      sendStartupGatewayBanner(
        '正在启动本地 OpenClaw 引擎（首次启动约 30 秒）... / Local OpenClaw engine is starting (about 30s on first run)...',
      );
    }
  }, 1500);

  startGatewayRepairInBackground()
    .then(async (result) => {
      // Push gateway status to frontend so Settings/Dashboard update without reload.
      if (result && result.ok && mainWindow?.webContents) {
        mainWindow.webContents.send('gateway:status-update', { running: true });
      }
      for (let attempt = 0; attempt < 12; attempt++) {
        try {
          if (await tcpProbeGatewayPort()) {
            await getGatewayWs();
            if (gatewayWsClient?.isConnected) {
              console.log('[startup] Gateway WS pre-warm connected on attempt', attempt + 1);
              sendStartupGatewayBanner('本地 OpenClaw 引擎已就绪 / Local OpenClaw engine ready');
              if (mainWindow?.webContents) {
                mainWindow.webContents.send('gateway:status-update', { running: true });
              }
              return;
            }
          }
        } catch (err: any) {
          // Expected during plugin load window — keep retrying.
          console.log('[startup] Gateway WS pre-warm attempt', attempt + 1, 'failed:', err?.message || err);
        }
        await sleep(5000);
      }
      console.warn('[startup] Gateway WS pre-warm gave up after 60s — first chat may take longer');
      sendStartupGatewayBanner(
        '本地引擎启动较慢，首条消息可能需要等待 / Local engine is slow to start; first message may take longer',
      );
    })
    .catch((err) => {
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

  // Startup zombie cleanup — fire-and-forget. Kills any orphan
  // `openclaw.mjs channels|cron` processes left over from a previous app session
  // (crashes, force-quits, or upgrades that didn't drain children). Without this,
  // every dev/test reinstall accumulates 800 MB-each zombies; real measurement
  // showed 27 orphans / 11 GB after one day.
  //
  // CRITICAL: this kill is NOT awaited. The powershell/pkill query takes 3-5 s on
  // Windows even when there's nothing to kill, so awaiting it would block the
  // startup status banner and the gateway pre-warm. Match scope is tightened to
  // ONLY `openclaw.mjs channels|cron`, never the gateway or awareness daemon.
  killAllStaleChannelOps().catch((err) => {
    console.warn('[startup] zombie cleanup failed (non-fatal):', err?.message || err);
  });

  // Auto-reconnect channel workers for enabled channels (WeChat, WhatsApp, Signal)
  // that need persistent `channels login` processes. Runs 45s after startup so
  // the gateway has time to finish loading plugins and the zombie cleanup is done.
  setTimeout(() => {
    autoReconnectChannelWorkers().catch((err) => {
      console.warn('[startup] auto-reconnect failed (non-fatal):', err?.message || err);
    });
  }, 45_000);

  // Background pre-warm of `openclaw channels list`. This serves three purposes:
  //   1. Loads the 50MB+ OpenClaw JS bundle into the OS file cache so any
  //      subsequent CLI invocation (like `openclaw channels login`) starts ~5-10 s faster.
  //   2. Populates the shared channelsListInflight dedup cache in openclaw-process-guard
  //      so the Channels page renders instantly on first open.
  //   3. Surfaces any "Gateway not running" / "plugin failed to load" errors early,
  //      not at the moment the user clicks "Connect WeChat".
  // Runs at 25 s after app start — late enough to not compete with Gateway startup,
  // early enough that it usually finishes before the user clicks Channels.
  // Routed through dedupedChannelsList so any concurrent IPC call to channels list
  // (e.g. user opens Channels page during the warm-up) shares this same process.
  setTimeout(() => {
    dedupedChannelsList(async (cmd, timeoutMs) => {
      try { return await runAsync(cmd, timeoutMs); } catch { return null; }
    }, 60_000).catch((err) => {
      console.warn('[startup] channels list pre-warm failed (non-fatal):', err?.message || err);
    });
  }, 25_000);
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

app.on('before-quit', (e: Event) => {
  if (upgradeInProgress) {
    e.preventDefault();
    isQuitting = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Upgrade In Progress',
        message: 'AwarenessClaw is upgrading components right now.',
        detail: 'Please wait for upgrade completion before closing the app.',
        buttons: ['OK'],
        defaultId: 0,
        noLink: true,
      });
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    return;
  }
  isQuitting = true;
  daemonWatchdog.stopDaemonWatchdog();
  // Force-kill any shell children (e.g. hung `openclaw skills list --json`) that
  // were spawned with detached:true. Without this they survive as orphan processes.
  shellUtils.killAllTrackedShellChildren();
  // Tree-kill any tracked channel login workers (cmd.exe wrapper + node openclaw.mjs
  // grandchild). Without this, every app close leaves an 800 MB bot worker behind,
  // and over a few app restarts the user accumulates 5-11 GB of zombies that compete
  // with the new app's CLI calls. Fire-and-forget — Electron won't wait on it.
  void killAllActiveLogins().catch(() => { /* best-effort */ });
  // Last-resort sweep: kill any orphan node/npx processes related to
  // @awareness-sdk/local or openclaw.mjs that escaped tracked-child cleanup
  // (e.g. from a prior crashed session or detached daemon spawn).
  void killAllOrphanProcesses(process.pid).catch(() => { /* best-effort */ });
});

app.on('window-all-closed', () => {
  if (!isQuitting && tray) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
