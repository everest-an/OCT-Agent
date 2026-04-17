/**
 * TaskCenter — Multi-agent team workflow page.
 *
 * Flow:
 * 1. User types a goal + optionally picks a workspace
 * 2. Main agent analyzes the task and auto-spawns relevant sub-agents
 * 3. Steps appear dynamically as sub-agents are spawned
 * 4. User sees each agent's progress in real-time
 * 5. Click any step to see details or jump to chat
 */

import { useState, useEffect, useCallback } from 'react';
import { AlertCircle, Bot, Loader2, Sparkles, Zap } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import {
  loadMissions,
  saveMissions,
  updateMission,
  removeMission,
} from '../lib/mission-store';
import type { Mission, MissionStep } from '../lib/mission-store';
import MissionDetail from '../components/task-center/MissionDetail';
import MissionFlowShell from '../components/mission-flow/MissionFlowShell';

interface AgentInfo {
  id: string;
  name?: string;
  emoji?: string;
}

interface SetupStatus {
  checked: boolean;
  maxSpawnDepth: number;
  agentCount: number;
  agentToAgentEnabled: boolean;
}

import type { Page } from '../components/Sidebar';

function uid(): string {
  return `mission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function TaskCenter({ onNavigate }: { onNavigate?: (page: Page) => void }) {
  const { t } = useI18n();
  const [missions, setMissions] = useState<readonly Mission[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [goalInput, setGoalInput] = useState('');
  const [workDir, setWorkDir] = useState(() => localStorage.getItem('awareness-claw-project-root') || '');
  const [creating, setCreating] = useState(false);
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupStatus>({ checked: false, maxSpawnDepth: 1, agentCount: 0, agentToAgentEnabled: false });
  const [enabling, setEnabling] = useState(false);
  // Streaming content per mission (accumulated delta text)
  const [streamingText, setStreamingText] = useState<Record<string, string>>({});

  // Load on mount, then reconcile persisted non-terminal missions with active mission ids from main process.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const persisted = loadMissions();
      let next = persisted;

      try {
        const active = await window.electronAPI?.missionListActive?.();
        const activeMissionIds = new Set(active?.missionIds || []);
        const finalizedAt = new Date().toISOString();
        let changed = false;

        next = persisted.map((mission) => {
          const isNonTerminal = mission.status === 'running' || mission.status === 'planning' || mission.status === 'paused';
          if (!isNonTerminal) return mission;
          if (activeMissionIds.has(mission.id)) return mission;

          changed = true;
          return {
            ...mission,
            status: 'failed',
            completedAt: mission.completedAt || finalizedAt,
            error: mission.error || 'Mission was interrupted or detached from runtime state.',
          };
        });

        if (changed) saveMissions(next);
      } catch {
        // Keep persisted state when runtime mission reconciliation is unavailable.
      }

      if (!cancelled) setMissions(next);
    })();

    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (missions.length > 0 || localStorage.getItem('awareness-claw-missions')) {
      saveMissions(missions);
    }
  }, [missions]);

  useEffect(() => {
    window.electronAPI?.agentsList?.().then((result: any) => {
      const list = result?.agents || (Array.isArray(result) ? result : []);
      if (list.length > 0) {
        setAgents(list.map((a: any) => ({ id: a.id || 'main', name: a.name || a.id, emoji: a.emoji })));
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const config = await window.electronAPI?.workflowConfig?.();
        const agentsResult = await window.electronAPI?.agentsList?.();
        const agentsList = (agentsResult as any)?.agents || (Array.isArray(agentsResult) ? agentsResult : []);
        setSetup({ checked: true, maxSpawnDepth: config?.maxSpawnDepth ?? 1, agentCount: agentsList.length, agentToAgentEnabled: config?.agentToAgentEnabled ?? false });
      } catch { setSetup(s => ({ ...s, checked: true })); }
    })();
  }, []);

  // Listen for mission progress events from main process
  useEffect(() => {
    const unsub = window.electronAPI?.onMissionProgress?.((data: any) => {
      if (!data?.missionId) return;

      setMissions(prev => {
        let updated = [...prev];
        const idx = updated.findIndex(m => m.id === data.missionId);
        if (idx < 0) return prev;

        const mission = updated[idx];

        // Handle new step (sub-agent spawned dynamically)
        if (data.newStep) {
          const step: MissionStep = {
            id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            agentId: data.newStep.agentId,
            agentName: data.newStep.agentName || data.newStep.agentId,
            agentEmoji: data.newStep.agentEmoji,
            role: data.newStep.agentName || data.newStep.agentId,
            instruction: '',
            status: data.newStep.status || 'running',
            sessionKey: data.newStep.sessionKey,
            startedAt: data.newStep.startedAt,
          };
          updated[idx] = { ...mission, steps: [...mission.steps, step] };
        }

        // Handle step update (sub-agent completed/failed/sessionKey rename)
        if (data.stepUpdate) {
          const su = data.stepUpdate;
          const steps = updated[idx].steps.map(s => {
            // Match by sessionKey (exact or pending-agentId format)
            const matchBySession = s.sessionKey && s.sessionKey === su.sessionKey;
            // Match by agentId (fallback — each agent appears once)
            const matchByAgent = su.agentId && s.agentId === su.agentId;
            if (!matchBySession && !matchByAgent) return s;

            const patch = { ...su };
            // If renaming sessionKey from pending to real
            if (patch.newSessionKey) {
              patch.sessionKey = patch.newSessionKey;
              delete patch.newSessionKey;
            }
            // Remove match keys from patch to avoid overwriting
            delete patch.agentId;
            return { ...s, ...patch };
          });
          updated[idx] = { ...updated[idx], steps };
        }

        // Handle streaming delta (accumulate text)
        if (data.streamDelta) {
          setStreamingText(prev => ({
            ...prev,
            [data.missionId]: (prev[data.missionId] || '') + data.streamDelta,
          }));
        } else if (data.streamDelta === null) {
          // Clear streaming when done
          setStreamingText(prev => {
            const next = { ...prev };
            delete next[data.missionId];
            return next;
          });
        }

        // Handle mission-level update
        if (data.missionPatch) {
          updated[idx] = { ...updated[idx], ...data.missionPatch };
        }

        // Handle legacy stepIndex-based updates
        if (data.stepIndex !== undefined && data.stepPatch) {
          const steps = mission.steps.map((s, i) =>
            i === data.stepIndex ? { ...s, ...data.stepPatch } : s
          );
          updated[idx] = { ...updated[idx], steps };
        }

        return updated;
      });
    });
    return unsub;
  }, []);

  // ---- Actions ----

  const handleStartMission = useCallback(async (goal: string) => {
    if (!goal.trim() || creating) return;
    setCreating(true);

    try {
      const missionId = uid();
      // Create mission with NO pre-set steps (steps are added dynamically as agents spawn)
      const mission: Mission = {
        id: missionId,
        goal: goal.trim(),
        status: 'planning',
        steps: [],
        createdAt: new Date().toISOString(),
        currentStepIndex: -1,
        workDir: workDir || undefined,
      };

      setMissions(prev => [mission, ...prev]);
      setGoalInput('');

      const result = await window.electronAPI?.missionStart?.({
        missionId,
        goal: goal.trim(),
        workDir: workDir || undefined,
        agents: agents.length > 0 ? agents : [{ id: 'main', name: 'Main', emoji: '🤖' }],
      });

      if (!result?.success) {
        setMissions(prev => updateMission(prev, missionId, {
          status: 'failed',
          error: result?.error || 'Failed to start',
        }));
      } else if (result.sessionKey) {
        setMissions(prev => updateMission(prev, missionId, {
          sessionKey: result.sessionKey,
        }));
      }
    } catch { /* handled via progress events */ }
    setCreating(false);
  }, [agents, creating, workDir]);

  const handlePickWorkDir = useCallback(async () => {
    const result = await window.electronAPI?.taskPickDirectory?.();
    if (result && !result.cancelled && result.path) {
      setWorkDir(result.path);
      // Sync to global workspace so Dashboard and other pages share the same value
      localStorage.setItem('awareness-claw-project-root', result.path);
    }
  }, []);

  const handleDeleteMission = useCallback((missionId: string) => {
    setMissions(prev => removeMission(prev, missionId));
    if (selectedMissionId === missionId) setSelectedMissionId(null);
  }, [selectedMissionId]);

  const handleOpenChat = useCallback((sessionKey: string, title: string) => {
    window.dispatchEvent(new CustomEvent('open-task-session', { detail: { sessionKey, title } }));
    onNavigate?.('chat');
  }, [onNavigate]);

  const handleEnableCollaboration = useCallback(async () => {
    setEnabling(true);
    try {
      const result = await window.electronAPI?.workflowEnableCollaboration?.();
      const cfg = (result as any)?.config;
      if (result?.success && cfg) {
        setSetup(s => ({ ...s, maxSpawnDepth: cfg.maxSpawnDepth, agentToAgentEnabled: cfg.agentToAgentEnabled }));
      }
    } catch { /* ignore */ }
    setEnabling(false);
  }, []);

  // ---- Render ----

  const needsSetup = setup.checked && setup.maxSpawnDepth < 2;
  const selectedMission = selectedMissionId ? missions.find(m => m.id === selectedMissionId) : null;

  if (selectedMission) {
    return (
      <div className="h-full">
        <MissionDetail
          mission={selectedMission}
          streamingText={streamingText[selectedMission.id] || ''}
          onBack={() => setSelectedMissionId(null)}
          onOpenChat={handleOpenChat}
          onDelete={() => handleDeleteMission(selectedMission.id)}
          t={t}
        />
      </div>
    );
  }

  const activeMissions = missions.filter(m => m.status === 'running' || m.status === 'planning' || m.status === 'paused');
  const completedMissions = missions.filter(m => m.status === 'done' || m.status === 'failed');
  const workDirName = workDir ? workDir.split(/[/\\]/).filter(Boolean).pop() || workDir : '';

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-6 pt-6 pb-2">
        <div className="flex items-center gap-3 mb-1">
          <Sparkles size={22} className="text-sky-400" />
          <h1 className="text-lg font-bold text-slate-100">{t('taskCenter.title', 'Team Tasks')}</h1>
        </div>
        <p className="text-xs text-slate-500 ml-[34px]">{t('taskCenter.subtitle', 'Tell your AI team what to do — they will figure out the rest')}</p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 space-y-5">
        {/* Setup banner */}
        {needsSetup && (
          <div className="p-4 rounded-xl bg-amber-950/20 border border-amber-700/30">
            <div className="flex items-start gap-3">
              <AlertCircle size={18} className="text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm text-amber-300 font-medium">{t('taskCenter.setup.title', 'Enable Team Mode')}</p>
                <p className="text-xs text-amber-400/70 mt-1">{t('taskCenter.setup.desc', 'Allow your agents to work together.')}</p>
                <button onClick={handleEnableCollaboration} disabled={enabling}
                  className="mt-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 text-xs font-medium border border-amber-600/30">
                  {enabling ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                  {enabling ? t('taskCenter.setup.enabling', 'Enabling...') : t('taskCenter.setup.enable', 'Enable')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Need agents hint */}
        {setup.checked && setup.agentCount < 2 && !needsSetup && (
          <div className="p-4 rounded-xl bg-sky-950/20 border border-sky-700/30">
            <div className="flex items-start gap-3">
              <Bot size={18} className="text-sky-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm text-sky-300">{t('taskCenter.setup.needAgents', 'You have one agent. Add more for team workflows.')}</p>
                <button onClick={() => onNavigate?.('agents')}
                  className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 text-xs font-medium border border-sky-600/30">
                  <Bot size={11} /> {t('taskCenter.setup.goToAgents', 'Manage Agents')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Mission Flow (F-Team-Tasks Phase 4) — primary team task surface */}
        <MissionFlowShell
          t={t}
          workDir={workDir || undefined}
          onPickWorkDir={handlePickWorkDir}
          onClearWorkDir={() => {
            setWorkDir('');
            localStorage.removeItem('awareness-claw-project-root');
          }}
          agents={agents.map(a => ({ id: a.id, name: a.name, emoji: a.emoji }))}
          onManageAgents={() => onNavigate?.('agents')}
        />
      </div>
    </div>
  );
}
