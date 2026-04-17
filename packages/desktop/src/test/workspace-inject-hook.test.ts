import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  installWorkspaceInjectHook,
  readActiveWorkspace,
  writeActiveWorkspace,
} from '../../electron/install-workspace-hook';

/**
 * Deep tests for the AwarenessClaw active-workspace injection flow. These cover three layers:
 *
 *   1. Pure helpers: readActiveWorkspace / writeActiveWorkspace (state file I/O)
 *   2. Installer: installWorkspaceInjectHook (deploys script + registers in openclaw.json)
 *   3. End-to-end: require the deployed script and invoke its before_prompt_build handler
 *      with realistic event shapes, verifying prefix injection and early-return paths.
 *
 * Every test runs in its own temp HOME so it cannot touch the real ~/.awarenessclaw or
 * ~/.openclaw of the developer machine.
 */

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'awc-wsinject-test-'));
}

function cleanupHome(home: string): void {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeOpenClawJson(home: string, config: unknown): void {
  const dir = path.join(home, '.openclaw');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'openclaw.json'), JSON.stringify(config, null, 2), 'utf8');
}

function readOpenClawJson(home: string): any {
  return JSON.parse(fs.readFileSync(path.join(home, '.openclaw', 'openclaw.json'), 'utf8'));
}

describe('writeActiveWorkspace / readActiveWorkspace', () => {
  let home: string;
  beforeEach(() => { home = makeTempHome(); });
  afterEach(() => cleanupHome(home));

  it('returns null when no state file exists', () => {
    expect(readActiveWorkspace(home)).toBeNull();
  });

  it('writes and reads back an absolute path', () => {
    writeActiveWorkspace('/Users/alice/MyProject', home);
    expect(readActiveWorkspace(home)).toBe('/Users/alice/MyProject');
  });

  it('overwrites on subsequent writes (timestamp updates)', () => {
    writeActiveWorkspace('/a', home);
    const first = fs.readFileSync(
      path.join(home, '.awarenessclaw', 'active-workspace.json'),
      'utf8',
    );
    writeActiveWorkspace('/b', home);
    const second = fs.readFileSync(
      path.join(home, '.awarenessclaw', 'active-workspace.json'),
      'utf8',
    );
    expect(readActiveWorkspace(home)).toBe('/b');
    expect(first).not.toBe(second);
  });

  it('clears state when passed null', () => {
    writeActiveWorkspace('/x', home);
    writeActiveWorkspace(null, home);
    expect(readActiveWorkspace(home)).toBeNull();
    expect(fs.existsSync(path.join(home, '.awarenessclaw', 'active-workspace.json'))).toBe(false);
  });

  it('clears state when passed empty / whitespace string', () => {
    writeActiveWorkspace('/x', home);
    writeActiveWorkspace('   ', home);
    expect(readActiveWorkspace(home)).toBeNull();
  });

  it('returns null on malformed JSON file (graceful fallback)', () => {
    const dir = path.join(home, '.awarenessclaw');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'active-workspace.json'), '{not json');
    expect(readActiveWorkspace(home)).toBeNull();
  });

  it('returns null when JSON has no path field', () => {
    const dir = path.join(home, '.awarenessclaw');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'active-workspace.json'), JSON.stringify({ foo: 'bar' }));
    expect(readActiveWorkspace(home)).toBeNull();
  });
});

describe('installWorkspaceInjectHook', () => {
  let home: string;
  beforeEach(() => { home = makeTempHome(); });
  afterEach(() => cleanupHome(home));

  it('returns no-config status when openclaw.json does not exist', () => {
    const result = installWorkspaceInjectHook(home);
    expect(result.status).toBe('no-config');
  });

  it('deploys script + registers config entry on first install', () => {
    writeOpenClawJson(home, { meta: { version: '1' } });
    const result = installWorkspaceInjectHook(home);
    expect(result.status).toBe('deployed');
    expect(result.changes).toContain('hook-script');
    expect(result.changes).toContain('config-entry');

    const scriptPath = path.join(home, '.openclaw', 'hooks', 'awareness-workspace-inject', 'index.cjs');
    expect(fs.existsSync(scriptPath)).toBe(true);
    const script = fs.readFileSync(scriptPath, 'utf8');
    expect(script).toContain('before_prompt_build');
    expect(script).toContain('PREFIX_TEMPLATE');

    const cfg = readOpenClawJson(home);
    expect(cfg.hooks.internal.enabled).toBe(true);
    expect(cfg.hooks.internal.entries['awareness-workspace-inject']).toBeDefined();
    expect(cfg.hooks.internal.entries['awareness-workspace-inject'].enabled).toBe(true);
    expect(cfg.hooks.internal.entries['awareness-workspace-inject'].path).toBe(scriptPath);
  });

  it('preserves existing unrelated hook entries', () => {
    writeOpenClawJson(home, {
      hooks: {
        internal: {
          enabled: true,
          entries: {
            'boot-md': { enabled: true, path: '/existing/boot.js' },
            'other-hook': { enabled: false, path: '/existing/other.js' },
          },
        },
      },
    });
    installWorkspaceInjectHook(home);
    const cfg = readOpenClawJson(home);
    expect(cfg.hooks.internal.entries['boot-md']).toEqual({ enabled: true, path: '/existing/boot.js' });
    expect(cfg.hooks.internal.entries['other-hook']).toEqual({ enabled: false, path: '/existing/other.js' });
    expect(cfg.hooks.internal.entries['awareness-workspace-inject']).toBeDefined();
  });

  it('never touches agents.list[*].workspace or agentDir (MD files stay put)', () => {
    writeOpenClawJson(home, {
      agents: {
        list: [
          {
            id: 'main',
            workspace: '/home/u/.openclaw/workspace-main',
            agentDir: '/home/u/.openclaw/agents/main/agent',
            identity: { name: 'Claw' },
          },
          {
            id: 'coder',
            workspace: '/home/u/.openclaw/workspace-coder',
            agentDir: '/home/u/.openclaw/agents/coder/agent',
          },
        ],
      },
    });
    installWorkspaceInjectHook(home);
    const cfg = readOpenClawJson(home);
    const main = cfg.agents.list.find((a: any) => a.id === 'main');
    const coder = cfg.agents.list.find((a: any) => a.id === 'coder');
    expect(main.workspace).toBe('/home/u/.openclaw/workspace-main');
    expect(main.agentDir).toBe('/home/u/.openclaw/agents/main/agent');
    expect(main.identity).toEqual({ name: 'Claw' });
    expect(coder.workspace).toBe('/home/u/.openclaw/workspace-coder');
    expect(coder.agentDir).toBe('/home/u/.openclaw/agents/coder/agent');
  });

  it('is idempotent — second install is ok status, no changes', () => {
    writeOpenClawJson(home, { meta: { version: '1' } });
    installWorkspaceInjectHook(home);
    const second = installWorkspaceInjectHook(home);
    expect(second.status).toBe('ok');
    expect(second.changes).toBeUndefined();
  });

  it('repairs a disabled / tampered config entry on reinstall', () => {
    writeOpenClawJson(home, { meta: { version: '1' } });
    installWorkspaceInjectHook(home);
    const cfgPath = path.join(home, '.openclaw', 'openclaw.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.hooks.internal.entries['awareness-workspace-inject'].enabled = false;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    const result = installWorkspaceInjectHook(home);
    expect(result.status).toBe('deployed');
    expect(result.changes).toContain('config-entry');
    const repaired = readOpenClawJson(home);
    expect(repaired.hooks.internal.entries['awareness-workspace-inject'].enabled).toBe(true);
  });

  it('writes a backup file when config is modified', () => {
    writeOpenClawJson(home, { meta: { version: '1' } });
    installWorkspaceInjectHook(home);
    const backups = fs.readdirSync(path.join(home, '.openclaw'))
      .filter((f) => f.startsWith('openclaw.json.desktop-bak') || f.startsWith('openclaw.json.bak.hook-'));
    expect(backups.length).toBeGreaterThan(0);
  });
});

describe('deployed hook script: before_prompt_build handler (end-to-end)', () => {
  let home: string;
  let hookModule: any;

  beforeEach(() => {
    home = makeTempHome();
    writeOpenClawJson(home, { meta: { version: '1' } });
    installWorkspaceInjectHook(home);

    // The hook script resolves ~/.awarenessclaw/active-workspace.json via os.homedir(). We
    // redirect os.homedir for this test module so the hook reads our temp state file
    // instead of the developer's real home. require.resolve + delete from cache so the
    // patched os is picked up.
    const originalHomedir = os.homedir;
    (os as any).homedir = () => home;

    const scriptPath = path.join(home, '.openclaw', 'hooks', 'awareness-workspace-inject', 'index.cjs');
    // Invalidate any cached version of the hook so os.homedir monkey-patch takes effect.
    delete require.cache[require.resolve(scriptPath)];
    hookModule = require(scriptPath);

    // Restore os.homedir immediately — the hook has already captured its own path closure
    // via STATE_PATH = path.join(os.homedir(), ...) which is evaluated at module load.
    (os as any).homedir = originalHomedir;
  });

  afterEach(() => cleanupHome(home));

  it('returns undefined when no active workspace is set', async () => {
    const result = await hookModule.hooks.before_prompt_build({ body: 'hello' }, {});
    expect(result).toBeUndefined();
  });

  it('returns prependContext with project dir when active workspace exists', async () => {
    // Create the target directory so pathExists() passes.
    const target = path.join(home, 'my-project');
    fs.mkdirSync(target, { recursive: true });
    writeActiveWorkspace(target, home);

    const result = await hookModule.hooks.before_prompt_build({ body: 'change the readme' }, {});
    expect(result).toBeDefined();
    expect(result.prependContext).toContain('[Project working directory:');
    expect(result.prependContext).toContain(target);
    expect(result.prependContext).toContain("agent's home workspace");
    // Must warn the LLM not to treat it as home workspace — this protects MD files.
    expect(result.prependContext).toContain('AGENTS.md');
    expect(result.prependContext).toContain('MEMORY.md');
    expect(result.prependContext).toContain('SOUL.md');
  });

  it('returns undefined when the configured directory does not exist (no stale injection)', async () => {
    writeActiveWorkspace('/nonexistent/bogus/path-xyz-123', home);
    const result = await hookModule.hooks.before_prompt_build({ body: 'hi' }, {});
    expect(result).toBeUndefined();
  });

  it('skips injection when the event body already contains the same prefix (avoid double-inject)', async () => {
    const target = path.join(home, 'proj2');
    fs.mkdirSync(target, { recursive: true });
    writeActiveWorkspace(target, home);

    // Desktop chat has already injected the prefix via register-chat-handlers.ts:416.
    const result = await hookModule.hooks.before_prompt_build(
      { body: '[Project working directory: /some/path] original msg' },
      {},
    );
    expect(result).toBeUndefined();
  });

  it('handles event.content as fallback field (alternative OpenClaw event shape)', async () => {
    const target = path.join(home, 'proj3');
    fs.mkdirSync(target, { recursive: true });
    writeActiveWorkspace(target, home);

    // When the event uses `content` instead of `body`, the hook should still check it
    // for the skip-on-duplicate heuristic.
    const alreadyPrefixed = await hookModule.hooks.before_prompt_build(
      { content: '[Project working directory: /x] msg' },
      {},
    );
    expect(alreadyPrefixed).toBeUndefined();

    const fresh = await hookModule.hooks.before_prompt_build({ content: 'plain msg' }, {});
    expect(fresh).toBeDefined();
    expect(fresh.prependContext).toContain(target);
  });

  it('never throws when the state file disappears between reads (race)', async () => {
    const target = path.join(home, 'proj4');
    fs.mkdirSync(target, { recursive: true });
    writeActiveWorkspace(target, home);
    // First call works.
    const first = await hookModule.hooks.before_prompt_build({ body: 'msg' }, {});
    expect(first).toBeDefined();

    // Delete the state mid-run.
    writeActiveWorkspace(null, home);
    const second = await hookModule.hooks.before_prompt_build({ body: 'msg' }, {});
    expect(second).toBeUndefined();
  });
});
