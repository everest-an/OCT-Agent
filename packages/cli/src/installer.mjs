/**
 * OpenClaw installer — downloads and installs OpenClaw using official scripts
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

const INSTALL_URLS = {
  darwin: 'https://openclaw.ai/install.sh',
  linux: 'https://openclaw.ai/install.sh',
  win32: 'https://openclaw.ai/install.ps1',
};

const NPM_MIRRORS = [
  null, // default registry
  'https://registry.npmmirror.com',
  'https://mirrors.huaweicloud.com/repository/npm/',
];

/**
 * Check if OpenClaw is installed at common locations beyond PATH.
 * Prevents duplicate installs when user's shell PATH doesn't include the binary.
 */
function checkOpenClawBeyondPath() {
  const home = homedir();
  const os = platform();

  // Check global npm root
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }).trim();
    if (npmRoot && existsSync(join(npmRoot, 'openclaw', 'package.json'))) {
      return { found: true, location: 'npm-global', path: npmRoot };
    }
  } catch {}

  // Check managed prefix (installed by AwarenessClaw Desktop previously)
  const managedCandidates = [
    join(home, '.awareness-claw', 'openclaw-runtime', 'lib', 'node_modules', 'openclaw', 'openclaw.mjs'),
    join(home, '.awareness-claw', 'openclaw-runtime', 'node_modules', 'openclaw', 'openclaw.mjs'),
  ];
  for (const p of managedCandidates) {
    if (existsSync(p)) {
      return { found: true, location: 'managed', path: p };
    }
  }

  // Check common bin directories
  const binCandidates = os === 'win32'
    ? [`${process.env.APPDATA}\\npm\\openclaw.cmd`]
    : [
        join(home, '.npm-global', 'bin', 'openclaw'),
        '/usr/local/bin/openclaw',
        '/opt/homebrew/bin/openclaw',
      ];
  for (const p of binCandidates) {
    if (p && existsSync(p)) {
      return { found: true, location: 'bin', path: p };
    }
  }

  return { found: false };
}

export async function installOpenClaw(env) {
  console.log('\n📦 Installing OpenClaw...\n');

  // Double-check: look for OpenClaw beyond PATH before installing
  const extraCheck = checkOpenClawBeyondPath();
  if (extraCheck.found) {
    console.log(`✅ OpenClaw already installed at ${extraCheck.path} (${extraCheck.location})`);
    console.log('   Skipping install to avoid duplicate. If it\'s not in PATH, add it manually.\n');
    env.openclawInstalled = true;
    return;
  }

  // Tier 1: managed prefix install (no root required, avoids permission issues)
  const home = homedir();
  const managedPrefix = join(home, '.awareness-claw', 'openclaw-runtime');
  for (const mirror of NPM_MIRRORS) {
    try {
      const registryFlag = mirror ? ` --registry=${mirror}` : '';
      console.log(`  Trying managed install${mirror ? ` (mirror: ${mirror})` : ''}...`);
      execSync(`npm install -g --prefix "${managedPrefix}" openclaw${registryFlag}`, {
        encoding: 'utf8',
        timeout: 120000,
        stdio: 'pipe',
      });
      console.log('✅ OpenClaw installed successfully (managed prefix)!\n');
      return;
    } catch {
      continue;
    }
  }

  // Tier 2: standard npm global install
  let lastError = '';
  for (const mirror of NPM_MIRRORS) {
    try {
      const registryFlag = mirror ? ` --registry=${mirror}` : '';
      console.log(`  Trying global install${mirror ? ` (mirror: ${mirror})` : ' (default registry)'}...`);
      execSync(`npm install -g openclaw${registryFlag}`, {
        encoding: 'utf8',
        timeout: 120000,
        stdio: 'pipe',
      });
      console.log('✅ OpenClaw installed successfully!\n');
      return;
    } catch (err) {
      lastError = err.message || '';
      continue;
    }
  }

  // Check if EACCES was the reason global install failed
  if (lastError.includes('EACCES') || lastError.includes('permission denied') || lastError.includes('Permission denied')) {
    console.log('⚠️  Permission denied for global npm install.');
    console.log('   Managed prefix install was attempted first — if it also failed, run:\n');
    console.log('     npm config set prefix ~/.npm-global');
    console.log('     export PATH=~/.npm-global/bin:$PATH');
    console.log('     npm install -g openclaw\n');
  }

  // Tier 3: official install script
  const scriptUrl = INSTALL_URLS[env.os];
  if (!scriptUrl) {
    throw new Error(`Unsupported platform: ${env.os}. Please install OpenClaw manually.`);
  }

  try {
    if (env.os === 'win32') {
      execSync(`powershell -Command "irm ${scriptUrl} | iex"`, {
        encoding: 'utf8',
        timeout: 180000,
        stdio: 'inherit',
      });
    } else {
      execSync(`curl -fsSL ${scriptUrl} | bash`, {
        encoding: 'utf8',
        timeout: 180000,
        stdio: 'inherit',
      });
    }
    console.log('✅ OpenClaw installed successfully!\n');
  } catch (err) {
    throw new Error(
      `Failed to install OpenClaw. Please install manually:\n` +
      `  https://docs.openclaw.ai/install\n` +
      `  Error: ${err.message}`
    );
  }
}
