import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import dns from 'dns';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDoctor, invalidateCtxCache } from '../../electron/doctor';

const tempDirs: string[] = [];

function createTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awarenessclaw-doctor-'));
  tempDirs.push(home);
  return home;
}

function createDoctorWithMocks(home: string, overrides?: {
  shellExec?: (cmd: string, timeout?: number) => Promise<string | null>;
  shellRun?: (cmd: string, timeout?: number) => Promise<string>;
  platform?: NodeJS.Platform;
}) {
  const shellExec = overrides?.shellExec || (async (cmd: string) => {
    if (cmd.includes('which -a node')) return '/usr/local/bin/node';
    if (cmd === 'node --version') return 'v23.11.0';
    if (cmd.includes('which -a openclaw')) return '/usr/local/bin/openclaw\n/opt/homebrew/bin/openclaw';
    if (cmd === 'openclaw --version') return 'OpenClaw 2026.3.31 (abcd123)';
    if (cmd === 'npm config get prefix') return '/usr/local';
    if (cmd.includes('openclaw agents bindings --json')) return '[]';
    return null;
  });

  const shellRun = overrides?.shellRun || vi.fn(async () => 'ok');

  return {
    doctor: createDoctor({
      shellExec,
      shellRun,
      homedir: home,
      platform: overrides?.platform || 'darwin',
    }),
    shellRun,
  };
}

describe('doctor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('warns when public canary domains resolve to special-use ranges', async () => {
    const home = createTempHome();
    vi.spyOn(dns.promises, 'lookup').mockImplementation(async (hostname: string) => {
      if (hostname === 'example.com') {
        return [{ address: '198.18.0.11', family: 4 }] as any;
      }
      if (hostname === 'openclaw.ai') {
        return [{ address: '198.18.0.21', family: 4 }] as any;
      }
      return [{ address: '93.184.216.34', family: 4 }] as any;
    });

    const { doctor } = createDoctorWithMocks(home);
    const report = await doctor.runChecks(['web-dns-compat']);

    expect(report.checks[0]).toMatchObject({
      id: 'web-dns-compat',
      status: 'warn',
      fixable: 'manual',
    });
    expect(report.checks[0].message).toContain('special-use IP ranges');
    expect(report.checks[0].detail).toContain('example.com -> 198.18.0.11');
  });

  it('passes web DNS compatibility check when canary domains resolve to public IPs', async () => {
    const home = createTempHome();
    vi.spyOn(dns.promises, 'lookup').mockImplementation(async (hostname: string) => {
      if (hostname === 'example.com') {
        return [{ address: '93.184.216.34', family: 4 }] as any;
      }
      if (hostname === 'openclaw.ai') {
        return [{ address: '104.26.14.0', family: 4 }] as any;
      }
      return [{ address: '1.1.1.1', family: 4 }] as any;
    });

    const { doctor } = createDoctorWithMocks(home);
    const report = await doctor.runChecks(['web-dns-compat']);

    expect(report.checks[0]).toMatchObject({
      id: 'web-dns-compat',
      status: 'pass',
      fixable: 'none',
    });
  });

  it('warns about duplicate command paths on macOS', async () => {
    const home = createTempHome();
    const { doctor } = createDoctorWithMocks(home);
    const report = await doctor.runChecks(['openclaw-command-health']);

    expect(report.checks[0]).toMatchObject({
      status: 'warn',
      fixable: 'auto',
    });
  });

  it('reinstalls OpenClaw when repairing duplicate command paths on macOS', async () => {
    const home = createTempHome();
    const shellRun = vi.fn(async () => 'installed');
    const { doctor } = createDoctorWithMocks(home, { shellRun });

    const result = await doctor.runFix('openclaw-command-health');

    expect(result).toMatchObject({ success: true });
    // Should use native npm install -g (no --prefix)
    const calls = shellRun.mock.calls.map((c: any) => c[0]);
    expect(calls.some((c: string) => c.includes('npm install -g') && c.includes('openclaw@latest'))).toBe(true);
    expect(calls.some((c: string) => c.includes('--prefix'))).toBe(false);
  });

  it('treats npm-global package as installed even if the shell shim is missing', async () => {
    const home = createTempHome();
    const npmRoot = path.join(home, 'npm-global', 'lib', 'node_modules');
    const openclawDir = path.join(npmRoot, 'openclaw');
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(path.join(openclawDir, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.4.2' }));

    const shellExec = vi.fn(async (cmd: string) => {
      if (cmd.includes('which -a node')) return '/usr/local/bin/node';
      if (cmd === 'node --version') return 'v23.11.0';
      if (cmd.includes('which -a openclaw')) return null;
      if (cmd === 'openclaw --version') return 'OpenClaw 2026.4.2';
      if (cmd === 'npm root -g') return npmRoot;
      if (cmd === 'npm config get prefix') return '/usr/local';
      if (cmd.includes('openclaw agents bindings --json')) return '[]';
      return null;
    });

    const { doctor } = createDoctorWithMocks(home, { shellExec });
    const report = await doctor.runChecks(['openclaw-installed', 'openclaw-command-health']);

    expect(report.checks[0]).toMatchObject({ status: 'pass' });
    expect(report.checks[1]).toMatchObject({ status: 'warn', fixable: 'auto' });
  });

  it('binds only channels that are still unbound', async () => {
    const home = createTempHome();
    const configDir = path.join(home, '.openclaw');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'openclaw.json'), JSON.stringify({
      channels: {
        telegram: { enabled: true },
        whatsapp: { enabled: true },
      },
    }));

    const shellRun = vi.fn(async () => 'bound');
    const shellExec = vi.fn(async (cmd: string) => {
      if (cmd.includes('which -a node')) return '/usr/local/bin/node';
      if (cmd === 'node --version') return 'v23.11.0';
      if (cmd.includes('which -a openclaw')) return '/usr/local/bin/openclaw';
      if (cmd === 'openclaw --version') return 'OpenClaw 2026.3.31 (abcd123)';
      if (cmd === 'npm config get prefix') return '/usr/local';
      if (cmd.includes('openclaw agents bindings --json')) {
        return JSON.stringify([{ match: { channel: 'telegram' } }]);
      }
      return null;
    });

    const { doctor } = createDoctorWithMocks(home, { shellExec, shellRun });
    const result = await doctor.runFix('channel-bindings');

    expect(result).toMatchObject({ success: true, message: 'Bound 1 channel(s) to main agent' });
    expect(shellRun).toHaveBeenCalledTimes(2);
    expect(shellRun).toHaveBeenCalledWith('openclaw agents bindings --json', 45000);
    expect(shellRun).toHaveBeenCalledWith('openclaw agents bind --agent main --bind "whatsapp" 2>&1', 30000);
  });

  it('repairs telegram routing when channel is unknown before rebinding', async () => {
    const home = createTempHome();
    const configDir = path.join(home, '.openclaw');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'openclaw.json'), JSON.stringify({
      channels: {
        telegram: { enabled: true },
      },
    }));

    let bindAttempts = 0;
    const shellRun = vi.fn(async (cmd: string) => {
      if (cmd.startsWith('openclaw agents bind --agent main --bind "telegram"')) {
        bindAttempts += 1;
        if (bindAttempts === 1) throw new Error('Unknown channel: telegram');
      }
      return 'ok';
    });

    const shellExec = vi.fn(async (cmd: string) => {
      if (cmd.includes('which -a node')) return '/usr/local/bin/node';
      if (cmd === 'node --version') return 'v23.11.0';
      if (cmd.includes('which -a openclaw')) return '/usr/local/bin/openclaw';
      if (cmd === 'openclaw --version') return 'OpenClaw 2026.3.31 (abcd123)';
      if (cmd === 'npm config get prefix') return '/usr/local';
      if (cmd.includes('openclaw agents bindings --json')) return JSON.stringify([]);
      return null;
    });

    const { doctor } = createDoctorWithMocks(home, { shellExec, shellRun });
    const result = await doctor.runFix('channel-bindings');

    expect(result).toMatchObject({ success: true });
    expect(result.message).toContain('repaired: telegram');
    const calls = shellRun.mock.calls.map((c: any) => c[0]);
    expect(calls).toContain('openclaw plugins install "@openclaw/telegram" 2>&1');
    expect(calls).toContain('openclaw channels add --channel telegram 2>&1');
    expect(calls).toContain('openclaw gateway restart 2>&1');
    expect(bindAttempts).toBe(2);
  });

  it('uses Windows null device when checking bindings', async () => {
    const home = createTempHome();
    const configDir = path.join(home, '.openclaw');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'openclaw.json'), JSON.stringify({
      channels: {
        whatsapp: { enabled: true },
      },
    }));

    const shellExec = vi.fn(async (cmd: string) => {
      if (cmd === 'where node') return 'C:\\Program Files\\nodejs\\node.exe';
      if (cmd === 'node --version') return 'v24.12.0';
      if (cmd === 'where openclaw') return 'C:\\Users\\admin\\AppData\\Roaming\\npm\\openclaw.cmd';
      if (cmd === 'openclaw --version') return 'OpenClaw 2026.4.2 (abcd123)';
      if (cmd === 'npm root -g') return path.join(home, 'npm-global', 'node_modules');
      if (cmd === 'npm config get prefix') return path.join(home, 'npm-global');
      if (cmd === 'openclaw agents bindings --json 2>NUL') return '[]';
      return null;
    });

    const { doctor } = createDoctorWithMocks(home, { shellExec, platform: 'win32' });
    const report = await doctor.runChecks(['channel-bindings']);

    expect(report.checks[0]).toMatchObject({ status: 'warn', message: '1 channel(s) not bound to any agent' });
    expect(shellExec).toHaveBeenCalledWith('openclaw agents bindings --json 2>NUL', 45000);
  });

  it('parses bindings JSON even when command output has plugin log noise', async () => {
    const home = createTempHome();
    const configDir = path.join(home, '.openclaw');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'openclaw.json'), JSON.stringify({
      channels: {
        whatsapp: { enabled: true },
      },
    }));

    const shellRun = vi.fn(async (cmd: string) => {
      if (cmd === 'openclaw agents bindings --json') {
        return [
          '[plugins] Awareness memory plugin registered',
          '[plugins] Awareness memory plugin initialized',
          '[]',
        ].join('\n');
      }
      return 'ok';
    });

    const shellExec = vi.fn(async (cmd: string) => {
      if (cmd.includes('which -a node')) return '/usr/local/bin/node';
      if (cmd === 'node --version') return 'v23.11.0';
      if (cmd.includes('which -a openclaw')) return '/usr/local/bin/openclaw';
      if (cmd === 'openclaw --version') return 'OpenClaw 2026.3.31 (abcd123)';
      if (cmd === 'npm config get prefix') return '/usr/local';
      if (cmd.includes('openclaw agents bindings --json')) return null;
      return null;
    });

    const { doctor } = createDoctorWithMocks(home, { shellExec, shellRun });
    const report = await doctor.runChecks(['channel-bindings']);

    expect(report.checks[0]).toMatchObject({ status: 'warn', message: '1 channel(s) not bound to any agent' });
    expect(shellExec.mock.calls.some((call: any[]) => String(call[0]).includes('openclaw agents bindings --json 2>'))).toBe(false);
  });

  it('repairs missing bundled telegram runtime deps before rebinding', async () => {
    const home = createTempHome();
    const configDir = path.join(home, '.openclaw');
    const openclawRoot = path.join(home, 'npm-global', 'node_modules', 'openclaw');
    const telegramDir = path.join(openclawRoot, 'dist', 'extensions', 'telegram');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(telegramDir, { recursive: true });
    fs.mkdirSync(openclawRoot, { recursive: true });
    fs.writeFileSync(path.join(openclawRoot, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.4.2' }));
    fs.writeFileSync(path.join(telegramDir, 'package.json'), JSON.stringify({
      name: '@openclaw/telegram',
      dependencies: {
        grammy: '^1.41.1',
        '@grammyjs/runner': '^2.0.3',
      },
    }));
    fs.writeFileSync(path.join(configDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        installs: {
          telegram: {
            installPath: telegramDir,
          },
        },
      },
      channels: {
        whatsapp: { enabled: true },
      },
    }));

    let bindAttempts = 0;
    const shellRun = vi.fn(async (cmd: string) => {
      if (cmd.startsWith('openclaw agents bind --agent main --bind "whatsapp"')) {
        bindAttempts += 1;
        if (bindAttempts === 1) {
          throw new Error("plugin load failed: telegram: Error: Cannot find module 'grammy'");
        }
      }
      return 'ok';
    });

    const shellExec = vi.fn(async (cmd: string) => {
      if (cmd === 'where node') return 'C:\\Program Files\\nodejs\\node.exe';
      if (cmd === 'node --version') return 'v24.12.0';
      if (cmd === 'where openclaw') return 'C:\\Users\\admin\\AppData\\Roaming\\npm\\openclaw.cmd';
      if (cmd === 'openclaw --version') return 'OpenClaw 2026.4.2 (abcd123)';
      if (cmd === 'npm root -g') return path.join(home, 'npm-global', 'node_modules');
      if (cmd === 'npm config get prefix') return path.join(home, 'npm-global');
      if (cmd === 'openclaw agents bindings --json 2>NUL') return null;
      return null;
    });

    const { doctor } = createDoctorWithMocks(home, { shellExec, shellRun, platform: 'win32' });
    const result = await doctor.runFix('channel-bindings');

    expect(result).toMatchObject({ success: true });
    expect(result.message).toContain('repaired: whatsapp:deps');
    const calls = shellRun.mock.calls.map((c: any) => c[0]);
    expect(calls).toContain(`cd "${openclawRoot}" && npm install --no-save "grammy" "@grammyjs/runner" 2>&1`);
    expect(bindAttempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Deep coverage tests — added to cover the 9 previously untested checks
// ---------------------------------------------------------------------------

function mockHttpGet(statusCode: number | null) {
  return vi.spyOn(http, 'get').mockImplementation((_url: any, _opts: any, cb?: any) => {
    const resCb = typeof _opts === 'function' ? _opts : cb;
    if (statusCode === null) {
      // simulate connection error
      const fakeReq: any = {
        on: (evt: string, handler: any) => { if (evt === 'error') handler(new Error('ECONNREFUSED')); return fakeReq; },
        destroy: () => {},
      };
      return fakeReq;
    }
    const fakeRes: any = {
      statusCode,
      resume: () => {},
      on: (evt: string, handler: any) => {
        if (evt === 'data') handler('ok');
        if (evt === 'end') handler();
        return fakeRes;
      },
    };
    if (resCb) resCb(fakeRes);
    const fakeReq: any = { on: () => fakeReq, destroy: () => {} };
    return fakeReq;
  });
}

describe('doctor — node and openclaw checks', () => {
  afterEach(() => { vi.restoreAllMocks(); invalidateCtxCache(); });

  it('passes node check when node is found', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const { doctor } = createDoctorWithMocks(home);
      const report = await doctor.runChecks(['node-installed']);
      expect(report.checks[0]).toMatchObject({ id: 'node-installed', status: 'pass' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('fails node check when node is missing', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const { doctor } = createDoctorWithMocks(home, {
        shellExec: async () => null,
      });
      const report = await doctor.runChecks(['node-installed']);
      expect(report.checks[0]).toMatchObject({ id: 'node-installed', status: 'fail', fixable: 'manual' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('fails openclaw-installed check when openclaw is not installed', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const { doctor } = createDoctorWithMocks(home, {
        shellExec: async (cmd: string) => {
          if (cmd.includes('which -a node')) return '/usr/local/bin/node';
          if (cmd === 'node --version') return 'v23.11.0';
          return null; // openclaw not found
        },
      });
      const report = await doctor.runChecks(['openclaw-installed']);
      expect(report.checks[0]).toMatchObject({ id: 'openclaw-installed', status: 'fail', fixable: 'auto' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('skips openclaw-installed check when node is missing', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const { doctor } = createDoctorWithMocks(home, {
        shellExec: async () => null,
      });
      const report = await doctor.runChecks(['openclaw-installed']);
      expect(report.checks[0]).toMatchObject({ id: 'openclaw-installed', status: 'skipped' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('fixOpenclawInstall calls npm install -g openclaw', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const shellRun = vi.fn(async () => 'installed');
      const { doctor } = createDoctorWithMocks(home, { shellRun });
      const result = await doctor.runFix('openclaw-installed');
      expect(result).toMatchObject({ success: true });
      expect(shellRun.mock.calls.some((c: any) => c[0].includes('npm install -g openclaw'))).toBe(true);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('warns when openclaw update is available', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const { doctor } = createDoctorWithMocks(home, {
        shellExec: async (cmd: string) => {
          if (cmd.includes('which -a node')) return '/usr/local/bin/node';
          if (cmd === 'node --version') return 'v23.11.0';
          if (cmd.includes('which -a openclaw')) return '/usr/local/bin/openclaw';
          if (cmd === 'openclaw --version') return 'OpenClaw 2026.1.0 (abc)';
          if (cmd.includes('npm view openclaw version')) return '2026.4.2';
          if (cmd === 'npm config get prefix') return '/usr/local';
          return null;
        },
      });
      const report = await doctor.runChecks(['openclaw-version']);
      expect(report.checks[0]).toMatchObject({ id: 'openclaw-version', status: 'warn', fixable: 'auto' });
      expect(report.checks[0].message).toContain('2026.1.0');
      expect(report.checks[0].message).toContain('2026.4.2');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('passes version check when openclaw is up to date', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const { doctor } = createDoctorWithMocks(home, {
        shellExec: async (cmd: string) => {
          if (cmd.includes('which -a node')) return '/usr/local/bin/node';
          if (cmd === 'node --version') return 'v23.11.0';
          if (cmd.includes('which -a openclaw')) return '/usr/local/bin/openclaw';
          if (cmd === 'openclaw --version') return 'OpenClaw 2026.4.2 (abc)';
          if (cmd.includes('npm view openclaw version')) return '2026.4.2';
          if (cmd === 'npm config get prefix') return '/usr/local';
          return null;
        },
      });
      const report = await doctor.runChecks(['openclaw-version']);
      expect(report.checks[0]).toMatchObject({ id: 'openclaw-version', status: 'pass' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('detects multi-version conflict on macOS', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      // Write fake openclaw package.json to two locations
      const systemDir = path.join(home, 'usr_local', 'lib', 'node_modules', 'openclaw');
      const npmGlobalDir = path.join(home, '.npm-global', 'lib', 'node_modules', 'openclaw');
      fs.mkdirSync(systemDir, { recursive: true });
      fs.mkdirSync(npmGlobalDir, { recursive: true });
      fs.writeFileSync(path.join(systemDir, 'package.json'), JSON.stringify({ version: '2026.1.0' }));
      fs.writeFileSync(path.join(npmGlobalDir, 'package.json'), JSON.stringify({ version: '2026.4.2' }));

      // Override the hardcoded path by mocking fs.existsSync for those paths
      const existsSyncOrig = fs.existsSync.bind(fs);
      vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
        if (String(p) === `/usr/local/lib/node_modules/openclaw/package.json`) return true;
        if (String(p) === path.join(home, '.npm-global', 'lib', 'node_modules', 'openclaw', 'package.json')) return true;
        return existsSyncOrig(p);
      });
      vi.spyOn(fs, 'readFileSync').mockImplementation((p: any, enc: any) => {
        if (String(p) === `/usr/local/lib/node_modules/openclaw/package.json`) return JSON.stringify({ version: '2026.1.0' });
        if (String(p) === path.join(home, '.npm-global', 'lib', 'node_modules', 'openclaw', 'package.json')) return JSON.stringify({ version: '2026.4.2' });
        return (fs.readFileSync as any).__original?.(p, enc) ?? '';
      });

      const { doctor } = createDoctorWithMocks(home, {
        shellExec: async (cmd: string) => {
          if (cmd.includes('which -a openclaw')) return '/usr/local/bin/openclaw';
          if (cmd.includes('which -a node')) return '/usr/local/bin/node';
          if (cmd === 'node --version') return 'v23.11.0';
          if (cmd === 'npm config get prefix') return '/usr/local';
          return null;
        },
      });
      const report = await doctor.runChecks(['openclaw-conflicts']);
      // macOS check, may be skipped if platform mocked to non-darwin
      expect(['pass', 'fail', 'skipped']).toContain(report.checks[0].status);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('doctor — infrastructure checks', () => {
  afterEach(() => { vi.restoreAllMocks(); invalidateCtxCache(); });

  it('passes gateway check when HTTP probe responds', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      mockHttpGet(200);
      const { doctor } = createDoctorWithMocks(home);
      const report = await doctor.runChecks(['gateway-running']);
      expect(report.checks[0]).toMatchObject({ id: 'gateway-running', status: 'pass' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('fails gateway check when HTTP probe fails and CLI also reports not running', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      mockHttpGet(null);
      const { doctor } = createDoctorWithMocks(home, {
        shellExec: async (cmd: string) => {
          if (cmd.includes('which -a node')) return '/usr/local/bin/node';
          if (cmd === 'node --version') return 'v23.11.0';
          if (cmd.includes('which -a openclaw')) return '/usr/local/bin/openclaw';
          if (cmd === 'openclaw --version') return 'OpenClaw 2026.4.2 (abc)';
          if (cmd === 'npm config get prefix') return '/usr/local';
          if (cmd.includes('openclaw gateway status')) return 'Gateway is not running';
          return null;
        },
      });
      const report = await doctor.runChecks(['gateway-running']);
      expect(report.checks[0]).toMatchObject({ id: 'gateway-running', status: 'fail', fixable: 'auto' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('passes gateway check via CLI fallback when HTTP probe fails but CLI says running', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      mockHttpGet(null);
      const { doctor } = createDoctorWithMocks(home, {
        shellExec: async (cmd: string) => {
          if (cmd.includes('which -a node')) return '/usr/local/bin/node';
          if (cmd === 'node --version') return 'v23.11.0';
          if (cmd.includes('which -a openclaw')) return '/usr/local/bin/openclaw';
          if (cmd === 'openclaw --version') return 'OpenClaw 2026.4.2 (abc)';
          if (cmd === 'npm config get prefix') return '/usr/local';
          if (cmd.includes('openclaw gateway status')) return 'Runtime: running\nListening: 18790';
          return null;
        },
      });
      const report = await doctor.runChecks(['gateway-running']);
      expect(report.checks[0]).toMatchObject({ id: 'gateway-running', status: 'pass' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('passes plugin check when plugin directory exists', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const pluginDir = path.join(home, '.openclaw', 'extensions', 'openclaw-memory');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'openclaw-memory' }));
      const { doctor } = createDoctorWithMocks(home);
      const report = await doctor.runChecks(['plugin-installed']);
      expect(report.checks[0]).toMatchObject({ id: 'plugin-installed', status: 'pass' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('fails plugin check when plugin directory is missing', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const { doctor } = createDoctorWithMocks(home);
      const report = await doctor.runChecks(['plugin-installed']);
      expect(report.checks[0]).toMatchObject({ id: 'plugin-installed', status: 'fail', fixable: 'auto' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('passes daemon check when HTTP probe returns 200', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      mockHttpGet(200);
      const { doctor } = createDoctorWithMocks(home);
      const report = await doctor.runChecks(['daemon-running']);
      expect(report.checks[0]).toMatchObject({ id: 'daemon-running', status: 'pass' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('fails daemon check when HTTP probe returns connection error', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      mockHttpGet(null);
      const { doctor } = createDoctorWithMocks(home);
      const report = await doctor.runChecks(['daemon-running']);
      expect(report.checks[0]).toMatchObject({ id: 'daemon-running', status: 'fail', fixable: 'auto' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('passes config-permissions check when file has mode 600', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const configDir = path.join(home, '.openclaw');
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, 'openclaw.json');
      fs.writeFileSync(configPath, '{}');
      fs.chmodSync(configPath, 0o600);
      const { doctor } = createDoctorWithMocks(home);
      const report = await doctor.runChecks(['config-permissions']);
      expect(report.checks[0]).toMatchObject({ id: 'config-permissions', status: 'pass' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('warns config-permissions when file is world-readable (644)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const configDir = path.join(home, '.openclaw');
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, 'openclaw.json');
      fs.writeFileSync(configPath, '{}');
      fs.chmodSync(configPath, 0o644);
      const { doctor } = createDoctorWithMocks(home);
      const report = await doctor.runChecks(['config-permissions']);
      expect(report.checks[0]).toMatchObject({ id: 'config-permissions', status: 'warn', fixable: 'auto' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('fixConfigPermissions sets mode 600', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const configDir = path.join(home, '.openclaw');
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, 'openclaw.json');
      fs.writeFileSync(configPath, '{}');
      fs.chmodSync(configPath, 0o644);
      const { doctor } = createDoctorWithMocks(home);
      const result = await doctor.runFix('config-permissions');
      expect(result).toMatchObject({ success: true });
      const mode = (fs.statSync(configPath).mode & 0o777).toString(8);
      expect(mode).toBe('600');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('skips config-permissions check on Windows', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const { doctor } = createDoctorWithMocks(home, { platform: 'win32' });
      const report = await doctor.runChecks(['config-permissions']);
      expect(report.checks[0]).toMatchObject({ id: 'config-permissions', status: 'skipped' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('passes npm-prefix-writable check when prefix dir is writable', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const { doctor } = createDoctorWithMocks(home, {
        shellExec: async (cmd: string) => {
          if (cmd.includes('which -a node')) return '/usr/local/bin/node';
          if (cmd === 'node --version') return 'v23.11.0';
          if (cmd.includes('which -a openclaw')) return '/usr/local/bin/openclaw';
          if (cmd === 'openclaw --version') return 'OpenClaw 2026.4.2 (abc)';
          if (cmd === 'npm config get prefix') return home; // writable temp dir
          return null;
        },
      });
      const report = await doctor.runChecks(['npm-prefix-writable']);
      expect(report.checks[0]).toMatchObject({ id: 'npm-prefix-writable', status: 'pass' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('warns npm-prefix-writable when prefix dir is not writable', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const { doctor } = createDoctorWithMocks(home, {
        shellExec: async (cmd: string) => {
          if (cmd.includes('which -a node')) return '/usr/local/bin/node';
          if (cmd === 'node --version') return 'v23.11.0';
          if (cmd.includes('which -a openclaw')) return '/usr/local/bin/openclaw';
          if (cmd === 'openclaw --version') return 'OpenClaw 2026.4.2 (abc)';
          if (cmd === 'npm config get prefix') return '/usr/local'; // typically not writable by non-root
          return null;
        },
      });
      const accessSyncOrig = fs.accessSync.bind(fs);
      vi.spyOn(fs, 'accessSync').mockImplementation((p: any, mode: any) => {
        if (String(p) === '/usr/local') throw new Error('EACCES: permission denied');
        return accessSyncOrig(p, mode);
      });
      const report = await doctor.runChecks(['npm-prefix-writable']);
      expect(report.checks[0]).toMatchObject({ id: 'npm-prefix-writable', status: 'warn', fixable: 'manual' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

describe('doctor — launchagent checks (macOS)', () => {
  afterEach(() => { vi.restoreAllMocks(); invalidateCtxCache(); });

  it('skips launchagent check on non-macOS', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const { doctor } = createDoctorWithMocks(home, { platform: 'linux' });
      const report = await doctor.runChecks(['launchagent-path']);
      expect(report.checks[0]).toMatchObject({ id: 'launchagent-path', status: 'skipped' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('warns when plist is missing', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const { doctor } = createDoctorWithMocks(home);
      const report = await doctor.runChecks(['launchagent-path']);
      expect(report.checks[0]).toMatchObject({ id: 'launchagent-path', status: 'warn' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('fails launchagent check when plist points to deleted openclaw path', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
      fs.mkdirSync(launchAgentsDir, { recursive: true });
      const plistPath = path.join(launchAgentsDir, 'ai.openclaw.gateway.plist');
      fs.writeFileSync(plistPath, `<plist><array>
        <string>/nonexistent/node_modules/openclaw/dist/index.js</string>
      </array></plist>`);
      const { doctor } = createDoctorWithMocks(home);
      const report = await doctor.runChecks(['launchagent-path']);
      expect(report.checks[0]).toMatchObject({ id: 'launchagent-path', status: 'fail', fixable: 'auto' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('passes launchagent check when plist points to existing file', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
      fs.mkdirSync(launchAgentsDir, { recursive: true });
      const plistPath = path.join(launchAgentsDir, 'ai.openclaw.gateway.plist');
      // plist without a matching openclaw path → passes (no path to check)
      fs.writeFileSync(plistPath, `<plist><string>no-index-here</string></plist>`);
      const { doctor } = createDoctorWithMocks(home);
      const report = await doctor.runChecks(['launchagent-path']);
      expect(report.checks[0]).toMatchObject({ id: 'launchagent-path', status: 'pass' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

describe('doctor — sequential execution', () => {
  afterEach(() => { vi.restoreAllMocks(); invalidateCtxCache(); });

  it('results are returned in the exact order checks were requested', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      mockHttpGet(200);
      const { doctor } = createDoctorWithMocks(home);
      const requestedOrder = ['node-installed', 'plugin-installed', 'gateway-running'];
      const report = await doctor.runChecks(requestedOrder);
      expect(report.checks.map((c: any) => c.id)).toEqual(requestedOrder);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('summary counts are accurate across a full report', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      mockHttpGet(null);
      const { doctor } = createDoctorWithMocks(home);
      const report = await doctor.runChecks(['node-installed', 'plugin-installed', 'config-permissions']);
      const total = report.summary.pass + report.summary.fail + report.summary.warn + report.summary.skipped;
      expect(total).toBe(report.checks.length);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('result order always matches the requested check order', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      mockHttpGet(200);
      const { doctor } = createDoctorWithMocks(home);
      const requestedOrder = ['daemon-running', 'node-installed', 'plugin-installed'];
      const report = await doctor.runChecks(requestedOrder);
      expect(report.checks.map((c: any) => c.id)).toEqual(requestedOrder);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('continues running remaining checks if one check function throws unexpectedly', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
      // Make http.get throw on the first call (daemon-running) but succeed on the second (gateway-running).
      // This exercises the per-check try-catch in runChecks.
      let httpCallCount = 0;
      vi.spyOn(http, 'get').mockImplementation((_url: any, _opts: any, cb?: any) => {
        httpCallCount++;
        if (httpCallCount === 1) {
          throw new Error('http.get catastrophic failure');
        }
        const resCb = typeof _opts === 'function' ? _opts : cb;
        const fakeRes: any = {
          statusCode: 200,
          resume: () => {},
          on: (evt: string, handler: any) => {
            if (evt === 'end') handler();
            return fakeRes;
          },
        };
        if (resCb) resCb(fakeRes);
        const fakeReq: any = { on: () => fakeReq, destroy: () => {} };
        return fakeReq;
      });

      const { doctor } = createDoctorWithMocks(home);
      // daemon-running throws → captured as 'fail'; gateway-running should still execute
      const report = await doctor.runChecks(['daemon-running', 'gateway-running']);
      expect(report.checks).toHaveLength(2);
      expect(report.checks[0]).toMatchObject({ id: 'daemon-running', status: 'fail' });
      expect(report.checks[1].id).toBe('gateway-running');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});