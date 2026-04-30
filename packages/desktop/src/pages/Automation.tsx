import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Plus, Trash2, RefreshCw, Loader2, ExternalLink, ChevronDown, ChevronRight, Timer } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { useExternalNavigator } from '../lib/useExternalNavigator';

interface CronJob {
  id?: string;
  name?: string;
  enabled?: boolean;
  expression?: string;
  command?: string;
  description?: string;
  schedule?: {
    kind?: string;
    expr?: string;
    at?: string;
    everyMs?: number;
    tz?: string;
    staggerMs?: number;
  };
  payload?: {
    kind?: string;
    message?: string;
    text?: string;
    model?: string;
  };
  state?: {
    nextRunAtMs?: number | null;
    lastRunAtMs?: number | null;
    lastStatus?: string | null;
    runningAtMs?: number | null;
  };
  sessionTarget?: string;
  agentId?: string;
  raw?: string;
}

interface CronAddRequest {
  name?: string;
  description?: string;
  cron: string;
  message?: string;
  systemEvent?: string;
  sessionTarget?: 'main' | 'isolated' | 'current' | `session:${string}`;
  wakeMode?: 'now' | 'next-heartbeat';
  timeoutSeconds?: number;
  announce?: boolean;
  disabled?: boolean;
}

type FrequencyType = 'daily' | 'hourly' | 'weekly' | 'custom';

const ACTIVE_SESSION_STORAGE_KEY = 'awareness-claw-active-session';
const HEARTBEAT_JOB_NAME = 'OCT Heartbeat';
const HEARTBEAT_EVENT_TEXT = 'OCT heartbeat check';
const HEARTBEAT_JOB_DESCRIPTION = 'Managed by OCT heartbeat toggle';

const WEEKDAYS = [
  { value: 1, key: 'auto.day.mon', fallback: 'Mon' },
  { value: 2, key: 'auto.day.tue', fallback: 'Tue' },
  { value: 3, key: 'auto.day.wed', fallback: 'Wed' },
  { value: 4, key: 'auto.day.thu', fallback: 'Thu' },
  { value: 5, key: 'auto.day.fri', fallback: 'Fri' },
  { value: 6, key: 'auto.day.sat', fallback: 'Sat' },
  { value: 0, key: 'auto.day.sun', fallback: 'Sun' },
];

function buildCronExpression(freq: FrequencyType, hour: number, minute: number, weekdays: number[]): string {
  const mm = String(minute);
  const hh = String(hour);
  switch (freq) {
    case 'hourly':
      return `${mm} * * * *`;
    case 'daily':
      return `${mm} ${hh} * * *`;
    case 'weekly': {
      const days = weekdays.length > 0 ? [...weekdays].sort().join(',') : '*';
      return `${mm} ${hh} * * ${days}`;
    }
    case 'custom':
      return '';
    default:
      return `${mm} ${hh} * * *`;
  }
}

function cronToHuman(expr: string, t: (key: string, fallback?: string) => string): string {
  if (!expr) return '';
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;

  const [min, hour, , , dow] = parts;

  if (min === '*' && hour === '*' && dow === '*') return t('auto.cron.everyMinute', 'Every minute');

  if (hour === '*' && dow === '*') {
    return min === '0'
      ? t('auto.cron.everyHour', 'Every hour')
      : t('auto.cron.everyHourAt', 'Every hour at :{min}').replace('{min}', min.padStart(2, '0'));
  }

  const timeStr = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;

  if (dow === '*') return t('auto.cron.daily', 'Daily {time}').replace('{time}', timeStr);

  const dayNames: Record<string, string> = {
    '0': t('auto.day.sun', 'Sun'),
    '1': t('auto.day.mon', 'Mon'),
    '2': t('auto.day.tue', 'Tue'),
    '3': t('auto.day.wed', 'Wed'),
    '4': t('auto.day.thu', 'Thu'),
    '5': t('auto.day.fri', 'Fri'),
    '6': t('auto.day.sat', 'Sat'),
    '7': t('auto.day.sun', 'Sun'),
  };
  const days = dow.split(',').map((day) => dayNames[day] || day).join(', ');
  return t('auto.cron.weekly', '{days} {time}').replace('{days}', days).replace('{time}', timeStr);
}

function getCronExpression(job: CronJob): string {
  if (job.schedule?.kind === 'cron' && job.schedule.expr) return job.schedule.expr;
  return job.expression || '';
}

function getPayloadText(job: CronJob): string {
  if (job.payload?.kind === 'agentTurn' && job.payload.message) return job.payload.message;
  if (job.payload?.kind === 'systemEvent' && job.payload.text) return job.payload.text;
  return job.command || '';
}

function formatDurationCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function formatTimestamp(timestampMs: number | null | undefined, locale: string): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return '';

  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleString(locale === 'zh' ? 'zh-CN' : undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getScheduleSummary(job: CronJob, t: (key: string, fallback?: string) => string, locale: string): string {
  if (job.schedule?.kind === 'every' && typeof job.schedule.everyMs === 'number') {
    return t('auto.schedule.every', 'Every {duration}').replace('{duration}', formatDurationCompact(job.schedule.everyMs));
  }

  if (job.schedule?.kind === 'at' && job.schedule.at) {
    const parsed = Date.parse(job.schedule.at);
    if (!Number.isNaN(parsed)) {
      return t('auto.schedule.once', 'Once at {time}').replace('{time}', formatTimestamp(parsed, locale));
    }
    return job.schedule.at;
  }

  const expression = getCronExpression(job);
  if (expression) {
    const human = cronToHuman(expression, t);
    const base = human || expression;
    return job.schedule?.tz ? `${base} (${job.schedule.tz})` : base;
  }

  return job.raw || '';
}

function getStatusLabel(job: CronJob, t: (key: string, fallback?: string) => string): string {
  if (job.enabled === false) return t('auto.status.disabled', 'Disabled');
  if (job.state?.runningAtMs) return t('auto.status.running', 'Running');

  switch (job.state?.lastStatus) {
    case 'ok':
      return t('auto.status.ok', 'OK');
    case 'error':
      return t('auto.status.error', 'Error');
    case 'skipped':
      return t('auto.status.skipped', 'Skipped');
    default:
      return t('auto.status.idle', 'Idle');
  }
}

function getSessionLabel(job: CronJob, t: (key: string, fallback?: string) => string): string {
  switch (job.sessionTarget) {
    case 'main':
      return t('auto.session.main', 'Main session');
    case 'isolated':
      return t('auto.session.isolated', 'Isolated session');
    case 'current':
      return t('auto.session.current', 'Current session');
    default:
      if (job.sessionTarget?.startsWith('session:')) {
        return `${t('auto.session.custom', 'Custom session')}: ${job.sessionTarget.slice('session:'.length)}`;
      }
      return '';
  }
}

function isManagedHeartbeatJob(job: CronJob): boolean {
  return job.name === HEARTBEAT_JOB_NAME || (job.payload?.kind === 'systemEvent' && job.payload.text === HEARTBEAT_EVENT_TEXT);
}

function getManagedHeartbeatInterval(job: CronJob): number | null {
  const expression = getCronExpression(job);
  const match = expression.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (!match) return null;

  const parsed = Number.parseInt(match[1] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5 && parts.every((part) => part.length > 0);
}

function resolveCronSessionTarget(): CronAddRequest['sessionTarget'] {
  try {
    const activeSessionId = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)?.trim();
    if (activeSessionId) {
      return `session:${activeSessionId}`;
    }
  } catch {
    // Ignore storage access failures and fall back to isolated jobs.
  }

  return 'isolated';
}

const PRESETS = [
  { labelKey: 'auto.preset.daily9', labelFallback: 'Daily 9 AM', freq: 'daily' as FrequencyType, hour: 9, minute: 0, weekdays: [] as number[], cmdKey: 'auto.presetCmd.dailySummary', cmdFallback: 'Check my to-do list and give me a summary' },
  { labelKey: 'auto.preset.hourly', labelFallback: 'Every hour', freq: 'hourly' as FrequencyType, hour: 0, minute: 0, weekdays: [] as number[], cmdKey: 'auto.presetCmd.checkMessages', cmdFallback: 'Check if there are new messages to reply' },
  { labelKey: 'auto.preset.monAm', labelFallback: 'Mon 9 AM', freq: 'weekly' as FrequencyType, hour: 9, minute: 0, weekdays: [1], cmdKey: 'auto.presetCmd.weeklyReport', cmdFallback: 'Review last week and generate a weekly report' },
  { labelKey: 'auto.preset.daily10pm', labelFallback: 'Daily 10 PM', freq: 'daily' as FrequencyType, hour: 22, minute: 0, weekdays: [] as number[], cmdKey: 'auto.presetCmd.conversationSummary', cmdFallback: 'Summarize today\'s conversations and learnings' },
];

export default function Automation() {
  const { t, locale } = useI18n();
  const { openDashboard, isOpening } = useExternalNavigator();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const jobsRef = useRef<CronJob[]>([]);
  const skipNextHeartbeatSyncRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [heartbeatReady, setHeartbeatReady] = useState(false);
  const [heartbeatEnabled, setHeartbeatEnabled] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('awareness-claw-heartbeat-enabled') || 'false');
    } catch {
      return false;
    }
  });
  const [heartbeatInterval, setHeartbeatInterval] = useState(() => {
    try {
      return Number.parseInt(localStorage.getItem('awareness-claw-heartbeat-interval') || '30', 10);
    } catch {
      return 30;
    }
  });

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => {
    localStorage.setItem('awareness-claw-heartbeat-enabled', JSON.stringify(heartbeatEnabled));
    localStorage.setItem('awareness-claw-heartbeat-interval', String(heartbeatInterval));
  }, [heartbeatEnabled, heartbeatInterval]);

  const [frequency, setFrequency] = useState<FrequencyType>('daily');
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [selectedDays, setSelectedDays] = useState<number[]>([1]);
  const [newCommand, setNewCommand] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [customCron, setCustomCron] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [creatingJob, setCreatingJob] = useState(false);

  const loadJobs = async () => {
    setLoading(true);
    if (window.electronAPI?.cronList) {
      try {
        const result = await window.electronAPI.cronList();
        const jobList = Array.isArray(result.jobs) ? result.jobs : [];
        const normalizedJobs = result.raw
          ? jobList.map((line) => ({ raw: String(line) } as CronJob))
          : (jobList as CronJob[]);

        jobsRef.current = normalizedJobs;
        setJobs(normalizedJobs);

        if (!heartbeatReady) {
          const heartbeatJob = normalizedJobs.find(isManagedHeartbeatJob);
          if (heartbeatJob) {
            skipNextHeartbeatSyncRef.current = true;
            setHeartbeatEnabled(true);
            const interval = getManagedHeartbeatInterval(heartbeatJob);
            if (interval) setHeartbeatInterval(interval);
          }
          setHeartbeatReady(true);
        }
      } catch {
        setJobs([]);
        if (!heartbeatReady) setHeartbeatReady(true);
      }
    } else if (!heartbeatReady) {
      setHeartbeatReady(true);
    }
    setLoading(false);
  };

  useEffect(() => {
    void loadJobs();
  }, []);

  const syncHeartbeatJob = async () => {
    if (!window.electronAPI?.cronAdd || !window.electronAPI?.cronRemove) return;

    const desiredExpression = `*/${heartbeatInterval} * * * *`;
    const heartbeatJobs = jobsRef.current.filter(isManagedHeartbeatJob);
    const jobsToRemove = heartbeatJobs.filter(
      (job) => job.id && (!heartbeatEnabled || getCronExpression(job) !== desiredExpression || job.enabled === false),
    );

    let changed = false;

    for (const job of jobsToRemove) {
      const result = await window.electronAPI.cronRemove(job.id || '');
      if (result?.success) changed = true;
    }

    if (heartbeatEnabled) {
      const hasActiveJob = heartbeatJobs.some(
        (job) => getCronExpression(job) === desiredExpression && job.enabled !== false,
      );

      if (!hasActiveJob) {
        const request: CronAddRequest = {
          name: HEARTBEAT_JOB_NAME,
          description: HEARTBEAT_JOB_DESCRIPTION,
          cron: desiredExpression,
          systemEvent: HEARTBEAT_EVENT_TEXT,
          sessionTarget: 'main',
          wakeMode: 'now',
        };
        const result = await window.electronAPI.cronAdd(request);
        if (result?.success) changed = true;
      }
    }

    if (changed) {
      await loadJobs();
    }
  };

  useEffect(() => {
    if (!heartbeatReady) return;
    if (skipNextHeartbeatSyncRef.current) {
      skipNextHeartbeatSyncRef.current = false;
      return;
    }
    void syncHeartbeatJob();
  }, [heartbeatReady, heartbeatEnabled, heartbeatInterval]);

  const cronExpression = useMemo(() => {
    if (frequency === 'custom') return customCron;
    return buildCronExpression(frequency, hour, minute, selectedDays);
  }, [frequency, hour, minute, selectedDays, customCron]);

  const visibleJobs = useMemo(() => jobs.filter((job) => !isManagedHeartbeatJob(job)), [jobs]);

  const addJob = async () => {
    if (creatingJob || !cronExpression || !newCommand || !window.electronAPI?.cronAdd) return;

    setAddError(null);
    setCreatingJob(true);
    try {
      const sessionTarget = resolveCronSessionTarget();
      const request: CronAddRequest = {
        cron: cronExpression,
        message: newCommand,
        sessionTarget,
        timeoutSeconds: 120,
        announce: sessionTarget === 'isolated',
      };
      const result = await window.electronAPI.cronAdd(request);
      if (result?.error) {
        setAddError(result.error);
        return;
      }

      resetForm();
      await loadJobs();
    } finally {
      setCreatingJob(false);
    }
  };

  const resetForm = () => {
    setFrequency('daily');
    setHour(9);
    setMinute(0);
    setSelectedDays([1]);
    setNewCommand('');
    setCustomCron('');
    setShowAdvanced(false);
    setShowAddForm(false);
  };

  const doRemoveJob = async (id: string) => {
    setRemoveError(null);
    if (!window.electronAPI?.cronRemove) return;

    const result = await window.electronAPI.cronRemove(id);
    if (result?.error) {
      setRemoveError(result.error);
      return;
    }

    await loadJobs();
  };

  const toggleDay = (day: number) => {
    setSelectedDays((prev) => (
      prev.includes(day) ? prev.filter((value) => value !== day) : [...prev, day]
    ));
  };

  const applyPreset = (preset: typeof PRESETS[0]) => {
    setFrequency(preset.freq);
    setHour(preset.hour);
    setMinute(preset.minute);
    setSelectedDays(preset.weekdays);
    setNewCommand(t(preset.cmdKey, preset.cmdFallback));
    setShowAdvanced(false);
  };

  const hours = Array.from({ length: 24 }, (_, index) => index);
  const minutes = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
  const isCreateDisabled = creatingJob || !cronExpression || !newCommand || (frequency === 'custom' && !isValidCron(customCron));

  return (
    <div className="h-full flex flex-col">
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-8">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-xs p-5 space-y-4">
            <p className="text-sm text-slate-200">{t('auto.deleteConfirm', 'Delete this scheduled task?')}</p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-1.5 text-sm text-slate-400 hover:text-slate-200"
              >
                {t('auto.cancel')}
              </button>
              <button
                onClick={() => {
                  void doRemoveJob(deleteConfirm);
                  setDeleteConfirm(null);
                }}
                className="px-4 py-1.5 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors"
              >
                {t('common.delete', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="px-6 py-4 border-b border-slate-800">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold flex items-center gap-2">
              <Timer size={20} className="text-brand-400" /> {t('auto.title')}
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">{t('auto.subtitle')}</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { void loadJobs(); }}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 bg-slate-800 rounded-lg transition-colors"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {t('common.refresh')}
            </button>
            <button
              onClick={() => { void openDashboard('automation-dashboard'); }}
              disabled={isOpening('automation-dashboard')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 disabled:text-slate-600 bg-slate-800 rounded-lg transition-colors"
            >
              {isOpening('automation-dashboard') ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />} {t('auto.dashboard', 'Dashboard')}
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-2xl">
        <div className="space-y-3">
          <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wider">{t('auto.heartbeat')}</h3>
          <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">{t('auto.heartbeat.title')}</div>
                <div className="text-xs text-slate-500">{t('auto.heartbeat.desc')}</div>
              </div>
              <button
                onClick={() => setHeartbeatEnabled(!heartbeatEnabled)}
                aria-label={t('auto.heartbeat.title', 'Heartbeat Check')}
                title={t('auto.heartbeat.title', 'Heartbeat Check')}
                className={`w-11 h-6 rounded-full transition-colors relative ${heartbeatEnabled ? 'bg-brand-600' : 'bg-slate-700'}`}
              >
                <div className={`w-5 h-5 rounded-full bg-white absolute top-0.5 transition-transform ${heartbeatEnabled ? 'translate-x-[21px]' : 'translate-x-px'}`} />
              </button>
            </div>
            {heartbeatEnabled && (
              <div className="flex items-center gap-3 border-t border-slate-700/50 pt-3">
                <span className="text-xs text-slate-400">{t('auto.heartbeat.interval')}</span>
                <input
                  type="range"
                  min={5}
                  max={120}
                  value={heartbeatInterval}
                  onChange={(event) => setHeartbeatInterval(Number.parseInt(event.target.value, 10))}
                  aria-label={t('auto.heartbeat.interval', 'Interval')}
                  title={t('auto.heartbeat.interval', 'Interval')}
                  className="flex-1 accent-brand-500"
                />
                <span className="text-sm text-slate-300 w-16 text-right">{heartbeatInterval} {t('auto.minutesShort', 'min')}</span>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wider">{t('auto.tasks')}</h3>
            <button
              onClick={() => setShowAddForm(true)}
              className="flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300"
            >
              <Plus size={12} /> {t('auto.addTask')}
            </button>
          </div>

          {showAddForm && (
            <div className="bg-slate-800/50 rounded-xl border border-brand-600/30 p-4 space-y-4 animate-fade-in">
              <div className="text-sm font-medium">{t('auto.newTask')}</div>

              <div className="flex flex-wrap gap-2">
                {PRESETS.map((preset, index) => (
                  <button
                    key={index}
                    onClick={() => applyPreset(preset)}
                    className="px-2.5 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded-lg text-slate-300 transition-colors"
                  >
                    {t(preset.labelKey, preset.labelFallback)}
                  </button>
                ))}
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1.5">{t('auto.frequency')}</label>
                <div className="grid grid-cols-4 gap-1.5">
                  {([
                    { key: 'daily', label: t('auto.daily') },
                    { key: 'hourly', label: t('auto.hourly') },
                    { key: 'weekly', label: t('auto.weekly') },
                    { key: 'custom', label: t('auto.custom') },
                  ] as const).map((option) => (
                    <button
                      key={option.key}
                      onClick={() => setFrequency(option.key)}
                      className={`py-1.5 text-xs rounded-lg transition-colors ${
                        frequency === option.key
                          ? 'bg-brand-600 text-white'
                          : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              {(frequency === 'daily' || frequency === 'weekly') && (
                <div>
                  <label className="text-xs text-slate-400 block mb-1.5">{t('auto.time', 'Time')}</label>
                  <div className="flex items-center gap-2">
                    <select
                      value={hour}
                      onChange={(event) => setHour(Number.parseInt(event.target.value, 10))}
                      aria-label={t('auto.time', 'Time')}
                      title={t('auto.time', 'Time')}
                      className="px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm focus:outline-none focus:border-brand-500 appearance-none cursor-pointer"
                    >
                      {hours.map((value) => (
                        <option key={value} value={value}>{String(value).padStart(2, '0')}</option>
                      ))}
                    </select>
                    <span className="text-slate-500 text-lg font-bold">:</span>
                    <select
                      value={minute}
                      onChange={(event) => setMinute(Number.parseInt(event.target.value, 10))}
                      aria-label={t('auto.time', 'Time')}
                      title={t('auto.time', 'Time')}
                      className="px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm focus:outline-none focus:border-brand-500 appearance-none cursor-pointer"
                    >
                      {minutes.map((value) => (
                        <option key={value} value={value}>{String(value).padStart(2, '0')}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {frequency === 'hourly' && (
                <div>
                  <label className="text-xs text-slate-400 block mb-1.5">{t('auto.atMinute', 'At minute')}</label>
                  <select
                    value={minute}
                    onChange={(event) => setMinute(Number.parseInt(event.target.value, 10))}
                    aria-label={t('auto.atMinute', 'At minute')}
                    title={t('auto.atMinute', 'At minute')}
                    className="px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm focus:outline-none focus:border-brand-500 appearance-none cursor-pointer"
                  >
                    {minutes.map((value) => (
                      <option key={value} value={value}>:{String(value).padStart(2, '0')}</option>
                    ))}
                  </select>
                </div>
              )}

              {frequency === 'weekly' && (
                <div>
                  <label className="text-xs text-slate-400 block mb-1.5">{t('auto.days', 'Days')}</label>
                  <div className="flex gap-1.5">
                    {WEEKDAYS.map((day) => (
                      <button
                        key={day.value}
                        onClick={() => toggleDay(day.value)}
                        className={`w-9 h-9 rounded-lg text-xs font-medium transition-colors ${
                          selectedDays.includes(day.value)
                            ? 'bg-brand-600 text-white'
                            : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                        }`}
                      >
                        {t(day.key, day.fallback)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {frequency === 'custom' && (
                <div>
                  <label className="text-xs text-slate-400 block mb-1">{t('auto.cronExpression', 'Cron expression')}</label>
                  <input
                    value={customCron}
                    onChange={(event) => setCustomCron(event.target.value)}
                    placeholder={t('auto.cronPlaceholder', '0 9 * * * (daily at 9 AM)')}
                    aria-label={t('auto.cronExpression', 'Cron expression')}
                    title={t('auto.cronExpression', 'Cron expression')}
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm font-mono focus:outline-none focus:border-brand-500"
                  />
                  {customCron && !isValidCron(customCron) ? (
                    <p className="text-[10px] text-amber-400 mt-1">{t('auto.cronInvalid', 'Needs 5 fields: minute hour day month weekday')}</p>
                  ) : (
                    <p className="text-[10px] text-slate-600 mt-1">{t('auto.cronFormat', 'Format: minute hour day month weekday')}</p>
                  )}
                </div>
              )}

              {frequency !== 'custom' && cronExpression && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    {showAdvanced ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    {t('auto.cronExpression', 'Cron expression')}
                  </button>
                  <code className="text-[10px] px-1.5 py-0.5 bg-slate-700/50 rounded text-slate-500 font-mono">{cronExpression}</code>
                  <span className="text-[10px] text-brand-400">{cronToHuman(cronExpression, t)}</span>
                </div>
              )}

              {showAdvanced && frequency !== 'custom' && (
                <div>
                  <input
                    value={cronExpression}
                    readOnly
                    aria-label={t('auto.cronExpression', 'Cron expression')}
                    title={t('auto.cronExpression', 'Cron expression')}
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm font-mono text-slate-500 focus:outline-none"
                  />
                </div>
              )}

              <div>
                <label className="text-xs text-slate-400 block mb-1">{t('auto.instruction')}</label>
                <textarea
                  value={newCommand}
                  onChange={(event) => setNewCommand(event.target.value)}
                  placeholder={t('auto.instruction.placeholder')}
                  rows={2}
                  aria-label={t('auto.instruction', 'Instruction')}
                  title={t('auto.instruction', 'Instruction')}
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm focus:outline-none focus:border-brand-500 resize-none"
                />
              </div>

              {addError && (
                <div className="text-xs text-red-400 bg-red-600/10 border border-red-600/20 rounded-lg px-3 py-2">
                  {addError}
                </div>
              )}

              <div className="flex gap-2 justify-end">
                <button onClick={() => { resetForm(); setAddError(null); }} className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200">{t('auto.cancel')}</button>
                <button
                  onClick={() => { void addJob(); }}
                  disabled={isCreateDisabled}
                  className="px-4 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700 text-white rounded-lg transition-colors"
                >
                  {creatingJob ? <Loader2 size={12} className="animate-spin inline-block" /> : null} {t('auto.create')}
                </button>
              </div>
            </div>
          )}

          {removeError && (
            <div className="text-xs text-red-400 bg-red-600/10 border border-red-600/20 rounded-lg px-3 py-2">
              {removeError}
            </div>
          )}

          {visibleJobs.length === 0 && !loading && (
            <div className="text-center py-8 text-slate-500">
              <Clock size={32} className="mx-auto mb-3 text-slate-600" />
              <p className="text-sm">{t('auto.noTasks')}</p>
              <p className="text-xs mt-1">{t('auto.noTasks.hint')}</p>
            </div>
          )}

          {visibleJobs.map((job, index) => {
            const expression = getCronExpression(job);
            const payloadText = getPayloadText(job);
            const scheduleSummary = getScheduleSummary(job, t, locale);
            const statusLabel = getStatusLabel(job, t);
            const sessionLabel = getSessionLabel(job, t);
            const nextRun = formatTimestamp(job.state?.nextRunAtMs, locale);
            const lastRun = formatTimestamp(job.state?.lastRunAtMs, locale);
            const secondaryDescription = job.description && job.description !== payloadText ? job.description : '';

            return (
              <div key={job.id || index} className="bg-slate-800/50 rounded-xl border border-slate-700/50 p-4 flex items-start justify-between group">
                <div className="flex-1">
                  {job.raw ? (
                    <p className="text-sm text-slate-300 font-mono">{job.raw}</p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-slate-100">{job.name || t('auto.newTask', 'Scheduled task')}</span>
                        <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-slate-700 text-slate-300">{statusLabel}</span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        {expression && (
                          <code className="text-xs px-1.5 py-0.5 bg-slate-700 rounded text-brand-300 font-mono">{expression}</code>
                        )}
                        {scheduleSummary && <span className="text-xs text-slate-500">{scheduleSummary}</span>}
                      </div>

                      {payloadText && <p className="text-sm text-slate-300">{payloadText}</p>}
                      {secondaryDescription && <p className="text-xs text-slate-500 mt-1">{secondaryDescription}</p>}

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[11px] text-slate-500">
                        {sessionLabel && <span>{sessionLabel}</span>}
                        {job.agentId && <span>{job.agentId}</span>}
                        {nextRun && <span>{t('auto.label.nextRun', 'Next {time}').replace('{time}', nextRun)}</span>}
                        {lastRun && <span>{t('auto.label.lastRun', 'Last {time}').replace('{time}', lastRun)}</span>}
                      </div>
                    </>
                  )}
                </div>
                {job.id ? (
                  <button
                    onClick={() => setDeleteConfirm(job.id || null)}
                    aria-label={t('common.delete', 'Delete')}
                    title={t('common.delete', 'Delete')}
                    className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-red-400 transition-all p-1"
                  >
                    <Trash2 size={14} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>

        <p className="text-xs text-slate-600 text-center pb-4">
          {t('auto.footer')}
        </p>
      </div>
    </div>
  );
}
