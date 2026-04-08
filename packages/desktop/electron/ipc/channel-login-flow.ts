import { shell } from 'electron';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerActiveLogin, unregisterActiveLogin } from '../openclaw-process-guard';

/**
 * URL hosts/paths that look like QR URLs to a naive regex but are NOT user-facing
 * scan pages. Hitting these causes the wizard to open a 404 page instead of the
 * real QR landing page.
 *
 * - ilinkai.weixin.qq.com: Tencent's iLink Bot HTTP/JSON API base. Root path is
 *   404 by design. openclaw-weixin >= 2.1.x logs `Fetching QR code from: <api>`
 *   BEFORE it logs the real liteapp.weixin.qq.com QR landing page, so the naive
 *   "first https URL after a qr-hint line wins" strategy opened the wrong one.
 * - localhost / 127.0.0.1: local daemon URLs (Awareness memory dashboard etc.)
 * - docs.openclaw / github.com: documentation links that often appear in plugin
 *   startup logs.
 * - weixin.qq.com/cgi-bin/: legacy WeChat API paths, never user-facing.
 */
const NON_QR_URL_PATTERNS: ReadonlyArray<string | RegExp> = [
  'ilinkai.weixin.qq.com',
  'localhost',
  '127.0.0.1',
  'docs.openclaw',
  'github.com',
  /weixin\.qq\.com\/cgi-bin\//i,
];

/**
 * Hostnames/paths that ARE the real QR scan landing page for a known channel.
 * When multiple URLs appear in close succession we prefer one of these over the
 * generic "first url wins" fallback.
 *
 * - liteapp.weixin.qq.com/q/: openclaw-weixin >= 2.1.x. Logged as
 *   `二维码链接: https://liteapp.weixin.qq.com/q/<code>?qrcode=...&bot_type=3`.
 * - login.weixin.qq.com / open.weixin.qq.com/connect: defensive coverage for
 *   older plugin versions in case Tencent rotates back.
 */
const QR_LANDING_HOSTS: ReadonlyArray<string> = [
  'liteapp.weixin.qq.com/q/',
  'login.weixin.qq.com',
  'open.weixin.qq.com/connect',
];

/** Lines like "Fetching QR code from: <api>" — we MUST NOT treat as a QR URL. */
const QR_FETCH_NOISE = /fetching\s+qr|requesting\s+qr|qr\s+code\s+received/i;

/** Lines that explicitly mean "here is the QR url, open it in a browser". */
const QR_DISPLAY_HINT = /(二维码链接|请用浏览器打开|scan\s+(this|the)[^\n]{0,40}qr|open[^\n]{0,40}qr[^\n]{0,40}browser)/i;

/** Loose fallback hint, kept for non-WeChat channels whose logs we have not catalogued. */
const QR_LOOSE_HINT = /二维码|qrcode|qr\s*code|scan/i;

export function isNonQrUrl(url: string): boolean {
  return NON_QR_URL_PATTERNS.some((p) => (typeof p === 'string' ? url.includes(p) : p.test(url)));
}

export function isQrLandingUrl(url: string): boolean {
  return QR_LANDING_HOSTS.some((host) => url.includes(host));
}

/**
 * Pick the best QR URL out of a sequence of (line, urls) candidates seen so far.
 * Returns null if nothing acceptable yet. Used by both the log watcher and stdout
 * paths so the WeChat fix and the WhatsApp/Signal/etc. fallback share one rule.
 *
 * Rules:
 *  1. Drop any URL that matches NON_QR_URL_PATTERNS.
 *  2. If any candidate matches QR_LANDING_HOSTS, return that (Tencent's real
 *     liteapp.weixin.qq.com page).
 *  3. Otherwise return the first surviving candidate from a line that matches
 *     QR_DISPLAY_HINT (a strong signal it is the URL the user is meant to open).
 *  4. Otherwise return null and let the caller wait or fall back to QR_LOOSE_HINT.
 */
export function pickQrUrl(
  candidates: ReadonlyArray<{ line: string; url: string }>,
): string | null {
  const surviving = candidates.filter((c) => !isNonQrUrl(c.url));
  if (surviving.length === 0) return null;
  const landing = surviving.find((c) => isQrLandingUrl(c.url));
  if (landing) return landing.url;
  const fromDisplay = surviving.find((c) => QR_DISPLAY_HINT.test(c.line));
  if (fromDisplay) return fromDisplay.url;
  return null;
}

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
  onFatalError?: (message: string) => void,
  onQrArt?: (asciiArt: string) => void,
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
  // ASCII QR collector — openclaw-weixin (and WhatsApp / Signal) print a multi-row block-character
  // QR via the OpenClaw logger, which writes JSON entries with embedded \n to the log file. After
  // our buf.split('\n') splits them, each visual QR row arrives as its own "line" that JSON.parse
  // fails on, so we treat the raw msg as the QR row directly. Collect contiguous QR rows and flush
  // via onQrArt as soon as the streak ends (or after a 400 ms quiet window).
  let qrArtRows: string[] = [];
  let qrArtFlushTimer: NodeJS.Timeout | null = null;
  let qrArtSent = false;
  const QR_ART_QUIET_MS = 400;
  const QR_ART_MIN_ROWS = 8;
  const flushQrArt = () => {
    if (qrArtFlushTimer) {
      clearTimeout(qrArtFlushTimer);
      qrArtFlushTimer = null;
    }
    if (qrArtSent || qrArtRows.length < QR_ART_MIN_ROWS) {
      qrArtRows = [];
      return;
    }
    qrArtSent = true;
    const art = qrArtRows.join('\n');
    qrArtRows = [];
    try { console.log(`[wechat-watcher] flushing QR art (${art.split('\n').length} rows, ${art.length} chars)`); } catch { /* ignore */ }
    if (onQrArt) onQrArt(art);
  };
  const isAsciiQrRow = (s: string): boolean => {
    if (!s || s.length < 8) return false;
    let block = 0;
    for (const ch of s) if ('▄▀█░▒▓ '.includes(ch)) block++;
    return block / s.length > 0.55;
  };
  // Buffer URL candidates briefly so a strong "liteapp.weixin.qq.com" match can win
  // over an early "ilinkai.weixin.qq.com" API URL that appears on the same flush.
  const qrCandidates: Array<{ line: string; url: string }> = [];
  let settleTimer: NodeJS.Timeout | null = null;
  const SETTLE_MS = 600;
  const flushBestQrCandidate = () => {
    if (qrFound || stopped) return;
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    const best = pickQrUrl(qrCandidates);
    if (best) {
      qrFound = true;
      try { console.log('[wechat-watcher] selected QR url:', best); } catch { /* ignore */ }
      onQrFound(best);
      if (!onLoginSuccess) stopped = true;
      return;
    }
    // No strong match yet — fall back to the first non-blacklisted URL we have seen
    // so non-WeChat channels (and any future plugin formats) still produce *some* URL.
    const fallback = qrCandidates.find((c) => !isNonQrUrl(c.url));
    if (fallback) {
      qrFound = true;
      try { console.log('[wechat-watcher] fallback QR url:', fallback.url); } catch { /* ignore */ }
      onQrFound(fallback.url);
      if (!onLoginSuccess) stopped = true;
    }
  };

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
        let msg = line;
        try {
          const entry = JSON.parse(line);
          msg = String(entry['1'] || line);
        } catch {
          msg = line;
        }

        // ASCII QR collection: every contiguous block-character row goes into qrArtRows;
        // when a non-QR row arrives we wait QR_ART_QUIET_MS then flush. Done once per session.
        if (!qrArtSent) {
          if (isAsciiQrRow(msg)) {
            qrArtRows.push(msg);
            if (qrArtFlushTimer) clearTimeout(qrArtFlushTimer);
            qrArtFlushTimer = setTimeout(flushQrArt, QR_ART_QUIET_MS);
          } else if (qrArtRows.length >= QR_ART_MIN_ROWS) {
            flushQrArt();
          } else if (qrArtRows.length > 0) {
            // Stray block-char line was noise — discard.
            qrArtRows = [];
            if (qrArtFlushTimer) {
              clearTimeout(qrArtFlushTimer);
              qrArtFlushTimer = null;
            }
          }
        }

        if (onFatalError) {
          const isWeChatPluginStackOverflow = /openclaw-weixin failed to load/i.test(msg)
            && /(maximum call stack size exceeded|rangeerror)/i.test(msg);
          if (isWeChatPluginStackOverflow) {
            stopped = true;
            onFatalError('WeChat plugin failed to load due to stack overflow. Retrying usually fixes it.');
            return;
          }
        }

        if (!qrFound) {
          // Skip "Fetching QR code from: <api>" style noise — that URL is the iLink
          // backend (ilinkai.weixin.qq.com), not the user-facing scan page.
          if (!QR_FETCH_NOISE.test(msg)) {
            const hasHint = QR_DISPLAY_HINT.test(msg) || QR_LOOSE_HINT.test(msg);
            if (hasHint) {
              const urls = msg.match(/https?:\/\/[^\s"',}\]]+/gi) || [];
              for (const rawUrl of urls) {
                if (isNonQrUrl(rawUrl)) continue;
                qrCandidates.push({ line: msg, url: rawUrl });
              }
              // Strong hit: a known landing host arrived → flush immediately, no need to wait.
              if (qrCandidates.some((c) => isQrLandingUrl(c.url))) {
                flushBestQrCandidate();
              } else if (qrCandidates.length > 0 && !settleTimer) {
                // Weak hit: wait briefly in case a stronger candidate (liteapp QR landing) is on its way.
                settleTimer = setTimeout(flushBestQrCandidate, SETTLE_MS);
              }
            }
            if (qrFound) {
              if (!onLoginSuccess) return;
              continue;
            }
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
      }
    } catch { /* ignore fs errors */ }
  };

  const interval = setInterval(checkNewLines, 500);
  return () => {
    stopped = true;
    clearInterval(interval);
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    if (qrArtFlushTimer) {
      clearTimeout(qrArtFlushTimer);
      qrArtFlushTimer = null;
    }
  };
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
    // Idle timeout (NOT total) — only fires after this many ms of stdout/stderr/log silence.
    // Bumped from 180s → 300s in 2026-04 to ride out OpenClaw v2026.4.5+ regression #62051
    // (every spawned worker re-loads ALL plugins, sometimes >3 minutes on machines with
    // many plugins like feishu_doc/chat/wiki/drive/perm + weixin + awareness-memory).
    // Plugin-loading lines reset the idle timer so this doesn't deadline pure plugin churn,
    // but the higher cap prevents premature failures during long compat checks (weixin's
    // Tencent ilinkai handshake stage in particular).
    timeoutMs = 300000,
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
      // PATH/PATHEXT/ComSpec are injected by runSpawn -> buildShellEnv automatically.
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
          // For WeChat (liteapp.weixin.qq.com), the URL is a mobile WeChat webview shell that
          // does NOT render a scannable QR in a desktop browser — opening it just shows a blank
          // weui page. The ASCII QR (delivered separately via onQrArt) is the real scan target.
          // We still mark qrShown=true so the idle timer treats this as "QR ready" and we still
          // notify the renderer of the URL for an optional copy-link button, but we DO NOT call
          // shell.openExternal anymore.
          qrShown = true;
          resetIdleTimer(); // keep the idle timer alive while user scans
          send('channel:status', 'channels.status.generatingQR');
          send('channel:qr-url', url);
          try { console.log('[wechat-watcher] QR url ready (not opened in browser):', url); } catch { /* ignore */ }
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
        (message) => {
          if (settled) return;
          settled = true;
          clearIdleTimer();
          if (qrFlushTimer) {
            clearTimeout(qrFlushTimer);
            qrFlushTimer = null;
          }
          stopLogWatcher?.();
          try { child.kill(); } catch {}
          resolve({ success: false, error: message });
        },
        (asciiArt) => {
          // Real WeChat QR delivered as ASCII block-character art via the OpenClaw logger.
          // Push it to the wizard, which already has a renderer for `channel:qr-art` (used by
          // WhatsApp). This is the ONLY scannable artifact for desktop users — the mobile
          // webview liteapp URL is not scannable in a desktop browser.
          if (settled) return;
          if (!qrShown) {
            qrShown = true;
            resetIdleTimer();
            send('channel:status', 'channels.status.generatingQR');
          }
          send('channel:qr-art', asciiArt);
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
          const httpsUrls = line.match(/https?:\/\/[^\s"',}\]]+/g) || [];
          for (const url of httpsUrls) {
            if (isNonQrUrl(url)) continue;
            qrShown = true;
            try { console.log('[channel-login-flow] stdout opened url:', url); } catch { /* ignore */ }
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
        const unsignedCode = typeof code === 'number' && code < 0 ? (0x100000000 + code) : code;
        const fullOutput = stdout.trim();
        // Diagnostic output kept on the result.output field for debugging only — never
        // surfaced as the user-facing `error` message. The wizard previously appended
        // stdout's last 300 chars to the error string, which on plugin-load failures
        // produced a giant unreadable wall of "[plugins] feishu_chat: Registered ...".
        // Now `error` is always a clean human sentence.
        const diagnostic = fullOutput ? fullOutput.slice(-12000) : undefined;
        if (code === 0) {
          resolve({ success: true, output: 'Connected!' });
        } else if (code === -1073741571 || unsignedCode === 3221225725) {
          resolve({
            success: false,
            error: 'OpenClaw crashed while loading plugins. Please retry — this is usually transient (OpenClaw upstream issue #62051).',
            output: diagnostic,
          });
        } else if (qrShown) {
          resolve({
            success: false,
            error: 'QR code expired before scan completed. Click "Re-link" to generate a new QR code.',
            output: diagnostic,
          });
        } else {
          // Try to extract the LAST meaningful error line from stdout (an "Error:" /
          // "ERROR" line, or the very last non-plugin-noise line). Fall back to a
          // generic friendly hint, NEVER raw stdout.
          const lines = fullOutput.split('\n').map((l) => l.trim()).filter(Boolean);
          const noisy = /^\[plugins\]|Registered .* tool|setWeixinRuntime|compat.*check/i;
          const meaningful = [...lines].reverse().find((l) => /error|fail|cannot|missing/i.test(l) && !noisy.test(l));
          const cleanError = meaningful?.slice(0, 240)
            || `OpenClaw exited with code ${code}. Plugin loading may still be in progress — please wait 30s and try again.`;
          resolve({
            success: false,
            error: cleanError,
            output: diagnostic,
          });
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