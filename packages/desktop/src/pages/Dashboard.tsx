import { useState, useEffect, useRef } from 'react';
import { ExternalLink, RefreshCw, AlertCircle, Loader2, Maximize2, Minimize2 } from 'lucide-react';

declare global {
  interface Window {
    Terminal?: any;
    FitAddon?: any;
    WebLinksAddon?: any;
  }
}

type GatewayStatus = 'checking' | 'online' | 'offline';

export default function Dashboard() {
  const [status, setStatus] = useState<GatewayStatus>('checking');
  const [termReady, setTermReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const termContainerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);

  useEffect(() => {
    checkGateway();
  }, []);

  useEffect(() => {
    if (status !== 'offline') return;
    const interval = setInterval(checkGateway, 10000);
    return () => clearInterval(interval);
  }, [status]);

  // Initialize terminal when gateway comes online
  useEffect(() => {
    if (status !== 'online' || termReady) return;

    const initTerminal = async () => {
      // Dynamic import xterm (works in both dev and packaged)
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');
      const { WebLinksAddon } = await import('@xterm/addon-web-links');

      // Import CSS
      await import('@xterm/xterm/css/xterm.css');

      if (!termContainerRef.current) return;

      const fitAddon = new FitAddon();
      const term = new Terminal({
        theme: {
          background: '#0f172a',
          foreground: '#e2e8f0',
          cursor: '#60a5fa',
          cursorAccent: '#0f172a',
          selectionBackground: '#334155',
          black: '#1e293b',
          red: '#f87171',
          green: '#4ade80',
          yellow: '#facc15',
          blue: '#60a5fa',
          magenta: '#c084fc',
          cyan: '#22d3ee',
          white: '#e2e8f0',
          brightBlack: '#475569',
          brightRed: '#fca5a5',
          brightGreen: '#86efac',
          brightYellow: '#fde047',
          brightBlue: '#93c5fd',
          brightMagenta: '#d8b4fe',
          brightCyan: '#67e8f9',
          brightWhite: '#f8fafc',
        },
        fontSize: 14,
        fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
        lineHeight: 1.4,
        cursorBlink: true,
        scrollback: 5000,
        allowProposedApi: true,
      });

      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      term.open(termContainerRef.current);
      fitAddon.fit();

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      // Connect terminal to PTY via IPC
      if (window.electronAPI) {
        // Start openclaw chat in PTY
        const ptyId = await (window.electronAPI as any).startPty();

        // PTY output → terminal
        (window.electronAPI as any).onPtyData((data: string) => {
          term.write(data);
        });

        // Terminal input → PTY
        term.onData((data: string) => {
          (window.electronAPI as any).writePty(data);
        });

        // Terminal resize → PTY
        term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
          (window.electronAPI as any).resizePty(cols, rows);
        });
      } else {
        // Dev mode without Electron — show demo text
        term.writeln('\x1b[1;36m╔═══════════════════════════════════════╗\x1b[0m');
        term.writeln('\x1b[1;36m║  🧠 AwarenessClaw Chat Terminal      ║\x1b[0m');
        term.writeln('\x1b[1;36m╚═══════════════════════════════════════╝\x1b[0m');
        term.writeln('');
        term.writeln('\x1b[33mDev mode: PTY not available. Run in Electron to chat.\x1b[0m');
      }

      setTermReady(true);

      // Handle window resize
      const observer = new ResizeObserver(() => {
        fitAddon.fit();
      });
      observer.observe(termContainerRef.current);

      return () => observer.disconnect();
    };

    initTerminal();
  }, [status, termReady]);

  const checkGateway = async () => {
    if (window.electronAPI) {
      try {
        const { url } = await (window.electronAPI as any).getDashboardUrl();
        setStatus(url ? 'online' : 'offline');
        return;
      } catch {}
    }
    try {
      await fetch('http://localhost:18789', { mode: 'no-cors', signal: AbortSignal.timeout(3000) });
      setStatus('online');
    } catch {
      setStatus('offline');
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-3 border-b border-slate-800 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">💬 聊天</h1>
          <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs ${
            status === 'online' ? 'bg-emerald-600/20 text-emerald-400' :
            status === 'offline' ? 'bg-red-600/20 text-red-400' :
            'bg-slate-700 text-slate-400'
          }`}>
            <div className={`w-1.5 h-1.5 rounded-full ${
              status === 'online' ? 'bg-emerald-400' :
              status === 'offline' ? 'bg-red-400' :
              'bg-slate-500 animate-pulse'
            }`} />
            {status === 'online' ? 'Gateway 运行中' :
             status === 'offline' ? 'Gateway 未运行' : '连接中...'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => window.electronAPI?.openExternal('http://localhost:18789')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 bg-slate-800 rounded-lg transition-colors"
          >
            <ExternalLink size={12} />
            Dashboard
          </button>
        </div>
      </div>

      {/* Terminal */}
      <div className="flex-1 relative">
        {status === 'online' && (
          <div
            ref={termContainerRef}
            className="w-full h-full p-2"
            style={{ backgroundColor: '#0f172a' }}
          />
        )}

        {status === 'offline' && (
          <div className="flex flex-col items-center justify-center h-full text-slate-400 space-y-6 p-8">
            <AlertCircle size={48} strokeWidth={1} className="text-slate-600" />
            <div className="text-center max-w-md">
              <h2 className="text-lg font-medium text-slate-300 mb-2">OpenClaw Gateway 未运行</h2>
              <p className="text-sm mb-4">请先启动 OpenClaw：</p>
              <code className="block px-4 py-3 bg-slate-800 rounded-xl text-sm text-brand-400 font-mono mb-4">
                openclaw up
              </code>
            </div>
            <button
              onClick={checkGateway}
              className="flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-500 text-white rounded-xl text-sm transition-colors"
            >
              <RefreshCw size={14} /> 重新检测
            </button>
          </div>
        )}

        {status === 'checking' && (
          <div className="flex flex-col items-center justify-center h-full text-slate-400 space-y-4">
            <Loader2 size={32} className="animate-spin text-brand-500" />
            <p className="text-sm">正在连接...</p>
          </div>
        )}
      </div>
    </div>
  );
}
