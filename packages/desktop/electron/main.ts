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
import { callMcp, callMcpStrict, setMemoryClientProjectDir } from './memory-client';
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
import { findPrebindingGatewayPids } from './gateway-startup-guards';
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
// preview.6: Mission Flow and legacy Workflow handlers removed — users now
// interact only via Chat; AI auto-spawns subagents via OpenClaw's native
// sessions_spawn tool. See docs/features/team-tasks/08-CHAT-FIRST-REDESIGN.md
import { registerFileDialogHandlers } from './ipc/register-file-dialog-handlers';
import { registerGatewayHandlers } from './ipc/register-gateway-handlers';
import { registerMemoryHandlers } from './ipc/register-memory-handlers';
import { registerOpenClawConfigHandlers } from './ipc/register-openclaw-config-handlers';
import { registerRuntimeHealthHandlers } from './ipc/register-runtime-health-handlers';
import { registerSetupHandlers } from './ipc/register-setup-handlers';
import { registerShellHandlers } from './ipc/register-shell-handlers';
import { registerSkillHandlers } from './ipc/register-skill-handlers';
import { registerFixOpenClawHandlers } from './ipc/register-fix-openclaw-handlers'; // 新增修复处理程序
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
  hasAwarenessPluginInstalled,
  mergeDesktopOpenClawConfig,
  needsDesktopLegacyBrowserWebMigration,
  persistDesktopAwarenessPluginConfig,
  redactSensitiveValues,
  sanitizeDesktopAwarenessPluginConfig,
  shouldUseLegacyWindowsOpenClawSafeMode,
  stripLegacyWindowsOpenClawRiskyConfig,
  stripRedactedValues,
} from './desktop-openclaw-config';
import { readJsonFileWithBom, restoreConfigFromBackupIfNeeded, safeWriteJsonFile } from './json-file';

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
let legacyWindowsOpenClawSafeMode = false;

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
  if (legacyWindowsOpenClawSafeMode) {
    stripLegacyWindowsOpenClawRiskyConfig(config);
  }
};

const sanitizeAwarenessPluginConfig = (config: Record<string, any>) => {
  sanitizeDesktopAwarenessPluginConfig(config, HOME);
  if (legacyWindowsOpenClawSafeMode) {
    stripLegacyWindowsOpenClawRiskyConfig(config);
  }
};

const persistAwarenessPluginConfig = (options?: { enableSlot?: boolean }) => {
  persistDesktopAwarenessPluginConfig(HOME, options);
};

const mergeOpenClawConfig = (existing: Record<string, any>, incoming: Record<string, any>) => {
  const merged = mergeDesktopOpenClawConfig(existing, incoming, HOME);
  if (legacyWindowsOpenClawSafeMode) {
    stripLegacyWindowsOpenClawRiskyConfig(merged);
  }
  return merged;
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

    if (legacyWindowsOpenClawSafeMode) {
      stripLegacyWindowsOpenClawRiskyConfig(current);
      current.gateway = {
        ...(current.gateway || {}),
        mode: current.gateway?.mode || 'local',
        bind: current.gateway?.bind || 'loopback',
        port: Number(current.gateway?.port) || 18789,
      };
      safeWriteJsonFile(configPath, current, { skipSizeCheck: true });
      return;
    }

    sanitizeAwarenessPluginConfig(current);

    // If awareness-memory plugin is installed but config entry is missing or
    // disabled (e.g. after OpenClaw upgrade, config migration, or safe-mode
    // strip), re-apply it so memory doesn't silently break.
    if (hasAwarenessPluginInstalled(HOME) && !current.plugins?.entries?.['openclaw-memory']?.enabled) {
      applyAwarenessPluginConfig(current, { enableSlot: true });
    }

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

    safeWriteJsonFile(configPath, current);

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
 * Return the PID currently listening on port 18789, or null if nothing is.
 *
 * This is the authoritative signal for "gateway is healthy". Command-line
 * matching (pgrep) is unreliable because:
 *   - macOS LaunchAgent renames the process to `openclaw-gateway` (no "gateway run" in argv)
 *   - Linux systemd services may use their own arg layout
 *   - Windows Scheduled Tasks spawn via a wrapper
 * Port ownership is platform-agnostic and unambiguous.
 */
async function getGatewayPortOwnerPid(): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      const output = await readShellOutputAsync(
        'netstat -ano -p TCP | findstr "LISTENING" | findstr ":18789"',
        5000,
      );
      for (const line of (output || '').split(/\r?\n/)) {
        const match = line.trim().match(/(\d+)\s*$/);
        if (match) {
          const pid = parseInt(match[1], 10);
          if (Number.isFinite(pid) && pid > 0) return pid;
        }
      }
      return null;
    }
    // lsof -tiTCP:18789 -sTCP:LISTEN prints only PIDs (one per line).
    // Graceful when no process is listening (exit 1 → `|| true` swallows it).
    const output = await readShellOutputAsync(
      'lsof -tiTCP:18789 -sTCP:LISTEN -P -n 2>/dev/null || true',
      5000,
    );
    const firstLine = (output || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (!firstLine) return null;
    const pid = parseInt(firstLine, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Check whether PID's executable path points at the OpenClaw gateway bundle.
 * Used as a safety check before SIGKILL-ing a suspected zombie, so we never
 * kill unrelated processes that happened to match a loose pattern.
 */
async function isOpenClawGatewayPid(pid: number): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const output = await readShellOutputAsync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\" | Select-Object -ExpandProperty CommandLine" 2>NUL`,
        5000,
      );
      return /openclaw[\\/]dist[\\/]index\.js|openclaw[\\/]openclaw\.mjs|openclaw-gateway/i.test(output || '');
    }
    // ps -p <pid> -o command= returns the full command (may be truncated but
    // openclaw path is short enough). Also check with `args` for full argv.
    const output = await readShellOutputAsync(`ps -p ${pid} -o command= 2>/dev/null || true`, 5000);
    const argsOutput = await readShellOutputAsync(`ps -p ${pid} -o args= 2>/dev/null || true`, 5000);
    const combined = `${output}\n${argsOutput}`;
    return /openclaw\/dist\/index\.js|openclaw\/openclaw\.mjs|openclaw-gateway/i.test(combined);
  } catch {
    return false;
  }
}

/**
 * Kill orphan OpenClaw gateway processes that do NOT own port 18789.
 * These arise from crashed/interrupted upgrades or dual-start race conditions.
 *
 * Safety rails:
 *   - Never kill the PID currently owning port 18789 (that's the real gateway).
 *   - Double-check the PID's cmdline contains the openclaw path before SIGKILL.
 *   - Skip our own process.
 */
async function killZombieGatewayProcesses(): Promise<number[]> {
  const portOwner = await getGatewayPortOwnerPid();
  let pids: number[] = [];
  try {
    if (process.platform === 'win32') {
      const output = await readShellOutputAsync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match \'openclaw.*(dist[\\\\/]index\\.js|openclaw\\.mjs).*gateway\' } | Select-Object -ExpandProperty ProcessId" 2>NUL',
        8000,
      );
      pids = (output || '').split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
    } else {
      // macOS pgrep has no `-a` flag — it silently outputs PIDs only.
      // Use `-f` to match full cmdline, then read each PID's args separately.
      // This works identically on macOS and Linux.
      const pidOutput = await readShellOutputAsync(
        'pgrep -f "openclaw" 2>/dev/null || true',
        5000,
      );
      const candidatePids: number[] = [];
      for (const line of (pidOutput || '').split(/\r?\n/)) {
        const pid = parseInt(line.trim(), 10);
        if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) candidatePids.push(pid);
      }
      // Confirm each candidate actually has "gateway" in its args.
      for (const pid of candidatePids) {
        const args = await readShellOutputAsync(`ps -p ${pid} -o args= 2>/dev/null || true`, 3000);
        if (/gateway/i.test(args || '')) pids.push(pid);
      }
    }
  } catch {
    return [];
  }
  const selfPid = process.pid;
  const zombies = pids.filter(pid => pid !== portOwner && pid !== selfPid);
  const killed: number[] = [];
  for (const pid of zombies) {
    // Safety: confirm it really is an OpenClaw gateway process before SIGKILL.
    if (!(await isOpenClawGatewayPid(pid))) continue;
    try {
      if (process.platform === 'win32') {
        await readShellOutputAsync(`taskkill /F /PID ${pid} 2>NUL`, 5000);
      } else {
        process.kill(pid, 'SIGKILL');
      }
      killed.push(pid);
      console.log(`[gateway] Killed zombie gateway pid=${pid} (not listening on 18789)`);
    } catch (err) {
      console.warn(`[gateway] Failed to kill zombie gateway pid=${pid}:`, err);
    }
  }
  return killed;
}

/**
 * Detect whether a HEALTHY OpenClaw gateway is bound to port 18789.
 * Port ownership is the single source of truth — if something listens, it's up.
 *
 * Zombie cleanup (orphan processes that exist but don't own the port) is
 * performed lazily by killZombieGatewayProcesses() on the spawn path.
 */
async function isGatewayProcessAlive(): Promise<boolean> {
  const pid = await getGatewayPortOwnerPid();
  return pid !== null;
}

/**
 * Extract a semver string (e.g. "2026.4.12") from an arbitrary text. Ignores
 * commit hashes and other digit tokens.
 */
function extractSemver(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/**
 * Read the OpenClaw version reported by the running gateway process.
 * On macOS LaunchAgent and Linux systemd, the version is exposed via the
 * `OPENCLAW_SERVICE_VERSION` env var on the process. We read it with `ps eww`
 * (Unix) / CIM (Windows) rather than calling `openclaw --version` twice.
 */
async function getRunningGatewayVersion(): Promise<string | null> {
  const pid = await getGatewayPortOwnerPid();
  if (!pid) return null;
  try {
    if (process.platform === 'win32') {
      const output = await readShellOutputAsync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\" | Select-Object -ExpandProperty CommandLine" 2>NUL`,
        5000,
      );
      return extractSemver(output);
    }
    // On macOS, `ps eww -p <pid>` can't read LaunchAgent env without root,
    // but `pgrep -lf` surfaces OPENCLAW_SERVICE_VERSION from the service
    // process name line for free. Try pgrep first, fall back to ps eww for
    // Linux / non-LaunchAgent cases.
    const pgrepOut = (await readShellOutputAsync('pgrep -lf "openclaw" 2>/dev/null || true', 5000)) || '';
    for (const line of pgrepOut.split(/\r?\n/)) {
      if (!line.startsWith(`${pid} `)) continue;
      const m = line.match(/OPENCLAW_SERVICE_VERSION=(\d+\.\d+\.\d+)/);
      if (m) return m[1];
    }
    const psOut = (await readShellOutputAsync(`ps eww -p ${pid} 2>/dev/null || true`, 5000)) || '';
    const m2 = psOut.match(/OPENCLAW_SERVICE_VERSION=(\d+\.\d+\.\d+)/);
    return m2 ? m2[1] : null;
  } catch {
    return null;
  }
}

/**
 * Compare semver strings (a > b returns 1, a < b returns -1, equal returns 0).
 * Non-numeric parts are compared lexicographically.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

let gatewayVersionAutoRepairAt = 0;
const GATEWAY_VERSION_REPAIR_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Detect a CLI-vs-gateway version mismatch and auto-repair via
 * `openclaw gateway install --force` to regenerate the LaunchAgent/Systemd
 * unit pointing at the new bundle.
 *
 * Root cause: when users upgrade `openclaw` globally (npm install -g openclaw),
 * the on-disk bundle updates but the service unit still references the old
 * path or old env. The old gateway keeps running — in 2026.3.8 this triggers
 * self-induced restart loops (openclaw#58620), manifesting as "Connecting to
 * local Gateway…" on every chat + Invalid session ID errors.
 *
 * This runs silently on startup and every 5 min after. Throttled so a stuck
 * repair can't turn into a hot loop.
 */
async function maybeRepairGatewayVersionMismatch(
  send?: (ch: string, data: any) => void,
): Promise<{ repaired: boolean; cliVersion: string | null; gatewayVersion: string | null }> {
  const now = Date.now();
  if (now - gatewayVersionAutoRepairAt < GATEWAY_VERSION_REPAIR_COOLDOWN_MS) {
    return { repaired: false, cliVersion: null, gatewayVersion: null };
  }

  const [cliRaw, gatewayVersion] = await Promise.all([
    safeShellExecAsync('openclaw --version', 8000),
    getRunningGatewayVersion(),
  ]);
  const cliVersion = extractSemver(cliRaw);

  // If either version is unknown, or they already match, do nothing.
  if (!cliVersion || !gatewayVersion) {
    return { repaired: false, cliVersion, gatewayVersion };
  }
  if (compareSemver(cliVersion, gatewayVersion) <= 0) {
    return { repaired: false, cliVersion, gatewayVersion };
  }

  console.warn(`[gateway] Version mismatch detected: CLI=${cliVersion} gateway=${gatewayVersion} — auto-repairing via "openclaw gateway install --force"`);
  send?.('chat:status', {
    type: 'gateway',
    message: `Updating Gateway service from ${gatewayVersion} to ${cliVersion}...`,
  });

  gatewayVersionAutoRepairAt = now;

  try {
    await runAsync('openclaw gateway install --force', 60000);
    console.log('[gateway] Version mismatch repaired — LaunchAgent/service regenerated');
    return { repaired: true, cliVersion, gatewayVersion };
  } catch (err: any) {
    console.warn('[gateway] Version mismatch repair failed:', err?.message || err);
    return { repaired: false, cliVersion, gatewayVersion };
  }
}

async function refreshLegacyWindowsOpenClawSafeMode(): Promise<void> {
  if (process.platform !== 'win32') {
    legacyWindowsOpenClawSafeMode = false;
    return;
  }
  try {
    const versionRaw = await safeShellExecAsync('openclaw --version', 8000);
    const version = extractSemver(versionRaw);
    legacyWindowsOpenClawSafeMode = shouldUseLegacyWindowsOpenClawSafeMode(process.platform, version);
    if (legacyWindowsOpenClawSafeMode) {
      console.warn('[compat] Enabled Windows OpenClaw 2026.4.10 safe mode: skipping startup hook/heal/browser-web mutations');
    }
  } catch {
    legacyWindowsOpenClawSafeMode = false;
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
  //
  // FIX: isGatewayProcessAlive() only checks if port 18789 is bound. On Windows,
  // the scheduled-task Gateway can take 15-30s to load plugins before binding the
  // port. During that window, isGatewayProcessAlive() returns false, causing us
  // to spawn a second `--force` instance → dual-instance fight → broken WS.
  // We now also check for any existing gateway *process* (even if it hasn't bound
  // the port yet) to avoid this race.
  let existingGateway = !launchRecently && await isGatewayProcessAlive();
  if (!existingGateway && !launchRecently) {
    // Check if a gateway process exists but hasn't bound the port yet (still loading plugins).
    // On Windows, the scheduled-task Gateway can take 15-30s to load plugins before binding
    // the port. On macOS/Linux, LaunchAgent or systemd may have the same startup delay.
    try {
      const gatewayPids = await findPrebindingGatewayPids(process.platform, readShellOutputAsync, process.pid);
      if (gatewayPids.length > 0) {
        console.log(`[gateway] Found ${gatewayPids.length} gateway process(es) still loading plugins (PIDs: ${gatewayPids.join(',')}), waiting instead of spawning a new one`);
        existingGateway = true;
      }
    } catch {
      // Non-fatal: fall through to normal spawn logic
    }
  }
  if (existingGateway) {
    console.log('[gateway] Healthy gateway already listening on 18789 — skipping spawn to avoid dual-instance conflict');
    send?.('chat:status', { type: 'gateway', message: 'Waiting for existing Gateway to finish loading...' });
  } else if (!launchRecently) {
    // No one owns the port — clean up any orphan openclaw gateway processes
    // before spawning a fresh one, so the new instance doesn't fight leftovers.
    try {
      const killed = await killZombieGatewayProcesses();
      if (killed.length > 0) {
        console.log(`[gateway] Cleaned up ${killed.length} orphan gateway process(es) before spawn`);
      }
    } catch (err) {
      console.warn('[gateway] Zombie cleanup failed (non-fatal):', err);
    }
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

  // Fast HTTP probe for Gateway readiness — avoids the 15-30s CLI plugin load penalty.
  // Gateway serves / with 200 once HTTP server is up and ready for WebSocket connections.
  const httpProbeGateway = (): Promise<boolean> => new Promise((resolve) => {
    const port = getGatewayPort();
    const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });

  // Wait up to 90 seconds for Gateway to become ready (plugin loading takes 30-60s on Windows).
  // Use fast HTTP probe instead of CLI snapshot to avoid double plugin-load delay.
  let consecutivePortClosed = 0;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    send?.('chat:status', { type: 'gateway', message: `Waiting for Gateway to load plugins... (${i * 2}s)` });
    // Fast pre-filter: skip HTTP probe when port isn't listening yet (~10ms check)
    if (!(await tcpProbeGatewayPort())) {
      consecutivePortClosed++;
      // If port has been closed for 20+ seconds after we spawned, the process
      // likely crashed during plugin loading.  Bail early instead of waiting
      // the full 90 s, so the caller can attempt a different recovery strategy.
      if (consecutivePortClosed >= 10 && !launchRecently) {
        console.warn('[gateway] Port closed for 20s after spawn — Gateway likely crashed during plugin load');
        send?.('chat:status', { type: 'gateway', message: 'Gateway process exited unexpectedly, retrying...' });
        break;
      }
      continue;
    }
    consecutivePortClosed = 0;
    // HTTP probe: Gateway returns 200 on / once HTTP server is ready
    if (await httpProbeGateway()) {
      // Double-check after brief delay to ensure it's stable
      await sleep(1500);
      if (await httpProbeGateway()) {
        if (process.platform === 'win32') {
          writeRuntimePreferences({ ...readRuntimePreferences(), preferUserSessionGateway: true, gatewayHasStackSize: true });
        }
        send?.('chat:status', { type: 'gateway', message: 'Gateway started in app session' });
        return { ok: true };
      }
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

/**
 * Detect and repair missing OpenClaw node host service on Windows.
 *
 * When `openclaw node status` returns `Runtime: unknown`, it means the node
 * host runtime binary is missing. This can happen when:
 * 1. OpenClaw was freshly installed but `openclaw node install` was never run
 * 2. The scheduled task was deleted or corrupted
 *
 * The node host is required for certain local execution features. Without it,
 * some OpenClaw operations may fail with "local helper runtime" errors.
 *
 * This function attempts to auto-repair by running `openclaw node install`,
 * which requires administrator privileges on Windows (creates a scheduled task).
 * If that fails, we try starting a foreground node host process.
 */
async function ensureNodeHostReady(send?: (ch: string, data: any) => void): Promise<{ ok: boolean; repaired: boolean }> {
  // Only check on Windows where this issue is most common
  if (process.platform !== 'win32') {
    return { ok: true, repaired: false };
  }

  try {
    const statusOutput = await readShellOutputAsync('openclaw node status 2>&1', 20000);

    // Check if Runtime is unknown (indicates missing runtime binary)
    if (!statusOutput || !statusOutput.includes('Runtime: unknown')) {
      // Runtime is known (working) or status check failed for other reasons
      return { ok: true, repaired: false };
    }

    console.warn('[node-host] Detected Runtime: unknown — attempting auto-repair');
    send?.('chat:status', { type: 'gateway', message: 'Installing local helper runtime...' });

    // Try to install the node host service (requires admin on Windows)
    try {
      await runAsync('openclaw node install 2>&1', 45000);
      console.log('[node-host] Node host service installed successfully');

      // Start the service after install
      try {
        await runAsync('schtasks /Run /TN "OpenClaw Node" 2>&1', 15000);
        console.log('[node-host] Node host service started');
      } catch (startErr: any) {
        console.warn('[node-host] Could not start scheduled task:', startErr?.message);
      }

      return { ok: true, repaired: true };
    } catch (installErr: any) {
      const errMsg = installErr?.message || '';
      console.warn('[node-host] Node host install failed:', errMsg);

      // If permission was denied, try running in foreground mode
      if (/access|denied|permission|administrator|拒绝/i.test(errMsg)) {
        send?.('chat:status', { type: 'gateway', message: 'Starting helper runtime in app session...' });

        try {
          // Start node host in background (fire-and-forget)
          const child = runSpawn('openclaw', ['node', 'run'], {
            cwd: HOME,
            detached: true,
            windowsHide: true,
            stdio: 'ignore',
          });
          child.unref();
          console.log('[node-host] Started node host in foreground mode');

          // Wait briefly for it to initialize
          await sleep(5000);
          return { ok: true, repaired: true };
        } catch (fgErr: any) {
          console.warn('[node-host] Foreground node host also failed:', fgErr?.message);
        }
      }

      // Install failed, but don't block Gateway startup
      return { ok: false, repaired: false };
    }
  } catch (err: any) {
    console.warn('[node-host] Status check failed:', err?.message);
    return { ok: true, repaired: false }; // Don't block on status check failure
  }
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

  // Windows: ensure node host is ready before Gateway startup.
  // This fixes "local helper runtime" errors on fresh installations.
  if (process.platform === 'win32') {
    const nodeHostResult = await ensureNodeHostReady(send);
    if (nodeHostResult.repaired) {
      console.log('[gateway] Node host was repaired before Gateway startup');
    }
  }

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

  // WORKAROUND: OpenClaw 2026.4.14 introduced a Windows regression where
  // `openclaw gateway status` hangs indefinitely during CLI runtime/plugin
  // loading (GitHub issues #67114, #67035, #66885). Bypass CLI status check
  // on Windows entirely and use extended HTTP probe retries instead.
  let statusOutput: string | null = null;
  if (process.platform !== 'win32') {
    // Non-Windows: CLI check handles non-default ports and older installs.
    statusOutput = await readShellOutputAsync('openclaw gateway status 2>&1', 15000);
    if (isGatewayRunningOutput(statusOutput)) return { ok: true };
  } else {
    // Windows: extra HTTP probes to compensate for skipped CLI check.
    // Gateway plugin loading can take 15-30s; probe every 3s up to 5 times.
    for (let i = 0; i < 5; i++) {
      await sleep(3000);
      if (await httpProbe()) return { ok: true };
    }
  }

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
    let fallback = await startGatewayInUserSession(send);
    if (!fallback.ok) {
      // First attempt may fail if OpenClaw crashed during plugin load (e.g.
      // awareness-memory plugin error, AJV stack overflow).  Wait briefly for
      // the crashed process to fully exit, then retry once.  This handles the
      // common "Gateway starts loading → plugin exception → process exits
      // before port is bound" scenario that leaves the user stuck.
      console.warn('[gateway] First user-session attempt failed, retrying after cleanup...');
      try {
        const killed = await killZombieGatewayProcesses();
        if (killed.length > 0) {
          console.log(`[gateway] Cleaned up ${killed.length} orphan(s) before retry`);
        }
      } catch { /* best-effort */ }
      await sleep(3000);
      emit('Retrying Gateway startup...');
      fallback = await startGatewayInUserSession(send);
    }
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
  // WORKAROUND: Skip CLI check on Windows due to OpenClaw 2026.4.14 regression.
  if (process.platform !== 'win32') {
    const finalStatusOutput = await readShellOutputAsync('openclaw gateway status 2>&1', 15000);
    if (isAuthGatedGatewayStatus(finalStatusOutput)) {
      return {
        ok: false,
        error: authGatedGatewayMessage,
      };
    }
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

      // Retry WS connection up to 3 times with 3s delays. Gateway may need time
      // to finish plugin loading after TCP listener is up (handshake timeout).
      for (let attempt = 0; attempt < 3; attempt++) {
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
          // (handshake races plugin loader — see openclaw#46256).
          console.warn(`[chat] Gateway WS connect attempt ${attempt + 1}/3 failed:`, detail);
          if (attempt < 2) {
            send('chat:status', {
              type: 'gateway',
              message: `Gateway is loading plugins... Retrying connection (${attempt + 2}/3)`,
            });
            await sleep(3000);
          }
        }
      }
    }

    // Gateway is not reachable via TCP, or all WS handshake attempts failed.
    // Trigger a background repair and use CLI fallback for this message.
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
    // Sync memory client's project header so all subsequent requests are scoped
    if (switchResult.ok) {
      setMemoryClientProjectDir(daemonTarget);
    }
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
// preview.6: Mission Flow + legacy workflow handlers removed — users only see
// Chat; AI spawns subagents inline via OpenClaw's native sessions_spawn.
registerGatewayHandlers({
  readShellOutputAsync,
  runAsync,
  startGatewayWithRepair: () => startGatewayWithRepair(),
  startGatewayInUserSession: () => startGatewayInUserSession(),
  isGatewayRunningOutput: (output) => isGatewayRunningOutput(output ?? null),
});
registerMemoryHandlers();
registerFileDialogHandlers();
registerShellHandlers();
registerFixOpenClawHandlers({
  safeShellExecAsync,
  homedir: HOME,
  getLocalDaemonHealth,
});
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

app.whenReady().then(async () => {
  await refreshLegacyWindowsOpenClawSafeMode();

  // Deploy internal hook for awareness memory backup (idempotent, version-gated)
  ensureInternalHook(HOME);

  // Detect CLI/gateway version mismatch (e.g. user upgraded openclaw via npm
  // but LaunchAgent still runs the old bundle — triggers restart loops on
  // 2026.3.8, openclaw#58620). Fire-and-forget so we don't block startup.
  // Non-blocking: typically <200ms for the detection, repair (if needed)
  // runs asynchronously and completes in 5-15s.
  maybeRepairGatewayVersionMismatch().catch((err) => {
    console.warn('[gateway-version] Auto-repair skipped:', err?.message || err);
  });

  // Self-heal the OpenClaw `main` agent if it has degraded into a skeleton entry
  // (no workspace / agentDir). This is the default agent that every channel binding
  // routes to. If main is broken, channels accept messages but never produce replies
  // because the routing target has no workspace and gets dropped from `agents list`.
  if (!legacyWindowsOpenClawSafeMode) {
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
  if (!legacyWindowsOpenClawSafeMode) {
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
        setMemoryClientProjectDir(target);
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

      // CONFIG GUARDIAN: After Gateway starts, OpenClaw may overwrite openclaw.json
      // and strip desktop-specific fields (awareness-memory plugin, multi-agent,
      // tool permissions, etc.).  Wait a few seconds for the dust to settle, then
      // check if the config shrunk and re-apply desktop defaults if needed.
      if (result && result.ok) {
        setTimeout(() => {
          try {
            const guardConfigPath = path.join(HOME, '.openclaw', 'openclaw.json');
            const restored = restoreConfigFromBackupIfNeeded(guardConfigPath);
            if (restored) {
              console.log('[config-guard] Config restored after Gateway startup — re-applying desktop defaults');
            }
            // Always re-apply desktop defaults after Gateway startup,
            // because OpenClaw may have normalized away our additions.
            repairOpenClawConfigFile();
          } catch (err: any) {
            console.warn('[config-guard] Post-gateway config repair failed (non-fatal):', err?.message || err);
          }
        }, 8000);
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
