import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { act } from 'react';
import SetupWizard from '../pages/Setup';

const updateConfig = vi.fn();
const syncConfig = vi.fn().mockResolvedValue(undefined);
const saveProviderConfig = vi.fn((_input, _providers) => ({
  providerKey: 'openai',
  providerProfiles: {
    openai: {
      apiKey: 'sk-test',
      models: [{ id: 'gpt-5', label: 'GPT-5' }],
      baseUrl: '',
    },
  },
}));

vi.mock('../lib/store', async () => {
  const actual = await vi.importActual<object>('../lib/store');
  return {
    ...actual,
    MODEL_PROVIDERS: [
      {
        key: 'openai',
        name: 'OpenAI',
        tag: 'Hosted',
        desc: 'Hosted model provider',
        needsKey: true,
        apiType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        models: [{ id: 'gpt-5', label: 'GPT-5' }],
      },
    ],
    getProviderProfile: () => ({ apiKey: '', baseUrl: '', models: [] }),
    useAppConfig: () => ({
      config: { language: 'en', providerKey: 'openai', providerProfiles: {} },
      updateConfig,
      syncConfig,
      saveProviderConfig,
    }),
  };
});

vi.mock('../lib/i18n', () => ({
  useI18n: () => ({
    t: (_key: string, fallback?: string) => fallback || _key,
    locale: 'en',
  }),
}));

function makeElectronApi() {
  return {
    detectEnvironment: vi.fn().mockResolvedValue({
      systemNodeInstalled: true,
      openclawInstalled: true,
      hasExistingConfig: false,
    }),
    installOpenClaw: vi.fn().mockResolvedValue({ success: true, alreadyInstalled: true }),
    installNodeJs: vi.fn().mockResolvedValue({ success: true, alreadyInstalled: true }),
    installPlugin: vi.fn().mockResolvedValue({ success: true }),
    startDaemon: vi.fn().mockResolvedValue({ success: true }),
    bootstrap: vi.fn().mockResolvedValue({ success: true }),
    readExistingConfig: vi.fn().mockResolvedValue({ hasProviders: false }),
    workspaceGetActive: vi.fn().mockResolvedValue({ success: true, path: '/Users/test/project-a' }),
    workspaceSetActive: vi.fn().mockResolvedValue({ success: true }),
    selectDirectory: vi.fn().mockResolvedValue({ directoryPath: '/Users/test/project-b' }),
    setDaemonAutostart: vi.fn().mockResolvedValue({ success: true }),
    invoke: vi.fn().mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'cloud:auth-start') {
        return {
          success: true,
          user_code: 'SETUP-1234',
          verification_uri: 'https://awareness.market/activate',
          verification_url: 'https://awareness.market/activate?code=SETUP-1234',
          device_code: 'device-setup',
          interval: 0.01,
          is_headless: true,
        };
      }
      if (channel === 'cloud:auth-poll') {
        return { api_key: 'setup-api-key' };
      }
      if (channel === 'cloud:get-profile') {
        return { success: true, email: 'setup@example.com' };
      }
      if (channel === 'cloud:list-memories') {
        return { memories: [{ id: 'mem-setup', name: 'Setup Memory', card_count: 12 }] };
      }
      if (channel === 'cloud:connect') {
        return { success: true, args };
      }
      if (channel === 'shell:openExternal') {
        return { success: true };
      }
      return null;
    }),
  };
}

describe('SetupWizard 7-step flow', () => {
  const onComplete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'electronAPI', { value: makeElectronApi(), writable: true });
    localStorage.clear();
  });

  it('walks through welcome → installing → model → workspace → memory → cloudauth → done', { timeout: 15000 }, async () => {
    render(<SetupWizard onComplete={onComplete} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /setup\.welcome\.start/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/setup\.model\.title/i)).toBeInTheDocument();
    }, { timeout: 5000 });

    fireEvent.click(screen.getByText('OpenAI'));
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/setup\.apiKey\.placeholder/i), { target: { value: 'sk-test' } });
      fireEvent.click(screen.getByRole('button', { name: /setup\.next/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/choose your default project folder/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /use this folder/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/setup\.memory\.title/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /setup\.memory\.cloud/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /setup\.next/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/connect your awareness cloud account/i)).toBeInTheDocument();
    }, { timeout: 5000 });

    await waitFor(() => {
      expect(screen.getByText('Setup Memory')).toBeInTheDocument();
    }, { timeout: 5000 });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm.*sync/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/setup\.done\.title/i)).toBeInTheDocument();
      expect(screen.getByText(/setup@example.com/i)).toBeInTheDocument();
      expect(screen.getByText(/setup memory/i)).toBeInTheDocument();
    }, { timeout: 5000 });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /setup\.done\.start/i }));
    });

    expect(onComplete).toHaveBeenCalled();
  });
});
