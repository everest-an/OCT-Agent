import { useState, useCallback, useRef } from 'react';
import type { DaemonHealth } from '../components/memory/memory-helpers';

export interface DaemonConnectionState {
  daemonHealth: DaemonHealth | null;
  daemonStarting: boolean;
  daemonConnected: boolean;
}

export interface DaemonConnectionActions {
  checkHealth: () => Promise<boolean>;
  startDaemonAndReload: (silentFailure?: boolean) => Promise<boolean>;
  handleStartDaemon: () => Promise<void>;
}

export type UseDaemonConnectionReturn = DaemonConnectionState & DaemonConnectionActions;

/**
 * Manages daemon health checking, auto-start, and reconnection.
 * Extracted from Memory.tsx to reduce file size.
 */
export function useDaemonConnection(
  api: any,
  t: (key: string, fallback?: string) => string,
  onConnected: () => Promise<void>,
): UseDaemonConnectionReturn {
  const [daemonHealth, setDaemonHealth] = useState<DaemonHealth | null>(null);
  const [daemonStarting, setDaemonStarting] = useState(false);
  const [daemonConnected, setDaemonConnected] = useState(false);
  const daemonStartingRef = useRef(false);

  const checkHealth = useCallback(async () => {
    if (!api) return false;
    try {
      const health = await api.memoryCheckHealth();
      if (health?.status === 'ok') {
        setDaemonHealth(health);
        setDaemonConnected(true);
        if (window.electronAPI) (window.electronAPI as any).daemonMarkConnected?.();
        return true;
      }
      setDaemonConnected(false);
      return false;
    } catch {
      setDaemonConnected(false);
      return false;
    }
  }, [api]);

  const startDaemonAndReload = useCallback(async (silentFailure = false) => {
    if (!api || daemonStartingRef.current) return false;
    daemonStartingRef.current = true;
    setDaemonStarting(true);
    try {
      const result = await api.startDaemon();
      if (!result?.success) {
        return false;
      }

      setDaemonConnected(true);
      if (window.electronAPI) (window.electronAPI as any).daemonMarkConnected?.();
      await checkHealth();
      await onConnected();
      return true;
    } catch {
      return false;
    } finally {
      daemonStartingRef.current = false;
      setDaemonStarting(false);
    }
  }, [api, checkHealth, onConnected]);

  const handleStartDaemon = useCallback(async () => {
    await startDaemonAndReload(false);
  }, [startDaemonAndReload]);

  return {
    daemonHealth,
    daemonStarting,
    daemonConnected,
    checkHealth,
    startDaemonAndReload,
    handleStartDaemon,
  };
}
