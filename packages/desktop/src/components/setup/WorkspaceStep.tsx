import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, FolderOpen, Folder, SkipForward } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

interface RecentWorkspace {
  path: string;
  lastUsed?: string;
}

interface WorkspaceStepProps {
  onNext: (selectedPath: string) => void;
  onBack: () => void;
  onSkip: () => void;
}

export default function WorkspaceStep({ onNext, onBack, onSkip }: WorkspaceStepProps) {
  const { t } = useI18n();
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Load current active workspace as default selection
    const api = window.electronAPI;
    if (api?.workspaceGetActive) {
      api.workspaceGetActive().then((result) => {
        if (result?.path) setSelectedPath(result.path);
      }).catch(() => {});
    }
  }, []);

  const handleChoose = async () => {
    const api = window.electronAPI;
    if (!api?.selectDirectory) return;
    setLoading(true);
    try {
      const result = await api.selectDirectory();
      if (result?.directoryPath) setSelectedPath(result.directoryPath);
    } catch { /* cancelled */ } finally {
      setLoading(false);
    }
  };

  const handleUseFolder = async () => {
    const path = selectedPath || '~';
    const api = window.electronAPI;
    if (api?.workspaceSetActive) {
      try { await api.workspaceSetActive(path); } catch { /* best-effort */ }
    }
    onNext(path);
  };

  const handleSkip = () => {
    // Default to home directory
    onSkip();
  };

  const displayPath = selectedPath || '~';

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold mb-2">
          {t('setup.workspace.title', 'Choose your default project folder')}
        </h2>
        <p className="text-slate-400 text-sm">
          {t('setup.workspace.subtitle', 'OCT scans this folder to build your memory, wiki, and code index.')}
        </p>
      </div>

      {/* Current selection */}
      <div className="p-4 bg-slate-800/60 border border-slate-700 rounded-xl space-y-3">
        <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">
          {t('setup.workspace.current', 'Current selection:')}
        </p>
        <div className="flex items-center gap-3">
          <FolderOpen size={18} className="text-amber-400 flex-shrink-0" />
          <span className="flex-1 text-sm font-mono text-slate-200 truncate">{displayPath}</span>
          <button
            onClick={handleChoose}
            disabled={loading}
            className="flex-shrink-0 px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition-colors"
          >
            {loading ? '...' : t('setup.workspace.change', 'Change…')}
          </button>
        </div>
        <div className="space-y-1 text-xs text-emerald-400/80">
          <p>✓ {t('setup.workspace.privacy', '100% local · nothing uploaded yet')}</p>
          <p>✓ {t('setup.workspace.first_scan', 'Large folders: first scan runs in background')}</p>
        </div>
      </div>

      {/* Recently opened */}
      {recentWorkspaces.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
            {t('setup.workspace.recently', 'Recently opened:')}
          </p>
          <div className="space-y-1">
            {recentWorkspaces.map((ws) => (
              <button
                key={ws.path}
                onClick={() => setSelectedPath(ws.path)}
                className={`w-full flex items-center gap-3 p-3 rounded-lg text-left transition-colors ${
                  selectedPath === ws.path
                    ? 'bg-brand-600/10 border border-brand-600/30'
                    : 'bg-slate-800/40 hover:bg-slate-800 border border-transparent'
                }`}
              >
                <Folder size={14} className="text-slate-500 flex-shrink-0" />
                <span className="flex-1 text-sm font-mono text-slate-300 truncate">{ws.path}</span>
                {ws.lastUsed && (
                  <span className="text-xs text-slate-500">
                    {t('setup.workspace.last_used', 'last used {time}').replace('{time}', ws.lastUsed)}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="flex justify-between items-center">
        <button
          onClick={onBack}
          className="px-4 py-2 text-slate-400 hover:text-slate-200 flex items-center gap-1"
        >
          <ChevronLeft size={16} />
          {t('setup.back', 'Back')}
        </button>

        <div className="flex flex-col items-end gap-2">
          <button
            onClick={handleUseFolder}
            className="px-6 py-2.5 bg-brand-600 hover:bg-brand-500 text-white rounded-xl font-medium transition-colors flex items-center gap-2"
          >
            {t('setup.workspace.confirm', 'Use this folder')}
            <ChevronRight size={16} />
          </button>
          <button
            onClick={handleSkip}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            <SkipForward size={12} />
            {t('setup.workspace.skip', "Skip — I'll pick later in the workspace picker")}
          </button>
        </div>
      </div>
    </div>
  );
}
