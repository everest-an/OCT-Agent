import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  getGatewayPort as getGatewayPortShared,
} from './openclaw-config';

export function createShellUtils(options: { home: string; app: any }) {
  const { home, app } = options;

  // Track all children spawned by readShellOutputAsync so they can be force-killed
  // on app quit and when the shell times out. Prevents orphaned openclaw processes.
  const trackedShellChildren = new Set<import('child_process').ChildProcess>();

  /**
   * Kill a shell child and its entire process group.
   * On Unix, requires the child to have been spawned with detached:true so it
   * owns a fresh process group — then process.kill(-pid) signals every member.
   * Falls back to child.kill() if the group kill throws.
   */
  function killChildProcessGroup(child: import('child_process').ChildProcess) {
    if (process.platform !== 'win32' && child.pid != null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch {}
      }
    } else {
      try { child.kill(); } catch {}
    }
  }

  /** Force-kill every tracked shell child. Called from before-quit. */
  function killAllTrackedShellChildren() {
    for (const child of trackedShellChildren) {
      killChildProcessGroup(child);
    }
    trackedShellChildren.clear();
  }

  function wrapWindowsCommand(cmd: string) {
    return process.platform === 'win32' ? `chcp 65001>nul & ${cmd}` : cmd;
  }

  function stripAnsi(text: string) {
    return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  }

  function getWindowsPathext() {
    const current = process.env.PATHEXT;
    if (typeof current === 'string' && current.trim()) return current;
    return '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';
  }

  function buildShellEnv(extra: Record<string, string> = {}, explicitPath?: string) {
    const resolvedPath = explicitPath || getEnhancedPath();
    if (process.platform !== 'win32') {
      return { ...process.env, PATH: resolvedPath, ...extra };
    }
    return {
      ...process.env,
      PATH: resolvedPath,
      PATHEXT: getWindowsPathext(),
      ComSpec: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
      ...extra,
    };
  }

  function getEnhancedPath(): string {
    const base = process.env.PATH || '';
    const extras: string[] = [];

    if (process.platform === 'darwin' || process.platform === 'linux') {
      extras.push(
        `${home}/.npm-global/bin`,
        `${home}/.local/bin`,
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
      );
      try {
        const nvmDir = path.join(home, '.nvm', 'versions', 'node');
        if (fs.existsSync(nvmDir)) {
          const versions = fs.readdirSync(nvmDir).filter(v => v.startsWith('v')).sort().reverse();
          if (versions.length > 0) extras.push(path.join(nvmDir, versions[0], 'bin'));
        }
      } catch {}
      try {
        const fnmDefault = path.join(home, '.fnm', 'aliases', 'default', 'bin');
        if (fs.existsSync(fnmDefault)) extras.push(fnmDefault);
      } catch {}
      if (process.platform === 'linux') {
        extras.push('/snap/bin');
      }
    } else if (process.platform === 'win32') {
      const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      const localappdata = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      const programfiles = process.env.ProgramFiles || 'C:\\Program Files';
      extras.push(
        `${appdata}\\npm`,
        `${localappdata}\\pnpm`,
        `${programfiles}\\nodejs`,
        `${process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\nodejs`,
        `${localappdata}\\fnm_multishells`,
      );
    }

    return [...extras, base].join(path.delimiter);
  }

  function findNodeExecutable() {
    const executableName = process.platform === 'win32' ? 'node.exe' : 'node';
    const pathEntries = (getEnhancedPath() || '').split(path.delimiter).filter(Boolean);

    for (const entry of pathEntries) {
      const candidate = path.join(entry, executableName);
      if (fs.existsSync(candidate)) return candidate;
    }

    const fallback = safeShellExec(process.platform === 'win32' ? 'where node' : 'which node', 3000);
    if (fallback) {
      const firstLine = fallback.split(/\r?\n/).map(line => line.trim()).find(Boolean);
      if (firstLine) return firstLine;
    }

    return process.platform === 'win32' ? 'node.exe' : 'node';
  }

  function getNodeInvocationCommand() {
    const nodeExecutable = findNodeExecutable();
    return nodeExecutable.includes(' ') ? `"${nodeExecutable}"` : nodeExecutable;
  }

  function getGatewayPort() {
    return getGatewayPortShared(home);
  }

  function rawShellExecSync(cmd: string, timeoutMs = 5000): string | null {
    try {
      const enhancedPath = getEnhancedPath();
      if (process.platform === 'win32') {
        return execSync(wrapWindowsCommand(cmd), { encoding: 'utf8', timeout: timeoutMs, stdio: 'pipe', shell: 'cmd.exe', windowsHide: true, env: buildShellEnv({ NO_COLOR: '1', FORCE_COLOR: '0' }, enhancedPath) }).trim();
      }
      return execSync(`/bin/bash --norc --noprofile -c 'export PATH="${enhancedPath}"; ${cmd.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf8', timeout: timeoutMs, stdio: 'pipe', env: buildShellEnv({}, enhancedPath),
      }).trim();
    } catch {
      return null;
    }
  }

  function rawShellExecAsync(cmd: string, timeoutMs = 5000): Promise<string | null> {
    return new Promise(resolve => {
      const enhancedPath = getEnhancedPath();
      const shellCmd = process.platform === 'win32' ? wrapWindowsCommand(cmd) : `export PATH="${enhancedPath}"; ${cmd}`;
      const child = process.platform === 'win32'
        ? spawn(shellCmd, [], { shell: 'cmd.exe', windowsHide: true, env: buildShellEnv({ NO_COLOR: '1', FORCE_COLOR: '0' }, enhancedPath), stdio: 'pipe' })
        : spawn('/bin/bash', ['--norc', '--noprofile', '-c', shellCmd], { env: buildShellEnv({}, enhancedPath), stdio: 'pipe' });
      let stdout = '';
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; child.kill(); resolve(null); } }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.on('close', (code: number | null) => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(code === 0 ? stdout.trim() : null); }
      });
      child.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } });
    });
  }

  function getOpenClawPackageDirSync(): string | null {
    const npmRoot = rawShellExecSync('npm root -g', 5000);
    if (!npmRoot) return null;
    const pkgDir = path.join(npmRoot.trim(), 'openclaw');
    return fs.existsSync(path.join(pkgDir, 'package.json')) ? pkgDir : null;
  }

  async function getOpenClawPackageDirAsync(): Promise<string | null> {
    const npmRoot = await rawShellExecAsync('npm root -g', 5000);
    if (!npmRoot) return null;
    const pkgDir = path.join(npmRoot.trim(), 'openclaw');
    return fs.existsSync(path.join(pkgDir, 'package.json')) ? pkgDir : null;
  }

  function getOpenClawEntryPath(pkgDir: string): string | null {
    const candidates = [
      path.join(pkgDir, 'openclaw.mjs'),
      path.join(pkgDir, 'dist', 'index.js'),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
  }

  // Default stack size for Node.js is ~1 MB. OpenClaw plugins (minimax, talk-voice,
  // openclaw-weixin) use AJV for schema compilation, which can exceed the default
  // stack depth on Windows, causing "RangeError: Maximum call stack size exceeded"
  // and exit code -1 (4294967295 unsigned).  --stack-size is in KB.
  const NODE_STACK_SIZE_KB = 8192; // 8 MB

  function buildOpenClawShellFallbackSync(): string | null {
    const pkgDir = getOpenClawPackageDirSync();
    if (!pkgDir) {
      // openclaw might be on PATH but we can't find its package dir — skip stack override
      return null;
    }
    const entryPath = getOpenClawEntryPath(pkgDir);
    if (!entryPath) return null;
    const candidate = `${getNodeInvocationCommand()} --stack-size=${NODE_STACK_SIZE_KB} "${entryPath}"`;
    return rawShellExecSync(`${candidate} --version`, 8000) ? candidate : null;
  }

  async function buildOpenClawShellFallbackAsync(): Promise<string | null> {
    const pkgDir = await getOpenClawPackageDirAsync();
    if (!pkgDir) return null;
    const entryPath = getOpenClawEntryPath(pkgDir);
    if (!entryPath) return null;
    const candidate = `${getNodeInvocationCommand()} --stack-size=${NODE_STACK_SIZE_KB} "${entryPath}"`;
    return await rawShellExecAsync(`${candidate} --version`, 8000) ? candidate : null;
  }

  function getOpenClawDirectSpawnSync(): { command: string; argsPrefix: string[] } | null {
    const pkgDir = getOpenClawPackageDirSync();
    if (!pkgDir) return null;
    const entryPath = getOpenClawEntryPath(pkgDir);
    if (!entryPath) return null;
    return { command: findNodeExecutable(), argsPrefix: [`--stack-size=${NODE_STACK_SIZE_KB}`, entryPath] };
  }

  function rewriteOpenClawShellCommand(command: string, fallback: string | null) {
    if (!fallback || !/\bopenclaw\b/.test(command)) return command;
    let rewritten = command.replace(/^openclaw\b/, fallback);
    rewritten = rewritten.replace(/(&&\s*)openclaw\b/g, `$1${fallback}`);
    rewritten = rewritten.replace(/(\|\|\s*)openclaw\b/g, `$1${fallback}`);
    rewritten = rewritten.replace(/(;\s*)openclaw\b/g, `$1${fallback}`);
    return rewritten;
  }

  function safeShellExec(cmd: string, timeoutMs = 5000): string | null {
    return rawShellExecSync(rewriteOpenClawShellCommand(cmd, buildOpenClawShellFallbackSync()), timeoutMs);
  }

  function safeShellExecAsync(cmd: string, timeoutMs = 5000): Promise<string | null> {
    return buildOpenClawShellFallbackAsync().then((fallback) => rawShellExecAsync(rewriteOpenClawShellCommand(cmd, fallback), timeoutMs));
  }

  function readShellOutputAsync(cmd: string, timeoutMs = 5000): Promise<string | null> {
    return new Promise(resolve => {
      const enhancedPath = getEnhancedPath();
      buildOpenClawShellFallbackAsync().then((fallback) => {
        const rewrittenCmd = rewriteOpenClawShellCommand(cmd, fallback);
        const shellCmd = process.platform === 'win32' ? wrapWindowsCommand(rewrittenCmd) : `export PATH="${enhancedPath}"; ${rewrittenCmd}`;
        // Unix: detached:true creates a fresh process group owned by this child, so
        // process.kill(-child.pid) on timeout kills bash AND openclaw AND any plugin
        // sub-processes in one shot. Without this, child.kill() only kills bash and
        // leaves openclaw hanging as an orphan (causing progressive system freeze).
        const child = process.platform === 'win32'
          ? spawn(shellCmd, [], { shell: 'cmd.exe', windowsHide: true, env: buildShellEnv({ NO_COLOR: '1', FORCE_COLOR: '0' }, enhancedPath), stdio: 'pipe' })
          : spawn('/bin/bash', ['--norc', '--noprofile', '-c', shellCmd], { env: buildShellEnv({}, enhancedPath), stdio: 'pipe', detached: true });
        trackedShellChildren.add(child);
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            killChildProcessGroup(child);
            resolve((stdout + stderr).trim() || null);
          }
        }, timeoutMs);
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('close', () => {
          trackedShellChildren.delete(child);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve((stdout + stderr).trim() || null);
          }
        });
        child.on('error', () => {
          trackedShellChildren.delete(child);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve((stdout + stderr).trim() || null);
          }
        });
      });
    });
  }

  function getNodeVersion(): string | null {
    return safeShellExec('node --version');
  }

  function getBundledNpmBin(binName: 'npx' | 'npm') {
    const candidates = [
      path.join(app.getPath('exe'), '..', '..', 'resources', 'app.asar.unpacked', 'node_modules', 'npm', 'bin', `${binName}-cli.js`),
      path.join(app.getAppPath(), 'node_modules', 'npm', 'bin', `${binName}-cli.js`),
      path.join(__dirname, '..', 'node_modules', 'npm', 'bin', `${binName}-cli.js`),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
  }

  function resolveBundledCache(fileName: string) {
    const candidates = [
      path.join(app.getPath('exe'), '..', '..', 'resources', 'app.asar.unpacked', 'cache', fileName),
      path.join(app.getAppPath(), 'cache', fileName),
      path.join(__dirname, '..', 'cache', fileName),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
  }

  function run(cmd: string, opts: Record<string, unknown> = {}): string {
    const enhancedPath = getEnhancedPath();
    const rewrittenCmd = rewriteOpenClawShellCommand(cmd, buildOpenClawShellFallbackSync());
    if (process.platform === 'win32') {
      return execSync(rewrittenCmd, { encoding: 'utf8', timeout: 180000, stdio: 'pipe', shell: 'cmd.exe', windowsHide: true, env: buildShellEnv({}, enhancedPath), ...opts } as any);
    }
    return execSync(`/bin/bash --norc --noprofile -c 'export PATH="${enhancedPath}"; ${rewrittenCmd.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf8', timeout: 180000, stdio: 'pipe', env: buildShellEnv({}, enhancedPath), ...opts,
    } as any);
  }

  function runSpawn(cmd: string, args: string[], opts: Record<string, unknown> = {}) {
    const mergeSpawnEnv = () => {
      const provided = (opts as any).env as Record<string, string> | undefined;
      if (!provided) return buildShellEnv();

      const explicitPath = typeof provided.PATH === 'string'
        ? provided.PATH
        : (typeof (provided as any).Path === 'string' ? (provided as any).Path : undefined);

      const passthroughEnv = { ...provided } as Record<string, string>;
      delete (passthroughEnv as any).PATH;
      delete (passthroughEnv as any).Path;

      return buildShellEnv(passthroughEnv, explicitPath);
    };

    const spawnOptions = {
      ...(process.platform === 'win32' && { windowsHide: true }),
      ...opts,
      env: mergeSpawnEnv(),
    };

    const tryBundledNpx = () => {
      const npxCli = getBundledNpmBin('npx');
      if (!npxCli) return null;
      return spawn(process.execPath, [npxCli, ...args], {
        ...spawnOptions,
      });
    };

    if (cmd === 'npx') {
      try {
        return spawn(cmd, args, {
          ...spawnOptions,
        });
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          const child = tryBundledNpx();
          if (child) return child;
        }
        throw err;
      }
    }

    if (cmd === 'openclaw' && process.platform === 'win32') {
      // On Windows, npm installs openclaw as a .cmd shim; spawn("openclaw") can fail
      // with ENOENT in non-shell mode. Prefer direct Node + entrypoint execution.
      // Include --stack-size to prevent AJV stack overflow during plugin loading.
      const pkgDir = getOpenClawPackageDirSync();
      const entryPath = pkgDir ? getOpenClawEntryPath(pkgDir) : null;
      if (entryPath) {
        return spawn(findNodeExecutable(), [`--stack-size=${NODE_STACK_SIZE_KB}`, entryPath, ...args], {
          ...spawnOptions,
        });
      }
    }

    if (cmd === 'openclaw') {
      const fallback = getOpenClawDirectSpawnSync();
      if (fallback) {
        return spawn(fallback.command, [...fallback.argsPrefix, ...args], {
          ...spawnOptions,
        });
      }
    }

    return spawn(cmd, args, {
      ...spawnOptions,
    });
  }

  /**
   * Run a binary with array args (no shell interpretation) with activity-based timeout.
   * This is the SAFE alternative to runAsync — use it whenever arguments contain
   * user-controlled data (agent names, messages, skill specs) to prevent shell injection.
   * On Windows, spawns the binary directly via CreateProcess (no cmd.exe).
   */
  function runSpawnAsync(cmd: string, args: string[], timeoutMs = 180000): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = runSpawn(cmd, args, { stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      let settled = false;

      let timer = setTimeout(() => {
        if (!settled) { settled = true; child.kill(); reject(new Error('Command timed out')); }
      }, timeoutMs);
      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (!settled) { settled = true; child.kill(); reject(new Error('Command timed out')); }
        }, timeoutMs);
      };

      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); resetTimer(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); resetTimer(); });
      child.on('close', (code: number | null) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (code === 0) resolve(stdout.trim());
          else reject(new Error(stderr.trim() || stdout.trim().slice(-500) || `Exit code ${code}`));
        }
      });
      child.on('error', (err: Error) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(err); }
      });
    });
  }

  /**
   * Run a shell command asynchronously with activity-based timeout.
   * The timer resets every time stdout/stderr produces output.
   * This handles OpenClaw's slow plugin loading (15-30s) gracefully —
   * as long as it keeps printing "[plugins] Registered xxx", it won't timeout.
   * Only if nothing happens for `timeoutMs` does it abort.
   *
   * WARNING: Do NOT use this for user-controlled input (agent names, messages, etc.)
   * Use runSpawnAsync instead to prevent shell injection.
   */
  function runAsync(cmd: string, timeoutMs = 180000): Promise<string> {
    return new Promise((resolve, reject) => {
      const enhancedPath = getEnhancedPath();
      const rewriteNpx = (command: string) => {
        if (!command.trim().startsWith('npx ')) return command;
        const npxCli = getBundledNpmBin('npx');
        if (!npxCli) return command;
        const rest = command.trim().slice(4);
        return `${process.execPath} "${npxCli}" ${rest}`;
      };
      buildOpenClawShellFallbackAsync().then((fallback) => {
        const rewrittenCommand = rewriteOpenClawShellCommand(cmd, fallback);
        const shellCmdRaw = process.platform === 'win32' ? wrapWindowsCommand(rewrittenCommand) : `export PATH="${enhancedPath}"; ${rewrittenCommand}`;
        const shellCmd = rewriteNpx(shellCmdRaw);
        const child = process.platform === 'win32'
          ? spawn(shellCmd, [], { shell: 'cmd.exe', windowsHide: true, env: buildShellEnv({ NO_COLOR: '1', FORCE_COLOR: '0' }, enhancedPath), stdio: 'pipe' })
          : spawn('/bin/bash', ['--norc', '--noprofile', '-c', shellCmd], { env: buildShellEnv({}, enhancedPath), stdio: 'pipe' });
        let stdout = '';
        let stderr = '';
        let settled = false;

        // Activity-based timeout: reset on every stdout/stderr output
        let timer = setTimeout(() => {
          if (!settled) { settled = true; child.kill(); reject(new Error('Command timed out')); }
        }, timeoutMs);
        const resetTimer = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (!settled) { settled = true; child.kill(); reject(new Error('Command timed out')); }
          }, timeoutMs);
        };

        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); resetTimer(); });
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); resetTimer(); });
        child.on('close', (code: number | null) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(stderr.trim() || stdout.trim().slice(-500) || `Exit code ${code}`));
          }
        });
        child.on('error', (err: Error) => {
          if (!settled) { settled = true; clearTimeout(timer); reject(err); }
        });
      }).catch(reject);
    });
  }

  /** Same as runAsync but with per-line progress callback. Activity-based timeout. */
  function runAsyncWithProgress(
    cmd: string,
    timeoutMs: number,
    onLine: (line: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const enhancedPath = getEnhancedPath();
      const rewriteNpx = (command: string) => {
        if (!command.trim().startsWith('npx ')) return command;
        const npxCli = getBundledNpmBin('npx');
        if (!npxCli) return command;
        const rest = command.trim().slice(4);
        return `${process.execPath} "${npxCli}" ${rest}`;
      };

      buildOpenClawShellFallbackAsync().then((fallback) => {
        const rewrittenCommand = rewriteOpenClawShellCommand(cmd, fallback);
        const shellCmdRaw = process.platform === 'win32' ? wrapWindowsCommand(rewrittenCommand) : `export PATH="${enhancedPath}"; ${rewrittenCommand}`;
        const shellCmd = rewriteNpx(shellCmdRaw);
        const child = process.platform === 'win32'
          ? spawn(shellCmd, [], { shell: 'cmd.exe', windowsHide: true, env: buildShellEnv({ NO_COLOR: '1', FORCE_COLOR: '0' }, enhancedPath), stdio: 'pipe' })
          : spawn('/bin/bash', ['--norc', '--noprofile', '-c', shellCmd], { env: buildShellEnv({}, enhancedPath), stdio: 'pipe' });
        let stdout = '';
        let stderr = '';
        let stdoutBuf = '';
        let stderrBuf = '';
        let settled = false;

        // Activity-based timeout: reset on every output
        let timer = setTimeout(() => {
          if (!settled) { settled = true; child.kill(); reject(new Error('Command timed out')); }
        }, timeoutMs);
        const resetTimer = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (!settled) { settled = true; child.kill(); reject(new Error('Command timed out')); }
          }, timeoutMs);
        };

        child.stdout?.on('data', (d: Buffer) => {
          const text = d.toString();
          stdout += text;
          stdoutBuf += text;
          resetTimer();
          const lines = stdoutBuf.split('\n');
          stdoutBuf = lines.pop() || '';
          for (const line of lines) {
            if (line.trim()) onLine(line, 'stdout');
          }
        });
        child.stderr?.on('data', (d: Buffer) => {
          const text = d.toString();
          stderr += text;
          stderrBuf += text;
          resetTimer();
          const lines = stderrBuf.split('\n');
          stderrBuf = lines.pop() || '';
          for (const line of lines) {
            if (line.trim()) onLine(line, 'stderr');
          }
        });
        child.on('close', (code: number | null) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(stderr.trim() || stdout.trim().slice(-500) || `Exit code ${code}`));
          }
        });
        child.on('error', (err: Error) => {
          if (!settled) { settled = true; clearTimeout(timer); reject(err); }
        });
      }).catch(reject);
    });
  }

  return {
    findNodeExecutable,
    getBundledNpmBin,
    getEnhancedPath,
    getGatewayPort,
    getNodeInvocationCommand,
    getNodeVersion,
    killAllTrackedShellChildren,
    readShellOutputAsync,
    resolveBundledCache,
    rewriteOpenClawShellCommand: (cmd: string) => {
      const fallback = buildOpenClawShellFallbackSync();
      return rewriteOpenClawShellCommand(cmd, fallback);
    },
    run,
    runAsync,
    runAsyncWithProgress,
    runSpawn,
    runSpawnAsync,
    safeShellExec,
    safeShellExecAsync,
    stripAnsi,
    wrapWindowsCommand,
  };
}
