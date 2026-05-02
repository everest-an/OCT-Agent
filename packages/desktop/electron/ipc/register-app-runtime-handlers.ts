import fs from 'fs';
import path from 'path';
import { app, ipcMain, shell } from 'electron';
import {
  AWARENESS_DOWNLOAD_URL,
  compareSemver,
  fetchLatestDesktopVersion,
} from '../app-update-check';
import { enableDaemonAutostart, disableDaemonAutostart, isDaemonAutostartEnabled } from '../daemon-autostart';
import { patchGatewayCmdStackSize } from '../openclaw-config';
import { safeWriteJsonFile } from '../json-file';

const OPENCLAW_INSTALL_TIMEOUT_MS = 300000;

/**
 * Extract changelog entries between currentVersion and latestVersion from a CHANGELOG.md file.
 * Returns the text of all version sections newer than currentVersion.
 */
function extractChangelog(changelogPath: string, currentVersion: string, latestVersion: string): string {
  try {
    if (!fs.existsSync(changelogPath)) return '';
    const content = fs.readFileSync(changelogPath, 'utf-8');
    const lines = content.split('\n');
    const result: string[] = [];
    let capturing = false;
    let foundAny = false;

    for (const line of lines) {
      // Match version headers like "## [0.6.1] - 2026-04-05"
      const vMatch = line.match(/^## \[(\d+\.\d+\.\d+)\]/);
      if (vMatch) {
        const ver = vMatch[1];
        if (ver === currentVersion) {
          // Stop — we've reached the current installed version
          break;
        }
        capturing = true;
        foundAny = true;
      }
      if (capturing) {
        result.push(line);
      }
    }

    if (!foundAny) return '';
    // Trim to max ~800 chars to avoid bloating IPC
    const text = result.join('\n').trim();
    return text.length > 800 ? text.slice(0, 800) + '\n...' : text;
  } catch {
    return '';
  }
}

export function registerAppRuntimeHandlers(deps: {
  home: string;
  safeShellExecAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  getLocalDaemonHealth: (timeoutMs?: number) => Promise<any | null>;
  runAsync: (cmd: string, timeoutMs?: number) => Promise<string>;
  runAsyncWithProgress: (cmd: string, timeoutMs: number, onLine: (line: string, stream: 'stdout' | 'stderr') => void) => Promise<string>;
  getBundledNpmBin: (binName: 'npx' | 'npm') => string | null;
  shutdownLocalDaemon: (timeoutMs?: number) => Promise<boolean>;
  clearAwarenessLocalNpxCache: (homedir: string) => Promise<string[]> | string[] | void;
  windowsForceKillTree?: (pid: number, timeoutMs?: number) => Promise<boolean>;
  freshNpxCacheArg?: () => string;
  doctor?: {
    runChecks: (subset?: string[]) => Promise<any>;
    runFix: (checkId: string) => Promise<any>;
  };
  getMainWindow: () => any | null;
  onUpgradeRunningChange?: (running: boolean) => void;
}) {
  const UPGRADE_STATE_PATH = path.join(deps.home, '.openclaw', '.desktop-upgrade-state.json');

  const writeUpgradeState = (state: Record<string, unknown>) => {
    try {
      fs.mkdirSync(path.dirname(UPGRADE_STATE_PATH), { recursive: true });
      fs.writeFileSync(UPGRADE_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    } catch {
      // Non-fatal: upgrade can proceed even if state marker fails.
    }
  };

  const clearUpgradeState = () => {
    try {
      fs.rmSync(UPGRADE_STATE_PATH, { force: true });
    } catch {
      // Non-fatal cleanup.
    }
  };

  // Upgrade progress helper — pushes phase info to renderer + taskbar progress
  let lastDetailTs = 0;
  function sendUpgradeProgress(data: {
    component: string;
    phase: string;
    status: 'running' | 'done' | 'error' | 'skipped';
    detail?: string;
    progressFraction?: number;
  }) {
    // Throttle detail-only updates to avoid flooding renderer
    if (data.detail && data.status === 'running') {
      const now = Date.now();
      if (now - lastDetailTs < 200) return;
      lastDetailTs = now;
    }
    const win = deps.getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send('app:upgrade-progress', data);
    // Taskbar / Dock progress bar
    if (typeof data.progressFraction === 'number') {
      win.setProgressBar(data.progressFraction);
    } else if (data.status === 'running') {
      win.setProgressBar(2); // >1 = indeterminate
    }
    if (data.status === 'done' || data.status === 'error') {
      if (data.phase === 'complete' || data.phase === 'failed') {
        win.setProgressBar(-1); // clear
      }
    }
  }

  let activeUpgradeJobs = 0;
  const setUpgradeRunning = (running: boolean) => {
    if (running) {
      activeUpgradeJobs += 1;
    } else {
      activeUpgradeJobs = Math.max(0, activeUpgradeJobs - 1);
    }
    const isRunning = activeUpgradeJobs > 0;
    deps.onUpgradeRunningChange?.(isRunning);
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('app:upgrade-lock', { running: isRunning });
    }
  };
  ipcMain.handle('app:get-platform', () => process.platform);

  ipcMain.handle('app:open-external', (_e: any, url: string) => {
    shell.openExternal(url);
  });

  ipcMain.handle('app:set-login-item', (_e: any, enabled: boolean) => {
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: true,
      });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('app:get-login-item', () => {
    try {
      const settings = app.getLoginItemSettings();
      return { openAtLogin: settings.openAtLogin };
    } catch {
      return { openAtLogin: false };
    }
  });

  // Daemon auto-start on boot (system-level service registration)
  ipcMain.handle('app:set-daemon-autostart', async (_e: any, enabled: boolean) => {
    return enabled ? enableDaemonAutostart() : disableDaemonAutostart();
  });

  ipcMain.handle('app:get-daemon-autostart', async () => {
    return { enabled: await isDaemonAutostartEnabled() };
  });

  ipcMain.handle('app:check-updates', async () => {
    const updates: any[] = [];

    // Desktop app (OCT itself) update check — polls backend for latest version.
    try {
      const currentDesktop = app.getVersion();
      const latest = await fetchLatestDesktopVersion();
      if (latest && currentDesktop && compareSemver(latest.latestVersion, currentDesktop) > 0) {
        updates.push({
          component: 'desktop',
          label: 'OCT Desktop',
          currentVersion: currentDesktop,
          latestVersion: latest.latestVersion,
          changelog: latest.releaseNotes || undefined,
          downloadUrl: latest.downloadUrl || AWARENESS_DOWNLOAD_URL,
        });
      }
    } catch { /* best-effort */ }

    const currentOC = await deps.safeShellExecAsync('openclaw --version');
    if (currentOC) {
      const versionMatch = currentOC.match(/(\d+\.\d+\.\d+)/);
      const current = versionMatch ? versionMatch[1] : null;
      if (current) {
        const latestOC = await deps.safeShellExecAsync('npm view openclaw version', 10000);
        if (latestOC && latestOC.trim() !== current) {
          updates.push({
            component: 'openclaw',
            label: 'OpenClaw',
            currentVersion: current,
            latestVersion: latestOC.trim(),
            changelog: `${current} → ${latestOC.trim()}`,
          });
        }
      }
    }

    try {
      let installedVersion: string | null = null;

      const extPkgPath = path.join(deps.home, '.openclaw', 'extensions', 'openclaw-memory', 'package.json');
      if (fs.existsSync(extPkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(extPkgPath, 'utf8'));
          installedVersion = pkg?.version || null;
        } catch {}
      }

      if (!installedVersion) {
        const lockPath = path.join(deps.home, '.openclaw', 'workspace', '.clawhub', 'lock.json');
        if (fs.existsSync(lockPath)) {
          const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          installedVersion = lock?.skills?.['awareness-memory']?.version || null;
        }
      }

      if (installedVersion) {
        const latestPlugin = await deps.safeShellExecAsync('npm view @awareness-sdk/openclaw-memory version', 10000);
        if (latestPlugin && latestPlugin.trim() !== installedVersion) {
          const pluginChangelog = extractChangelog(
            path.join(deps.home, '.openclaw', 'extensions', 'openclaw-memory', 'CHANGELOG.md'),
            installedVersion,
            latestPlugin.trim(),
          );
          updates.push({
            component: 'plugin',
            label: 'Awareness Memory Plugin',
            currentVersion: installedVersion,
            latestVersion: latestPlugin.trim(),
            changelog: pluginChangelog || undefined,
          });
        }
      }
    } catch {}

    try {
      const health = await deps.getLocalDaemonHealth(2000);
      const daemonCurrent = health?.version;
      if (daemonCurrent) {
        const latestDaemon = await deps.safeShellExecAsync('npm view @awareness-sdk/local version', 10000);
        if (latestDaemon && latestDaemon.trim() !== daemonCurrent) {
          // Try to find daemon CHANGELOG in npx cache
          let daemonChangelog = '';
          try {
            const npxCacheDir = path.join(deps.home, '.npm', '_npx');
            if (fs.existsSync(npxCacheDir)) {
              const entries = fs.readdirSync(npxCacheDir);
              for (const entry of entries) {
                const cl = path.join(npxCacheDir, entry, 'node_modules', '@awareness-sdk', 'local', 'CHANGELOG.md');
                if (fs.existsSync(cl)) {
                  daemonChangelog = extractChangelog(cl, daemonCurrent, latestDaemon.trim());
                  break;
                }
              }
            }
          } catch {}
          updates.push({
            component: 'daemon',
            label: 'Awareness Local Daemon',
            currentVersion: daemonCurrent,
            latestVersion: latestDaemon.trim(),
            changelog: daemonChangelog || undefined,
          });
        }
      }
    } catch {}

    return { updates };
  });

  ipcMain.handle('app:upgrade-component', async (_e: any, component: string) => {
    const progress = (phase: string, status: 'running' | 'done' | 'error' | 'skipped', detail?: string, progressFraction?: number) => {
      sendUpgradeProgress({ component, phase, status, detail, progressFraction });
    };

    setUpgradeRunning(true);
    writeUpgradeState({
      running: true,
      component,
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });

    try {
      if (component === 'desktop') {
        // Desktop app upgrade is manual for now: open the download/landing page in the
        // user's default browser. When we ship electron-updater, replace this with the
        // native download + install flow.
        progress('desktop:open-download', 'running');
        let downloadUrl = AWARENESS_DOWNLOAD_URL;
        try {
          const latest = await fetchLatestDesktopVersion();
          if (latest?.downloadUrl) downloadUrl = latest.downloadUrl;
        } catch {}
        try {
          await shell.openExternal(downloadUrl);
          progress('desktop:open-download', 'done', downloadUrl);
          progress('complete', 'done');
          return { success: true, version: 'manual', downloadUrl };
        } catch (err: any) {
          progress('desktop:open-download', 'error', err?.message);
          return { success: false, error: `Failed to open download page: ${err?.message || 'unknown error'}` };
        }
      } else if (component === 'openclaw') {
        progress('openclaw:check-version', 'running');
        const preVer = await deps.safeShellExecAsync('openclaw --version', 5000);
        const preMatch = preVer?.match(/(\d+\.\d+\.\d+)/);
        const preSemver = preMatch ? preMatch[1] : null;
        progress('openclaw:check-version', 'done', preSemver || undefined);

        let upgraded = false;

        // Tier 1: openclaw update (native self-update)
        if (preVer) {
          progress('openclaw:self-update', 'running');
          try {
            await deps.runAsyncWithProgress('openclaw update --yes --no-restart 2>&1', 180000, (line) => {
              progress('openclaw:self-update', 'running', line.slice(0, 120));
            });
            upgraded = true;
            progress('openclaw:self-update', 'done');
          } catch {
            progress('openclaw:self-update', 'skipped');
          }
        }

        // Tier 2: npm install -g openclaw@latest (use bundled npm if available)
        if (!upgraded) {
          progress('openclaw:npm-install', 'running');
          const npmCli = deps.getBundledNpmBin('npm');
          const registries = ['', '--registry=https://registry.npmmirror.com'];
          for (const reg of registries) {
            try {
              const cmd = npmCli
                ? `"${process.execPath}" "${npmCli}" install -g openclaw@latest ${reg}`.trim()
                : `npm install -g openclaw@latest ${reg}`.trim();
              await deps.runAsyncWithProgress(cmd, OPENCLAW_INSTALL_TIMEOUT_MS, (line) => {
                progress('openclaw:npm-install', 'running', line.slice(0, 120));
              });
              upgraded = true;
              progress('openclaw:npm-install', 'done');
              break;
            } catch {}
          }
          if (!upgraded) progress('openclaw:npm-install', 'skipped');
        }

        // Tier 3: official install script
        if (!upgraded) {
          progress('openclaw:install-script', 'running');
          try {
            if (process.platform === 'win32') {
              await deps.runAsync('powershell -Command "irm https://openclaw.ai/install.ps1 | iex"', OPENCLAW_INSTALL_TIMEOUT_MS);
            } else {
              await deps.runAsync('curl -fsSL https://openclaw.ai/install.sh | bash', OPENCLAW_INSTALL_TIMEOUT_MS);
            }
            upgraded = true;
            progress('openclaw:install-script', 'done');
          } catch {
            progress('openclaw:install-script', 'skipped');
          }
        }

        if (!upgraded) {
          progress('failed', 'error');
          return {
            success: false,
            error: 'OpenClaw upgrade failed. Check your network connection and try again.\nYou can also try in terminal: npm install -g openclaw@latest',
          };
        }

        progress('openclaw:verify', 'running');
        const newVer = await deps.safeShellExecAsync('openclaw --version');
        const vMatch = newVer?.match(/(\d+\.\d+\.\d+)/);
        const newSemver = vMatch ? vMatch[1] : newVer?.trim();

        if (!newSemver) {
          progress('openclaw:verify', 'error');
          return {
            success: false,
            error: `Upgrade may have failed — openclaw not responding after install. Previous version: ${preSemver || 'unknown'}`,
          };
        }

        progress('openclaw:verify', 'done', newSemver);

        // Post-upgrade: auto-fix config schema changes (prevents agent list breakage)
        progress('openclaw:doctor-fix', 'running');
        try {
          await deps.runAsync('openclaw doctor --fix 2>&1', 30000);
          progress('openclaw:doctor-fix', 'done');
        } catch {
          progress('openclaw:doctor-fix', 'skipped', 'doctor fix skipped');
        }

        if (deps.doctor) {
          progress('openclaw:channel-audit', 'running');
          try {
            const audit = await deps.doctor.runChecks(['channel-compatibility']);
            const check = Array.isArray(audit?.checks) ? audit.checks[0] : null;
            if (check?.fixable === 'auto' && (check.status === 'warn' || check.status === 'fail')) {
              const fix = await deps.doctor.runFix('channel-compatibility');
              progress('openclaw:channel-audit', fix?.success ? 'done' : 'skipped', fix?.message || check.message);
            } else {
              progress('openclaw:channel-audit', check?.status === 'pass' ? 'done' : 'skipped', check?.message || 'channel audit skipped');
            }
          } catch {
            progress('openclaw:channel-audit', 'skipped', 'channel audit skipped');
          }
        }

        // Post-upgrade: restart gateway so new version takes effect
        progress('openclaw:gateway-restart', 'running');
        if (process.platform === 'win32') patchGatewayCmdStackSize(deps.home);
        try {
          await deps.runAsync('openclaw gateway restart 2>&1', 20000);
          progress('openclaw:gateway-restart', 'done');
        } catch {
          // Gateway may not be running — that's fine
          progress('openclaw:gateway-restart', 'skipped');
        }

        // Refresh .desktop-bak so the config guardian won't revert legitimate
        // schema changes that the new OpenClaw version introduced during upgrade.
        // Without this, restoreConfigFromBackupIfNeeded() would see "config shrunk
        // vs old backup" and restore the pre-upgrade config, breaking the new version.
        try {
          const cfgPath = path.join(deps.home, '.openclaw', 'openclaw.json');
          if (fs.existsSync(cfgPath)) {
            fs.copyFileSync(cfgPath, cfgPath + '.desktop-bak');
          }
        } catch { /* best effort */ }

        progress('complete', 'done');
        return { success: true, version: newSemver, previousVersion: preSemver };
      } else if (component === 'plugin') {
        const extDir = path.join(deps.home, '.openclaw', 'extensions', 'openclaw-memory');
        const extensionsDir = path.join(deps.home, '.openclaw', 'extensions');
        fs.mkdirSync(extensionsDir, { recursive: true });

        const stageRoot = path.join(extensionsDir, '.openclaw-memory-upgrade-stage');
        const backupDir = path.join(extensionsDir, '.openclaw-memory-upgrade-backup');

        const resetUpgradeDirs = () => {
          try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch {}
          try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
          fs.mkdirSync(stageRoot, { recursive: true });
        };

        // Clean only staging area. Called in fallbacks so backupDir is preserved
        // until the new install succeeds — ensuring extDir can always be restored.
        const cleanStageOnly = () => {
          try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch {}
          fs.mkdirSync(stageRoot, { recursive: true });
        };

        // If a prior commitStagedPlugin failed at the rename step, extDir may be
        // missing while backupDir still holds the old plugin. Restore it before
        // attempting any fallback so we never start from a completely empty state.
        const restoreFromBackupIfNeeded = () => {
          try {
            if (!fs.existsSync(extDir) && fs.existsSync(backupDir)) {
              fs.renameSync(backupDir, extDir);
            }
          } catch {}
        };

        const commitStagedPlugin = (stagedDir: string): void => {
          const oldExists = fs.existsSync(extDir);
          try {
            if (oldExists) {
              try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
              fs.renameSync(extDir, backupDir);
            }
            fs.renameSync(stagedDir, extDir);
            if (oldExists) {
              try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
            }
          } catch (err) {
            // Roll back so partial upgrades never wipe the user's existing plugin.
            try {
              if (!fs.existsSync(extDir) && fs.existsSync(backupDir)) {
                fs.renameSync(backupDir, extDir);
              }
            } catch {}
            throw err;
          }
        };

        progress('plugin:cleanup', 'running');
        resetUpgradeDirs();
        progress('plugin:cleanup', 'done');

        const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null';
        const pluginRegistries = ['', '--registry=https://registry.npmmirror.com'];

        const finalizePluginUpgrade = (dir: string): string => {
          let newVer = 'latest';
          try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            newVer = pkg.version || 'latest';
          } catch {}
          try {
            const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
            if (fs.existsSync(configPath)) {
              const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
              const installs = config?.plugins?.installs;
              if (installs?.['openclaw-memory']) {
                installs['openclaw-memory'].version = newVer;
                installs['openclaw-memory'].resolvedVersion = newVer;
                installs['openclaw-memory'].resolvedSpec = `@awareness-sdk/openclaw-memory@${newVer}`;
                installs['openclaw-memory'].installedAt = new Date().toISOString();
                safeWriteJsonFile(configPath, config);
              }
            }
          } catch {}
          return newVer;
        };

        for (const regFlag of pluginRegistries) {
          try {
            progress('plugin:npm-pack', 'running');
            const packOut = await deps.runAsync(`cd "${extensionsDir}" && npm pack @awareness-sdk/openclaw-memory@latest ${regFlag} 2>${nullDev}`, 120000);
            const tgzName = packOut.trim().split('\n').pop()?.trim() || '';
            if (!tgzName || !tgzName.endsWith('.tgz')) {
              throw new Error('npm pack did not produce a tarball');
            }
            progress('plugin:npm-pack', 'done');

            const stagedExtDir = path.join(stageRoot, `attempt-${Date.now()}`);

            progress('plugin:extract', 'running');
            const tgzPath = path.join(extensionsDir, tgzName);
            fs.mkdirSync(stagedExtDir, { recursive: true });
            await deps.runAsync(`tar -xzf "${tgzPath}" -C "${stagedExtDir}" --strip-components=1`, 30000);
            try { fs.unlinkSync(tgzPath); } catch {}
            progress('plugin:extract', 'done');

            progress('plugin:npm-install', 'running');
            await deps.runAsyncWithProgress(`cd "${stagedExtDir}" && npm install --omit=dev --no-audit --no-fund`, 300000, (line) => {
              progress('plugin:npm-install', 'running', line.slice(0, 120));
            });
            progress('plugin:npm-install', 'done');

            progress('plugin:finalize', 'running');
            const newVer = finalizePluginUpgrade(stagedExtDir);
            commitStagedPlugin(stagedExtDir);
            progress('plugin:finalize', 'done', newVer);
            progress('complete', 'done');
            return { success: true, version: newVer, method: regFlag ? 'npm-direct-mirror' : 'npm-direct' };
          } catch {}
        }

        progress('plugin:fallback-openclaw', 'running');
        try {
          restoreFromBackupIfNeeded();
          cleanStageOnly();
          await deps.runAsyncWithProgress(`cd "${deps.home}" && openclaw plugins install @awareness-sdk/openclaw-memory`, 120000, (line) => {
            progress('plugin:fallback-openclaw', 'running', line.slice(0, 120));
          });
          const newVer = finalizePluginUpgrade(extDir);
          try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
          progress('plugin:fallback-openclaw', 'done');
          progress('complete', 'done');
          return { success: true, version: newVer, method: 'openclaw-plugin' };
        } catch {
          restoreFromBackupIfNeeded();
          progress('plugin:fallback-openclaw', 'skipped');
        }

        progress('plugin:fallback-clawhub', 'running');
        try {
          restoreFromBackupIfNeeded();
          cleanStageOnly();
          await deps.runAsyncWithProgress(`cd "${deps.home}" && npx -y clawhub@latest install awareness-memory --force`, 120000, (line) => {
            progress('plugin:fallback-clawhub', 'running', line.slice(0, 120));
          });
          const newVer = finalizePluginUpgrade(extDir);
          try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
          progress('plugin:fallback-clawhub', 'done');
          progress('complete', 'done');
          return { success: true, version: newVer, method: 'clawhub' };
        } catch (e: any) {
          restoreFromBackupIfNeeded();
          progress('failed', 'error');
          throw new Error(`Plugin upgrade failed: ${e.message?.slice(0, 200)}`);
        }
      } else if (component === 'daemon') {
        const isWin = process.platform === 'win32';
        progress('daemon:shutdown', 'running');
        await deps.shutdownLocalDaemon(3000);

        // Windows native addon (better-sqlite3.node) locks its DLL file as
        // long as ANY process in the tree holds it. `process.kill` on
        // Windows only terminates the tracked PID, leaving children +
        // native handles alive — breaks the subsequent `npx install`
        // with EBUSY on rename. Use `taskkill /F /T` to kill the tree.
        for (let w = 0; w < 6; w++) {
          const health = await deps.getLocalDaemonHealth(1000);
          if (!health?.pid) break;
          if (w === 3 && health?.version) {
            try { process.kill(health.pid, 'SIGKILL'); } catch {}
            if (isWin && deps.windowsForceKillTree) {
              try { await deps.windowsForceKillTree(health.pid, 5000); } catch {}
            }
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        // Extra settle time on Windows — DLL handles take 1-2s to drop
        // even after TerminateProcess returns. Without this, the next
        // rmSync/npx-rename hits EBUSY.
        if (isWin) await new Promise((r) => setTimeout(r, 2000));
        progress('daemon:shutdown', 'done');

        progress('daemon:clear-cache', 'running');
        const stuck = (await Promise.resolve(deps.clearAwarenessLocalNpxCache(deps.home))) || [];
        const cacheLocked = Array.isArray(stuck) && stuck.length > 0;
        progress('daemon:clear-cache', cacheLocked ? 'running' : 'done', cacheLocked ? `${stuck.length} entries still locked — using fresh cache` : undefined);

        // If the old cache is locked (Windows EBUSY that survived retry),
        // install into a fresh throwaway --cache so npx doesn't need to
        // rename over the locked dir. Resolves the Windows upgrade path
        // when antivirus / file-indexer is scanning the old DLL.
        const npxArgs = cacheLocked && deps.freshNpxCacheArg ? ` ${deps.freshNpxCacheArg()}` : '';

        progress('daemon:start', 'running', 'downloading package (first install may take 1-3 min)...');
        // 5 minute idle timeout (was 60s). First-time `npx` resolves
        // the tarball, extracts, then compiles better-sqlite3 native
        // addon — on slow CPUs / slow network this alone is 60-180s.
        // 0.9.6+ also downloads multilingual-e5-small (118MB) on first
        // daemon boot. runAsyncWithProgress is idle-timeout, so 300s
        // only fires if nothing outputs for 5 min — safe ceiling.
        const DAEMON_START_TIMEOUT_MS = 300_000;
        try {
          await deps.runAsyncWithProgress(
            `npx -y${npxArgs} @awareness-sdk/local@latest start --port 37800 --project "${path.join(deps.home, '.openclaw')}" --background`,
            DAEMON_START_TIMEOUT_MS,
            (line) => { progress('daemon:start', 'running', line.slice(0, 120)); },
          );
        } catch (err: any) {
          // One more rescue: on any error, retry with a fresh --cache so
          // users who hit EBUSY on the first attempt at least succeed on
          // retry without having to reboot.
          const msg = String(err?.message || '');
          if ((msg.includes('EBUSY') || msg.includes('rename') || msg.includes('errno -4082')) && deps.freshNpxCacheArg) {
            progress('daemon:start', 'running', 'cache locked — retrying with fresh cache...');
            await deps.runAsyncWithProgress(
              `npx -y ${deps.freshNpxCacheArg()} @awareness-sdk/local@latest start --port 37800 --project "${path.join(deps.home, '.openclaw')}" --background`,
              DAEMON_START_TIMEOUT_MS,
              (line) => { progress('daemon:start', 'running', line.slice(0, 120)); },
            );
          } else {
            throw err;
          }
        }
        progress('daemon:start', 'done');

        for (let i = 0; i < 12; i++) {
          progress('daemon:health-check', 'running', `${i + 1}/12`, (i + 1) / 12);
          const delay = i < 3 ? 1000 : i < 6 ? 2000 : 3000;
          await new Promise(r => setTimeout(r, delay));
          const health = await deps.getLocalDaemonHealth(3000);
          if (health?.version) {
            progress('daemon:health-check', 'done', health.version, 1);
            progress('complete', 'done');
            return { success: true, version: health.version };
          }
        }
        progress('complete', 'done');
        return { success: true, version: 'latest' };
      }
      return { success: false, error: 'Unknown component' };
    } catch (err: any) {
      console.error(`[upgrade] ${component} failed:`, err.message);
      progress('failed', 'error', (err.message || '').slice(0, 120));
      const msg = err.message || '';
      if (msg.includes('EACCES') || msg.includes('permission denied') || msg.includes('Permission denied')) {
        return {
          success: false,
          error: 'Permission denied. Run this in terminal to fix:\n  npm config set prefix ~/.npm-global\n  export PATH=~/.npm-global/bin:$PATH',
        };
      }
      if (msg.includes('EBUSY') || msg.includes('errno -4082')) {
        return {
          success: false,
          error: 'Upgrade blocked: Windows file lock on the daemon cache.\nPlease:\n  1. Right-click the OCT tray icon → Quit\n  2. Wait 5 seconds for the background daemon to release files\n  3. Re-open OCT and click Upgrade again\nOr run: taskkill /F /T /IM node.exe (warning: kills all Node processes)',
        };
      }
      return { success: false, error: msg.slice(0, 300) };
    } finally {
      setUpgradeRunning(false);
      clearUpgradeState();
    }
  });
}