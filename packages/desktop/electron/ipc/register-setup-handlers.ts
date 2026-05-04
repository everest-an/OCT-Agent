import fs from 'fs';
import os from 'os';
import path from 'path';
import { ipcMain, shell } from 'electron';
import { writeDesktopExecApprovalDefaults } from '../openclaw-config';
import { readJsonFileWithBom, safeWriteJsonFile } from '../json-file';

const OPENCLAW_INSTALL_TIMEOUT_MS = 300000;
const OPENCLAW_STATUS_PULSE_MS = 15000;
const SETUP_DAEMON_WAIT_PRIMARY_MS = 45000;
const SETUP_DAEMON_WAIT_AFTER_DIRECT_TRIGGER_MS = 30000;
const SETUP_DAEMON_WAIT_PREPARING_MS = 120000;
const SETUP_DAEMON_WAIT_RETRYING_MS = 180000;
const SETUP_DAEMON_WAIT_AFTER_BOOTSTRAP_MS = 90000;
const SETUP_DAEMON_BOOTSTRAP_TIMEOUT_MS = 240000;

function isCommandTimeoutError(message: string) {
  return /timed out/i.test(message);
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(1, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function stripWrappingQuotes(value: string) {
  return String(value || '').trim().replace(/^['"]+|['"]+$/g, '');
}

function normalizeHomePath(value: string) {
  const normalized = stripWrappingQuotes(value);
  return normalized || value;
}

function hasAwarenessPluginPackage(home: string) {
  return fs.existsSync(path.join(home, '.openclaw', 'extensions', 'openclaw-memory', 'package.json'));
}

function isPathInside(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function removeAwarenessPluginExtensionIfInvalid(home: string) {
  const extensionsDir = path.join(home, '.openclaw', 'extensions');
  const extDir = path.join(extensionsDir, 'openclaw-memory');
  const pkgPath = path.join(extDir, 'package.json');
  if (!fs.existsSync(extDir) || fs.existsSync(pkgPath)) return;
  if (!isPathInside(extensionsDir, extDir)) return;
  fs.rmSync(extDir, { recursive: true, force: true });
}

function patchAwarenessPluginWindowsNpx(home: string) {
  const distDir = path.join(home, '.openclaw', 'extensions', 'openclaw-memory', 'dist');
  for (const fileName of ['index.js', 'index.cjs']) {
    const filePath = path.join(distDir, fileName);
    if (!fs.existsSync(filePath)) continue;
    const before = fs.readFileSync(filePath, 'utf8');
    const after = before.replace(
      /spawn\((["'])npx\1\s*,/g,
      'spawn(process.platform === "win32" ? "npx.cmd" : "npx",',
    );
    if (after !== before) fs.writeFileSync(filePath, after, 'utf8');
  }
}

export function registerSetupHandlers(deps: {
  home: string;
  getEnhancedPath: () => string;
  getNodeVersion: () => string | null;
  runAsync: (cmd: string, timeoutMs?: number) => Promise<string>;
  safeShellExecAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  getBundledNpmBin: (binName: 'npx' | 'npm') => string | null;
  resolveBundledCache: (fileName: string) => string | null;
  downloadFile: (url: string, dest: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  getLocalDaemonHealth: (timeoutMs?: number) => Promise<any | null>;
  checkDaemonHealth: () => Promise<boolean>;
  waitForLocalDaemonReady: (
    timeoutMs: number,
    statusKey: string,
    options: { sendStatus: (key: string, detail?: string) => void; sleep: (ms: number) => Promise<void> },
  ) => Promise<boolean>;
  sendSetupDaemonStatus: (key: string, detail?: string) => void;
  startLocalDaemonDetached: (options: {
    homedir: string;
    resolveBundledCache: (fileName: string) => string | null;
    getBundledNpmBin: (binName: 'npx' | 'npm') => string | null;
    runSpawn: (cmd: string, args: string[], opts?: Record<string, unknown>) => any;
    getEnhancedPath: () => string;
  }) => Promise<void>;
  runSpawn: (cmd: string, args: string[], opts?: Record<string, unknown>) => any;
  forceStopLocalDaemon: (options: { sleep: (ms: number) => Promise<void> }) => Promise<void>;
  clearAwarenessLocalNpxCache: (homedir: string) => void;
  formatDaemonSetupError: () => string;
  persistAwarenessPluginConfig: (options?: { enableSlot?: boolean }) => void;
  applyAwarenessPluginConfig: (config: Record<string, any>, options?: { enableSlot?: boolean }) => void;
  sanitizeAwarenessPluginConfig: (config: Record<string, any>) => void;
  mergeOpenClawConfig: (existing: Record<string, any>, incoming: Record<string, any>) => Record<string, any>;
  getDaemonStartupPromise: () => Promise<{ success: boolean; alreadyRunning?: boolean; error?: string }> | null;
  setDaemonStartupPromise: (value: Promise<{ success: boolean; alreadyRunning?: boolean; error?: string }> | null) => void;
  getDaemonStartupLastKickoff: () => number;
  setDaemonStartupLastKickoff: (value: number) => void;
  sendSetupStatus: (stepKey: string, key: string, detail?: string) => void;
  setOpenclawInstalling: (value: boolean) => void;
}) {
  const sendOpenClawStatus = (key: string, detail?: string) => deps.sendSetupStatus('openclaw', key, detail);

  const runOpenClawStage = async <T>(key: string, task: () => Promise<T>) => {
    sendOpenClawStatus(key);
    const startedAt = Date.now();
    const interval = setInterval(() => {
      sendOpenClawStatus(key, formatElapsed(Date.now() - startedAt));
    }, OPENCLAW_STATUS_PULSE_MS);

    try {
      return await task();
    } finally {
      clearInterval(interval);
    }
  };

  const isNodeBinaryMissing = (message: string) => {
    const normalized = message.toLowerCase();
    return normalized.includes('enoent')
      || normalized.includes('node is not recognized')
      || normalized.includes('command not found')
      || normalized.includes('not recognized as an internal or external command');
  };

  const isNodeCliEntryMissing = (message: string) => {
    const normalized = message.toLowerCase();
    return normalized.includes('cannot find module') || normalized.includes('module not found');
  };

  const runWithBundledNpmCli = async (
    cliPath: string,
    cliArgs: string,
    timeoutMs: number,
    cwd?: string,
  ) => {
    const prefix = cwd ? `cd "${cwd}" && ` : '';
    const nodeCommand = `${prefix}node "${cliPath}" ${cliArgs}`.trim();
    try {
      return await deps.runAsync(nodeCommand, timeoutMs);
    } catch (nodeErr: any) {
      const message = nodeErr?.message || String(nodeErr);
      if (!isNodeBinaryMissing(message) && !isNodeCliEntryMissing(message)) throw nodeErr;

      const processCommand = `${prefix}"${process.execPath}" "${cliPath}" ${cliArgs}`.trim();
      return deps.runAsync(processCommand, timeoutMs);
    }
  };

  const runSpawnCommand = async (
    cmd: string,
    args: string[],
    timeoutMs: number,
    opts?: Record<string, unknown>,
  ) => new Promise<string>((resolve, reject) => {
    let child: any;
    try {
      child = deps.runSpawn(cmd, args, { stdio: 'pipe', ...(opts || {}) });
    } catch (spawnErr) {
      reject(spawnErr);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error('Command timed out'));
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || stdout.trim().slice(-500) || `Exit code ${code}`));
      }
    });

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });

  ipcMain.handle('setup:detect-environment', async () => {
    const result: Record<string, unknown> = {
      platform: process.platform,
      arch: process.arch,
      home: deps.home,
      electronNodeVersion: process.version,
      systemNodeInstalled: false,
      systemNodeVersion: null,
      npmInstalled: false,
      openclawInstalled: false,
      openclawVersion: null,
      hasExistingConfig: false,
    };

    const nodeVersion = await deps.safeShellExecAsync('node --version', 5000);
    if (nodeVersion) {
      result.systemNodeInstalled = true;
      result.systemNodeVersion = nodeVersion;
      // Flag if version is too old for daemon (requires v20+)
      const majorMatch = nodeVersion.match(/v(\d+)/);
      const major = majorMatch ? parseInt(majorMatch[1], 10) : 0;
      result.nodeVersionTooOld = major > 0 && major < 20;
    }

    result.npmInstalled = await deps.safeShellExecAsync('npm --version', 5000) !== null;

    const openclawVersion = await deps.safeShellExecAsync('openclaw --version', 8000);
    if (openclawVersion) {
      result.openclawInstalled = true;
      result.openclawVersion = openclawVersion;
    }

    try {
      const configPath = path.join(deps.home, '.openclaw', 'openclaw.json');
      result.hasExistingConfig = fs.existsSync(configPath);
    } catch {}

    try {
      const pluginPkg = path.join(deps.home, '.openclaw', 'extensions', 'openclaw-memory', 'package.json');
      if (fs.existsSync(pluginPkg)) {
        const pkg = JSON.parse(fs.readFileSync(pluginPkg, 'utf8'));
        result.awarenessPluginVersion = pkg.version || null;
      }
    } catch {}

    const health = await deps.getLocalDaemonHealth(2000);
    if (health) {
      result.daemonRunning = health.status === 'ok';
      result.daemonVersion = health.version || null;
      result.daemonStats = { memories: health.stats?.totalMemories, knowledge: health.stats?.totalKnowledge, sessions: health.stats?.totalSessions };
    } else {
      result.daemonRunning = false;
    }

    return result;
  });

  ipcMain.handle('setup:install-nodejs', async () => {
    const currentVersion = deps.getNodeVersion();
    if (currentVersion) {
      // Check minimum version — daemon requires Node.js v20+ (ES2022+ features)
      const majorMatch = currentVersion.match(/v(\d+)/);
      const major = majorMatch ? parseInt(majorMatch[1], 10) : 0;
      if (major >= 20) {
        return { success: true, alreadyInstalled: true, version: currentVersion };
      }
      // Old Node.js detected — proceed to install newer version
      // (existing version stays, new one gets higher PATH priority via nvm/managed install)
    }

    try {
      if (process.platform === 'win32') {
        // Tier 1: winget (only if available — skip quickly if not)
        const hasWinget = await deps.safeShellExecAsync('winget --version', 3000);
        if (hasWinget) {
          try {
            await deps.runAsync('winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements', 300000);
            return { success: true, method: 'winget' };
          } catch { /* fall through to MSI */ }
        }

        // Tier 2: MSI download + install
        try {
          const msiUrl = 'https://nodejs.org/dist/v22.12.0/node-v22.12.0-x64.msi';
          const msiPath = path.join(os.tmpdir(), `node-installer-${Date.now()}.msi`);
          await deps.downloadFile(msiUrl, msiPath);
          if (!fs.existsSync(msiPath)) {
            return { success: false, error: 'Download failed — file was not created.', hint: 'Check your internet connection and try again.' };
          }
          await deps.runAsync(`msiexec /i "${msiPath}" /qn`, 300000);
          // Verify Node.js is now available
          await deps.sleep(2000);
          if (!deps.getNodeVersion()) {
            return {
              success: false,
              error: 'Node.js installer ran but node is not available. This usually means administrator rights are needed.',
              hint: 'Please reopen OCT as administrator, or install Node.js manually from https://nodejs.org',
            };
          }
          return { success: true, method: 'msi' };
        } catch (msiErr) {
          const msg = String(msiErr);
          if (msg.includes('EACCES') || msg.includes('Access is denied') || msg.includes('elevation')) {
            return {
              success: false,
              error: 'Node.js installation requires administrator rights.',
              hint: 'Please reopen OCT as administrator, or install Node.js manually from https://nodejs.org',
            };
          }
          return { success: false, error: msg, hint: 'Please install Node.js 22+ manually from https://nodejs.org' };
        }
      } else if (process.platform === 'darwin') {
        const hasBrew = await deps.safeShellExecAsync('brew --version') !== null;
        if (hasBrew) {
          try {
            await deps.runAsync('brew install node@22', 300000);
            return { success: true, method: 'homebrew' };
          } catch {}
        }
        const pkgUrl = 'https://nodejs.org/dist/v22.12.0/node-v22.12.0.pkg';
        const pkgPath = path.join(os.tmpdir(), 'node-installer.pkg');
        await deps.downloadFile(pkgUrl, pkgPath);
        await deps.runAsync(`open "${pkgPath}"`, 10000);
        for (let i = 0; i < 30; i++) {
          const delay = i < 3 ? 2000 : i < 6 ? 4000 : 8000;
          await deps.sleep(delay);
          if (deps.getNodeVersion()) return { success: true, method: 'pkg-gui' };
        }
        return { success: false, error: 'Node.js installation timed out' };
      } else {
        const sudoCmd = fs.existsSync('/usr/bin/pkexec') ? 'pkexec' : 'sudo';
        try {
          await deps.runAsync(`curl -fsSL https://deb.nodesource.com/setup_22.x | ${sudoCmd} -E bash - && ${sudoCmd} apt-get install -y nodejs`, 300000);
          return { success: true, method: 'nodesource-deb' };
        } catch {
          try {
            await deps.runAsync(`curl -fsSL https://rpm.nodesource.com/setup_22.x | ${sudoCmd} bash - && ${sudoCmd} dnf install -y nodejs`, 300000);
            return { success: true, method: 'nodesource-rpm' };
          } catch (err) {
            return {
              success: false,
              error: String(err),
              hint: 'Linux requires admin privileges. Please run in terminal:\n  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -\n  sudo apt-get install -y nodejs',
            };
          }
        }
      }
    } catch (err) {
      return {
        success: false,
        error: String(err),
        hint: 'Please install Node.js 22+ manually from https://nodejs.org',
      };
    }
  });

  ipcMain.handle('setup:install-openclaw', async () => {
    sendOpenClawStatus('setup.install.openclawStatus.checking');

    // Check if already installed (PATH-based + npm root)
    const existing = await deps.safeShellExecAsync('openclaw --version');
    if (existing) {
      sendOpenClawStatus('setup.install.openclawStatus.ready');
      return { success: true, alreadyInstalled: true, version: existing };
    }

    deps.setOpenclawInstalling(true);
    try {
      return await _installOpenclawCore();
    } finally {
      deps.setOpenclawInstalling(false);
    }
  });

  async function _installOpenclawCore(): Promise<{ success: boolean; alreadyInstalled?: boolean; version?: string; method?: string; error?: string; hint?: string }> {
    const npmRoot = await deps.safeShellExecAsync('npm root -g', 5000);
    if (npmRoot) {
      const openclawDir = path.join(npmRoot.trim(), 'openclaw');
      const globalOpenClawPkg = path.join(openclawDir, 'package.json');
      if (fs.existsSync(globalOpenClawPkg)) {
        sendOpenClawStatus('setup.install.openclawStatus.foundPackage');
        const ver = await deps.safeShellExecAsync('openclaw --version', 8000);
        if (ver) {
          return {
            success: true,
            alreadyInstalled: true,
            version: ver,
          };
        }
        // package.json exists but openclaw --version fails: corrupted install.
        // Remove the broken directory so npm install -g can proceed cleanly.
        console.warn('[setup] openclaw package.json exists but binary is broken — removing corrupted install at', openclawDir);
        try { fs.rmSync(openclawDir, { recursive: true, force: true }); } catch {}
      } else if (fs.existsSync(openclawDir)) {
        // Directory exists but no package.json (interrupted install / corrupted).
        // npm install -g will fail with ENOTEMPTY if we don't clean up first.
        console.warn('[setup] openclaw directory exists without package.json — removing corrupted install at', openclawDir);
        try { fs.rmSync(openclawDir, { recursive: true, force: true }); } catch {}
      }
    }

    // Not found — install with native npm install -g
    // First: auto-fix npm prefix if it requires sudo (macOS/Linux only)
    if (process.platform !== 'win32') {
      const npmPrefix = await deps.safeShellExecAsync('npm config get prefix', 5000);
      const needsSudo = npmPrefix && (
        npmPrefix.trim().startsWith('/usr/local') ||
        npmPrefix.trim().startsWith('/usr/lib') ||
        npmPrefix.trim() === '/usr'
      );
      if (needsSudo) {
        const userPrefix = path.join(deps.home, '.npm-global');
        try {
          fs.mkdirSync(userPrefix, { recursive: true });
          await deps.runAsync(`npm config set prefix "${userPrefix}"`, 10000);
        } catch {
          // Best-effort — if this fails, npm install -g will fail with EACCES
          // and the error message will guide the user
        }
      }
    }

    const registries = ['', '--registry=https://registry.npmmirror.com'];
    let lastError = '';

    // Tier 1: npm install -g (try bundled npm first for reliability)
    const npmCli = deps.getBundledNpmBin('npm');
    for (const reg of registries) {
      try {
        sendOpenClawStatus(
          reg
            ? 'setup.install.openclawStatus.retryingMirror'
            : npmCli
              ? 'setup.install.openclawStatus.preparingBundledNpm'
              : 'setup.install.openclawStatus.preparingNpm'
        );
        const cmd = npmCli
          ? `install -g openclaw ${reg}`.trim()
          : `npm install -g openclaw ${reg}`.trim();
        await runOpenClawStage('setup.install.openclawStatus.downloading', () => {
          if (npmCli) {
            return runWithBundledNpmCli(npmCli, cmd, OPENCLAW_INSTALL_TIMEOUT_MS);
          }
          return deps.runAsync(cmd, OPENCLAW_INSTALL_TIMEOUT_MS);
        });
        sendOpenClawStatus('setup.install.openclawStatus.verifying');
        const verified = await deps.safeShellExecAsync('openclaw --version', 10000);
        if (verified) {
          sendOpenClawStatus('setup.install.openclawStatus.ready');
          return { success: true, version: verified };
        }
      } catch (err) {
        lastError = String(err);
      }
    }

    // Tier 2: official install script
    try {
      if (process.platform === 'win32') {
        const execPolicy = await deps.safeShellExecAsync('powershell -NoProfile -Command "Get-ExecutionPolicy"', 5000);
        if (execPolicy?.trim().toLowerCase() === 'restricted') {
          return {
            success: false,
            error: 'PowerShell execution policy is too restrictive to install OpenClaw.\nPlease run in PowerShell as administrator:\n  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser\nThen reopen OCT.',
          };
        }
        await runOpenClawStage('setup.install.openclawStatus.officialInstaller', () => deps.runAsync('powershell -NoProfile -Command "irm https://openclaw.ai/install.ps1 | iex"', OPENCLAW_INSTALL_TIMEOUT_MS));
      } else {
        await runOpenClawStage('setup.install.openclawStatus.officialInstaller', () => deps.runAsync('curl -fsSL https://openclaw.ai/install.sh | bash', OPENCLAW_INSTALL_TIMEOUT_MS));
      }
      sendOpenClawStatus('setup.install.openclawStatus.verifying');
      const verified = await deps.safeShellExecAsync('openclaw --version', 10000);
      if (verified) {
        sendOpenClawStatus('setup.install.openclawStatus.ready');
        return { success: true, method: 'official-script', version: verified };
      }
      return {
        success: false,
        error: 'OpenClaw files were downloaded, but the command is still unavailable. OCT will not continue until OpenClaw can actually run.',
      };
    } catch (err) {
      const msg = String(err);
      if (isCommandTimeoutError(msg) || isCommandTimeoutError(lastError)) {
        return {
          success: false,
          error: process.platform === 'win32'
            ? 'Installing OpenClaw is taking longer than expected. First-time setup on Windows can take 2-5 minutes. Please keep this window open and retry once.'
            : 'Installing OpenClaw is taking longer than expected. First-time setup can take several minutes. Please keep this window open and retry once.',
          hint: 'You can also install manually in terminal: npm install -g openclaw',
        };
      }
      if (/EACCES|permission denied|Access is denied/i.test(msg) || /EACCES|permission denied/i.test(lastError)) {
        const isWin = process.platform === 'win32';
        const fallbackCmd = isWin 
          ? 'npm config set prefix "%APPDATA%\\npm" && npm install -g openclaw'
          : 'npm config set prefix ~/.npm-global && export PATH=~/.npm-global/bin:$PATH && npm install -g openclaw';
        return {
          success: false,
          error: `Permission denied during installation. Please run in terminal:\n  ${fallbackCmd}`,
        };
      }
      return { success: false, error: msg, hint: 'Install OpenClaw manually: npm install -g openclaw' };
    }
  }

  ipcMain.handle('setup:install-plugin', async () => {
    const hasOpenClaw = await deps.safeShellExecAsync('openclaw --version') !== null;
    const npmCli = deps.getBundledNpmBin('npm');
    const pluginTarball = deps.resolveBundledCache('awareness-memory.tgz');

    const extensionsDir = path.join(deps.home, '.openclaw', 'extensions');
    const extDir = path.join(extensionsDir, 'openclaw-memory');
    const stageRoot = path.join(extensionsDir, '.openclaw-memory-setup-stage');
    const backupDir = path.join(extensionsDir, '.openclaw-memory-setup-backup');
    const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const setupRegistries = ['', '--registry=https://registry.npmmirror.com'];
    const installErrors: string[] = [];
    const recordInstallError = (stage: string, err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      installErrors.push(`${stage}: ${message.slice(0, 240)}`);
    };
    let npmDirectOk = false;

    const resetSetupStageDirs = () => {
      try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
      fs.mkdirSync(stageRoot, { recursive: true });
    };

    const commitSetupStagePlugin = (stagedDir: string): void => {
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
        try {
          if (!fs.existsSync(extDir) && fs.existsSync(backupDir)) {
            fs.renameSync(backupDir, extDir);
          }
        } catch {}
        throw err;
      }
    };

    removeAwarenessPluginExtensionIfInvalid(deps.home);
    for (const regFlag of setupRegistries) {
      try {
        resetSetupStageDirs();
        fs.mkdirSync(extensionsDir, { recursive: true });
        const packOut = await deps.runAsync(`cd "${extensionsDir}" && npm pack @awareness-sdk/openclaw-memory@latest ${regFlag} 2>${nullDev}`, 120000);
        const tgzName = packOut.trim().split('\n').pop()?.trim() || '';
        if (!tgzName || !tgzName.endsWith('.tgz')) throw new Error('npm pack failed');
        const tgzPath = path.join(extensionsDir, tgzName);
        const stagedExtDir = path.join(stageRoot, `attempt-${Date.now()}`);
        fs.mkdirSync(stagedExtDir, { recursive: true });
        await deps.runAsync(`tar -xzf "${tgzPath}" -C "${stagedExtDir}" --strip-components=1`, 30000);
        try { fs.unlinkSync(tgzPath); } catch {}
        const stagedPkg = path.join(stagedExtDir, 'package.json');
        if (!fs.existsSync(stagedPkg)) {
          throw new Error('awareness plugin package.json missing after extract');
        }
        commitSetupStagePlugin(stagedExtDir);
        if (!hasAwarenessPluginPackage(deps.home)) {
          throw new Error('awareness plugin package.json missing after commit');
        }
        patchAwarenessPluginWindowsNpx(deps.home);
        deps.persistAwarenessPluginConfig({ enableSlot: true });
        writeDesktopExecApprovalDefaults(deps.home);
        npmDirectOk = true;
        return { success: true, method: regFlag ? 'npm-direct-mirror' : 'npm-direct' };
      } catch (err) {
        recordInstallError(regFlag ? 'npm-direct-mirror' : 'npm-direct', err);
        removeAwarenessPluginExtensionIfInvalid(deps.home);
      }
    }
    if (!npmDirectOk) {}

    if (hasOpenClaw) {
      try {
        await deps.runAsync(`cd "${deps.home}" && openclaw plugins install @awareness-sdk/openclaw-memory`, 60000);
        if (!hasAwarenessPluginPackage(deps.home)) {
          throw new Error('awareness plugin package.json missing after openclaw plugins install');
        }
        patchAwarenessPluginWindowsNpx(deps.home);
        deps.persistAwarenessPluginConfig({ enableSlot: true });
        writeDesktopExecApprovalDefaults(deps.home);
        return { success: true, method: 'openclaw-plugin' };
      } catch (err) {
        recordInstallError('openclaw-plugin', err);
        removeAwarenessPluginExtensionIfInvalid(deps.home);
      }
    }

    try {
      if (pluginTarball && npmCli) {
        await runWithBundledNpmCli(npmCli, `exec --yes "${pluginTarball}" install awareness-memory --force`, 60000, deps.home);
        if (!hasAwarenessPluginPackage(deps.home)) {
          throw new Error('awareness plugin package.json missing after bundled clawhub install');
        }
        patchAwarenessPluginWindowsNpx(deps.home);
        deps.persistAwarenessPluginConfig({ enableSlot: true });
        writeDesktopExecApprovalDefaults(deps.home);
        return { success: true, method: 'clawhub-offline' };
      }

      await deps.runAsync(`cd "${deps.home}" && npx -y clawhub@latest install awareness-memory --force`, 60000);
      if (!hasAwarenessPluginPackage(deps.home)) {
        throw new Error('awareness plugin package.json missing after clawhub install');
      }
      patchAwarenessPluginWindowsNpx(deps.home);
      deps.persistAwarenessPluginConfig({ enableSlot: true });
      writeDesktopExecApprovalDefaults(deps.home);
      return { success: true, method: 'clawhub' };
    } catch (err) {
      recordInstallError('clawhub', err);
      try {
        const configDir = path.join(deps.home, '.openclaw');
        const configPath = path.join(configDir, 'openclaw.json');
        fs.mkdirSync(configDir, { recursive: true });

        let config: any = {};
        try { config = readJsonFileWithBom<Record<string, any>>(configPath); } catch {}

        if (config.plugins?.entries?.['openclaw-memory']) {
          delete config.plugins.entries['openclaw-memory'];
        }
        if (Array.isArray(config.plugins?.allow)) {
          config.plugins.allow = config.plugins.allow.filter((pluginId: string) => pluginId !== 'openclaw-memory');
        }
        if (config.plugins?.slots?.memory === 'openclaw-memory') {
          delete config.plugins.slots.memory;
        }
        deps.sanitizeAwarenessPluginConfig(config);
        safeWriteJsonFile(configPath, config);
        return {
          success: false,
          error: `Awareness Memory plugin could not be installed. OCT cleaned stale plugin state so Retry can self-repair. ${installErrors.slice(-3).join(' | ') || 'Please check npm/network access.'}`,
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
  });

  ipcMain.handle('setup:start-daemon', async () => {
    const existingPromise = deps.getDaemonStartupPromise();
    if (existingPromise) return existingPromise;

    const startupPromise = (async () => {
      const normalizedHomeDir = normalizeHomePath(deps.home);
      const daemonProjectDir = path.join(normalizedHomeDir, '.openclaw');
      const daemonSpec = stripWrappingQuotes(deps.resolveBundledCache('awareness-sdk-local.tgz') || '@awareness-sdk/local@latest');
      const bundledNpxCli = stripWrappingQuotes(deps.getBundledNpmBin('npx') || '');

      const bootstrapDaemonInForeground = async (statusKey: string) => {
        deps.sendSetupDaemonStatus(statusKey);
        const daemonArgs = ['-y', daemonSpec, 'start', '--port', '37800', '--project', daemonProjectDir, '--background'];
        try {
          if (bundledNpxCli) {
            await runSpawnCommand(process.execPath, [bundledNpxCli, ...daemonArgs], SETUP_DAEMON_BOOTSTRAP_TIMEOUT_MS, { cwd: normalizedHomeDir });
          } else {
            if (process.platform === 'win32') {
              await runSpawnCommand('cmd.exe', ['/d', '/c', 'npx', ...daemonArgs], SETUP_DAEMON_BOOTSTRAP_TIMEOUT_MS, { cwd: normalizedHomeDir });
            } else {
              await runSpawnCommand('npx', daemonArgs, SETUP_DAEMON_BOOTSTRAP_TIMEOUT_MS, { cwd: normalizedHomeDir });
            }
          }
          return true;
        } catch {
          return false;
        }
      };

      const isReady = await deps.checkDaemonHealth();
      if (isReady) return { success: true, alreadyRunning: true };

      const recentlyStarted = Date.now() - deps.getDaemonStartupLastKickoff() < 120000;
      if (recentlyStarted) {
        deps.sendSetupDaemonStatus('setup.install.daemonStatus.waiting');
        if (await deps.waitForLocalDaemonReady(45000, 'setup.install.daemonStatus.waiting', { sendStatus: deps.sendSetupDaemonStatus, sleep: deps.sleep })) {
          return { success: true };
        }
      }

      try {
        deps.sendSetupDaemonStatus('setup.install.daemonStatus.starting');
        deps.setDaemonStartupLastKickoff(Date.now());
        await deps.startLocalDaemonDetached({
          homedir: normalizedHomeDir,
          resolveBundledCache: deps.resolveBundledCache,
          getBundledNpmBin: deps.getBundledNpmBin,
          runSpawn: deps.runSpawn,
          getEnhancedPath: deps.getEnhancedPath,
        });
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          return { success: false, error: 'Node/npm not found. Please install Node.js 22+ and reopen OCT.' };
        }
        const foregroundStarted = await bootstrapDaemonInForeground('setup.install.daemonStatus.preparing');
        if (!foregroundStarted) {
          return { success: false, error: err?.message?.slice(0, 200) || String(err) };
        }
      }

      deps.sendSetupDaemonStatus('setup.install.daemonStatus.preparing');
      if (await deps.waitForLocalDaemonReady(SETUP_DAEMON_WAIT_PRIMARY_MS, 'setup.install.daemonStatus.preparing', { sendStatus: deps.sendSetupDaemonStatus, sleep: deps.sleep })) {
        return { success: true };
      }

      // Detached spawn can report success while the daemon process exits immediately.
      // Trigger one direct foreground bootstrap earlier to avoid long setup hangs.
      const directTriggered = await bootstrapDaemonInForeground('setup.install.daemonStatus.activating');
      if (directTriggered) {
        if (await deps.waitForLocalDaemonReady(SETUP_DAEMON_WAIT_AFTER_DIRECT_TRIGGER_MS, 'setup.install.daemonStatus.waiting', {
          sendStatus: deps.sendSetupDaemonStatus,
          sleep: deps.sleep,
        })) {
          return { success: true };
        }
      }

      try {
        deps.sendSetupDaemonStatus('setup.install.daemonStatus.repairing');
        await deps.forceStopLocalDaemon({ sleep: deps.sleep });
        deps.clearAwarenessLocalNpxCache(normalizedHomeDir);
        deps.setDaemonStartupLastKickoff(Date.now());
        await deps.startLocalDaemonDetached({
          homedir: normalizedHomeDir,
          resolveBundledCache: deps.resolveBundledCache,
          getBundledNpmBin: deps.getBundledNpmBin,
          runSpawn: deps.runSpawn,
          getEnhancedPath: deps.getEnhancedPath,
        });
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          return { success: false, error: 'Node/npm not found. Please install Node.js 22+ and reopen OCT.' };
        }
        const foregroundStarted = await bootstrapDaemonInForeground('setup.install.daemonStatus.retrying');
        if (!foregroundStarted) {
          return { success: false, error: err?.message?.slice(0, 200) || String(err) };
        }
      }

      deps.sendSetupDaemonStatus('setup.install.daemonStatus.retrying');
      if (await deps.waitForLocalDaemonReady(SETUP_DAEMON_WAIT_RETRYING_MS, 'setup.install.daemonStatus.retrying', { sendStatus: deps.sendSetupDaemonStatus, sleep: deps.sleep })) {
        return { success: true };
      }

      const foregroundStarted = await bootstrapDaemonInForeground('setup.install.daemonStatus.retrying');
      if (foregroundStarted) {
        if (await deps.waitForLocalDaemonReady(SETUP_DAEMON_WAIT_AFTER_BOOTSTRAP_MS, 'setup.install.daemonStatus.waiting', { sendStatus: deps.sendSetupDaemonStatus, sleep: deps.sleep })) {
          return { success: true };
        }
      }

      // Do not block first install forever when native deps are still compiling in background.
      return {
        success: true,
        pending: true,
        warning: deps.formatDaemonSetupError(),
      };
    })();

    deps.setDaemonStartupPromise(startupPromise);

    try {
      return await startupPromise;
    } finally {
      deps.setDaemonStartupPromise(null);
    }
  });

  ipcMain.handle('setup:save-config', async (_e, config: Record<string, unknown>) => {
    const configDir = path.join(deps.home, '.openclaw');
    const configPath = path.join(configDir, 'openclaw.json');

    fs.mkdirSync(configDir, { recursive: true });

    let existing: Record<string, any> = {};
    try {
      existing = readJsonFileWithBom<Record<string, any>>(configPath);
    } catch {}

    const merged = deps.mergeOpenClawConfig(existing, config as Record<string, any>);
    safeWriteJsonFile(configPath, merged);
    writeDesktopExecApprovalDefaults(deps.home);
    return { success: true };
  });

  ipcMain.handle('setup:open-auth-url', (_e, url: string) => {
    shell.openExternal(url);
  });
}
