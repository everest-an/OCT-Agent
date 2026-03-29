import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Mock image imports (vitest doesn't handle static assets)
vi.mock('../assets/logo.png', () => ({ default: 'logo.png' }));
vi.mock('../assets/logo.svg', () => ({ default: 'logo.svg' }));

// Mock DOM APIs not available in jsdom
Element.prototype.scrollIntoView = vi.fn();
HTMLElement.prototype.scrollIntoView = vi.fn();

// Mock clipboard
Object.assign(navigator, {
  clipboard: { writeText: vi.fn(() => Promise.resolve()) },
});

// Mock Electron API for tests
Object.defineProperty(window, 'electronAPI', {
  value: {
    getPlatform: () => Promise.resolve('darwin'),
    openExternal: () => Promise.resolve(),
    getDashboardUrl: () => Promise.resolve({ url: null }),
    detectEnvironment: () => Promise.resolve({
      platform: 'darwin',
      arch: 'arm64',
      home: '/Users/test',
      systemNodeInstalled: true,
      systemNodeVersion: 'v22.0.0',
      npmInstalled: true,
      openclawInstalled: true,
      openclawVersion: '2026.3.23',
      hasExistingConfig: true,
    }),
    installNodeJs: () => Promise.resolve({ success: true, alreadyInstalled: true }),
    installOpenClaw: () => Promise.resolve({ success: true }),
    installPlugin: () => Promise.resolve({ success: true }),
    startDaemon: () => Promise.resolve({ success: true }),
    saveConfig: () => Promise.resolve({ success: true }),
    openAuthUrl: () => Promise.resolve(),
    readExistingConfig: () => Promise.resolve({
      exists: true,
      hasProviders: true,
      providers: ['qwen-portal'],
      primaryModel: 'qwen-portal/qwen-turbo',
      hasApiKey: true,
    }),
    chatSend: (msg: string) => Promise.resolve({
      success: true,
      text: `Mock response to: ${msg}`,
      sessionId: 'test-session',
    }),
    onChatStream: () => {},
    onChatStatus: () => {},
    checkUpdates: () => Promise.resolve({ updates: [] }),
    channelSave: () => Promise.resolve({ success: true }),
    channelTest: () => Promise.resolve({ success: true }),
    cronList: () => Promise.resolve({ jobs: [] }),
    cronAdd: () => Promise.resolve({ success: true }),
    cronRemove: () => Promise.resolve({ success: true }),
    gatewayStatus: () => Promise.resolve({ running: true }),
    gatewayStart: () => Promise.resolve({ success: true }),
    gatewayStop: () => Promise.resolve({ success: true }),
    gatewayRestart: () => Promise.resolve({ success: true }),
    getRecentLogs: () => Promise.resolve({ logs: 'Test log output' }),
    memorySearch: () => Promise.resolve({ result: { content: [{ text: '[]' }] } }),
    memoryGetCards: () => Promise.resolve({ error: 'mock: daemon not connected' }),
  },
  writable: true,
});
