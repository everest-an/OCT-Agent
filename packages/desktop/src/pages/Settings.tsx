import { useState, useEffect, useRef } from 'react';
import { Moon, Sun, Monitor, ChevronRight, X, Check, ChevronDown, Play, Square, RotateCw, RefreshCw, Loader2, Plus, Trash2, Download, Upload, Shield, AlertTriangle, Puzzle, Webhook, CheckCircle, Lock, Code2, Zap, ExternalLink, Cloud, CloudOff } from 'lucide-react';
import { useAppConfig, useDynamicProviders, getProviderProfile } from '../lib/store';
import { getUsageStats, clearUsage, type UsageStats } from '../lib/usage';
import { useI18n } from '../lib/i18n';
import PasswordInput from '../components/PasswordInput';
import OpenClawConfigSectionForm from '../components/OpenClawConfigSectionForm';
import { SettingsModalShell, SettingsRow, SettingsSection, SettingsToggle } from '../components/settings/SettingsPrimitives';
import { SettingsPermissionsPanel } from '../components/settings/SettingsPermissionsPanel';
import { SettingsUsagePanel, SettingsVersionPanel } from '../components/settings/SettingsStatsPanels';
import { buildDynamicSectionsFromSchema, getValueAtPath, setValueAtPath, type DynamicConfigSection } from '../lib/openclaw-capabilities';
import pkg from '../../package.json';

const KNOWN_ALLOWED_TOOLS = [
  { id: 'awareness_init', label: 'Awareness Init', desc: 'Bootstrap memory instructions automatically', risk: 'Core' },
  { id: 'awareness_get_agent_prompt', label: 'Prompt Pack', desc: 'Load installed Awareness prompt pack', risk: 'Core' },
  { id: 'exec', label: 'Shell Commands', desc: 'Run coding and terminal commands on your machine', risk: 'High' },
  { id: 'awareness_recall', label: 'Memory Recall', desc: 'Search past decisions and knowledge cards', risk: 'Normal' },
  { id: 'awareness_record', label: 'Memory Save', desc: 'Write new knowledge back to Awareness memory', risk: 'Normal' },
  { id: 'awareness_lookup', label: 'Knowledge Lookup', desc: 'Read structured memory cards', risk: 'Normal' },
  { id: 'awareness_perception', label: 'Project Signals', desc: 'Read file patterns and activity signals', risk: 'Elevated' },
];

const KNOWN_DENIED_COMMANDS = [
  { id: 'camera.snap', label: 'Camera', desc: 'Block taking photos or screen clips', impact: 'Privacy' },
  { id: 'screen.record', label: 'Screen Recording', desc: 'Block recording the screen', impact: 'Privacy' },
  { id: 'contacts.add', label: 'Contacts', desc: 'Block reading or adding contacts', impact: 'Privacy' },
  { id: 'calendar.add', label: 'Calendar', desc: 'Block creating calendar events', impact: 'Privacy' },
  { id: 'sms.send', label: 'SMS / Messages', desc: 'Block sending text messages', impact: 'Privacy' },
  { id: 'exec', label: 'Shell Commands', desc: 'Hard-block running arbitrary shell commands', impact: 'Critical' },
];

const WEB_PROVIDER_GUIDANCE: Record<string, { title: string; detail: string; requiresKey: boolean }> = {
  brave: {
    title: 'Brave search needs an API key',
    detail: 'Paste the Brave key into the API key field below. Once saved, OpenClaw can use web search immediately.',
    requiresKey: true,
  },
  perplexity: {
    title: 'Perplexity search needs an API key',
    detail: 'Perplexity is supported through the same dynamic config flow. Save the provider first, then add the API key.',
    requiresKey: true,
  },
  grok: {
    title: 'Grok may require extra x_search setup',
    detail: 'OpenClaw supports Grok web search, but some setups also require x_search to be enabled in OpenClaw.',
    requiresKey: true,
  },
  browser: {
    title: 'Browser mode does not require a Brave key',
    detail: 'Use this when you want OpenClaw to rely on browser-backed search/fetch instead of a remote search API.',
    requiresKey: false,
  },
};

export default function Settings() {
  const { t } = useI18n();
  const { config, updateConfig, syncConfig, saveProviderConfig } = useAppConfig();
  const DEFAULT_EXEC_ASK = 'on-miss' as const;
  const BASE_REQUIRED_TOOLS = ['awareness_init', 'awareness_get_agent_prompt'] as const;
  const STANDARD_ALLOWED_TOOLS = ['exec', 'awareness_recall', 'awareness_record', 'awareness_lookup'] as const;
  const DEVELOPER_EXTRA_TOOLS = ['awareness_perception'] as const;
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [gatewayStatus, setGatewayStatus] = useState<'checking' | 'running' | 'stopped'>('checking');
  const [gatewayLoading, setGatewayLoading] = useState(false);
  const [logs, setLogs] = useState('');
  const [showLogs, setShowLogs] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<'idle' | 'success' | 'error'>('idle');
  const [tempProvider, setTempProvider] = useState('');
  const [tempModel, setTempModel] = useState('');
  const [tempApiKey, setTempApiKey] = useState('');
  const [tempBaseUrl, setTempBaseUrl] = useState('');
  const [detectedProviderKey, setDetectedProviderKey] = useState('');
  const [detectedModels, setDetectedModels] = useState<Array<{ id: string; label: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }>>([]);
  const [webSections, setWebSections] = useState<DynamicConfigSection[]>([]);
  const [webValues, setWebValues] = useState<Record<string, any>>({});
  const [webLoading, setWebLoading] = useState(true);
  const [webSaving, setWebSaving] = useState(false);
  const [webError, setWebError] = useState<string | null>(null);
  const [webSaved, setWebSaved] = useState(false);

  // Permissions state
  const [permissions, setPermissions] = useState<{ profile: string; alsoAllow: string[]; denied: string[]; execAsk: 'off' | 'on-miss' } | null>(null);
  const [newAllowTool, setNewAllowTool] = useState('');
  const [newDenyCmd, setNewDenyCmd] = useState('');
  const [showAdvancedPerms, setShowAdvancedPerms] = useState(false);

  // Cloud auth state
  const [showCloudAuth, setShowCloudAuth] = useState(false);
  const [cloudAuthStep, setCloudAuthStep] = useState<'init' | 'loading' | 'waiting' | 'select' | 'done' | 'error'>('init');
  const [cloudDeviceCode, setCloudDeviceCode] = useState('');
  const [cloudUserCode, setCloudUserCode] = useState('');
  const [cloudVerifyUrl, setCloudVerifyUrl] = useState('');
  const [cloudApiKey, setCloudApiKey] = useState('');
  const [cloudMemories, setCloudMemories] = useState<Array<{ id: string; name: string }>>([]);
  const [cloudMode, setCloudMode] = useState<string>('local');
  const cloudPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Permission presets
  const PERMISSION_PRESETS = {
    safe: {
      label: t('settings.permissions.safe', 'Safe'),
      desc: t('settings.permissions.safe.desc', 'Minimal access — no shell commands, privacy tools blocked'),
      icon: <Lock size={16} />,
      color: 'blue',
      alsoAllow: [...BASE_REQUIRED_TOOLS] as string[],
      denied: ['exec', 'bash', 'shell', 'camera.snap', 'screen.record', 'contacts.add', 'calendar.add', 'sms.send'],
      execAsk: 'on-miss' as const,
    },
    standard: {
      label: t('settings.permissions.standard', 'Standard'),
      desc: t('settings.permissions.standard.desc', 'Code editing + Awareness memory, privacy tools blocked'),
      icon: <Shield size={16} />,
      color: 'emerald',
      alsoAllow: [...BASE_REQUIRED_TOOLS, ...STANDARD_ALLOWED_TOOLS] as string[],
      denied: ['camera.snap', 'screen.record', 'contacts.add', 'calendar.add', 'sms.send'],
      execAsk: 'on-miss' as const,
    },
    developer: {
      label: t('settings.permissions.developer', 'Developer'),
      desc: t('settings.permissions.developer.desc', 'Full tool access, all capabilities enabled'),
      icon: <Code2 size={16} />,
      color: 'purple',
      alsoAllow: [...BASE_REQUIRED_TOOLS, ...STANDARD_ALLOWED_TOOLS, ...DEVELOPER_EXTRA_TOOLS] as string[],
      denied: [] as string[],
      execAsk: 'off' as const,
    },
  };

  type PresetKey = keyof typeof PERMISSION_PRESETS;

  const detectPreset = (): PresetKey | null => {
    if (!permissions) return null;
    for (const [key, preset] of Object.entries(PERMISSION_PRESETS)) {
      const allowMatch = JSON.stringify([...preset.alsoAllow].sort()) === JSON.stringify([...permissions.alsoAllow].sort());
      const denyMatch = JSON.stringify([...preset.denied].sort()) === JSON.stringify([...permissions.denied].sort());
      const execAskMatch = preset.execAsk === permissions.execAsk;
      if (allowMatch && denyMatch && execAskMatch) return key as PresetKey;
    }
    return null; // custom
  };

  const applyPreset = async (key: PresetKey) => {
    const preset = PERMISSION_PRESETS[key];
    await savePermissions({ alsoAllow: preset.alsoAllow, denied: preset.denied, execAsk: preset.execAsk });
  };

  // Plugins state — entries is Record<name, {enabled}> in openclaw.json
  const [plugins, setPlugins] = useState<Record<string, { enabled?: boolean }>>({});

  // Hooks state — hooks is Record<name, {enabled, entries?}> in openclaw.json
  const [hooks, setHooks] = useState<Record<string, { enabled?: boolean; entries?: Record<string, { enabled?: boolean }> }>>({});

  // Dynamic providers
  const { providers: allProviders } = useDynamicProviders();

  // Security audit
  const [securityIssues, setSecurityIssues] = useState<Array<{ level: string; message: string; fix?: string }>>([]);

  // Doctor (System Health)
  const [doctorReport, setDoctorReport] = useState<any>(null);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [fixingId, setFixingId] = useState<string | null>(null);

  // Usage stats
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);

  // System version info
  const [versionInfo, setVersionInfo] = useState<{
    platform?: string; arch?: string; nodeVersion?: string; openclawVersion?: string;
    awarenessPluginVersion?: string; daemonRunning?: boolean; daemonVersion?: string;
    daemonStats?: { memories?: number; knowledge?: number; sessions?: number };
  } | null>(null);

  // Load version info on mount
  useEffect(() => {
    const loadVersions = async () => {
      if (!window.electronAPI) return;
      const env = await (window.electronAPI as any).detectEnvironment();
      setVersionInfo({
        platform: env.platform,
        arch: env.arch,
        nodeVersion: env.systemNodeVersion || null,
        openclawVersion: env.openclawVersion || null,
        awarenessPluginVersion: env.awarenessPluginVersion || null,
        daemonRunning: env.daemonRunning || false,
        daemonVersion: env.daemonVersion || null,
        daemonStats: env.daemonStats || null,
      });
    };
    loadVersions();
  }, []);

  // Workspace files state
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileSaving, setFileSaving] = useState(false);
  const [fileSaveSuccess, setFileSaveSuccess] = useState(false);

  // Load permissions, plugins, hooks on mount
  useEffect(() => {
    const api = window.electronAPI as any;
    if (!api) return;
    api.permissionsGet().then((res: any) => {
      if (res.success) setPermissions({ profile: res.profile, alsoAllow: res.alsoAllow, denied: res.denied, execAsk: res.execAsk || DEFAULT_EXEC_ASK });
    });
    api.pluginsList?.().then((res: any) => {
      if (res.success && res.entries && typeof res.entries === 'object') setPlugins(res.entries);
    }).catch(() => {});
    api.hooksList?.().then((res: any) => {
      if (res.success && res.hooks && typeof res.hooks === 'object') setHooks(res.hooks);
    }).catch(() => {});
    api.securityCheck?.().then((res: any) => {
      if (res?.issues) setSecurityIssues(res.issues);
    }).catch(() => {});
    setUsageStats(getUsageStats());
    // Run doctor on mount
    runDoctor();

    if (!api.openclawConfigSchema || !api.openclawConfigRead) {
      setWebLoading(false);
      return;
    }

    api.openclawConfigSchema().then(async (schemaResult: any) => {
      if (!schemaResult?.success || !schemaResult.schema) {
        setWebError(schemaResult?.error || 'Failed to load OpenClaw config schema.');
        setWebLoading(false);
        return;
      }

      const valueResult = await api.openclawConfigRead?.('tools.web');
      const nextValues = (valueResult?.success ? valueResult.value : {}) || {};
      setWebValues(nextValues);
      setWebSections(buildDynamicSectionsFromSchema(schemaResult.schema, 'tools.web', nextValues));
      setWebLoading(false);
    }).catch(() => {
      setWebError('Failed to load OpenClaw config schema.');
      setWebLoading(false);
    });
  }, []);

  const runDoctor = async () => {
    setDoctorLoading(true);
    try {
      const report = await (window.electronAPI as any).doctorRun?.();
      if (report) setDoctorReport(report);
    } catch {}
    setDoctorLoading(false);
  };

  const handleFix = async (checkId: string) => {
    setFixingId(checkId);
    try {
      await (window.electronAPI as any).doctorFix?.(checkId);
      // Re-run all checks after fix (fixing one may affect others)
      await runDoctor();
    } catch {}
    setFixingId(null);
  };

  const savePermissions = async (changes: { alsoAllow?: string[]; denied?: string[]; execAsk?: 'off' | 'on-miss' }) => {
    if (!window.electronAPI || !permissions) return;
    const updated = { ...permissions, ...changes, execAsk: changes.execAsk || permissions.execAsk || DEFAULT_EXEC_ASK };
    setPermissions(updated);
    await (window.electronAPI as any).permissionsUpdate(changes);
  };

  const loadWorkspaceFile = async (filename: string) => {
    if (!window.electronAPI) return;
    const res = await (window.electronAPI as any).workspaceReadFile(filename);
    if (res.success) {
      setFileContent(res.content || '');
      setEditingFile(filename);
    } else {
      // File doesn't exist yet — open editor with empty content to allow creating it
      setFileContent('');
      setEditingFile(filename);
    }
  };

  const saveWorkspaceFile = async () => {
    if (!window.electronAPI || !editingFile) return;
    setFileSaving(true);
    const res = await (window.electronAPI as any).workspaceWriteFile(editingFile, fileContent);
    setFileSaving(false);
    if (res?.success !== false) {
      setFileSaveSuccess(true);
      setTimeout(() => { setFileSaveSuccess(false); setEditingFile(null); }, 1500);
    }
  };

  // Check gateway status — only poll when page is visible, reduced frequency
  useEffect(() => {
    checkGateway();
    let interval: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (!interval) interval = setInterval(checkGateway, 30000);
    };
    const stopPolling = () => {
      if (interval) { clearInterval(interval); interval = null; }
    };

    const onVisibility = () => {
      if (document.hidden) { stopPolling(); }
      else { checkGateway(); startPolling(); }
    };

    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) startPolling();

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const checkGateway = async () => {
    if (!window.electronAPI) { setGatewayStatus('stopped'); return; }
    const result = await (window.electronAPI as any).gatewayStatus();
    setGatewayStatus(result.running ? 'running' : 'stopped');
  };

  const handleGatewayAction = async (action: 'start' | 'stop' | 'restart') => {
    setGatewayLoading(true);
    const api = window.electronAPI as any;
    if (action === 'start') await api.gatewayStart();
    else if (action === 'stop') await api.gatewayStop();
    else await api.gatewayRestart();
    await checkGateway();
    setGatewayLoading(false);
  };

  const loadLogs = async () => {
    if (!window.electronAPI) return;
    const result = await (window.electronAPI as any).getRecentLogs();
    setLogs(result.logs || t('settings.gateway.noLogs', 'No logs'));
    setShowLogs(true);
  };

  const currentProvider = allProviders.find((p) => p.key === config.providerKey);
  const currentModel = currentProvider?.models.find((m) => m.id === config.modelId);

  const openModelPicker = () => {
    const currentProfile = getProviderProfile(config, config.providerKey);
    setTempProvider(config.providerKey);
    setTempModel(config.modelId);
    setTempApiKey(currentProfile.apiKey);
    setTempBaseUrl(currentProfile.baseUrl);
    setDetectedProviderKey('');
    setDetectedModels([]);
    setTestResult('idle');
    setShowModelPicker(true);
  };

  const [showRestartHint, setShowRestartHint] = useState(false);

  const saveModelChange = async () => {
    const selectedProvider = allProviders.find((provider) => provider.key === tempProvider);
    if (!selectedProvider) return;

    const modelSource = detectedProviderKey === tempProvider && detectedModels.length > 0
      ? detectedModels
      : selectedProvider.models;

    const effectiveModelId = tempModel || modelSource[0]?.id || '';

    saveProviderConfig({
      providerKey: tempProvider,
      modelId: effectiveModelId,
      apiKey: tempApiKey,
      baseUrl: tempBaseUrl,
      apiType: selectedProvider.apiType,
      name: selectedProvider.name,
      needsKey: selectedProvider.needsKey,
      models: modelSource.map((model) => ({
        id: model.id,
        label: model.label,
        name: model.label,
        ...(typeof (model as any).reasoning === 'boolean' ? { reasoning: (model as any).reasoning } : {}),
        ...(typeof (model as any).contextWindow === 'number' ? { contextWindow: (model as any).contextWindow } : {}),
        ...(typeof (model as any).maxTokens === 'number' ? { maxTokens: (model as any).maxTokens } : {}),
      })),
    }, allProviders);
    await syncConfig(allProviders);
    setShowModelPicker(false);
    setShowRestartHint(true);
    setTimeout(() => setShowRestartHint(false), 8000);
  };

  const discoverModels = async () => {
    const selectedProvider = allProviders.find((provider) => provider.key === tempProvider);
    const api = window.electronAPI as any;
    if (!selectedProvider || !api?.modelsDiscover) return;

    setTestingConnection(true);
    setTestResult('idle');

    try {
      const result = await api.modelsDiscover({
        providerKey: selectedProvider.key,
        baseUrl: tempBaseUrl || selectedProvider.baseUrl,
        apiKey: tempApiKey,
      });

      if (result?.success && Array.isArray(result.models) && result.models.length > 0) {
        const nextModels = result.models.map((model: any) => ({
          id: model.id,
          label: model.name || model.id,
          ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
          ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
          ...(typeof model.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {}),
        }));
        setDetectedProviderKey(selectedProvider.key);
        setDetectedModels(nextModels);
        if (!nextModels.some((model: { id: string }) => model.id === tempModel)) {
          setTempModel(nextModels[0].id);
        }
        setTestResult('success');
      } else {
        setDetectedProviderKey('');
        setDetectedModels([]);
        setTestResult('error');
      }
    } catch {
      setDetectedProviderKey('');
      setDetectedModels([]);
      setTestResult('error');
    }

    setTestingConnection(false);
  };

  const handleToggle = (key: keyof typeof config, value: boolean) => {
    updateConfig({ [key]: value } as any);
    syncConfig(allProviders);
  };

  const handleRecallLimit = (value: number) => {
    updateConfig({ recallLimit: value });
    syncConfig(allProviders);
  };

  const handleWebFieldChange = (path: string, nextValue: any) => {
    setWebValues((prev) => setValueAtPath(prev, path.replace(/^tools\.web\./, ''), nextValue));
    setWebSaved(false);
  };

  const selectedWebProvider = String(webValues?.search?.provider || '').trim();
  const webProviderGuide = WEB_PROVIDER_GUIDANCE[selectedWebProvider];
  const webProviderApiKey = webValues?.search?.apiKey;
  const webProviderMissingKey = !!(webProviderGuide?.requiresKey && (!webProviderApiKey || (typeof webProviderApiKey === 'string' && !webProviderApiKey.trim())));

  const knownAllowed = permissions
    ? KNOWN_ALLOWED_TOOLS.map((tool) => ({ ...tool, enabled: permissions.alsoAllow.includes(tool.id) }))
    : [];
  const allowedNow = knownAllowed.filter((tool) => tool.enabled);
  const availableToAllow = knownAllowed.filter((tool) => !tool.enabled);
  const customAllowed = permissions
    ? permissions.alsoAllow.filter((tool) => !KNOWN_ALLOWED_TOOLS.some((known) => known.id === tool))
    : [];

  const knownDenied = permissions
    ? KNOWN_DENIED_COMMANDS.map((cmd) => ({ ...cmd, blocked: permissions.denied.includes(cmd.id) }))
    : [];
  const blockedNow = knownDenied.filter((cmd) => cmd.blocked);
  const customDenied = permissions
    ? permissions.denied.filter((cmd) => !KNOWN_DENIED_COMMANDS.some((known) => known.id === cmd))
    : [];

  const toggleAllowedTool = (toolId: string) => {
    if (!permissions) return;
    const isOn = permissions.alsoAllow.includes(toolId);
    savePermissions({
      alsoAllow: isOn
        ? permissions.alsoAllow.filter((tool) => tool !== toolId)
        : [...permissions.alsoAllow, toolId],
    });
  };

  const toggleDeniedCommand = (commandId: string) => {
    if (!permissions) return;
    const isOn = permissions.denied.includes(commandId);
    savePermissions({
      denied: isOn
        ? permissions.denied.filter((command) => command !== commandId)
        : [...permissions.denied, commandId],
    });
  };

  const saveWebConfig = async () => {
    const api = window.electronAPI as any;
    if (!api?.openclawConfigWrite) return;
    setWebSaving(true);
    setWebError(null);
    const result = await api.openclawConfigWrite('tools.web', webValues);
    setWebSaving(false);
    if (!result?.success) {
      setWebError(result?.error || 'Failed to save Web settings.');
      return;
    }
    setWebSaved(true);
    setTimeout(() => setWebSaved(false), 2500);
  };

  // Check cloud status on mount
  useEffect(() => {
    const api = window.electronAPI as any;
    api?.cloudStatus?.().then((res: any) => {
      if (res?.success) setCloudMode(res.mode || 'local');
    }).catch(() => {});
  }, []);

  // Cleanup cloud auth polling on unmount
  useEffect(() => {
    return () => { if (cloudPollRef.current) clearTimeout(cloudPollRef.current); };
  }, []);

  const startCloudAuth = async () => {
    const api = window.electronAPI as any;
    if (!api) return;
    setCloudAuthStep('loading');
    const res = await api.cloudAuthStart();
    if (!res?.success || !res.device_code) {
      setCloudAuthStep('error');
      return;
    }
    setCloudDeviceCode(res.device_code);
    setCloudUserCode(res.user_code);
    setCloudVerifyUrl(`${res.verification_uri}?code=${res.user_code}`);
    setCloudAuthStep('waiting');

    // Open browser automatically
    api.openExternal(res.verification_uri + '?code=' + res.user_code);

    // Sequential polling — daemon holds each request up to 30s (long poll),
    // so we use recursive setTimeout to avoid request pileup.
    if (cloudPollRef.current) clearTimeout(cloudPollRef.current);
    const expiresIn = (res.expires_in || 600) * 1000;
    const startTime = Date.now();
    const deviceCode = res.device_code;

    const doPoll = async () => {
      if (Date.now() - startTime > expiresIn) {
        // Don't jump to error — stay on waiting screen so user can click refresh
        return;
      }
      try {
        const poll = await api.cloudAuthPoll(deviceCode);
        // Direct awareness.market response: { status: "approved", api_key: "..." }
        // or { status: "pending" } or { status: "expired" }
        if (poll?.api_key) {
          setCloudApiKey(poll.api_key);
          const memRes = await api.cloudListMemories(poll.api_key);
          const mems = memRes?.memories || [];
          if (mems.length <= 1) {
            const memId = mems[0]?.id || '';
            await api.cloudConnect(poll.api_key, memId);
            setCloudMode('hybrid');
            updateConfig({ memoryMode: 'cloud' });
            syncConfig(allProviders);
            setCloudAuthStep('done');
          } else {
            setCloudMemories(mems);
            setCloudAuthStep('select');
          }
          return; // Stop polling
        }
        if (poll?.status === 'expired' || poll?.status === 'denied') {
          setCloudAuthStep('error');
          return;
        }
      } catch { /* network error, retry */ }
      // Poll every 5s (direct API call, no daemon long-poll)
      cloudPollRef.current = setTimeout(doPoll, 5000);
    };
    // Start first poll after 1s (daemon does its own 30s long-poll internally)
    cloudPollRef.current = setTimeout(doPoll, 1000);
  };

  const selectCloudMemory = async (memoryId: string) => {
    const api = window.electronAPI as any;
    if (!api) return;
    await api.cloudConnect(cloudApiKey, memoryId);
    setCloudMode('hybrid');
    updateConfig({ memoryMode: 'cloud' });
    syncConfig(allProviders);
    setCloudAuthStep('done');
  };

  const handleCloudDisconnect = async () => {
    const api = window.electronAPI as any;
    if (!api) return;
    await api.cloudDisconnect();
    setCloudMode('local');
    updateConfig({ memoryMode: 'local' });
    syncConfig(allProviders);
  };

  const addCustomAllowedTool = () => {
    const toolName = newAllowTool.trim();
    if (!permissions || !toolName || permissions.alsoAllow.includes(toolName)) return;
    savePermissions({ alsoAllow: [...permissions.alsoAllow, toolName] });
    setNewAllowTool('');
  };

  const addCustomDeniedCommand = () => {
    const commandName = newDenyCmd.trim();
    if (!permissions || !commandName || permissions.denied.includes(commandName)) return;
    savePermissions({ denied: [...permissions.denied, commandName] });
    setNewDenyCmd('');
  };

  const selectedTempProvider = allProviders.find((p) => p.key === tempProvider);
  const tempModelOptions = detectedProviderKey === tempProvider && detectedModels.length > 0
    ? detectedModels
    : (selectedTempProvider?.models || []);
  const Section = SettingsSection;
  const Row = SettingsRow;
  const Toggle = SettingsToggle;

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-6 py-4 border-b border-slate-800">
        <h1 className="text-lg font-semibold">⚙️ {t('settings.title')}</h1>
      </div>

      <div className="p-6 space-y-6 max-w-2xl">
        {/* Model */}
        <SettingsSection title={`🤖 ${t('settings.model')}`}>
          <SettingsRow
            label={t('settings.model.currentModel')}
            desc={currentProvider
              ? `${currentProvider.emoji} ${currentProvider.name} / ${currentModel?.label || config.modelId}`
              : t('settings.model.notConfigured')
            }
          >
            <button
              onClick={openModelPicker}
              className="flex items-center gap-1 px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 rounded-lg text-white transition-colors"
            >
              {t('settings.model.change')} <ChevronRight size={12} />
            </button>
          </SettingsRow>
          {config.baseUrl && config.baseUrl !== currentProvider?.baseUrl && (
            <SettingsRow label={t('settings.model.customUrl')} desc={config.baseUrl}>
              <button
                onClick={() => { updateConfig({ baseUrl: '' }); syncConfig(allProviders); }}
                className="text-xs text-slate-500 hover:text-red-400"
              >
                {t('settings.model.resetDefault')}
              </button>
            </SettingsRow>
          )}
        </SettingsSection>

        {/* Model change restart hint */}
        {showRestartHint && (
          <div className="flex items-center gap-2 p-3 bg-amber-600/10 border border-amber-600/20 rounded-xl text-xs text-amber-400">
            <AlertTriangle size={14} />
            <span>{t('settings.model.restartHint')}</span>
          </div>
        )}

        <SettingsSection title="🌐 Web & Browser">
          <div className="p-4 space-y-4">
            <div className="text-xs text-slate-500">
              Configure OpenClaw web search and browser-adjacent capabilities directly from Desktop. This form is generated from the OpenClaw config schema, so supported fields track the installed OpenClaw version.
            </div>

            {webProviderGuide && (
              <div className={`rounded-xl border px-3 py-3 text-xs ${webProviderMissingKey ? 'border-amber-500/30 bg-amber-500/10 text-amber-200' : 'border-sky-500/20 bg-sky-500/10 text-sky-100'}`}>
                <div className="font-medium mb-1">{webProviderGuide.title}</div>
                <div className="opacity-80">{webProviderGuide.detail}</div>
                {webProviderMissingKey && <div className="mt-2 text-amber-300">Current status: provider selected, but credential is still missing.</div>}
              </div>
            )}

            {webLoading ? (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Loader2 size={12} className="animate-spin" />
                Loading OpenClaw capability schema...
              </div>
            ) : webSections.length > 0 ? (
              <>
                <OpenClawConfigSectionForm
                  sections={webSections}
                  values={Object.fromEntries(
                    webSections
                      .flatMap((section) => section.fields)
                      .map((field) => [field.path, getValueAtPath({ tools: { web: webValues } }, field.path)]),
                  )}
                  onChange={handleWebFieldChange}
                />

                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs text-slate-500">
                    OpenClaw hot-reloads most `tools.web` changes. Browser or web search fixes should not require a manual restart.
                  </div>
                  <div className="flex items-center gap-3">
                    {webSaved && <span className="text-xs text-emerald-400">Saved to OpenClaw</span>}
                    <button
                      onClick={saveWebConfig}
                      disabled={webSaving}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-lg text-white transition-colors"
                    >
                      {webSaving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                      Save Web Settings
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="text-xs text-slate-500">This OpenClaw version does not expose a dynamic web capability schema yet.</div>
            )}

            {webError && (
              <div className="text-xs text-red-400 bg-red-950/30 border border-red-900/50 rounded-lg px-3 py-2">
                {webError}
              </div>
            )}
          </div>
        </SettingsSection>

        {/* Memory */}
        <SettingsSection title={`🧠 ${t('settings.memory')}`}>
          <SettingsRow label={t('settings.memory.autoCapture')} desc={t('settings.memory.autoCapture.desc')}>
            <SettingsToggle checked={config.autoCapture} onChange={(v) => handleToggle('autoCapture', v)} />
          </SettingsRow>
          <SettingsRow label={t('settings.memory.autoRecall')} desc={t('settings.memory.autoRecall.desc')}>
            <SettingsToggle checked={config.autoRecall} onChange={(v) => handleToggle('autoRecall', v)} />
          </SettingsRow>
          <SettingsRow label={t('settings.memory.recallCount')} desc={t('settings.memory.recallCount.desc')}>
            <div className="flex items-center gap-3">
              <input
                type="range" min={1} max={20}
                value={config.recallLimit}
                onChange={(e) => handleRecallLimit(parseInt(e.target.value))}
                className="w-24 accent-brand-500"
              />
              <span className="text-sm text-slate-300 w-6 text-right">{config.recallLimit}</span>
            </div>
          </SettingsRow>
          <SettingsRow label={t('settings.memory.storage')} desc={t('settings.memory.storage.desc')}>
            <div className="flex bg-slate-700 rounded-lg overflow-hidden">
              {(['local', 'cloud'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => {
                    updateConfig({ memoryMode: mode });
                    if (mode === 'cloud' && cloudMode !== 'hybrid' && cloudMode !== 'cloud') {
                      setShowCloudAuth(true);
                      setCloudAuthStep('init');
                      setTimeout(() => startCloudAuth(), 100);
                    }
                  }}
                  className={`px-3 py-1.5 text-xs transition-colors ${config.memoryMode === mode ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  {t(`settings.memory.${mode}`)}
                </button>
              ))}
            </div>
          </SettingsRow>
          {/* Cloud connection status */}
          {config.memoryMode === 'cloud' && (
            <SettingsRow label="" desc="">
              <div className="w-full">
                {cloudMode === 'hybrid' || cloudMode === 'cloud' ? (
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                      <Cloud size={14} /> {t('settings.memory.cloud.connected')}
                    </span>
                    <button
                      onClick={handleCloudDisconnect}
                      className="text-xs text-red-400/70 hover:text-red-400 px-2 py-1 rounded hover:bg-red-600/10 transition-colors"
                    >
                      {t('settings.memory.cloud.disconnect')}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setShowCloudAuth(true); setCloudAuthStep('init'); setTimeout(() => startCloudAuth(), 100); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors"
                  >
                    <ExternalLink size={12} /> {t('settings.memory.cloud.connect')}
                  </button>
                )}
              </div>
            </SettingsRow>
          )}
        </SettingsSection>

        {/* Memory Privacy */}
        <SettingsSection title={`🔒 ${t('settings.privacy', 'Memory Privacy')}`}>
          <div className="p-4 space-y-3">
            <p className="text-xs text-slate-500">{t('settings.privacy.desc', 'Choose which sources are allowed to save conversations to memory.')}</p>
            {[
              { id: 'desktop', label: t('settings.privacy.desktop', 'Desktop Chat'), emoji: '💬' },
              { id: 'openclaw-telegram', label: 'Telegram', emoji: '✈️' },
              { id: 'openclaw-whatsapp', label: 'WhatsApp', emoji: '📱' },
              { id: 'openclaw-discord', label: 'Discord', emoji: '🎮' },
              { id: 'openclaw-slack', label: 'Slack', emoji: '💼' },
              { id: 'openclaw-wechat', label: 'WeChat', emoji: '💚' },
              { id: 'mcp', label: t('settings.privacy.devTools', 'Dev Tools (Claude Code / IDE)'), emoji: '🛠️' },
            ].map(({ id, label, emoji }) => {
              const blocked = config.memoryBlockedSources || [];
              const isAllowed = !blocked.includes(id);
              return (
                <div key={id} className="flex items-center justify-between py-1.5">
                  <div className="flex items-center gap-2 text-sm">
                    <span>{emoji}</span>
                    <span className="text-slate-300">{label}</span>
                  </div>
                  <SettingsToggle
                    checked={isAllowed}
                    onChange={(v) => {
                      const next = v
                        ? blocked.filter((s: string) => s !== id)
                        : [...blocked, id];
                      updateConfig({ memoryBlockedSources: next });
                      syncConfig(allProviders);
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div className="px-4 pb-4">
            <button
              onClick={async () => {
                if (!confirm(t('settings.privacy.clearConfirm', 'Delete ALL local memories? This cannot be undone.'))) return;
                try {
                  const resp = await fetch('http://127.0.0.1:37800/api/v1/knowledge/cleanup', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ patterns: ['.*'] }),
                  });
                  if (resp.ok) alert(t('settings.privacy.cleared', 'All knowledge cards deleted.'));
                  else alert(t('settings.privacy.clearFailed', 'Failed to clear memories.'));
                } catch {
                  alert(t('settings.privacy.clearFailed', 'Failed to clear memories. Is the daemon running?'));
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-600/10 rounded-lg transition-colors"
            >
              <Trash2 size={12} />
              {t('settings.privacy.clearAll', 'Delete All Knowledge Cards')}
            </button>
          </div>
        </SettingsSection>

        {/* Token Optimization */}
        <SettingsSection title={`💰 ${t('settings.token')}`}>
          <SettingsRow label={t('settings.token.thinkingLevel')} desc={t('settings.token.thinkingLevel.desc')}>
            <select
              value={config.thinkingLevel || 'low'}
              onChange={(e) => { updateConfig({ thinkingLevel: e.target.value as any }); }}
              className="px-3 py-1.5 bg-slate-700 rounded-lg text-sm border-none focus:outline-none focus:ring-2 focus:ring-brand-500/50"
            >
              <option value="off">{t('settings.token.thinkingOff')}</option>
              <option value="minimal">{t('settings.token.thinkingMinimal')}</option>
              <option value="low">{t('settings.token.thinkingLow')}</option>
              <option value="medium">{t('settings.token.thinkingMedium')}</option>
              <option value="high">{t('settings.token.thinkingHigh')}</option>
            </select>
          </SettingsRow>
          <SettingsRow label={t('settings.token.recallLimit')} desc={t('settings.token.recallLimit.desc')}>
            <div className="flex items-center gap-3">
              <input
                type="range" min={1} max={20}
                value={config.recallLimit}
                onChange={(e) => handleRecallLimit(parseInt(e.target.value))}
                className="w-24 accent-brand-500"
              />
              <span className="text-sm text-slate-300 w-6 text-right">{config.recallLimit}</span>
            </div>
          </SettingsRow>
          <SettingsRow label={t('settings.token.estimate')} desc={t('settings.token.estimate.desc')}>
            <span className="text-xs text-slate-400 font-mono">
              ~{(() => {
                const recallTokens = config.autoRecall ? config.recallLimit * 200 : 0;
                const thinkingTokens = { off: 0, minimal: 100, low: 300, medium: 800, high: 2000 }[config.thinkingLevel || 'low'] || 300;
                return `${((recallTokens + thinkingTokens + 500) / 1000).toFixed(1)}k`;
              })()}
              {' '}{t('settings.token.overhead')}
            </span>
          </SettingsRow>
        </SettingsSection>

        {/* Appearance */}
        <SettingsSection title={`🎨 ${t('settings.appearance')}`}>
          <SettingsRow label={t('settings.language')}>
            <select
              value={config.language}
              onChange={(e) => updateConfig({ language: e.target.value })}
              className="px-3 py-1.5 bg-slate-700 rounded-lg text-sm border-none focus:outline-none focus:ring-2 focus:ring-brand-500/50"
            >
              <option value="zh">🇨🇳 中文</option>
              <option value="en">🇺🇸 English</option>
              <option value="ja">🇯🇵 日本語</option>
              <option value="ko">🇰🇷 한국어</option>
            </select>
          </SettingsRow>
          <SettingsRow label={t('settings.theme')}>
            <div className="flex bg-slate-700 rounded-lg overflow-hidden">
              {([
                { key: 'light' as const, icon: Sun, labelKey: 'settings.theme.light' },
                { key: 'dark' as const, icon: Moon, labelKey: 'settings.theme.dark' },
                { key: 'system' as const, icon: Monitor, labelKey: 'settings.theme.system' },
              ]).map(({ key, icon: Icon, labelKey }) => (
                <button
                  key={key}
                  onClick={() => updateConfig({ theme: key })}
                  className={`px-3 py-1.5 text-xs flex items-center gap-1 ${config.theme === key ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  <Icon size={12} /> {t(labelKey)}
                </button>
              ))}
            </div>
          </SettingsRow>
        </SettingsSection>

        {/* Permissions */}
        {permissions && (
          <SettingsPermissionsPanel
            t={t}
            permissions={permissions}
            presets={(Object.entries(PERMISSION_PRESETS) as [PresetKey, typeof PERMISSION_PRESETS[PresetKey]][]).map(([key, preset]) => ({ key, preset }))}
            activePreset={detectPreset()}
            allowedNow={allowedNow}
            availableToAllow={availableToAllow}
            customAllowed={customAllowed}
            blockedNow={blockedNow}
            customDenied={customDenied}
            knownAllowedTools={KNOWN_ALLOWED_TOOLS}
            knownDeniedCommands={KNOWN_DENIED_COMMANDS}
            showAdvancedPerms={showAdvancedPerms}
            newAllowTool={newAllowTool}
            newDenyCmd={newDenyCmd}
            onApplyPreset={(key) => applyPreset(key as PresetKey)}
            onToggleAllowedTool={toggleAllowedTool}
            onToggleDeniedCommand={toggleDeniedCommand}
            onSaveExecAsk={(mode) => savePermissions({ execAsk: mode })}
            onToggleAdvanced={() => setShowAdvancedPerms((value) => !value)}
            onNewAllowToolChange={setNewAllowTool}
            onNewDenyCmdChange={setNewDenyCmd}
            onAddCustomAllowed={addCustomAllowedTool}
            onAddCustomDenied={addCustomDeniedCommand}
          />
        )}

        {/* System Health (Doctor) */}
        <SettingsSection title={`🩺 ${t('settings.health', 'System Health')}`}>
          <div className="p-4 space-y-2">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-slate-500">{t('settings.health.desc', 'Automatic diagnostics for OpenClaw and AwarenessClaw')}</p>
              <button onClick={runDoctor} disabled={doctorLoading}
                className="flex items-center gap-1 px-2.5 py-1 text-xs bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-slate-300">
                {doctorLoading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                {t('settings.health.recheck', 'Re-check')}
              </button>
            </div>
            {doctorLoading && !doctorReport && (
              <div className="flex items-center gap-2 text-xs text-slate-400 py-4 justify-center">
                <Loader2 size={14} className="animate-spin" />
                {t('settings.health.checking', 'Running diagnostics...')}
              </div>
            )}
            {doctorReport && (
              <>
                {doctorReport.summary.fail === 0 && doctorReport.summary.warn === 0 && (
                  <div className="flex items-center gap-2 text-xs p-2 rounded-lg bg-emerald-500/10 text-emerald-400">
                    <CheckCircle size={14} className="shrink-0" />
                    <p>{t('settings.health.allGood', 'All systems operational')}</p>
                  </div>
                )}
                {doctorReport.checks.map((check: any) => (
                  <div key={check.id} className={`flex items-center gap-3 p-2.5 rounded-lg text-xs ${
                    check.status === 'pass' ? 'bg-emerald-500/5 text-emerald-400' :
                    check.status === 'warn' ? 'bg-amber-500/10 text-amber-400' :
                    check.status === 'fail' ? 'bg-red-500/10 text-red-400' :
                    'bg-slate-800/50 text-slate-500'
                  }`}>
                    <span className="shrink-0">
                      {check.status === 'pass' ? '✅' : check.status === 'warn' ? '⚠️' : check.status === 'fail' ? '❌' : '⏭️'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="font-medium">{check.label}</span>
                      <span className="ml-2 text-slate-400">{check.message}</span>
                      {check.fixable === 'manual' && check.fixDescription && (
                        <p className="text-[10px] text-slate-500 mt-0.5 font-mono break-all">{check.fixDescription}</p>
                      )}
                    </div>
                    {check.fixable === 'auto' && (
                      <button onClick={() => handleFix(check.id)} disabled={fixingId === check.id}
                        className="shrink-0 px-2.5 py-1 bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700 text-white rounded text-[10px] font-medium">
                        {fixingId === check.id ? <Loader2 size={10} className="animate-spin" /> : t('settings.health.fix', 'Fix')}
                      </button>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </SettingsSection>

        {/* Security Audit */}
        <SettingsSection title={`🔒 ${t('settings.security') || 'Security Audit'}`}>
          <div className="p-4 space-y-2">
            {securityIssues.length === 0 ? (
              <div className="flex items-center gap-2 text-xs p-2 rounded-lg bg-emerald-500/10 text-emerald-400">
                <CheckCircle size={14} className="shrink-0" />
                <p>{t('settings.security.allGood', 'No security issues found')}</p>
              </div>
            ) : (
              securityIssues.map((issue, i) => (
                <div key={i} className={`flex items-start gap-2 text-xs p-2 rounded-lg ${
                  issue.level === 'warning' ? 'bg-amber-500/10 text-amber-400' : 'bg-slate-800 text-slate-400'
                }`}>
                  {issue.level === 'warning' ? <AlertTriangle size={14} className="mt-0.5 shrink-0" /> : <Shield size={14} className="mt-0.5 shrink-0" />}
                  <div>
                    <p>{issue.message}</p>
                    {issue.fix && <code className="mt-1 block text-[10px] text-slate-500 bg-slate-900 px-2 py-1 rounded">{issue.fix}</code>}
                  </div>
                </div>
              ))
            )}
          </div>
        </SettingsSection>

        {/* Plugins */}
        {Object.keys(plugins).length > 0 && (
          <SettingsSection title={`🧩 Plugins (${Object.keys(plugins).length})`}>
            {Object.entries(plugins).map(([name, cfg]) => {
              const enabled = cfg?.enabled !== false;
              return (
                <SettingsRow key={name} label={name}>
                  <SettingsToggle checked={enabled} onChange={async (v) => {
                    setPlugins(prev => ({ ...prev, [name]: { ...prev[name], enabled: v } }));
                    // Write back to openclaw.json
                    const api = window.electronAPI as any;
                    await api.pluginsToggle?.(name, v);
                  }} />
                </SettingsRow>
              );
            })}
          </SettingsSection>
        )}

        {/* Hooks */}
        {Object.keys(hooks).length > 0 && (
          <SettingsSection title={`🪝 Hooks (${Object.keys(hooks).length})`}>
            {Object.entries(hooks).map(([hookName, hookCfg]) => {
              const enabled = hookCfg?.enabled !== false;
              const subEntries = hookCfg?.entries ? Object.entries(hookCfg.entries) : [];
              return (
                <div key={hookName} className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
                      <Webhook size={12} /> {hookName}
                    </div>
                    <SettingsToggle checked={enabled} onChange={async (v) => {
                      setHooks(prev => ({ ...prev, [hookName]: { ...prev[hookName], enabled: v } }));
                      const api = window.electronAPI as any;
                      await api.hooksToggle?.(hookName, v);
                    }} />
                  </div>
                  {subEntries.length > 0 && (
                    <div className="ml-4 space-y-1 border-l border-slate-700/50 pl-3">
                      {subEntries.map(([subName, subCfg]) => (
                        <div key={subName} className="flex items-center justify-between gap-2 py-0.5">
                          <code className="text-[11px] font-mono text-slate-500 truncate flex-1">{subName}</code>
                          <span className={`text-[10px] ${(subCfg as any)?.enabled !== false ? 'text-emerald-500' : 'text-slate-600'}`}>
                            {(subCfg as any)?.enabled !== false ? t('common.on', 'on') : t('common.off', 'off')}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </SettingsSection>
        )}

        {/* Workspace */}
        <SettingsSection title={`📋 ${t('settings.workspace')}`}>
          {['SOUL.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md', 'AGENTS.md'].map(file => {
            const descMap: Record<string, string> = {
              'SOUL.md': t('settings.workspace.personality'),
              'USER.md': t('settings.workspace.userInfo'),
              'IDENTITY.md': t('settings.workspace.identity'),
              'TOOLS.md': t('settings.workspace.tools'),
              'AGENTS.md': t('settings.workspace.agents'),
            };
            return (
            <SettingsRow key={file} label={file} desc={descMap[file] || ''}>

              <button
                onClick={() => loadWorkspaceFile(file)}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded-lg text-slate-300 transition-colors"
              >
                {t('common.edit')} <ChevronRight size={12} />
              </button>
            </SettingsRow>
            );
          })}
        </SettingsSection>

        {/* Workspace file editor modal */}
        {editingFile && (
          <SettingsModalShell
            title={<span className="font-semibold text-sm">{editingFile}</span>}
            onClose={() => setEditingFile(null)}
            maxWidthClass="max-w-3xl"
            zIndexClass="z-[60]"
            paddingClass="p-0"
            footer={(
              <div className="flex items-center justify-end gap-2 p-4">
                {fileSaveSuccess && (
                  <span className="flex items-center gap-1 text-xs text-emerald-400 mr-2">
                    <CheckCircle size={14} /> {t('common.saved', 'Saved')}
                  </span>
                )}
                <button onClick={() => setEditingFile(null)} className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200">{t('common.cancel')}</button>
                <button
                  onClick={saveWorkspaceFile}
                  disabled={fileSaving || fileSaveSuccess}
                  className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700 text-white rounded-lg text-sm transition-colors flex items-center gap-1"
                >
                  {fileSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {t('common.save')}
                </button>
              </div>
            )}
          >
              <textarea
                value={fileContent}
                onChange={e => setFileContent(e.target.value)}
                className="flex-1 p-4 bg-slate-950 text-sm font-mono text-slate-300 leading-relaxed resize-none focus:outline-none min-h-[400px]"
                spellCheck={false}
              />
          </SettingsModalShell>
        )}

        {/* Gateway Management */}
        <SettingsSection title={`🖥️ ${t('settings.gateway')}`}>
          <SettingsRow
            label={t('settings.gateway.label', 'OpenClaw Gateway')}
            desc={t(`settings.gateway.status.${gatewayStatus}`)}
          >
            <div className="flex items-center gap-2">
              {gatewayLoading ? (
                <Loader2 size={14} className="animate-spin text-brand-400" />
              ) : (
                <>
                  {gatewayStatus === 'stopped' && (
                    <button
                      onClick={() => handleGatewayAction('start')}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors"
                    >
                      <Play size={10} /> {t('settings.gateway.start')}
                    </button>
                  )}
                  {gatewayStatus === 'running' && (
                    <>
                      <button
                        onClick={() => handleGatewayAction('restart')}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition-colors"
                      >
                        <RotateCw size={10} /> {t('settings.gateway.restart')}
                      </button>
                      <button
                        onClick={() => handleGatewayAction('stop')}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg transition-colors"
                      >
                        <Square size={10} /> {t('settings.gateway.stop')}
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          </SettingsRow>
          <SettingsRow label={t('settings.gateway.logs')} desc={t('settings.gateway.logs.desc')}>
            <button
              onClick={loadLogs}
              className="flex items-center gap-1 px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded-lg text-slate-300 transition-colors"
            >
              {t('settings.gateway.viewLogs')} <ChevronRight size={12} />
            </button>
          </SettingsRow>
        </SettingsSection>

        {/* System */}
        <SettingsSection title={`🔧 ${t('settings.system')}`}>
          <SettingsRow label={t('settings.autoUpdate')} desc={t('settings.autoUpdate.desc')}>
            <SettingsToggle checked={config.autoUpdate} onChange={(v) => updateConfig({ autoUpdate: v })} />
          </SettingsRow>
          <SettingsRow label={t('settings.bootStart')} desc={t('settings.bootStart.desc')}>
            <SettingsToggle checked={config.autoStart} onChange={async (v) => {
              updateConfig({ autoStart: v });
              if (window.electronAPI) {
                await (window.electronAPI as any).setLoginItem(v);
              }
            }} />
          </SettingsRow>
          <SettingsRow label={t('settings.diagnostic')} desc={t('settings.diagnostic.desc')}>
            <button
              onClick={async () => {
                if (!window.electronAPI) return;
                const env = await (window.electronAPI as any).detectEnvironment();
                const info = [
                  `${t('settings.diagnostic.platform')}: ${env.platform} ${env.arch}`,
                  `${t('settings.diagnostic.nodejs')}: ${env.systemNodeVersion || t('settings.diagnostic.notInstalled')}`,
                  `${t('settings.diagnostic.openclaw')}: ${env.openclawVersion || t('settings.diagnostic.notInstalled')}`,
                  `${t('settings.diagnostic.configFile')}: ${env.hasExistingConfig ? t('settings.diagnostic.exists') : t('settings.diagnostic.notExists')}`,
                ].join('\n');
                alert(info);
              }}
              className="flex items-center gap-1 px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded-lg text-slate-300 transition-colors"
            >
              {t('settings.diagnostic.run')} <ChevronRight size={12} />
            </button>
          </SettingsRow>
          <SettingsRow label={t('settings.export')} desc={t('settings.export.desc')}>
            <button
              onClick={async () => {
                if (!window.electronAPI) return;
                const result = await (window.electronAPI as any).configExport();
                if (result.success) alert(`${t('settings.export.success')}\n${result.path}`);
                else if (result.error !== 'Cancelled') alert(`${t('settings.export.failed')} ${result.error}`);
              }}
              className="flex items-center gap-1 px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded-lg text-slate-300 transition-colors"
            >
              <Download size={12} /> {t('settings.export')}
            </button>
          </SettingsRow>
          <SettingsRow label={t('settings.import')} desc={t('settings.import.desc')}>
            <button
              onClick={async () => {
                if (!window.electronAPI) return;
                const result = await (window.electronAPI as any).configImport();
                if (result.success) {
                  alert(t('settings.import.success'));
                  window.location.reload();
                } else if (result.error !== 'Cancelled') {
                  const msg = result.error === 'Invalid config file format'
                    ? t('settings.import.formatError', 'Invalid config file. Please use a file exported from AwarenessClaw.')
                    : `${t('settings.import.failed')} ${result.error}`;
                  alert(msg);
                }
              }}
              className="flex items-center gap-1 px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded-lg text-slate-300 transition-colors"
            >
              <Upload size={12} /> {t('settings.import')}
            </button>
          </SettingsRow>
          <SettingsRow label={t('settings.reset')} desc={t('settings.reset.desc')}>
            <button
              onClick={() => { localStorage.removeItem('awareness-claw-setup-done'); window.location.reload(); }}
              className="px-3 py-1.5 text-xs bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg transition-colors"
            >
              {t('settings.reset.btn')}
            </button>
          </SettingsRow>
        </SettingsSection>

        {/* Log Viewer Modal */}
        {showLogs && (
          <SettingsModalShell
            title={`📋 ${t('settings.gateway.logs')}`}
            onClose={() => setShowLogs(false)}
            maxWidthClass="max-w-3xl"
            maxHeightClass="max-h-[80vh]"
            paddingClass="p-0"
          >
              <pre className="flex-1 overflow-auto p-4 text-xs font-mono text-slate-300 bg-slate-950 whitespace-pre-wrap">
                {logs}
              </pre>
          </SettingsModalShell>
        )}

        {/* Usage Stats Panel */}
        {usageStats && usageStats.totalMessages > 0 && (
          <SettingsUsagePanel
            usageStats={usageStats}
            t={t}
            onClear={() => {
              if (confirm(t('settings.usage.clearConfirm', 'Clear all usage data? This cannot be undone.'))) {
                clearUsage();
                setUsageStats(getUsageStats());
              }
            }}
          />
        )}

        <SettingsVersionPanel
          packageVersion={pkg.version}
          versionInfo={versionInfo}
          t={t}
          onOpenGithub={() => window.electronAPI?.openExternal('https://github.com/edwin-hao-ai/AwarenessClaw')}
        />
      </div>

      {/* === Model Picker Modal === */}
      {showModelPicker && (
        <SettingsModalShell
          title={`🤖 ${t('settings.model.change')}`}
          onClose={() => setShowModelPicker(false)}
          footer={(
            <div className="flex justify-end gap-3 p-5">
              <button
                onClick={() => setShowModelPicker(false)}
                className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => { void saveModelChange(); }}
                disabled={!tempProvider || (selectedTempProvider?.needsKey && !tempApiKey)}
                className="px-5 py-2 bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-xl text-sm font-medium transition-colors flex items-center gap-1"
              >
                <Check size={14} /> {t('common.save')}
              </button>
            </div>
          )}
        >
            <div className="space-y-4">
              {/* Provider grid */}
              <div className="grid grid-cols-3 gap-2">
                {allProviders.map((p) => (
                  <button
                    key={p.key}
                    onClick={() => {
                      const profile = getProviderProfile(config, p.key);
                      const restoredModels = profile.models?.length
                        ? profile.models.map((model) => ({ id: model.id, label: model.label || model.name || model.id }))
                        : [];
                      setTempProvider(p.key);
                      setTempModel(p.key === config.providerKey ? config.modelId : (profile.models[0]?.id || p.models[0]?.id || ''));
                      setTempApiKey(profile.apiKey);
                      setTempBaseUrl(profile.baseUrl);
                      setDetectedProviderKey(restoredModels.length > 0 ? p.key : '');
                      setDetectedModels(restoredModels);
                      setTestResult('idle');
                    }}
                    className={`p-3 rounded-xl text-left transition-all border text-xs ${
                      tempProvider === p.key
                        ? 'border-brand-500 bg-brand-600/10'
                        : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-0.5">
                      <span>{p.emoji}</span>
                      <span className="font-medium text-sm">{p.name}</span>
                    </div>
                    <span className="text-slate-500">{p.tag}</span>
                  </button>
                ))}
              </div>

              {/* Selected provider config */}
              {selectedTempProvider && (
                <div className="space-y-3 p-4 bg-slate-800/50 rounded-xl animate-fade-in">
                  {/* API Key */}
                  {selectedTempProvider.needsKey && (
                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1">🔑 {t('settings.model.apiKey', 'API Key')}</label>
                      <PasswordInput
                        value={tempApiKey}
                        onChange={(e) => setTempApiKey(e.target.value)}
                        placeholder={t('common.pasteApiKey', 'Paste your API Key...')}
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm focus:outline-none focus:border-brand-500"
                      />
                    </div>
                  )}

                  {/* Model selector */}
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">{t('settings.model.selectModel')}</label>
                    <div className="flex gap-2 flex-wrap">
                      {tempModelOptions.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => setTempModel(m.id)}
                          className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${
                            tempModel === m.id ? 'bg-brand-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                          }`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Base URL */}
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">{t('settings.model.baseUrl', 'API Base URL')}</label>
                    <input
                      type="text"
                      value={tempBaseUrl || selectedTempProvider.baseUrl}
                      onChange={(e) => setTempBaseUrl(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-xs font-mono focus:outline-none focus:border-brand-500"
                    />
                    <p className="text-xs text-slate-600 mt-1">{t('settings.model.baseUrlHint')}</p>
                  </div>

                  {/* Test Connection */}
                  {selectedTempProvider.needsKey && tempApiKey && (
                    <div className="flex items-center gap-3 pt-2 border-t border-slate-700/50">
                      <button
                        onClick={discoverModels}
                        disabled={testingConnection}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition-colors"
                      >
                        {testingConnection ? <Loader2 size={12} className="animate-spin" /> : '🔗'} {t('settings.model.discoverModels', 'Test & Refresh Models')}
                      </button>
                      {testResult === 'success' && <span className="text-xs text-emerald-400">{t('settings.model.detectSuccess', 'Model list updated')}</span>}
                      {testResult === 'error' && <span className="text-xs text-red-400">{t('settings.model.detectFailed', 'Could not fetch models, please check API Key / Base URL')}</span>}
                    </div>
                  )}
                </div>
              )}
            </div>
        </SettingsModalShell>
      )}
      {/* Cloud Auth Modal */}
      {showCloudAuth && (
        <SettingsModalShell
          title={(
            <span className="flex items-center gap-2">
              <Cloud size={20} className="text-brand-400" />
              {t('settings.memory.cloud.authTitle')}
            </span>
          )}
          onClose={() => {
            setShowCloudAuth(false);
            if (cloudPollRef.current) clearTimeout(cloudPollRef.current);
          }}
          maxWidthClass="max-w-md"
          zIndexClass="z-[60]"
          paddingClass="p-6"
        >

            {(cloudAuthStep === 'init' || cloudAuthStep === 'loading') && (
              <div className="space-y-4 text-center py-4">
                <Loader2 size={28} className="animate-spin text-brand-400 mx-auto" />
                <p className="text-sm text-slate-400">{t('settings.memory.cloud.connecting')}</p>
              </div>
            )}

            {cloudAuthStep === 'waiting' && (
              <div className="space-y-4 text-center">
                <p className="text-sm text-slate-400">{t('settings.memory.cloud.authDesc')}</p>
                <div className="bg-slate-800 rounded-xl p-4">
                  <p className="text-xs text-slate-500 mb-1">{t('settings.memory.cloud.code')}</p>
                  <p className="text-2xl font-mono font-bold text-brand-400 tracking-widest">{cloudUserCode}</p>
                </div>
                <button
                  onClick={() => (window.electronAPI as any)?.openExternal?.(cloudVerifyUrl)}
                  className="flex items-center justify-center gap-2 w-full py-2 bg-brand-600 hover:bg-brand-500 text-sm text-white rounded-xl transition-colors"
                >
                  <ExternalLink size={14} /> {t('settings.memory.cloud.openBrowser')}
                </button>
                <div className="flex items-center justify-center gap-2 text-xs text-slate-500">
                  <Loader2 size={12} className="animate-spin" /> {t('settings.memory.cloud.waiting')}
                </div>
                <button
                  onClick={() => { if (cloudPollRef.current) clearTimeout(cloudPollRef.current); startCloudAuth(); }}
                  className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                >
                  {t('settings.memory.cloud.refreshCode', 'Code expired? Get a new one')}
                </button>
              </div>
            )}

            {cloudAuthStep === 'select' && (
              <div className="space-y-3">
                <p className="text-sm text-slate-400">{t('settings.memory.cloud.selectMemory')}</p>
                {cloudMemories.map(mem => (
                  <button
                    key={mem.id}
                    onClick={() => selectCloudMemory(mem.id)}
                    className="w-full flex items-center gap-3 p-3 bg-slate-800 hover:bg-slate-700 rounded-xl text-left transition-colors"
                  >
                    <span className="text-brand-400">🧠</span>
                    <div>
                      <p className="text-sm text-slate-200">{mem.name || mem.id}</p>
                      <p className="text-[10px] text-slate-500 font-mono">{mem.id.slice(0, 8)}...</p>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {cloudAuthStep === 'done' && (
              <div className="text-center space-y-3 py-4">
                <CheckCircle size={40} className="mx-auto text-emerald-400" />
                <p className="text-sm text-emerald-400">{t('settings.memory.cloud.success')}</p>
                <button
                  onClick={() => setShowCloudAuth(false)}
                  className="px-6 py-2 bg-brand-600 hover:bg-brand-500 text-white text-sm rounded-xl transition-colors"
                >
                  OK
                </button>
              </div>
            )}

            {cloudAuthStep === 'error' && (
              <div className="text-center space-y-3 py-4">
                <CloudOff size={40} className="mx-auto text-red-400" />
                <p className="text-sm text-red-400">{t('settings.memory.cloud.failed')}</p>
                <button
                  onClick={() => { setCloudAuthStep('init'); }}
                  className="px-6 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-xl transition-colors"
                >
                  {t('common.retry', 'Retry')}
                </button>
              </div>
            )}
        </SettingsModalShell>
      )}
    </div>
  );
}
