import { useState, useEffect, useCallback } from 'react';
import { Bot, Plus, Trash2, Link, Loader2, RefreshCw, Edit3, Check, X, AlertCircle, FileText, ChevronDown, ChevronUp, Save, ShoppingBag } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { useAppConfig } from '../lib/store';
import AgentWizard from '../components/AgentWizard';
import AgentAvatar from '../components/AgentAvatar';
import AgentEmojiPicker from '../components/AgentEmojiPicker';
import AgentMarketplace from './AgentMarketplace';

interface AgentInfo {
  id: string;
  name?: string;
  emoji?: string;
  model?: string;
  bindings?: string[];
  isDefault?: boolean;
  workspace?: string;
  routes?: string[];
}

const WORKSPACE_FILE_META: Record<string, string> = {
  'SOUL.md': 'agents.file.soul.desc',
  'TOOLS.md': 'agents.file.tools.desc',
  'IDENTITY.md': 'agents.file.identity.desc',
  'USER.md': 'agents.file.user.desc',
  'MEMORY.md': 'agents.file.memory.desc',
  'AGENTS.md': 'agents.file.agents.desc',
  'HEARTBEAT.md': 'agents.file.heartbeat.desc',
};

import type { Page } from '../components/Sidebar';

export default function Agents({ onNavigate }: { onNavigate?: (page: Page) => void } = {}) {
  const { t } = useI18n();
  const { updateConfig } = useAppConfig();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Wizard state
  const [showWizard, setShowWizard] = useState(false);

  // F-063 Marketplace overlay
  const [showMarketplace, setShowMarketplace] = useState(false);

  // Identity editing
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmoji, setEditEmoji] = useState('');
  const [editAvatar, setEditAvatar] = useState('');
  const [editTheme, setEditTheme] = useState('');

  // Binding
  // Channel routing is no longer managed here — it lives in the Channels page via
  // a per-channel "Replied by" dropdown. An agent card just shows WHICH channels
  // currently route to it (read-only), see agent.bindings display below.

  // Workspace file editing
  const [fileEditAgentId, setFileEditAgentId] = useState<string | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [fileOriginal, setFileOriginal] = useState('');
  const [fileListLoading, setFileListLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);
  const [fileSaved, setFileSaved] = useState(false);

  const loadAgents = async () => {
    setLoading(true);
    setError(null);
    if (!window.electronAPI) {
      setAgents([{ id: 'main', name: 'Claw', emoji: '🦞', isDefault: true, bindings: [] }]);
      setLoading(false);
      return;
    }
    try {
      const result = await (window.electronAPI as any).agentsList();
      if (result.success) {
        setAgents(result.agents || []);
      } else {
        setError(result.error || t('agents.loadFailed', 'Failed to load agents'));
      }
    } catch { setError(t('agents.connectFailed', 'Failed to connect')); }
    setLoading(false);
  };

  useEffect(() => { loadAgents(); }, []);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const handleDelete = async (agentId: string) => {
    if (!window.electronAPI || agentId === 'main') return;
    if (!confirm(t('agents.deleteConfirm', 'Delete this agent? This will remove its workspace and all data.'))) return;
    setDeletingId(agentId);
    setError(null);
    try {
      const result = await (window.electronAPI as any).agentsDelete(agentId);
      if (result.success) loadAgents();
      else setError(result.error || t('agents.deleteFailed', 'Delete failed'));
    } finally {
      setDeletingId(null);
    }
  };

  const handleSetIdentity = async (agentId: string) => {
    if (!window.electronAPI) return;
    const result = await (window.electronAPI as any).agentsSetIdentity(agentId, editName, editEmoji, editAvatar, editTheme);
    if (result.success) {
      setEditingId(null);
      loadAgents();
    } else {
      setError(result.error || t('agents.identityFailed', 'Set identity failed'));
    }
  };

  // handleBind / handleUnbind removed 2026-04-08 — channel-to-agent routing is now
  // managed exclusively on the Channels page via the per-channel "Replied by" dropdown.
  // This keeps the Agents page focused on identity/workspace/prompts editing only.
  // Any display of current routing on an agent card is read-only and derived from the
  // same agents:list bindings[] that the Channels page dropdown writes to.

  // Workspace file editing
  const loadFile = useCallback(async (agentId: string, fileName: string) => {
    if (!window.electronAPI) return;
    setFileLoading(true);
    setFileSaved(false);
    try {
      if (!(window.electronAPI as any).agentsReadFile) {
        throw new Error(t('agents.fileReadUnavailable', 'This desktop build does not expose agent file reading yet. Please restart with the latest package.'));
      }
      const result = await (window.electronAPI as any).agentsReadFile(agentId, fileName);
      if (result.success) {
        setFileContent(result.content || '');
        setFileOriginal(result.content || '');
      } else {
        throw new Error(result.error || t('agents.loadFileFailed', 'Failed to load {0}').replace('{0}', fileName));
      }
    } catch (err: any) {
      setFileContent('');
      setFileOriginal('');
      setError(err?.message || t('agents.loadFileFailed', 'Failed to load {0}').replace('{0}', fileName));
    }
    setFileLoading(false);
  }, [t]);

  const loadWorkspaceFiles = useCallback(async (agentId: string) => {
    if (!window.electronAPI) return;
    setFileListLoading(true);
    try {
      if (!(window.electronAPI as any).agentsListFiles) {
        throw new Error(t('agents.fileListUnavailable', 'This desktop build does not expose dynamic agent workspace files yet. Please restart with the latest package.'));
      }
      const result = await (window.electronAPI as any).agentsListFiles(agentId);
      if (!result?.success) {
        throw new Error(result?.error || t('agents.filesLoadFailed', 'Failed to load workspace files'));
      }
      const files = Array.isArray(result?.files) ? result.files : [];
      setWorkspaceFiles(files);
      if (files.length === 0) {
        setActiveFile('');
        setFileContent('');
        setFileOriginal('');
        return;
      }
      const nextFile = files.includes(activeFile) ? activeFile : files[0];
      setActiveFile(nextFile);
      await loadFile(agentId, nextFile);
    } catch (err: any) {
      setWorkspaceFiles([]);
      setActiveFile('');
      setFileContent('');
      setFileOriginal('');
      setError(err?.message || t('agents.filesLoadFailed', 'Failed to load workspace files'));
    } finally {
      setFileListLoading(false);
    }
  }, [activeFile, loadFile, t]);

  const handleOpenFiles = (agentId: string) => {
    if (fileEditAgentId === agentId) {
      setFileEditAgentId(null);
      setWorkspaceFiles([]);
      setActiveFile('');
      return;
    }
    setFileEditAgentId(agentId);
    void loadWorkspaceFiles(agentId);
  };

  const handleSaveFile = async () => {
    if (!window.electronAPI || !fileEditAgentId) return;
    setFileSaving(true);
    try {
      const result = await (window.electronAPI as any).agentsWriteFile(fileEditAgentId, activeFile, fileContent);
      if (result.success) {
        setFileOriginal(fileContent);
        setFileSaved(true);
        setTimeout(() => setFileSaved(false), 2000);
      } else {
        setError(result.error || t('agents.saveFailed', 'Save failed'));
      }
    } catch {
      setError(t('agents.fileSaveFailed', 'Failed to save file'));
    }
    setFileSaving(false);
  };

  const fileDirty = fileContent !== fileOriginal;

  // F-063: If marketplace overlay is open, render it full-bleed.
  if (showMarketplace) {
    return (
      <AgentMarketplace
        onClose={() => setShowMarketplace(false)}
        onInstalled={() => { loadAgents(); }}
      />
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-800">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h1 className="text-lg font-semibold">🤖 {t('agents.title')}</h1>
            <p className="text-xs text-slate-500">{t('agents.subtitle')}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowMarketplace(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-violet-600 hover:bg-violet-500 text-white rounded-lg transition-colors"
              title={t('agents.marketplace.title', 'Browse Agent Marketplace')}>
              <ShoppingBag size={12} />
              {t('agents.marketplace.entry', '浏览集市')}
            </button>
            <button onClick={() => setShowWizard(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors">
              <Plus size={12} />
              {t('agents.createAgent')}
            </button>
            <button onClick={loadAgents} disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 bg-slate-800 rounded-lg">
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-600/10 border border-red-600/20 rounded-xl text-xs text-red-400">
            <AlertCircle size={14} />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} title={t('common.close', 'Close')} aria-label={t('common.close', 'Close')} className="ml-auto"><X size={12} /></button>
          </div>
        )}

        {/* Agent Creation Wizard */}
        {showWizard && (
          <AgentWizard
            onComplete={(agentId) => {
              setShowWizard(false);
              loadAgents();
              // If agentId returned, auto-switch to the new agent and navigate to chat
              // so the Bootstrap Q&A ritual starts immediately
              if (agentId && onNavigate) {
                updateConfig({ selectedAgentId: agentId });
                // Delay navigation to let config change propagate to Dashboard first
                setTimeout(() => onNavigate('chat'), 200);
              }
            }}
            onCancel={() => setShowWizard(false)}
          />
        )}

        {/* Agent List */}
        {loading ? (
          <div className="flex items-center justify-center py-12"><Loader2 size={24} className="animate-spin text-brand-500" /></div>
        ) : agents.length === 0 ? (
          <div className="text-center py-12 text-slate-500 text-sm">{t('agents.empty')}</div>
        ) : (
          <div className="space-y-3">
            {agents.map((agent) => (
              <div key={agent.id} className="bg-slate-800/50 border border-slate-700/50 rounded-xl overflow-hidden">
                {/* Agent header */}
                <div className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <AgentAvatar name={agent.name || agent.id} emoji={agent.emoji} size={28} fallback="logo" className="text-2xl" />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{agent.name || agent.id}</span>
                          {agent.isDefault && <span className="px-1.5 py-0.5 text-[10px] bg-brand-600/20 text-brand-400 rounded">{t('agents.default', 'Default')}</span>}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {t('agents.idLabel', 'ID')}: {agent.id}{agent.model && <span className="ml-2">{t('agents.modelLabel', 'Model')}: {agent.model}</span>}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => handleOpenFiles(agent.id)}
                        className={`p-1.5 rounded transition-colors ${fileEditAgentId === agent.id ? 'text-brand-400 bg-brand-600/10' : 'text-slate-500 hover:text-slate-300'}`}
                        title={t('agents.editDefinition')}>
                        <FileText size={14} />
                      </button>
                      <button onClick={() => { setEditingId(agent.id); setEditName(agent.name || ''); setEditEmoji(agent.emoji || ''); setEditAvatar(''); setEditTheme(''); }}
                        className="p-1.5 text-slate-500 hover:text-slate-300 rounded" title={t('agents.editIdentity', 'Edit identity')}><Edit3 size={14} /></button>
                      {/* "Add binding" button removed 2026-04-08 — channel routing is now
                          managed on the Channels page via per-channel "Replied by" dropdown. */}
                      {!agent.isDefault && (
                        <button
                          onClick={() => handleDelete(agent.id)}
                          disabled={deletingId === agent.id}
                          title={t('common.delete', 'Delete')}
                          className="p-1.5 text-slate-500 hover:text-red-400 rounded disabled:opacity-50"
                        >
                          {deletingId === agent.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Bindings (read-only): which channels currently route to this agent.
                      Managed exclusively on the Channels page; this is just a status pill. */}
                  {agent.bindings && agent.bindings.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pl-11">
                      {agent.bindings.map((b, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] bg-emerald-600/15 text-emerald-400 rounded-full"
                          title={t('agents.bindingReadOnlyHint', 'Manage channel routing on the Channels page')}
                        >
                          <Link size={9} />{b}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Inline identity edit */}
                  {editingId === agent.id && (
                    <div className="space-y-2 pl-11 pt-2 border-t border-slate-700/30">
                      <AgentEmojiPicker
                        value={editEmoji}
                        onChange={setEditEmoji}
                        size="sm"
                      />
                      <div className="flex items-center gap-2">
                        <input value={editEmoji} onChange={(e) => setEditEmoji(e.target.value)} placeholder={t('agents.emojiOptional', 'Optional')}
                          className="w-10 px-1 py-1 bg-slate-900 border border-slate-600 rounded text-center text-sm" maxLength={4} />
                        <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder={t('agents.namePlaceholder', 'Name')}
                          className="flex-1 px-2 py-1 bg-slate-900 border border-slate-600 rounded text-sm" />
                        <button onClick={() => handleSetIdentity(agent.id)} title={t('common.save', 'Save')} aria-label={t('common.save', 'Save')} className="p-1 text-emerald-400 hover:text-emerald-300"><Check size={14} /></button>
                        <button onClick={() => setEditingId(null)} title={t('common.cancel', 'Cancel')} aria-label={t('common.cancel', 'Cancel')} className="p-1 text-slate-500 hover:text-slate-300"><X size={14} /></button>
                      </div>
                      <div className="flex items-center gap-2">
                        <input value={editAvatar} onChange={(e) => setEditAvatar(e.target.value)}
                          placeholder={t('agents.avatarPlaceholder', 'Avatar URL (optional)')}
                          className="flex-1 px-2 py-1 bg-slate-900 border border-slate-600 rounded text-xs text-slate-400" />
                        <select value={editTheme} onChange={(e) => setEditTheme(e.target.value)} aria-label={t('agents.theme', 'Theme')}
                          className="px-2 py-1 bg-slate-900 border border-slate-600 rounded text-xs text-slate-400">
                          <option value="">{t('agents.theme', 'Theme')}</option>
                          <option value="dark">{t('agents.themeDark', 'Dark')}</option>
                          <option value="light">{t('agents.themeLight', 'Light')}</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {/* Inline bind UI removed 2026-04-08 — see handleBind comment above. */}
                </div>

                {/* Workspace file editor (expanded) */}
                {fileEditAgentId === agent.id && (
                  <div className="border-t border-slate-700/50 bg-slate-900/50">
                    {/* File tabs */}
                    <div className="grid grid-cols-2 gap-1 border-b border-slate-700/30 p-2 sm:grid-cols-3 xl:grid-cols-6">
                      {workspaceFiles.map((fileName) => (
                        <button key={fileName}
                          onClick={() => { setActiveFile(fileName); void loadFile(agent.id, fileName); }}
                          className={`rounded-lg px-3 py-2 text-[11px] text-left transition-colors ${
                            activeFile === fileName
                              ? 'bg-brand-600/10 text-brand-400 ring-1 ring-brand-500/40'
                              : 'text-slate-500 hover:bg-slate-800/70 hover:text-slate-300'
                          }`}>
                          {fileName}
                        </button>
                      ))}
                    </div>

                    {/* File description */}
                    <div className="px-4 pt-2">
                      <p className="text-[10px] text-slate-500">
                        {activeFile
                          ? t(WORKSPACE_FILE_META[activeFile] || 'agents.file.defaultDesc', WORKSPACE_FILE_META[activeFile] ? undefined : 'OpenClaw workspace file: {file}').replace('{file}', activeFile)
                          : t('agents.noWorkspaceFiles', 'No markdown workspace files found for this agent.')}
                      </p>
                    </div>

                    {/* Editor */}
                    <div className="p-4">
                      {fileListLoading || fileLoading ? (
                        <div className="flex items-center justify-center py-8">
                          <Loader2 size={16} className="animate-spin text-slate-500" />
                        </div>
                      ) : !activeFile ? (
                        <div className="rounded-lg border border-dashed border-slate-700 px-4 py-8 text-sm text-slate-500">
                          {t('agents.noTopLevelFiles', 'This agent does not expose any top-level markdown workspace files yet.')}
                        </div>
                      ) : (
                        <textarea
                          value={fileContent}
                          onChange={(e) => setFileContent(e.target.value)}
                          rows={20}
                          className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-300 font-mono leading-relaxed focus:outline-none focus:border-brand-500 resize-y min-h-[300px]"
                          placeholder={activeFile === 'SOUL.md'
                            ? t('agents.placeholder.soul', 'You are a helpful assistant specialized in...\n\n# Personality\n- Friendly and professional\n- Always explain your reasoning\n\n# Rules\n- Never share private information\n- Always cite sources')
                            : activeFile === 'TOOLS.md'
                            ? t('agents.placeholder.tools', '# Available Tools\n- exec: Run shell commands\n- read: Read files\n- write: Write files\n\n# Restrictions\n- Do not delete files without confirmation')
                            : t('agents.placeholder.file', 'Content for {file}...').replace('{file}', activeFile)
                          }
                        />
                      )}

                      {/* Save button */}
                      <div className="flex items-center justify-between mt-2">
                        <span className="text-[10px] text-slate-600">
                          {fileDirty ? t('agents.unsavedChanges', 'Unsaved changes') : ''}
                        </span>
                        <button onClick={handleSaveFile}
                          disabled={!fileDirty || fileSaving}
                          className={`px-3 py-1.5 text-xs rounded-lg flex items-center gap-1.5 transition-colors ${
                            fileSaved
                              ? 'bg-emerald-600/20 text-emerald-400'
                              : fileDirty
                              ? 'bg-brand-600 hover:bg-brand-500 text-white'
                              : 'bg-slate-800 text-slate-600 cursor-not-allowed'
                          }`}>
                          {fileSaving ? <Loader2 size={12} className="animate-spin" /> :
                           fileSaved ? <Check size={12} /> : <Save size={12} />}
                          {fileSaved ? t('agents.saved') : t('agents.save')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
