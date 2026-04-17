import { spawn, execFileSync } from 'child_process';
import path from 'path';

const DAEMON_PORT = 37800;
const BASE_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 30 * 60_000;
const FAIL_THRESHOLD_FOR_BACKOFF = 3;

/**
 * Synchronously find PIDs bound to the given port.
 * Returns empty array if nothing found or the lookup is unavailable.
 *
 * Why: Pre-0.7.2 the watchdog would respawn `npx @awareness-sdk/local start`
 * whenever /healthz failed, without checking whether a prior daemon had left
 * the socket half-held. That produced the EADDRINUSE loop seen in daemon.log.
 * We now kill orphans before spawning a replacement.
 */
function findPidsOnPort(port: number): number[] {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('cmd.exe', ['/d', '/c', `netstat -ano -p TCP | findstr :${port}`], {
        encoding: 'utf-8',
        timeout: 3000,
      });
      const pids = new Set<number>();
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/\s(\d+)$/);
        if (m) {
          const pid = Number(m[1]);
          if (pid && pid !== process.pid) pids.add(pid);
        }
      }
      return Array.from(pids);
    }
    const out = execFileSync('/usr/sbin/lsof', ['-ti', `:${port}`], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    return out.split(/\s+/)
      .map((s) => Number(s.trim()))
      .filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid);
  } catch {
    return [];
  }
}

function killPids(pids: number[]) {
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'], { timeout: 3000 });
      } else {
        process.kill(pid, 'SIGKILL');
      }
      console.log(`[watchdog] killed orphan daemon PID ${pid} holding port ${DAEMON_PORT}`);
    } catch {
      // Process already gone or permission denied — best effort.
    }
  }
}

export function createDaemonWatchdog(options: {
  homedir: string;
  getEnhancedPath: () => string;
  getLocalDaemonHealth: (timeoutMs?: number) => Promise<any | null>;
}) {
  let watchdogTimeout: ReturnType<typeof setTimeout> | null = null;
  let daemonEverConnected = false;
  let consecutiveFailures = 0;
  // After this many consecutive failures, stop retrying to avoid an infinite
  // restart loop on Windows when the daemon/runtime is terminally broken.
  const MAX_CONSECUTIVE_FAILURES = 5;

  function scheduleNext(delay: number) {
    if (watchdogTimeout) return;
    watchdogTimeout = setTimeout(tick, delay);
  }

  async function tick() {
    watchdogTimeout = null;
    try {
      const health = await options.getLocalDaemonHealth(3000);
      if (health) {
        consecutiveFailures = 0;
        scheduleNext(BASE_INTERVAL_MS);
        return;
      }
      consecutiveFailures++;
      if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
        if (consecutiveFailures === MAX_CONSECUTIVE_FAILURES + 1) {
          console.warn(`[watchdog] Daemon failed ${MAX_CONSECUTIVE_FAILURES} consecutive times, suspending restart attempts. Will resume if daemon recovers.`);
        }
        scheduleNext(MAX_INTERVAL_MS);
        return;
      }

      console.log(`[watchdog] daemon not responding (fail ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}), attempting restart...`);

      // Kill any orphan holding the daemon port before respawn.
      const orphanPids = findPidsOnPort(DAEMON_PORT);
      if (orphanPids.length > 0) {
        console.log(`[watchdog] found ${orphanPids.length} orphan(s) on port ${DAEMON_PORT}: ${orphanPids.join(',')}`);
        killPids(orphanPids);
      }

      const projectDir = `"${path.join(options.homedir, '.openclaw')}"`;
      const startCmd = `npx -y @awareness-sdk/local start --port ${DAEMON_PORT} --project ${projectDir} --background`;
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/d', '/c', startCmd], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: {
            ...process.env,
            PATH: options.getEnhancedPath(),
            PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC',
            ComSpec: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
          },
        }).unref();
      } else {
        spawn('/bin/bash', ['--norc', '--noprofile', '-c', `export PATH="${options.getEnhancedPath()}"; ${startCmd}`], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch (err) {
      console.error('[watchdog] restart attempt threw:', err);
    }

    // Exponential backoff after repeated failures so a terminally broken
    // install (e.g. corrupt npx cache) doesn't flood logs or burn CPU.
    const backoffFactor = Math.max(1, consecutiveFailures - FAIL_THRESHOLD_FOR_BACKOFF + 1);
    const delay = Math.min(BASE_INTERVAL_MS * backoffFactor, MAX_INTERVAL_MS);
    scheduleNext(delay);
  }

  function startDaemonWatchdog() {
    if (watchdogTimeout) return;
    consecutiveFailures = 0;
    scheduleNext(BASE_INTERVAL_MS);
  }

  function stopDaemonWatchdog() {
    if (watchdogTimeout) {
      clearTimeout(watchdogTimeout);
      watchdogTimeout = null;
    }
  }

  function markConnected() {
    daemonEverConnected = true;
    consecutiveFailures = 0;
    startDaemonWatchdog();
  }

  function isRunning() {
    return !!watchdogTimeout;
  }

  function hasConnected() {
    return daemonEverConnected;
  }

  return {
    startDaemonWatchdog,
    stopDaemonWatchdog,
    markConnected,
    isRunning,
    hasConnected,
  };
}
