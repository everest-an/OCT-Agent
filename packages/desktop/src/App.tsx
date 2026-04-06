import { useState, useEffect } from 'react';
import SetupWizard from './pages/Setup';
import Dashboard from './pages/Dashboard';
import Memory from './pages/Memory';
import Channels from './pages/Channels';
import Models from './pages/Models';
import Skills from './pages/Skills';
import Automation from './pages/Automation';
import Agents from './pages/Agents';
import TaskCenter from './pages/TaskCenter';
import Settings from './pages/Settings';
import Sidebar, { type Page } from './components/Sidebar';
import UpdateBanner from './components/UpdateBanner';
import { useAppConfig } from './lib/store';

const SETUP_COMPLETED_AT_KEY = 'awareness-claw-setup-completed-at';
const POST_SETUP_RUNTIME_GRACE_MS = 3 * 60 * 1000;
const POST_SETUP_DAEMON_RECHECK_ATTEMPTS = 3;
const POST_SETUP_DAEMON_RECHECK_DELAY_MS = 15000;
// Max time to wait for startup checks before showing app anyway.
// OpenClaw loads 10+ plugins per CLI invocation (~15-30s each).
// Background gateway repair (startGatewayRepairInBackground) handles the rest.
const STARTUP_CHECK_TIMEOUT_MS = 20_000;


/** Apply theme to document root */
function useThemeEffect(theme: 'dark' | 'light' | 'system') {
  useEffect(() => {
    const root = document.documentElement;
    const applyTheme = (isDark: boolean) => {
      root.classList.toggle('dark', isDark);
      root.classList.toggle('light', !isDark);
      root.style.colorScheme = isDark ? 'dark' : 'light';
    };

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      applyTheme(mq.matches);
      const handler = (e: MediaQueryListEvent) => applyTheme(e.matches);
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    } else {
      applyTheme(theme === 'dark');
    }
  }, [theme]);
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return target.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
}

function isZoomInKey(event: KeyboardEvent): boolean {
  const key = event.key;
  const withModifier = event.ctrlKey || event.metaKey;
  if (withModifier) {
    return key === '+' || key === '=' || key === 'Add' || key === 'NumpadAdd';
  }
  return key === '+' || key === 'NumpadAdd';
}

function isZoomOutKey(event: KeyboardEvent): boolean {
  const key = event.key;
  const withModifier = event.ctrlKey || event.metaKey;
  if (withModifier) {
    return key === '-' || key === '_' || key === 'Subtract' || key === 'NumpadSubtract';
  }
  return key === '-' || key === 'NumpadSubtract';
}

export default function App() {
  const { config } = useAppConfig();
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const [runtimeReady, setRuntimeReady] = useState<boolean | null>(null);
  const [currentPage, setCurrentPage] = useState<Page>('chat');
  // Channel to focus in Dashboard after "Open Chat" from Channels page
  const [pendingChannelId, setPendingChannelId] = useState<string | null>(null);

  // Apply theme switching
  useThemeEffect(config.theme || 'dark');

  useEffect(() => {
    const done = localStorage.getItem('awareness-claw-setup-done');
    setSetupComplete(done === 'true');
  }, []);

  useEffect(() => {
    const onKeyDown = async (event: KeyboardEvent) => {
      if (!window.electronAPI) return;
      if (isEditableElement(event.target)) return;

      if (isZoomInKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        await window.electronAPI.appZoomIn?.();
        return;
      }

      if (isZoomOutKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        await window.electronAPI.appZoomOut?.();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key === '0') {
        event.preventDefault();
        event.stopPropagation();
        await window.electronAPI.appZoomReset?.();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (setupComplete !== true) {
      setRuntimeReady(setupComplete === false ? true : null);
      return;
    }

    // Existing users: show app immediately, run checks in background.
    // New users (setupComplete === false) go directly to SetupWizard above.
    setRuntimeReady(true);

    let cancelled = false;

    const recentSetupCompletedAt = Number(localStorage.getItem(SETUP_COMPLETED_AT_KEY) || '0');
    const recentlyCompletedSetup = recentSetupCompletedAt > 0
      && Date.now() - recentSetupCompletedAt < POST_SETUP_RUNTIME_GRACE_MS;

    const runBackgroundChecks = async () => {
      if (!window.electronAPI?.startupEnsureRuntime) {
        localStorage.removeItem(SETUP_COMPLETED_AT_KEY);
        return;
      }

      try {
        type StartupResult = { ok: boolean; needsSetup?: boolean; blockingId?: string; blockingMessage?: string; fixed: string[]; warnings: string[] };
        const timeoutResult: StartupResult = { ok: true, fixed: [], warnings: [] };
        let result = await Promise.race([
          window.electronAPI.startupEnsureRuntime() as Promise<StartupResult>,
          new Promise<StartupResult>((resolve) =>
            setTimeout(() => resolve(timeoutResult), STARTUP_CHECK_TIMEOUT_MS)
          ),
        ]);
        if (cancelled) return;

        // Post-setup daemon recheck: daemon may still be warming up after first install
        if (!result.ok && result.blockingId === 'daemon-running' && recentlyCompletedSetup) {
          for (let attempt = 0; attempt < POST_SETUP_DAEMON_RECHECK_ATTEMPTS; attempt += 1) {
            if (cancelled) return;
            await new Promise((resolve) => setTimeout(resolve, POST_SETUP_DAEMON_RECHECK_DELAY_MS));
            if (cancelled) return;
            result = await window.electronAPI.startupEnsureRuntime();
            if (cancelled) return;
            if (result.ok || result.blockingId !== 'daemon-running') break;
          }
        }

        if (!result.ok && result.needsSetup) {
          const setupBlockingIds = new Set(['node-installed', 'openclaw-installed', 'plugin-installed']);
          const isSetupBlocking = !result.blockingId || setupBlockingIds.has(result.blockingId);
          if (!isSetupBlocking) {
            localStorage.removeItem(SETUP_COMPLETED_AT_KEY);
            return;
          }

          // Guard 1: install tasks just completed in the wizard
          // (Windows PATH not yet refreshed, AV scanning, etc.)
          const installTasksDone = localStorage.getItem('awareness-claw-install-tasks-done') === 'true';
          if (installTasksDone) {
            localStorage.removeItem('awareness-claw-install-tasks-done');
            localStorage.removeItem(SETUP_COMPLETED_AT_KEY);
            return;
          }

          // Guard 2: user already has providers / API keys — transient check failure
          // should NOT redirect them back to the wizard; Doctor handles repairs.
          try {
            const existingCfg = await window.electronAPI?.readExistingConfig?.();
            if (existingCfg?.hasProviders || existingCfg?.hasApiKey) {
              localStorage.removeItem(SETUP_COMPLETED_AT_KEY);
              return;
            }
          } catch {
            localStorage.removeItem(SETUP_COMPLETED_AT_KEY);
            return;
          }

          // Truly needs setup — redirect to wizard (rare: e.g. OS reinstall, no config)
          if (!cancelled) {
            localStorage.setItem('awareness-claw-setup-done', 'false');
            setSetupComplete(false);
          }
          return;
        }

        if (!result.ok && result.blockingId === 'daemon-running' && recentlyCompletedSetup) {
          console.warn('[startup] Local daemon still warming after post-setup rechecks:', result.blockingMessage || 'daemon-running');
        }
      } catch (err) {
        console.warn('[startup] Background runtime check failed:', err);
      }

      if (!cancelled) {
        localStorage.removeItem(SETUP_COMPLETED_AT_KEY);
      }
    };

    runBackgroundChecks();
    return () => { cancelled = true; };
  }, [setupComplete]);

  const handleSetupComplete = () => {
    localStorage.setItem(SETUP_COMPLETED_AT_KEY, String(Date.now()));
    localStorage.setItem('awareness-claw-setup-done', 'true');
    setSetupComplete(true);
  };

  // Render nothing while localStorage is being read (one frame, imperceptible)
  if (setupComplete === null || runtimeReady === null) return null;

  if (!setupComplete) {
    return <SetupWizard onComplete={handleSetupComplete} />;
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* macOS title bar drag region */}
      <div className="titlebar-drag fixed top-0 left-0 right-0 h-8 z-50" />

      {/* Update banner (weak reminder — top tooltip bar) */}
      <UpdateBanner />

      <div className="flex flex-1 overflow-hidden pt-8">
        <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} />

        <main className="flex-1 overflow-hidden relative">
          {/* Dashboard is always mounted so in-flight chats survive tab switches */}
          <div className={`absolute inset-0 overflow-y-auto ${currentPage === 'chat' ? '' : 'hidden'}`}>
            <Dashboard isActive={currentPage === 'chat'} onNavigate={setCurrentPage}
              pendingChannelId={pendingChannelId} onChannelOpened={() => setPendingChannelId(null)} />
          </div>
          {currentPage === 'memory' && <div className="h-full overflow-y-auto"><Memory /></div>}
          {currentPage === 'channels' && <div className="h-full overflow-y-auto"><Channels onNavigate={setCurrentPage}
            onOpenChannelChat={(channelId) => { setPendingChannelId(channelId); setCurrentPage('chat'); }} /></div>}
          {currentPage === 'models' && <div className="h-full overflow-y-auto"><Models /></div>}
          {currentPage === 'skills' && <div className="h-full overflow-y-auto"><Skills /></div>}
          {currentPage === 'automation' && <div className="h-full overflow-y-auto"><Automation /></div>}
          {currentPage === 'agents' && <div className="h-full overflow-y-auto"><Agents onNavigate={setCurrentPage} /></div>}
          {currentPage === 'taskCenter' && <div className="h-full overflow-y-auto"><TaskCenter onNavigate={setCurrentPage} /></div>}
          {currentPage === 'settings' && <div className="h-full overflow-y-auto"><Settings /></div>}
        </main>
      </div>
    </div>
  );
}
