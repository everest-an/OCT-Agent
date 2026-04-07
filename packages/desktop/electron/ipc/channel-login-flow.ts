import { shell } from 'electron';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerActiveLogin, unregisterActiveLogin } from '../openclaw-process-guard';

/**
 * Watch the OpenClaw plugin log file for a WeChat QR URL.
 * openclaw channels login --verbose has no stdout output due to Node.js block buffering
 * when stdout is a pipe. However, the openclaw-weixin plugin logger writes to a log file
 * synchronously (fs.appendFileSync), so we can detect the QR URL reliably via file watch.
 *
 * Returns a cleanup function to stop watching.
 */
function watchOpenClawLogForQrUrl(
  onQrFound: (url: string) => void,
  onLoginSuccess?: () => void,
): () => void {
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  // OpenClaw writes plugin logs to <tmp>/openclaw/openclaw-YYYY-MM-DD.log on all platforms.
  // macOS/Linux -> /tmp/openclaw ; Windows -> %TEMP%\openclaw. Node fs APIs do NOT honor
  // Git Bash's /tmp -> %TEMP% mapping, so on Windows we must resolve via os.tmpdir().
  const logDir = process.env.OPENCLAW_PREFERRED_TMP_DIR
    || (process.platform === 'win32' ? path.join(os.tmpdir(), 'openclaw') : '/tmp/openclaw');
  const logPath = path.join(logDir, `openclaw-${dateKey}.log`);
  try {
    console.log(`[wechat-watcher] watching ${logPath} exists=${fs.existsSync(logPath)}`);
  } catch { /* ignore */ }

  let offset = 0;
  let stopped = false;
  let qrFound = false;

  // Start from current end-of-file to only read new entries
  try {
    if (fs.existsSync(logPath)) {
      offset = fs.statSync(logPath).size;
    }
  } catch { /* ignore */ }

  const checkNewLines = () => {
    if (stopped) return;
    try {
      if (!fs.existsSync(logPath)) return;
      const stat = fs.statSync(logPath);
      if (stat.size <= offset) return;
      const buf = Buffer.alloc(stat.size - offset);
      const fd = fs.openSync(logPath, 'r');
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = stat.size;
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim() || stopped) continue;
        try {
          const entry = JSON.parse(line);
          const msg = String(entry['1'] || '');
          if (!qrFound) {
            const match = msg.match(/二维码链接:\s*(https?:\/\/\S+)/);
            if (match) {
              qrFound = true;
              onQrFound(match[1]);
              if (!onLoginSuccess) {
                stopped = true;
                return;
              }
              continue;
            }
          }
          // After QR is shown, watch for the WeChat login success marker.
          // openclaw-weixin logs "weixin monitor started (...)" once the bot session
          // is established post-scan. This is the cleanest single-line success signal.
          if (qrFound && onLoginSuccess && /weixin monitor started/i.test(msg)) {
            stopped = true;
            onLoginSuccess();
            return;
          }
        } catch { /* non-JSON line, skip */ }
      }
    } catch { /* ignore fs errors */ }
  };

  const interval = setInterval(checkNewLines, 500);
  return () => { stopped = true; clearInterval(interval); };
}

function isQrLine(line: string, stripAnsi: (value: string) => string): boolean {
  const clean = stripAnsi(line);
  if (clean.length < 4) return false;
  const blockCount = [...clean].filter((char) => '▄▀█░▒▓'.includes(char) || char === ' ').length;
  return blockCount / clean.length > 0.55;
}

export function createChannelLoginWithQR(deps: {
  runSpawn: (cmd: string, args: string[], opts?: Record<string, unknown>) => ChildProcess;
  stripAnsi: (value: string) => string;
  sendToRenderer: (channel: string, payload: unknown) => void;
}) {
  return function channelLoginWithQR(
    loginCmd: string,
    timeoutMs = 180000,
    extraEnv: Record<string, string> = {},
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    // Tokenise the legacy string-form command (`openclaw channels login --channel <id> --verbose`)
    // and route it through `runSpawn` so we get the same direct-`node.exe` + `--stack-size=8192`
    // path that the gateway uses on Windows. This bypasses three failure modes that the old
    // `cmd.exe`-shell + `rewriteOpenClawCommand` combo suffered from:
    //   1. `rewriteOpenClawCommand` silently no-ops if the sync `npm root -g` (5s timeout) is
    //      slow on Windows → command stays as bare `openclaw` → the .cmd shim runs node
    //      WITHOUT `--stack-size` → AJV in `openclaw-weixin` overflows V8's default ~984 KB
    //      stack → `RangeError` → exit -1 = 4294967295.
    //   2. Even when rewrite fires, sending the full string through cmd.exe + chcp wrappers
    //      fragments quoting and is harder to reason about for diagnostics.
    //   3. String-form command opens a shell-injection surface for any future caller that
    //      forgets to escape the channel id.
    // By tokenising once at the boundary and using runSpawn(argv) we get a single,
    // platform-uniform spawn with no shell, no rewrite, no race.
    const tokens = loginCmd.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || tokens[0] !== 'openclaw') {
      return Promise.resolve({ success: false, error: `Unexpected login command: ${loginCmd}` });
    }
    const args = tokens.slice(1);
    const send = (channel: string, data: unknown) => {
      deps.sendToRenderer(channel, data);
    };

    return new Promise((resolve) => {
      let settled = false;
      let stdout = '';
      let lineBuffer = '';
      let qrShown = false;
      let qrLines: string[] = [];
      let lineCount = 0;
      let qrFlushTimer: NodeJS.Timeout | null = null;

      let stopLogWatcher: (() => void) | null = null;

      // Disable colour everywhere so our QR / line parsing is not foiled by ANSI escapes.
      // PATH/PATHEXT/ComSpec are injected by runSpawn → buildShellEnv automatically.
      const child = deps.runSpawn('openclaw', args, {
        cwd: os.homedir(),
        stdio: 'pipe',
        env: {
          ...extraEnv,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
      });

      // Register this login under its channel id so:
      //   1. A subsequent login for the same channel can tree-kill us before spawning
      //      (prevents two bot workers competing for the same WeChat session — root
      //      cause of "connected but not replying").
      //   2. `channel:remove` IPC can find and tree-kill our process tree before
      //      deleting the channel config (otherwise the bot worker stays alive
      //      with a now-broken config).
      //   3. `app.on('before-quit')` can clean us up so users don't leave 800 MB
      //      orphans behind on app close.
      // Channel id is parsed from the login command argv (always shaped like
      // `openclaw channels login --channel <id> --verbose`).
      const channelMatch = loginCmd.match(/--channel\s+(\S+)/);
      const trackedChannelId = channelMatch ? channelMatch[1] : null;
      const trackedPid = child.pid || 0;
      if (trackedChannelId && trackedPid) {
        registerActiveLogin(trackedChannelId, child);
      }

      let idleTimer: NodeJS.Timeout | null = null;
      const clearIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };
      const resetIdleTimer = () => {
        clearIdleTimer();
        idleTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          stopLogWatcher?.();
          try { child.kill(); } catch {}
          if (qrFlushTimer) {
            clearTimeout(qrFlushTimer);
            qrFlushTimer = null;
          }
          if (qrShown) {
            resolve({ success: false, error: 'QR code expired. Click "Try again" to get a new QR code.' });
          } else {
            resolve({ success: false, error: 'Connection timed out while OpenClaw was still loading. Please retry in 20-60 seconds.' });
          }
        }, timeoutMs);
      };
      resetIdleTimer();

      // openclaw channels login produces no stdout when piped on all platforms (Node.js block
      // buffering on a non-TTY pipe). The openclaw-weixin plugin logger writes the QR URL to a
      // log file via fs.appendFileSync (synchronous, never buffered), so watching that file is
      // the reliable cross-platform path. Previously this was gated to non-Windows, which broke
      // WeChat login on Windows after the stdout fallback became unreliable.
      stopLogWatcher = watchOpenClawLogForQrUrl(
        (url) => {
          if (qrShown || settled) return;
          qrShown = true;
          resetIdleTimer(); // keep the idle timer alive while user scans
          send('channel:status', 'channels.status.generatingQR');
          shell.openExternal(url);
        },
        () => {
          // WeChat login succeeded post-scan. The openclaw CLI process stays alive
          // forever to maintain the bot session, so we never get child.on('exit').
          // Resolve the IPC promise here and detach the child so the wizard can close.
          if (settled) return;
          settled = true;
          clearIdleTimer();
          if (qrFlushTimer) {
            clearTimeout(qrFlushTimer);
            qrFlushTimer = null;
          }
          stopLogWatcher?.();
          // IMPORTANT: do NOT kill the child here. `openclaw channels login --channel
          // openclaw-weixin` is itself the worker that hosts the WeChat bot session
          // (it logs `[...-im-bot] starting weixin provider` / `weixin monitor started`).
          // Killing it tears down the bot and the channel goes silent on incoming messages.
          // We just resolve the IPC promise so the wizard can close; the child keeps running
          // in the background, owned by the Electron main process. The exit handler is a
          // no-op once settled.
          send('channel:status', 'channels.status.connected');
          resolve({ success: true, output: 'Connected!' });
        },
      );

      const processLine = (line: string) => {
        resetIdleTimer();
        lineCount++;
        stdout += line + '\n';

        if (!qrShown) {
          if (line.includes('[plugins]') && line.includes('Registered')) {
            const pluginMatch = line.match(/\[plugins\]\s+(\S+?):/);
            send('channel:status', pluginMatch ? `channels.status.loadingPlugin::${pluginMatch[1]}` : 'channels.status.loadingPlugins');
          } else if (line.includes('Waiting for') || line.includes('Scan this QR')) {
            send('channel:status', 'channels.status.generatingQR');
          } else if (line.includes('auto-start')) {
            send('channel:status', 'channels.status.startingMemory');
          } else if (line.includes('plugin registered') || line.includes('plugin initialized')) {
            send('channel:status', 'channels.status.almostReady');
          }
        }

        if (!qrShown) {
          const httpsUrls = line.match(/https?:\/\/\S+/g) || [];
          for (const url of httpsUrls) {
            if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('docs.openclaw') || url.includes('github.com')) continue;
            qrShown = true;
            shell.openExternal(url);
            return;
          }
        }

        if (!qrShown) {
          const signalLink = line.match(/sgnl:\/\/\S+/);
          if (signalLink) {
            qrShown = true;
            shell.openExternal(signalLink[0]);
            return;
          }
        }

        if (isQrLine(line, deps.stripAnsi)) {
          qrLines.push(line);
          if (qrFlushTimer) clearTimeout(qrFlushTimer);
          qrFlushTimer = setTimeout(() => {
            if (qrLines.length >= 5 && !qrShown) {
              qrShown = true;
              send('channel:qr-art', qrLines.join('\n'));
            }
          }, 300);
        } else {
          if (qrFlushTimer) {
            clearTimeout(qrFlushTimer);
            qrFlushTimer = null;
          }
          if (qrLines.length >= 5 && !qrShown) {
            qrShown = true;
            send('channel:qr-art', qrLines.join('\n'));
          }
          qrLines = [];
        }
      };

      child.stdout?.on('data', (data: Buffer) => {
        resetIdleTimer();
        const chunk = data.toString();
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      });

      child.stderr?.on('data', (data: Buffer) => {
        resetIdleTimer();
        const chunk = data.toString();
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      });

      child.on('exit', (code) => {
        if (lineBuffer) processLine(lineBuffer);
        stopLogWatcher?.();
        if (trackedChannelId && trackedPid) unregisterActiveLogin(trackedChannelId, trackedPid);
        if (settled) return;
        settled = true;
        clearIdleTimer();
        if (qrFlushTimer) {
          clearTimeout(qrFlushTimer);
          qrFlushTimer = null;
        }
        if (code === 0) {
          resolve({ success: true, output: 'Connected!' });
        } else if (qrShown) {
          resolve({ success: false, error: 'QR code expired. Click "Try again" to get a new QR code.' });
        } else {
          resolve({ success: false, error: stdout.slice(-300) || `Exit code ${code}` });
        }
      });

      child.on('error', (err) => {
        stopLogWatcher?.();
        if (trackedChannelId && trackedPid) unregisterActiveLogin(trackedChannelId, trackedPid);
        clearIdleTimer();
        if (qrFlushTimer) {
          clearTimeout(qrFlushTimer);
          qrFlushTimer = null;
        }
        if (settled) return;
        settled = true;
        resolve({ success: false, error: String(err).slice(0, 300) });
      });
    });
  };
}