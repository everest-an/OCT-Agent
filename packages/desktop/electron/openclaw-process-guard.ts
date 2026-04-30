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
import os from 'os';

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
const CHANNELS_LIST_CACHE_TTL_MS = 10_000;
let channelsListCachedAt = 0;
let channelsListCachedOutput: string | null = null;

export function clearChannelsListCache() {
  channelsListCachedAt = 0;
  channelsListCachedOutput = null;
}

export function dedupedChannelsList(
  reader: (cmd: string, timeoutMs: number) => Promise<string | null>,
  timeoutMs = 20000,
): Promise<string | null> {
  const cacheFresh = channelsListCachedOutput !== null
    && (Date.now() - channelsListCachedAt) < CHANNELS_LIST_CACHE_TTL_MS;
  if (cacheFresh) return Promise.resolve(channelsListCachedOutput);

  return channelsListDedup(async () => {
    const output = await reader('openclaw channels list 2>&1', timeoutMs);
    if (output !== null) {
      channelsListCachedOutput = output;
      channelsListCachedAt = Date.now();
    }
    return output;
  });
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
 * Kill ORPHAN `openclaw channels login` processes — those NOT tracked by our
 * in-process `activeLogins` map. Called before spawning a new login worker to
 * clean up leftovers from a crashed/previous session, while preserving any
 * healthy bot workers we're managing in the current session.
 *
 * NEVER matches the gateway process (`openclaw/dist/index.js gateway`).
 */
export function killStaleChannelLogins(): Promise<void> {
  // Collect PIDs we're actively managing — these MUST survive.
  const safePids = new Set<number>();
  for (const record of activeLogins.values()) {
    if (record.wrapperPid > 0) safePids.add(record.wrapperPid);
  }

  if (process.platform === 'win32') {
    // Build a PowerShell filter that excludes our tracked PIDs.
    const excludeClause = safePids.size > 0
      ? ` -and @(${[...safePids].join(',')}) -notcontains $_.ProcessId`
      : '';
    return runKillCommand('powershell', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\" | " +
      `Where-Object { $_.CommandLine -like '*openclaw.mjs*channels login*'${excludeClause} } | ` +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    ]);
  }

  // Unix: list matching PIDs, filter out safe ones, then kill the rest.
  if (safePids.size === 0) {
    return runKillCommand('bash', ['-c',
      "pgrep -f 'openclaw\\.mjs.*channels login' | xargs -r kill -9 2>/dev/null",
    ]);
  }
  const grepExclude = [...safePids].map(p => `-e '^${p}$'`).join(' ');
  return runKillCommand('bash', ['-c',
    `pgrep -f 'openclaw\\.mjs.*channels login' | grep -v ${grepExclude} | xargs -r kill -9 2>/dev/null`,
  ]);
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
 * Check whether a specific channel id has a tracked (in-process) login worker.
 * Returns the wrapper PID if tracked, 0 otherwise.
 */
export function getTrackedLoginPid(channelId: string): number {
  return activeLogins.get(channelId)?.wrapperPid ?? 0;
}

/**
 * Kill any untracked `channels login` process for a specific channel id.
 * Used by auto-reconnect to replace orphan workers from previous sessions
 * with fresh tracked ones. Does NOT kill workers in our activeLogins map.
 */
export function killOrphanWorkerForChannel(openclawId: string): Promise<void> {
  const trackedPid = activeLogins.get(openclawId)?.wrapperPid ?? 0;

  if (process.platform === 'win32') {
    const excludeClause = trackedPid > 0 ? ` -and $_.ProcessId -ne ${trackedPid}` : '';
    return runKillCommand('powershell', [
      '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*channels login*' -and ` +
      `$_.CommandLine -like '*--channel ${openclawId}*'${excludeClause} } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    ]);
  }

  if (trackedPid > 0) {
    return runKillCommand('bash', ['-c',
      `pgrep -f 'channels login.*--channel ${openclawId}' | grep -v '^${trackedPid}$' | xargs -r kill -9 2>/dev/null`,
    ]);
  }
  return runKillCommand('bash', ['-c',
    `pgrep -f 'channels login.*--channel ${openclawId}' | xargs -r kill -9 2>/dev/null`,
  ]);
}

/**
 * Kill ALL stale `openclaw channels {list,login,add}` and `cron list` processes.
 * Called once at app startup to clean up orphans from a previous crashed/quit
 * session. Fire-and-forget — runs in the background while the app starts up
 * normally. NEVER matches the gateway or awareness daemon processes.
 *
 * Match strategy is intentionally narrow:
 *   - `openclaw.mjs channels {list,add,capabilities}` (short-lived read/write ops)
 *   - `openclaw.mjs cron`     (covers cron list/add)
 *   - DOES NOT match `openclaw.mjs channels login` — those are long-running bot
 *     workers that must stay alive across app restarts. Killing them silently
 *     breaks WeChat/WhatsApp/Signal message delivery with no visible error.
 *   - Gateway process (`openclaw/dist/index.js gateway`) does NOT match either
 *     pattern, so cleanup is safe to run at any time.
 */
export function killAllStaleChannelOps(): Promise<void> {
  if (process.platform === 'win32') {
    // Match channels list/add/capabilities but NOT channels login.
    // The -notlike guard ensures bot workers survive app restart.
    return runKillCommand('powershell', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\" | " +
      "Where-Object { ($_.CommandLine -like '*openclaw.mjs*channels*' -and " +
      "$_.CommandLine -notlike '*channels login*') -or " +
      "$_.CommandLine -like '*openclaw.mjs*cron*' } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    ]);
  }
  // Unix: kill channels list/add/capabilities but not channels login
  return runKillCommand('bash', ['-c',
    "pgrep -f 'openclaw\\.mjs.*channels (list|add|capabilities)' | xargs -r kill -9 2>/dev/null; " +
    "pgrep -f 'openclaw\\.mjs.*cron' | xargs -r kill -9 2>/dev/null",
  ]);
}

// ---------- detect existing channel login workers ----------
//
// At app startup we need to know which `channels login` bot workers are
// already running (e.g. left from the previous session or started by a
// scheduled task). These workers are long-lived and MUST be kept alive —
// they ARE the channel bot that receives and routes messages.

/**
 * Kill ALL orphan processes related to OCT that were not tracked by
 * the in-process child tracking (e.g. spawned by a previous crashed session,
 * or detached npx/daemon processes). Called from `app.on('before-quit')` as
 * a last-resort sweep after tracked children have already been killed.
 *
 * Targets: node.exe / npx.exe processes whose command line contains
 * `@awareness-sdk/local` or `openclaw.mjs`. NEVER matches the current
 * Electron main process itself (filtered by PID).
 */
export function killAllOrphanProcesses(currentPid: number): Promise<void> {
  if (process.platform === 'win32') {
    return runKillCommand('powershell', [
      '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { ` +
      `($_.Name -eq 'node.exe' -or $_.Name -eq 'npx.exe') -and ` +
      `($_.CommandLine -like '*@awareness-sdk/local*' -or $_.CommandLine -like '*openclaw.mjs*') -and ` +
      `$_.ProcessId -ne ${currentPid} } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    ]);
  }
  return runKillCommand('bash', ['-c',
    `ps -eo pid,args | grep -E '(@awareness-sdk/local|openclaw\\.mjs)' | grep -v grep | awk '{print $1}' | grep -v '^${currentPid}$' | xargs -r kill -9 2>/dev/null`,
  ]);
}

/**
 * Returns a Set of openclaw channel ids that have an active `channels login`
 * process (e.g. `openclaw.mjs channels login --channel openclaw-weixin`).
 * Cross-platform: uses `Get-CimInstance` on Windows, `ps aux` on Unix.
 */
export function detectRunningChannelLoginWorkers(): Promise<Set<string>> {
  return new Promise((resolve) => {
    const result = new Set<string>();
    let stdout = '';

    const parseChannelIds = (output: string) => {
      // Match `--channel <id>` from command lines
      const regex = /channels\s+login\s+--channel\s+(\S+)/g;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(output)) !== null) {
        result.add(m[1]);
      }
    };

    let child: ChildProcess;
    if (process.platform === 'win32') {
      child = spawn('powershell', [
        '-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\" | " +
        "Where-Object { $_.CommandLine -like '*channels login*' } | " +
        "Select-Object -ExpandProperty CommandLine",
      ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } else {
      child = spawn('bash', ['-c',
        "ps aux | grep 'channels login' | grep -v grep",
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
    }

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on('error', () => resolve(result));
    child.on('exit', () => {
      parseChannelIds(stdout);
      resolve(result);
    });
    // Safety timeout — never hang waiting for ps/powershell
    setTimeout(() => { try { child.kill(); } catch { /* */ } resolve(result); }, 8000);
  });
}
