import fs from 'fs';
import path from 'path';
import { normalizePluginAllow, GATEWAY_DEFAULTS, writeDesktopExecApprovalDefaults } from '../openclaw-config';
import { safeWriteJsonFile } from '../json-file';

export const OPENCLAW_INSTALL_TIMEOUT_MS = 300000;
export const WEB_DNS_CANARY_DOMAINS = ['example.com', 'openclaw.ai'];
export const CHANNEL_BINDINGS_CHECK_TIMEOUT_MS = 45000;

// Native npm install — no managed prefix
export function getNpmInstallCommand(packageName = 'openclaw') {
  return `npm install -g ${packageName}`;
}

export function getNullDevice(platform: NodeJS.Platform) {
  return platform === 'win32' ? 'NUL' : '/dev/null';
}

export function persistAwarenessPluginConfig(homedir: string) {
  const configDir = path.join(homedir, '.openclaw');
  const configPath = path.join(configDir, 'openclaw.json');
  fs.mkdirSync(configDir, { recursive: true });

  let config: Record<string, any> = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    config = {};
  }

  if (!config.plugins) config.plugins = {};
  config.gateway = {
    ...(config.gateway || {}),
    mode: GATEWAY_DEFAULTS.mode,
    bind: config.gateway?.bind || GATEWAY_DEFAULTS.bind,
    port: Number(config.gateway?.port) || GATEWAY_DEFAULTS.port,
  };
  if (!config.plugins.entries) config.plugins.entries = {};
  config.plugins.entries['openclaw-memory'] = {
    ...(config.plugins.entries['openclaw-memory'] || {}),
    enabled: true,
    config: {
      ...(config.plugins.entries['openclaw-memory']?.config || {}),
      autoRecall: true,
      autoCapture: true,
      recallLimit: 8,
      localUrl: 'http://127.0.0.1:37800',
      baseUrl: 'https://awareness.market/api/v1',
      embeddingLanguage: 'multilingual',
    },
  };
  config.plugins.allow = Array.from(new Set([...(normalizePluginAllow(config.plugins.allow) || []), 'openclaw-memory']));
  config.plugins.slots = { ...(config.plugins.slots || {}), memory: 'openclaw-memory' };
  if (config.plugins.entries['memory-awareness']) delete config.plugins.entries['memory-awareness'];
  if (Array.isArray(config.plugins.allow)) {
    config.plugins.allow = config.plugins.allow.filter((pluginId: string) => pluginId !== 'memory-awareness');
    if (config.plugins.allow.length === 0) delete config.plugins.allow;
  }

  safeWriteJsonFile(configPath, config);
  writeDesktopExecApprovalDefaults(homedir);
}
