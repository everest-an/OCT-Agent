/**
 * Environment detection — OS, architecture, Node.js, OpenClaw, existing config
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform, arch } from 'node:os';

export async function detectEnvironment() {
  const os = platform();
  const cpuArch = arch();
  const home = homedir();

  const env = {
    os,
    arch: cpuArch,
    home,
    nodeVersion: process.version,
    openclawInstalled: false,
    openclawVersion: null,
    openclawConfigPath: join(home, '.openclaw', 'openclaw.json'),
    awarenessConfigPath: join(home, '.awareness', 'credentials.json'),
    hasExistingConfig: false,
    hasAwarenessPlugin: false,
  };

  // Detect OpenClaw — check PATH first, then common locations
  try {
    const version = execSync('openclaw --version', { encoding: 'utf8', timeout: 5000 }).trim();
    env.openclawInstalled = true;
    env.openclawVersion = version;
    console.log(`✅ OpenClaw detected: ${version}`);
  } catch {
    // Not in PATH — check common install locations to avoid duplicate installs
    const extraPaths = [
      join(home, '.npm-global', 'bin', 'openclaw'),
      join(home, '.awareness-claw', 'openclaw-runtime', 'bin', 'openclaw'),
      '/usr/local/bin/openclaw',
      '/opt/homebrew/bin/openclaw',
    ];
    let foundPath = null;
    for (const p of extraPaths) {
      if (existsSync(p)) { foundPath = p; break; }
    }
    if (foundPath) {
      try {
        const version = execSync(`"${foundPath}" --version`, { encoding: 'utf8', timeout: 5000 }).trim();
        env.openclawInstalled = true;
        env.openclawVersion = version;
        console.log(`✅ OpenClaw found at ${foundPath}: ${version}`);
      } catch {
        // Binary exists but can't execute — still mark as installed to avoid duplicate
        env.openclawInstalled = true;
        console.log(`⚠️  OpenClaw found at ${foundPath} but couldn't get version`);
      }
    } else {
      // Also check npm global root
      try {
        const npmRoot = execSync('npm root -g', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }).trim();
        if (npmRoot && existsSync(join(npmRoot, 'openclaw', 'package.json'))) {
          env.openclawInstalled = true;
          console.log(`✅ OpenClaw detected in npm global (${npmRoot}), not in PATH`);
        } else {
          console.log('📦 OpenClaw not found, will install...');
        }
      } catch {
        console.log('📦 OpenClaw not found, will install...');
      }
    }
  }

  // Check existing config
  if (existsSync(env.openclawConfigPath)) {
    env.hasExistingConfig = true;
    try {
      const config = JSON.parse(readFileSync(env.openclawConfigPath, 'utf8'));
      if (config?.plugins?.['openclaw-memory']) {
        env.hasAwarenessPlugin = true;
        console.log('✅ Awareness plugin already configured');
      }
    } catch { /* ignore parse errors */ }
  }

  return env;
}
