// Doctor checks: Gateway, Daemon, LaunchAgent, plugin install, config permissions, npm prefix, DNS.

import fs from 'fs';
import path from 'path';
import http from 'http';
import dns from 'dns';
import type { CheckResult, FixResult, Ctx } from './types';
import { getNullDevice, persistAwarenessPluginConfig, WEB_DNS_CANARY_DOMAINS } from './utils';
import { isGatewayRunningOutput, getGatewayPort } from '../openclaw-config';

// --- DNS / IP helpers (only used by checkWebDnsCompatibility) ---

function parseIpv4Address(ip: string): number[] | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
  return bytes;
}

function isSpecialUseIpv4(ip: string): boolean {
  const bytes = parseIpv4Address(ip);
  if (!bytes) return false;
  const [a, b] = bytes;

  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 224 || a >= 240) return true; // multicast/reserved

  return false;
}

function isSpecialUseIpv6(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  if (!normalized.includes(':')) return false;

  if (normalized === '::' || normalized === '::1') return true;

  const firstHextetRaw = normalized.split(':')[0] || '0';
  const firstHextet = Number.parseInt(firstHextetRaw, 16);
  if (!Number.isFinite(firstHextet)) return false;

  if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true; // ULA fc00::/7
  if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true; // link-local fe80::/10

  return false;
}

function isSpecialUseIpAddress(ip: string): boolean {
  return isSpecialUseIpv4(ip) || isSpecialUseIpv6(ip);
}

function getNpxCacheDirs(homedir: string): string[] {
  const dirs = [path.join(homedir, '.npm', '_npx')];

  const npmConfigCache = process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE;
  if (npmConfigCache) dirs.push(path.join(npmConfigCache, '_npx'));

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
    dirs.push(path.join(localAppData, 'npm-cache', '_npx'));
  }

  return Array.from(new Set(dirs.map((dir) => path.normalize(dir))));
}

function getWindowsGatewayStartupPaths(homedir: string) {
  const startupCmdPath = path.join(
    homedir,
    'AppData',
    'Roaming',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'OpenClaw Gateway.cmd',
  );
  const gatewayCmdPath = path.join(homedir, '.openclaw', 'gateway.cmd');
  return { startupCmdPath, gatewayCmdPath };
}

async function resolveDomainAddresses(domain: string): Promise<string[]> {
  try {
    const records = await dns.promises.lookup(domain, { all: true, verbatim: true });
    return Array.from(new Set(records.map((record) => record.address).filter(Boolean)));
  } catch {
    return [];
  }
}

// --- LaunchAgent (macOS only) ---

export async function checkLaunchAgentPath(ctx: Ctx): Promise<CheckResult> {
  if (ctx.deps.platform !== 'darwin') return { id: 'launchagent-path', label: 'Gateway service', status: 'skipped', message: 'Skipped (macOS only)', fixable: 'none' };

  const plistPath = path.join(ctx.deps.homedir, 'Library', 'LaunchAgents', 'ai.openclaw.gateway.plist');
  if (!fs.existsSync(plistPath)) {
    return { id: 'launchagent-path', label: 'Gateway service', status: 'warn', message: 'Gateway service not installed', fixable: 'auto', fixDescription: 'Run openclaw gateway start to install' };
  }

  try {
    const plist = fs.readFileSync(plistPath, 'utf8');
    // Extract the openclaw path from ProgramArguments
    const indexJsMatch = plist.match(/<string>([^<]*node_modules\/openclaw\/dist\/index\.js)<\/string>/);
    if (indexJsMatch) {
      const indexJsPath = indexJsMatch[1];
      if (!fs.existsSync(indexJsPath)) {
        return { id: 'launchagent-path', label: 'Gateway service', status: 'fail',
          message: 'Gateway points to a deleted OpenClaw path',
          fixable: 'auto', fixDescription: 'Update Gateway to use the correct OpenClaw path',
          detail: `Missing: ${indexJsPath}` };
      }
    }
    return { id: 'launchagent-path', label: 'Gateway service', status: 'pass', message: 'Service paths correct', fixable: 'none' };
  } catch {
    return { id: 'launchagent-path', label: 'Gateway service', status: 'warn', message: 'Could not read Gateway service config', fixable: 'none' };
  }
}

export async function fixLaunchAgentPath(ctx: Ctx): Promise<FixResult> {
  const plistPath = path.join(ctx.deps.homedir, 'Library', 'LaunchAgents', 'ai.openclaw.gateway.plist');
  try {
    let plist = fs.readFileSync(plistPath, 'utf8');
    // Find the correct openclaw index.js
    const correctPath = path.join(ctx.deps.homedir, '.npm-global', 'lib', 'node_modules', 'openclaw', 'dist', 'index.js');
    if (!fs.existsSync(correctPath)) {
      return { id: 'launchagent-path', success: false, message: 'Cannot find OpenClaw installation' };
    }
    // Replace any openclaw index.js path with the correct one
    plist = plist.replace(/<string>[^<]*node_modules\/openclaw\/dist\/index\.js<\/string>/, `<string>${correctPath}</string>`);
    fs.writeFileSync(plistPath, plist);
    // Reload the LaunchAgent
    const uid = (await ctx.deps.shellExec('id -u', 3000))?.trim() || '501';
    await ctx.deps.shellExec(`launchctl bootout gui/${uid}/ai.openclaw.gateway 2>/dev/null`, 5000);
    await ctx.deps.shellExec(`launchctl bootstrap gui/${uid} "${plistPath}" 2>/dev/null`, 5000);
    return { id: 'launchagent-path', success: true, message: 'Gateway service path fixed and reloaded' };
  } catch (err: any) {
    return { id: 'launchagent-path', success: false, message: err.message?.slice(0, 200) || 'Fix failed' };
  }
}

// --- Gateway ---

export async function checkGatewayRunning(ctx: Ctx): Promise<CheckResult> {
  if (!ctx.openclawPath) return { id: 'gateway-running', label: 'Gateway', status: 'skipped', message: 'Skipped (OpenClaw not installed)', fixable: 'none' };

  if (ctx.deps.platform === 'win32') {
    const { startupCmdPath, gatewayCmdPath } = getWindowsGatewayStartupPaths(ctx.deps.homedir);
    if (fs.existsSync(startupCmdPath) && !fs.existsSync(gatewayCmdPath)) {
      return {
        id: 'gateway-running',
        label: 'Gateway',
        status: 'fail',
        message: 'Gateway startup entry is broken (missing launcher file)',
        fixable: 'auto',
        fixDescription: 'Reinstall Gateway startup launcher',
        detail: `Missing launcher: ${gatewayCmdPath}`,
      };
    }
  }

  // Fast path: probe Gateway HTTP port directly (avoids 15-20s plugin preload from CLI)
  const port = getGatewayPort(ctx.deps.homedir);
  const probeOk = await new Promise<boolean>((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/healthz`, { timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });

  if (probeOk) {
    return { id: 'gateway-running', label: 'Gateway', status: 'pass', message: 'Running', fixable: 'none' };
  }

  // Fallback: try CLI only if HTTP probe failed (Gateway may be on non-default port)
  const output = await ctx.deps.shellExec('openclaw gateway status 2>&1', 15000);
  if (isGatewayRunningOutput(output)) {
    return { id: 'gateway-running', label: 'Gateway', status: 'pass', message: 'Running', fixable: 'none' };
  }
  return { id: 'gateway-running', label: 'Gateway', status: 'fail', message: 'Gateway is not running', fixable: 'auto', fixDescription: 'Start the Gateway' };
}

export async function fixGatewayStart(ctx: Ctx): Promise<FixResult> {
  try {
    if (ctx.deps.platform === 'win32') {
      const { startupCmdPath, gatewayCmdPath } = getWindowsGatewayStartupPaths(ctx.deps.homedir);
      if (fs.existsSync(startupCmdPath) && !fs.existsSync(gatewayCmdPath)) {
        try {
          await ctx.deps.shellRun('openclaw gateway install 2>&1', 30000);
        } catch {
          // Keep existing flow intact; start/install fallback below will still run.
        }
      }
    }

    await ctx.deps.shellRun('openclaw gateway start 2>&1', 20000);
    return { id: 'gateway-running', success: true, message: 'Gateway started' };
  } catch (err: any) {
    const message = err?.message || '';
    if (ctx.deps.platform === 'win32' && /schtasks run failed/i.test(message)) {
      try {
        await ctx.deps.shellRun('openclaw gateway install 2>&1', 30000);
        await ctx.deps.shellRun('openclaw gateway start 2>&1', 20000);
        return { id: 'gateway-running', success: true, message: 'Gateway service installed and started' };
      } catch (installErr: any) {
        const installMessage = installErr?.message || '';
        if (/EACCES|Access is denied|permission denied|拒绝访问|schtasks create failed/i.test(installMessage)) {
          try {
            await ctx.deps.shellRun(
              'where openclaw >nul 2>nul && powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath openclaw -ArgumentList \'gateway\',\'run\',\'--force\',\'--allow-unconfigured\'"',
              10000,
            );
            return {
              id: 'gateway-running',
              success: true,
              message: 'Gateway started in the current Windows session without installing a service',
            };
          } catch {
            return {
              id: 'gateway-running',
              success: false,
              message: 'Windows blocked Gateway service installation and the OpenClaw command is not ready yet. Reopen AwarenessClaw as administrator once, then run Doctor again.',
            };
          }
        }
        return { id: 'gateway-running', success: false, message: installMessage.slice(0, 200) || 'Could not repair Gateway service' };
      }
    }
    return { id: 'gateway-running', success: false, message: 'Could not start Gateway. Check logs in Settings.' };
  }
}

// --- Awareness Plugin ---

export async function checkPluginInstalled(ctx: Ctx): Promise<CheckResult> {
  const pluginPath = path.join(ctx.deps.homedir, '.openclaw', 'extensions', 'openclaw-memory');
  if (fs.existsSync(path.join(pluginPath, 'package.json'))) {
    return { id: 'plugin-installed', label: 'Awareness plugin', status: 'pass', message: 'Installed', fixable: 'none' };
  }
  return { id: 'plugin-installed', label: 'Awareness plugin', status: 'fail', message: 'Awareness Memory plugin is missing', fixable: 'auto', fixDescription: 'Install the Awareness Memory plugin' };
}

export async function fixPluginInstall(ctx: Ctx): Promise<FixResult> {
  const HOME = ctx.deps.homedir;
  const extensionsDir = path.join(HOME, '.openclaw', 'extensions');
  const extDir = path.join(extensionsDir, 'openclaw-memory');
  const nullDev = getNullDevice(ctx.deps.platform);

  // Primary: direct npm pack + extract (avoids openclaw/clawhub cwd=/ path issues in Electron)
  try {
    fs.mkdirSync(extensionsDir, { recursive: true });
    if (fs.existsSync(extDir)) fs.rmSync(extDir, { recursive: true, force: true });
    const packOut = await ctx.deps.shellRun(`cd "${extensionsDir}" && npm pack @awareness-sdk/openclaw-memory@latest 2>${nullDev}`, 60000);
    // Find the .tgz filename in npm pack output (last line is usually the filename,
    // but npm may also emit warnings — use .find() for robustness)
    const tgzName = packOut.trim().split('\n').map(l => l.trim()).reverse().find(l => l.endsWith('.tgz')) || '';
    if (!tgzName) throw new Error('npm pack failed');
    const tgzPath = path.join(extensionsDir, tgzName);
    fs.mkdirSync(extDir, { recursive: true });
    await ctx.deps.shellRun(`tar -xzf "${tgzPath}" -C "${extDir}" --strip-components=1`, 30000);
    try { fs.unlinkSync(tgzPath); } catch { /* best-effort */ }
    persistAwarenessPluginConfig(HOME);
    return { id: 'plugin-installed', success: true, message: 'Plugin installed' };
  } catch { /* fall through */ }

  // Fallback: openclaw plugins install with cd to HOME
  try {
    await ctx.deps.shellRun(`cd "${HOME}" && openclaw plugins install awareness-memory 2>&1`, 30000);
    persistAwarenessPluginConfig(HOME);
    return { id: 'plugin-installed', success: true, message: 'Plugin installed via OpenClaw' };
  } catch (err: any) {
    return { id: 'plugin-installed', success: false, message: err.message?.slice(0, 200) || 'Installation failed' };
  }
}

// --- Local Daemon ---

export async function checkDaemonRunning(_ctx: Ctx): Promise<CheckResult> {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:37800/healthz', { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ id: 'daemon-running', label: 'Local Daemon', status: 'pass', message: 'Running', fixable: 'none' });
        } else {
          resolve({ id: 'daemon-running', label: 'Local Daemon', status: 'fail', message: 'Daemon not responding', fixable: 'auto', fixDescription: 'Restart the local daemon' });
        }
      });
    });
    req.on('error', () => {
      resolve({ id: 'daemon-running', label: 'Local Daemon', status: 'fail', message: 'Local Daemon is not running', fixable: 'auto', fixDescription: 'Start the local daemon' });
    });
    req.on('timeout', () => { req.destroy(); resolve({ id: 'daemon-running', label: 'Local Daemon', status: 'fail', message: 'Daemon not responding', fixable: 'auto', fixDescription: 'Restart daemon' }); });
  });
}

export async function fixDaemonStart(ctx: Ctx): Promise<FixResult> {
  try {
    // Clean corrupted npx cache first (common cause of ENOTEMPTY errors)
    for (const npxCacheDir of getNpxCacheDirs(ctx.deps.homedir)) {
      if (!fs.existsSync(npxCacheDir)) continue;

      try {
        const entries = fs.readdirSync(npxCacheDir);
        for (const entry of entries) {
          const entryPath = path.join(npxCacheDir, entry, 'node_modules', '@awareness-sdk');
          if (fs.existsSync(entryPath)) {
            fs.rmSync(path.join(npxCacheDir, entry), { recursive: true, force: true });
          }
        }
      } catch { /* best effort cleanup */ }
    }
    const projectDir = path.join(ctx.deps.homedir, '.openclaw');
    await ctx.deps.shellRun(`npx -y @awareness-sdk/local@latest start --port 37800 --project "${projectDir}" --background 2>&1`, 60000);
    await new Promise(r => setTimeout(r, 5000));
    return { id: 'daemon-running', success: true, message: 'Daemon started' };
  } catch (err: any) {
    return { id: 'daemon-running', success: false, message: err.message?.slice(0, 200) || 'Could not start daemon' };
  }
}

// --- Config permissions ---

export async function checkConfigPermissions(ctx: Ctx): Promise<CheckResult> {
  if (ctx.deps.platform === 'win32') return { id: 'config-permissions', label: 'Config security', status: 'skipped', message: 'Skipped (Windows)', fixable: 'none' };
  try {
    const stat = fs.statSync(ctx.configPath);
    const mode = (stat.mode & 0o777).toString(8);
    if (mode !== '600') {
      return { id: 'config-permissions', label: 'Config security', status: 'warn', message: `Config file permissions too open (${mode})`, fixable: 'auto', fixDescription: 'Set permissions to 600 (owner only)' };
    }
    return { id: 'config-permissions', label: 'Config security', status: 'pass', message: 'Permissions correct (600)', fixable: 'none' };
  } catch {
    return { id: 'config-permissions', label: 'Config security', status: 'skipped', message: 'Config file not found', fixable: 'none' };
  }
}

export async function fixConfigPermissions(ctx: Ctx): Promise<FixResult> {
  try {
    fs.chmodSync(ctx.configPath, 0o600);
    return { id: 'config-permissions', success: true, message: 'Permissions set to 600' };
  } catch (err: any) {
    return { id: 'config-permissions', success: false, message: err.message?.slice(0, 200) || 'Failed' };
  }
}

// --- npm prefix writability ---

export async function checkNpmPrefixWritable(ctx: Ctx): Promise<CheckResult> {
  if (!ctx.npmPrefix) return { id: 'npm-prefix-writable', label: 'npm permissions', status: 'skipped', message: 'Skipped', fixable: 'none' };
  try {
    fs.accessSync(ctx.npmPrefix, fs.constants.W_OK);
    return { id: 'npm-prefix-writable', label: 'npm permissions', status: 'pass', message: 'npm global directory is writable', fixable: 'none' };
  } catch {
    return { id: 'npm-prefix-writable', label: 'npm permissions', status: 'warn',
      message: 'npm global directory is not writable — upgrades may fail', fixable: 'manual',
      fixDescription: 'Run: npm config set prefix ~/.npm-global && export PATH=~/.npm-global/bin:$PATH' };
  }
}

// --- Web DNS compatibility ---

export async function checkWebDnsCompatibility(_ctx: Ctx): Promise<CheckResult> {
  const suspiciousMappings: string[] = [];

  for (const domain of WEB_DNS_CANARY_DOMAINS) {
    const addresses = await resolveDomainAddresses(domain);
    if (addresses.length === 0) continue;
    const specialUse = addresses.filter(isSpecialUseIpAddress);
    if (specialUse.length > 0) {
      suspiciousMappings.push(`${domain} -> ${specialUse.join(', ')}`);
    }
  }

  if (suspiciousMappings.length > 0) {
    return {
      id: 'web-dns-compat',
      label: 'Web tools network compatibility',
      status: 'warn',
      message: 'Public domains resolved to special-use IP ranges (VPN/DNS compatibility risk)',
      fixable: 'manual',
      fixDescription: 'In your VPN/proxy app, disable full DNS hijack or enable split DNS for public websites, then click Re-check.',
      detail: suspiciousMappings.join('; '),
    };
  }

  return {
    id: 'web-dns-compat',
    label: 'Web tools network compatibility',
    status: 'pass',
    message: 'Public DNS resolution looks normal',
    fixable: 'none',
  };
}
