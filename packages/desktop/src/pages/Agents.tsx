import { useState, useEffect } from 'react';
import { Bot, Plus, Trash2, Link, Loader2, RefreshCw, Edit3, Check, X, AlertCircle } from 'lucide-react';
import { useI18n } from '../lib/i18n';

interface AgentInfo {
  id: string;
  name?: string;
  emoji?: string;
  model?: string;
  bindings?: string[];  // bindingDetails from CLI (e.g. "telegram", "whatsapp accountId=default")
  isDefault?: boolean;
  workspace?: string;
  routes?: string[];
}

export default function Agents() {
  const { t } = useI18n();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [newAgentModel, setNewAgentModel] = useState('');
  // Identity editing
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmoji, setEditEmoji] = useState('');
  const [editAvatar, setEditAvatar] = useState('');
  const [editTheme, setEditTheme] = useState('');
  // Binding
  const [bindingAgentId, setBindingAgentId] = useState<string | null>(null);
  const [bindChannel, setBindChannel] = useState('');

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
        setError(result.error || 'Failed to load agents');
      }
    } catch { setError('Failed to connect'); }
    setLoading(false);
  };

  useEffect(() => { loadAgents(); }, []);

  const handleDelete = async (agentId: string) => {
    if (!window.electronAPI || agentId === 'main') return;
    if (!confirm('Delete this agent?')) return;
    const result = await (window.electronAPI as any).agentsDelete(agentId);
    if (result.success) loadAgents();
    else setError(result.error || 'Delete failed');
  };

  const handleCreate = async () => {
    if (!newAgentName.trim() || !window.electronAPI) return;
    setCreating(true);
    setError(null);
    try {
      const result = await (window.electronAPI as any).agentsAdd(newAgentName.trim(), newAgentModel || undefined);
      if (result.success) {
        setNewAgentName('');
        setNewAgentModel('');
        loadAgents();
      } else {
        const errMsg = result.error || '';
        if (/permission|access|denied/i.test(errMsg)) {
          setError('Permission denied. Check your system permissions and try again.');
        } else if (/already exists|duplicate/i.test(errMsg)) {
          setError(`Agent "${newAgentName.trim()}" already exists. Choose a different name.`);
        } else {
          setError(errMsg || 'Failed to create agent. Please try again.');
        }
      }
    } catch {
      setError('Unexpected error. Please try again.');
    }
    setCreating(false);
  };

  const handleSetIdentity = async (agentId: string) => {
    if (!window.electronAPI) return;
    const result = await (window.electronAPI as any).agentsSetIdentity(agentId, editName, editEmoji, editAvatar, editTheme);
    if (result.success) {
      setEditingId(null);
      loadAgents();
    } else {
      setError(result.error || 'Set identity failed');
    }
  };

  const handleBind = async (agentId: string) => {
    if (!window.electronAPI || !bindChannel.trim()) return;
    const result = await (window.electronAPI as any).agentsBind(agentId, bindChannel.trim());
    if (result.success) {
      setBindingAgentId(null);
      setBindChannel('');
      loadAgents();
    } else {
      setError(result.error || 'Bind failed');
    }
  };

  const handleUnbind = async (agentId: string, binding: string) => {
    if (!window.electronAPI) return;
    const result = await (window.electronAPI as any).agentsUnbind(agentId, binding);
    if (result.success) loadAgents();
    else setError(result.error || 'Unbind failed');
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-slate-800">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h1 className="text-lg font-semibold">🤖 {t('agents.title')}</h1>
            <p className="text-xs text-slate-500">{t('agents.subtitle')}</p>
          </div>
          <button onClick={loadAgents} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 bg-slate-800 rounded-lg">
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {t('common.refresh') || 'Refresh'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-600/10 border border-red-600/20 rounded-xl text-xs text-red-400">
            <AlertCircle size={14} />
            <span>{error}</span>
            <button onClick={() => setError(null)} className="ml-auto"><X size={12} /></button>
          </div>
        )}

        {/* Create */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <input value={newAgentName} onChange={(e) => setNewAgentName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder={t('agents.newPlaceholder')}
              className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm focus:outline-none focus:border-brand-500" />
            <button onClick={handleCreate} disabled={!newAgentName.trim() || creating}
              className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700 text-white rounded-lg text-sm flex items-center gap-1.5">
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              {t('agents.create')}
            </button>
          </div>
          <input value={newAgentModel} onChange={(e) => setNewAgentModel(e.target.value)}
            placeholder={t('agents.modelPlaceholder', 'Model (optional, e.g. anthropic/claude-sonnet-4-20250514)')}
            className="w-full px-3 py-1.5 bg-slate-800/50 border border-slate-700/50 rounded-lg text-xs text-slate-400 focus:outline-none focus:border-brand-500" />
        </div>

        {/* List */}
        {loading ? (
          <div className="flex items-center justify-center py-12"><Loader2 size={24} className="animate-spin text-brand-500" /></div>
        ) : agents.length === 0 ? (
          <div className="text-center py-12 text-slate-500 text-sm">{t('agents.empty')}</div>
        ) : (
          <div className="space-y-3">
            {agents.map((agent) => (
              <div key={agent.id} className="p-4 bg-slate-800/50 border border-slate-700/50 rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{agent.emoji || '🤖'}</span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{agent.name || agent.id}</span>
                        {agent.isDefault && <span className="px-1.5 py-0.5 text-[10px] bg-brand-600/20 text-brand-400 rounded">Default</span>}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        ID: {agent.id}{agent.model && <span className="ml-2">Model: {agent.model}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => { setEditingId(agent.id); setEditName(agent.name || ''); setEditEmoji(agent.emoji || ''); setEditAvatar(''); setEditTheme(''); }}
                      className="p-1.5 text-slate-500 hover:text-slate-300 rounded" title="Edit identity"><Edit3 size={14} /></button>
                    <button onClick={() => { setBindingAgentId(agent.id); setBindChannel(''); }}
                      className="p-1.5 text-slate-500 hover:text-emerald-400 rounded" title="Add binding"><Link size={14} /></button>
                    {!agent.isDefault && (
                      <button onClick={() => handleDelete(agent.id)} className="p-1.5 text-slate-500 hover:text-red-400 rounded"><Trash2 size={14} /></button>
                    )}
                  </div>
                </div>

                {/* Bindings */}
                {agent.bindings && agent.bindings.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pl-11">
                    {agent.bindings.map((b, i) => (
                      <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] bg-emerald-600/15 text-emerald-400 rounded-full">
                        <Link size={9} />{b}
                        <button onClick={() => handleUnbind(agent.id, b)} className="hover:text-red-400 ml-0.5"><X size={9} /></button>
                      </span>
                    ))}
                  </div>
                )}

                {/* Inline identity edit */}
                {editingId === agent.id && (
                  <div className="space-y-2 pl-11 pt-2 border-t border-slate-700/30">
                    <div className="flex items-center gap-2">
                      <input value={editEmoji} onChange={(e) => setEditEmoji(e.target.value)} placeholder="🤖"
                        className="w-10 px-1 py-1 bg-slate-900 border border-slate-600 rounded text-center text-sm" maxLength={4} />
                      <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Name"
                        className="flex-1 px-2 py-1 bg-slate-900 border border-slate-600 rounded text-sm" />
                      <button onClick={() => handleSetIdentity(agent.id)} className="p-1 text-emerald-400 hover:text-emerald-300"><Check size={14} /></button>
                      <button onClick={() => setEditingId(null)} className="p-1 text-slate-500 hover:text-slate-300"><X size={14} /></button>
                    </div>
                    <div className="flex items-center gap-2">
                      <input value={editAvatar} onChange={(e) => setEditAvatar(e.target.value)}
                        placeholder={t('agents.avatarPlaceholder', 'Avatar URL (optional)')}
                        className="flex-1 px-2 py-1 bg-slate-900 border border-slate-600 rounded text-xs text-slate-400" />
                      <select value={editTheme} onChange={(e) => setEditTheme(e.target.value)}
                        className="px-2 py-1 bg-slate-900 border border-slate-600 rounded text-xs text-slate-400">
                        <option value="">{t('agents.themeDefault', 'Theme')}</option>
                        <option value="dark">Dark</option>
                        <option value="light">Light</option>
                      </select>
                    </div>
                  </div>
                )}

                {/* Inline bind input */}
                {bindingAgentId === agent.id && (
                  <div className="space-y-1.5 pl-11 pt-1 border-t border-slate-700/30">
                    <div className="flex items-center gap-2">
                      <input value={bindChannel} onChange={(e) => setBindChannel(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleBind(agent.id)}
                        placeholder="telegram, discord:12345, whatsapp:default"
                        className="flex-1 px-2 py-1 bg-slate-900 border border-slate-600 rounded text-sm" />
                      <button onClick={() => handleBind(agent.id)} disabled={!bindChannel.trim()} className="p-1 text-emerald-400 hover:text-emerald-300"><Check size={14} /></button>
                      <button onClick={() => setBindingAgentId(null)} className="p-1 text-slate-500 hover:text-slate-300"><X size={14} /></button>
                    </div>
                    <p className="text-[10px] text-slate-500">{t('agents.bindHint', 'Format: channel or channel:accountId — e.g. telegram, slack, whatsapp:default')}</p>
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
