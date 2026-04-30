// Doctor checks: Node.js and OpenClaw installation/version/conflicts.

import fs from 'fs';
import path from 'path';
import type { CheckResult, FixResult, Ctx } from './types';
import { getNpmInstallCommand, getNullDevice, OPENCLAW_INSTALL_TIMEOUT_MS } from './utils';

export async function checkNodeInstalled(ctx: Ctx): Promise<CheckResult> {
  if (ctx.nodePath && ctx.nodeVersion) {
    return { id: 'node-installed', label: 'Node.js', status: 'pass', message: `Installed (${ctx.nodeVersion})`, fixable: 'none' };
  }
  return { id: 'node-installed', label: 'Node.js', status: 'fail', message: 'Node.js is not installed. Install it from nodejs.org', fixable: 'manual', fixDescription: 'Visit nodejs.org to download and install Node.js' };
}

export async function checkOpenclawInstalled(ctx: Ctx): Promise<CheckResult> {
  if (!ctx.nodePath) return { id: 'openclaw-installed', label: 'OpenClaw', status: 'skipped', message: 'Skipped (Node.js required)', fixable: 'none' };
  if ((ctx.openclawPath || ctx.openclawPackageDir) && ctx.openclawVersion) {
    return { id: 'openclaw-installed', label: 'OpenClaw', status: 'pass', message: `Installed (${ctx.openclawVersion.match(/\d+\.\d+\.\d+/)?.[0] || ctx.openclawVersion})`, fixable: 'none' };
  }
  return { id: 'openclaw-installed', label: 'OpenClaw', status: 'fail', message: 'OpenClaw is not installed', fixable: 'auto', fixDescription: 'Install OpenClaw via npm' };
}

export async function fixOpenclawInstall(ctx: Ctx): Promise<FixResult> {
  try {
    await ctx.deps.shellRun(`${getNpmInstallCommand()} 2>&1`, OPENCLAW_INSTALL_TIMEOUT_MS);
    return { id: 'openclaw-installed', success: true, message: 'OpenClaw installed successfully' };
  } catch (err: any) {
    return { id: 'openclaw-installed', success: false, message: err.message?.slice(0, 200) || 'Installation failed' };
  }
}

export async function checkOpenclawCommandHealth(ctx: Ctx): Promise<CheckResult> {
  if (!ctx.openclawPath && !ctx.openclawPackageDir) {
    return { id: 'openclaw-command-health', label: 'OpenClaw command path', status: 'skipped', message: 'Skipped (OpenClaw not installed)', fixable: 'none' };
  }

  if (!ctx.openclawPath && ctx.openclawPackageDir) {
    return {
      id: 'openclaw-command-health',
      label: 'OpenClaw command path',
      status: 'warn',
      message: ctx.deps.platform === 'win32'
        ? 'OpenClaw is installed, but the Windows command shim is missing or not visible yet.'
        : 'OpenClaw is installed, but the shell command is missing from the current PATH.',
      fixable: 'auto',
      fixDescription: ctx.deps.platform === 'win32'
        ? 'Refresh the Windows OpenClaw command shims'
        : 'Refresh the OpenClaw command link',
    };
  }

  const duplicates = ctx.openclawCandidates.filter(candidate => candidate !== ctx.openclawPath);
  if (duplicates.length === 0) {
    return { id: 'openclaw-command-health', label: 'OpenClaw command path', status: 'pass', message: 'Command path is healthy', fixable: 'none' };
  }

  return {
    id: 'openclaw-command-health',
    label: 'OpenClaw command path',
    status: 'warn',
    message: ctx.deps.platform === 'win32'
      ? 'Multiple OpenClaw command shims found. This can cause slow startup or launch the wrong version.'
      : 'Multiple OpenClaw command paths found. The app may start the wrong version.',
    fixable: 'auto',
    fixDescription: ctx.deps.platform === 'win32'
      ? 'Refresh the Windows OpenClaw command shims'
      : 'Install and pin the OCT managed OpenClaw runtime',
    detail: ctx.openclawCandidates.join('; '),
  };
}

export async function fixOpenclawCommandHealth(ctx: Ctx): Promise<FixResult> {
  try {
    if (ctx.deps.platform !== 'win32') {
      // Best-effort: remove stale global OpenClaw to avoid two instances
      try {
        await ctx.deps.shellRun('npm uninstall -g openclaw 2>&1', 60000);
      } catch {
        // May need sudo — that's OK, managed install will still pin the correct version
      }
      await ctx.deps.shellRun(`${getNpmInstallCommand('openclaw@latest')} 2>&1`, OPENCLAW_INSTALL_TIMEOUT_MS);
      return {
        id: 'openclaw-command-health',
        success: true,
        message: 'OpenClaw reinstalled to resolve command path conflicts',
      };
    }

    // Windows: clean stale shims, then reinstall
    const shimDir = path.join(process.env.APPDATA || path.join(ctx.deps.homedir, 'AppData', 'Roaming'), 'npm');
    try {
      await ctx.deps.shellRun('npm uninstall -g openclaw 2>&1', 60000);
    } catch {}

    for (const fileName of ['openclaw', 'openclaw.cmd', 'openclaw.ps1']) {
      const filePath = path.join(shimDir, fileName);
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    }

    await ctx.deps.shellRun(`${getNpmInstallCommand()} 2>&1`, OPENCLAW_INSTALL_TIMEOUT_MS);
    return { id: 'openclaw-command-health', success: true, message: 'OpenClaw command shims refreshed' };
  } catch (err: any) {
    return { id: 'openclaw-command-health', success: false, message: err.message?.slice(0, 200) || 'Cleanup failed' };
  }
}

export async function checkOpenclawVersion(ctx: Ctx): Promise<CheckResult> {
  if (!ctx.openclawVersion) return { id: 'openclaw-version', label: 'OpenClaw version', status: 'skipped', message: 'Skipped (OpenClaw not installed)', fixable: 'none' };
  try {
    const latest = await ctx.deps.shellExec(`npm view openclaw version 2>${getNullDevice(ctx.deps.platform)}`, 10000);
    const current = ctx.openclawVersion.match(/(\d+\.\d+\.\d+)/)?.[1];
    const latestVer = latest?.trim();
    if (current && latestVer && current !== latestVer) {
      return { id: 'openclaw-version', label: 'OpenClaw version', status: 'warn', message: `Update available: ${current} → ${latestVer}`, fixable: 'auto', fixDescription: `Update to ${latestVer}` };
    }
    return { id: 'openclaw-version', label: 'OpenClaw version', status: 'pass', message: `Up to date (${current})`, fixable: 'none' };
  } catch {
    return { id: 'openclaw-version', label: 'OpenClaw version', status: 'pass', message: 'Could not check for updates', fixable: 'none' };
  }
}

export async function fixOpenclawUpdate(ctx: Ctx): Promise<FixResult> {
  try {
    await ctx.deps.shellRun(`${getNpmInstallCommand('openclaw@latest')} 2>&1`, OPENCLAW_INSTALL_TIMEOUT_MS);
    return { id: 'openclaw-version', success: true, message: 'Updated successfully' };
  } catch (err: any) {
    return { id: 'openclaw-version', success: false, message: err.message?.slice(0, 200) || 'Update failed' };
  }
}

export async function checkMultiVersionConflicts(ctx: Ctx): Promise<CheckResult> {
  if (ctx.deps.platform !== 'darwin' && ctx.deps.platform !== 'linux') {
    return { id: 'openclaw-conflicts', label: 'Version conflicts', status: 'skipped', message: 'Skipped (platform check)', fixable: 'none' };
  }
  if (!ctx.openclawPath) return { id: 'openclaw-conflicts', label: 'Version conflicts', status: 'skipped', message: 'Skipped', fixable: 'none' };

  const globalPaths = ['/usr/local/lib/node_modules/openclaw', '/usr/lib/node_modules/openclaw'];
  const npmGlobal = path.join(ctx.deps.homedir, '.npm-global', 'lib', 'node_modules', 'openclaw');
  const conflicts: string[] = [];

  for (const p of globalPaths) {
    if (fs.existsSync(path.join(p, 'package.json')) && fs.existsSync(path.join(npmGlobal, 'package.json'))) {
      try {
        const oldVer = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')).version;
        const newVer = JSON.parse(fs.readFileSync(path.join(npmGlobal, 'package.json'), 'utf8')).version;
        if (oldVer !== newVer) conflicts.push(`${p} (v${oldVer}) conflicts with ~/.npm-global (v${newVer})`);
      } catch {}
    }
  }

  if (conflicts.length > 0) {
    return { id: 'openclaw-conflicts', label: 'Version conflicts', status: 'fail', message: 'Multiple OpenClaw versions found', fixable: 'manual',
      fixDescription: 'Run: sudo rm -rf /usr/local/lib/node_modules/openclaw /usr/local/bin/openclaw',
      detail: conflicts.join('; ') };
  }
  return { id: 'openclaw-conflicts', label: 'Version conflicts', status: 'pass', message: 'No conflicts', fixable: 'none' };
}
