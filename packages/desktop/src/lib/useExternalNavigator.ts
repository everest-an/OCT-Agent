import { useCallback, useRef, useState } from 'react';

const DEFAULT_OPENCLAW_DASHBOARD_URL = 'http://127.0.0.1:18789/';

export function useExternalNavigator() {
  const pendingKeysRef = useRef(new Set<string>());
  const [pendingKeys, setPendingKeys] = useState<Record<string, boolean>>({});

  const begin = useCallback((key: string) => {
    if (pendingKeysRef.current.has(key)) return false;
    pendingKeysRef.current.add(key);
    setPendingKeys((prev) => ({ ...prev, [key]: true }));
    return true;
  }, []);

  const end = useCallback((key: string) => {
    pendingKeysRef.current.delete(key);
    setPendingKeys((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const openExternal = useCallback(async (url: string, key = 'external') => {
    const api = window.electronAPI;
    if (!api?.openExternal || !url || !begin(key)) return false;
    try {
      await api.openExternal(url);
      return true;
    } finally {
      end(key);
    }
  }, [begin, end]);

  const openDashboard = useCallback(async (key = 'dashboard') => {
    const api = window.electronAPI;
    if (!api?.openExternal || !begin(key)) return false;
    try {
      const resolved = await api.getDashboardUrl?.();
      const url = resolved?.url || DEFAULT_OPENCLAW_DASHBOARD_URL;
      await api.openExternal(url);
      return true;
    } finally {
      end(key);
    }
  }, [begin, end]);

  const isOpening = useCallback((key: string) => !!pendingKeys[key], [pendingKeys]);

  return {
    isOpening,
    openDashboard,
    openExternal,
  };
}