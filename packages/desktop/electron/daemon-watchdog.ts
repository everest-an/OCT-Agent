import { spawn } from 'child_process';
import path from 'path';

export function createDaemonWatchdog(options: {
  homedir: string;
  getEnhancedPath: () => string;
  getLocalDaemonHealth: (timeoutMs?: number) => Promise<any | null>;
}) {
  let watchdogInterval: ReturnType<typeof setInterval> | null = null;
  let daemonEverConnected = false;

  function startDaemonWatchdog() {
    if (watchdogInterval) return;
    watchdogInterval = setInterval(async () => {
      const health = await options.getLocalDaemonHealth(3000);
      if (health) return;
      console.log('[watchdog] Daemon not responding, attempting restart...');
      try {
        const startCmd = `npx -y @awareness-sdk/local start --port 37800 --project ${path.join(options.homedir, '.openclaw')} --background`;
        if (process.platform === 'win32') {
          spawn('cmd.exe', ['/c', startCmd], { detached: true, stdio: 'ignore', env: { ...process.env, PATH: options.getEnhancedPath() } }).unref();
        } else {
          spawn('/bin/bash', ['--norc', '--noprofile', '-c', `export PATH="${options.getEnhancedPath()}"; ${startCmd}`], { detached: true, stdio: 'ignore' }).unref();
        }
      } catch (err) {
        console.error('[watchdog] Failed to restart daemon:', err);
      }
    }, 60_000);
  }

  function stopDaemonWatchdog() {
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
  }

  function markConnected() {
    daemonEverConnected = true;
    startDaemonWatchdog();
  }

  function isRunning() {
    return !!watchdogInterval;
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