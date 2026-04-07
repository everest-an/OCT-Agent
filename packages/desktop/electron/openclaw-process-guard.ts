/**
 * OpenClaw Process Guard
 *
 * Centralized process management for `openclaw channels {list,login,add}` and other
 * heavyweight OpenClaw CLI invocations.
 *
 * # Background
 *
 * OpenClaw CLI re-loads ALL plugins (~15-30 s, ~800 MB RAM each) on every invocation.
 * Without coordination, the desktop ends up spawning 6+ concurrent `channels list`
 * and 3+ concurrent `channels login` processes that pile up to 5-11 GB of RAM and
 * tank performance — every command runs 5-10x slower because processes compete for
 * CPU and disk IO.
 *
 * Worse, OpenClaw children are NOT killed when the Electron parent exits. Every app
 * restart leaves orphans behind, and they accumulate over time. Real measurement:
 * after one day of dev/test cycles a user's machine had 27 OpenClaw zombies totaling
 * ~11 GB RAM, making every new connection attempt take 2+ minutes.
 *
 * # API
 *
 *  1. dedupedChannelsList()       — single in-flight `channels list` shared across all callers
 *  2. dedupedChannelsAddHelp()    — single in-flight `channels add --help` (read-only, cacheable)
 *  3. dedupedCronList()           — single in-flight `cron list`
 *  4. acquireChannelLoginLock()   — JS-level mutex around `channels login`
 *  5. killStaleChannelLogins()    — kill leftover login processes (fire-and-forget safe)
 *  6. killAllStaleChannelOps()    — startup-time orphan cleanup (fire-and-forget safe)
 *
 * # CLAUDE.md compliance
 *
 * - Cross-platform: all kill helpers branch on process.platform (Windows powershell,
 *   Unix pkill). Never assumes platform-specific tooling exists.
 * - Non-blocking: kill helpers spawn the killer in the background and return immediately
 *   when called via the fire-and-forget pattern. They never block the main IPC path.
 * - Never kills the gateway: kill scopes are tightened to ONLY match `*openclaw.mjs*channels*`
 *   or `*openclaw.mjs*cron*`, NOT `*openclaw*` (which would also match the gateway entry
 *   point `openclaw/dist/index.js gateway --port 18789` and the awareness daemon).
 * - No new failure modes: every helper catches its own errors and resolves silently;
 *   the worst case is that a kill is skipped, never that the caller crashes.
 */

import { spawn, type ChildProcess } from 'child_process';

// ---------- generic dedup primitive ----------

function makeDedup<T>() {
  let inflight: Promise<T> | null = null;
  return (fn: () => Promise<T>): Promise<T> => {
    if (inflight) return inflight;
    inflight = fn().finally(() => { inflight = null; });
    return inflight;
  };
}

// ---------- channels list dedup ----------

const channelsListDedup = makeDedup<string | null>();

export function dedupedChannelsList(
  reader: (cmd: string, timeoutMs: number) => Promise<string | null>,
  timeoutMs = 20000,
): Promise<string | null> {
  return channelsListDedup(() => reader('openclaw channels list 2>&1', timeoutMs));
}

// ---------- channels add --help dedup ----------
//
// `register-channel-config-handlers.ts` calls `openclaw channels add --help` from
// dynamic CLI args parsing on every channel:save. The output is constant for a
// given OpenClaw version, so we can dedup AND cache it for the process lifetime.

let channelsAddHelpCached: string | null = null;
const channelsAddHelpDedup = makeDedup<string | null>();

export function dedupedChannelsAddHelp(
  reader: (cmd: string, timeoutMs: number) => Promise<string | null>,
  timeoutMs = 5000,
  stderrRedirect = '2>&1',
): Promise<string | null> {
  if (channelsAddHelpCached !== null) return Promise.resolve(channelsAddHelpCached);
  return channelsAddHelpDedup(async () => {
    const out = await reader(`openclaw channels add --help ${stderrRedirect}`, timeoutMs);
    if (out) channelsAddHelpCached = out;
    return out;
  });
}

// ---------- cron list dedup ----------

const cronListDedup = makeDedup<string | null>();

export function dedupedCronList(
  reader: (cmd: string, timeoutMs: number) => Promise<string | null>,
  cmd = 'openclaw cron list 2>&1',
  timeoutMs = 20000,
): Promise<string | null> {
  return cronListDedup(() => reader(cmd, timeoutMs));
}

// ---------- channels login mutex (JS-level, no powershell on hot path) ----------
//
// Plain JS Promise-based mutex with two safety nets:
//
//  1. Idempotent release — calling release() multiple times is a no-op after the
//     first call. This lets callers safely use try/finally + early-return without
//     fearing double-release.
//
//  2. Auto-release timeout — every acquired lock is automatically released after
//     LOGIN_LOCK_MAX_HOLD_MS even if the holder forgets / crashes / throws an
//     uncaught exception. Without this, ONE missed release() deadlocks the entire
//     mutex chain forever, freezing every subsequent connect attempt without
//     spawning anything (the symptom: front-end spinner spins, zero node.exe
//     children, no error).
//
// The previous powershell-based version added 3-5 s of latency on every login,
// even when there was nothing to kill — that made WeChat appear "stuck loading".
// This version is purely in-process and zero-cost on the happy path.

const LOGIN_LOCK_MAX_HOLD_MS = 5 * 60 * 1000; // 5 min hard ceiling — login + plugins + retry should never exceed this

let channelLoginLockChain: Promise<void> = Promise.resolve();

export async function acquireChannelLoginLock(): Promise<() => void> {
  let release!: () => void;
  let released = false;
  const next = new Promise<void>((resolve) => {
    release = () => {
      if (released) return;
      released = true;
      resolve();
    };
  });

  // Hard ceiling: auto-release after 5 min so a crashed/throwing holder cannot
  // permanently freeze the mutex chain. This is the failsafe against the
  // "0 node.exe but front-end spinning" deadlock.
  const autoReleaseTimer = setTimeout(() => {
    if (!released) {
      console.warn('[openclaw-process-guard] login lock auto-released after 5 min — caller likely threw without releasing');
      release();
    }
  }, LOGIN_LOCK_MAX_HOLD_MS);
  // Don't keep the event loop alive just for this watchdog.
  if (typeof autoReleaseTimer.unref === 'function') autoReleaseTimer.unref();

  const wait = channelLoginLockChain;
  channelLoginLockChain = channelLoginLockChain.then(() => next).catch(() => undefined);
  await wait.catch(() => undefined);

  // Wrap release so callers see one stable function — it both clears the timer
  // and resolves the gate. Safe to call multiple times.
  return () => {
    clearTimeout(autoReleaseTimer);
    release();
  };
}

// ---------- process killers (fire-and-forget safe) ----------

function runKillCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, detached: false });
      child.on('exit', finish);
      child.on('error', finish);
      // Hard timeout — never let a stuck powershell/pkill block the caller forever.
      setTimeout(() => { try { child.kill(); } catch { /* best-effort */ } finish(); }, 8000);
    } catch {
      finish();
    }
  });
}

/**
 * Kill any running `openclaw channels login` processes. Safe to call as
 * fire-and-forget (returns a Promise but caller may ignore it). NEVER matches
 * the gateway process (which runs `openclaw/dist/index.js gateway`), only the
 * `openclaw.mjs channels login` wrapper and its node grandchildren.
 */
export function killStaleChannelLogins(): Promise<void> {
  if (process.platform === 'win32') {
    return runKillCommand('powershell', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*openclaw.mjs*channels login*' } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    ]);
  }
  return runKillCommand('pkill', ['-f', 'openclaw.*channels login']);
}

// ---------- precise PID tracking for active channel logins ----------
//
// Why this exists: the diagnosis showed that even with our login mutex, two
// `channels login --channel openclaw-weixin` worker processes were running
// simultaneously. The reason is that `commandline`-based killing is too coarse
// (race conditions during the kill window) and the mutex was global, not per-
// channel-id. This API tracks each spawned login by channel-id and the wrapper
// PID returned by spawn(). When the user clicks Connect again, we precisely
// kill the prior tree (tree-kill, NOT just the wrapper) before spawning a new
// one. When the user clicks Remove, we kill the bot worker so it doesn't keep
// running with a now-deleted config.
//
// Cross-platform tree-kill:
//   Windows: `taskkill /T /F /PID <pid>` — /T = include children, /F = force
//   Unix:    SIGTERM then SIGKILL after 1 s grace; relies on bash propagating
//            SIGTERM to its child openclaw.mjs process, which is the default
//            behavior unless the child traps signals.

interface ActiveLoginRecord {
  channelId: string;
  wrapperPid: number;
  child: ChildProcess;
  startedAt: number;
}

const activeLogins = new Map<string, ActiveLoginRecord>();

/**
 * Tree-kill a process by PID. Cross-platform. Always resolves (never rejects)
 * so callers can safely fire-and-forget.
 */
export function treeKillPid(pid: number): Promise<void> {
  if (!pid || pid <= 0) return Promise.resolve();
  if (process.platform === 'win32') {
    return runKillCommand('taskkill', ['/T', '/F', '/PID', String(pid)]);
  }
  return new Promise<void>((resolve) => {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
      resolve();
    }, 1000);
  });
}

/**
 * Register an active login child process under a channel id. If a previous
 * login for the same channel is still tracked, its tree is killed first
 * (fire-and-forget) so we never end up with two bot workers competing for the
 * same WeChat session.
 */
export function registerActiveLogin(channelId: string, child: ChildProcess): void {
  if (!channelId || !child || !child.pid) return;
  const prior = activeLogins.get(channelId);
  if (prior && prior.wrapperPid !== child.pid) {
    void treeKillPid(prior.wrapperPid).catch(() => { /* best-effort */ });
  }
  activeLogins.set(channelId, {
    channelId,
    wrapperPid: child.pid,
    child,
    startedAt: Date.now(),
  });
}

/**
 * Unregister a login record. Called from the child's exit/error handler. The
 * pid argument guards against the unlikely case where a new login took over
 * the slot before the old one's exit handler fired (we only delete if the slot
 * is still ours).
 */
export function unregisterActiveLogin(channelId: string, pid: number): void {
  const cur = activeLogins.get(channelId);
  if (!cur) return;
  if (cur.wrapperPid !== pid) return;
  activeLogins.delete(channelId);
}

/**
 * Kill the active login process tree for a given channel and remove the
 * tracking record. Called from `channel:remove` IPC handler BEFORE running
 * `openclaw channels remove`, so the bot worker dies before its config goes
 * away (otherwise it stays alive in a half-broken state).
 */
export async function killActiveLoginForChannel(channelId: string): Promise<void> {
  const cur = activeLogins.get(channelId);
  if (!cur) return;
  activeLogins.delete(channelId);
  await treeKillPid(cur.wrapperPid).catch(() => { /* best-effort */ });
}

/**
 * Kill ALL active login process trees. Called from `app.on('before-quit')` so
 * users don't leave 800 MB orphans behind on app close. Fire-and-forget safe.
 */
export async function killAllActiveLogins(): Promise<void> {
  const all = [...activeLogins.values()];
  activeLogins.clear();
  await Promise.all(all.map((r) => treeKillPid(r.wrapperPid).catch(() => { /* best-effort */ })));
}

/**
 * Diagnostic: how many login workers are currently being tracked. Useful for
 * IPC `app:get-status` style health endpoints.
 */
export function getActiveLoginCount(): number {
  return activeLogins.size;
}

/**
 * Kill ALL stale `openclaw channels {list,login,add}` and `cron list` processes.
 * Called once at app startup to clean up orphans from a previous crashed/quit
 * session. Fire-and-forget — runs in the background while the app starts up
 * normally. NEVER matches the gateway or awareness daemon processes.
 *
 * Match strategy is intentionally narrow:
 *   - `openclaw.mjs channels` (covers list/login/add wrappers)
 *   - `openclaw.mjs cron`     (covers cron list/add)
 *   - The Node grandchild children of those wrappers ALSO match because OpenClaw
 *     spawns them with the same openclaw.mjs argv.
 *   - Gateway process (`openclaw/dist/index.js gateway`) does NOT match either
 *     pattern, so cleanup is safe to run at any time.
 */
export function killAllStaleChannelOps(): Promise<void> {
  if (process.platform === 'win32') {
    return runKillCommand('powershell', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*openclaw.mjs*channels*' -or " +
      "$_.CommandLine -like '*openclaw.mjs*cron*' } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    ]);
  }
  return runKillCommand('pkill', ['-f', 'openclaw\\.mjs (channels|cron)']);
}
