import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import Models from '../pages/Models';

// Helper: wait for a button to appear then click it (handles async rendering under parallel execution)
async function waitAndClick(name: RegExp) {
  await waitFor(() => {
    expect(screen.getByRole('button', { name })).toBeInTheDocument();
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

describe('Models Page', () => {
  let originalElectronAPI: any;

  beforeEach(() => {
    originalElectronAPI = { ...(window as any).electronAPI };
    localStorage.clear();
    localStorage.setItem('awareness-claw-config', JSON.stringify({
      language: 'en',
      providerKey: 'openai',
      modelId: 'gpt-4o',
      providerProfiles: {
        openai: {
          apiKey: 'sk-openai',
          baseUrl: 'https://api.openai.com/v1',
          models: [{ id: 'gpt-4o', label: 'GPT-4o' }],
        },
      },
    }));
  });

  afterEach(() => {
    cleanup();
    (window as any).electronAPI = originalElectronAPI;
  });

  it('renders the standalone models page and current model summary', async () => {
    await act(async () => { render(<Models />); });
    expect(screen.getByRole('heading', { name: /Models/i })).toBeInTheDocument();
    expect(screen.getAllByText(/OpenAI/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/gpt-4o/i).length).toBeGreaterThan(0);
  });

  it('allows adding a custom provider and saving a discovered model through providerProfiles', async () => {
    const saveConfigMock = vi.fn().mockResolvedValue({ success: true });
    const modelsDiscoverMock = vi.fn().mockResolvedValue({
      success: true,
      models: [{ id: 'proxy-model-1', name: 'Proxy Model 1' }],
    });
    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      saveConfig: saveConfigMock,
      modelsReadProviders: () => Promise.resolve({ success: true, providers: [], primaryModel: '' }),
      modelsDiscover: modelsDiscoverMock,
    };

    await act(async () => { render(<Models />); });

    await waitAndClick(/Add Custom Provider/i);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('My Provider')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('My Provider'), { target: { value: 'Proxy Hub' } });
      fireEvent.change(screen.getByPlaceholderText('https://api.example.com/v1'), { target: { value: 'https://proxy.example/v1' } });
      fireEvent.change(screen.getByPlaceholderText('Paste your API Key...'), { target: { value: 'proxy-key' } });
      fireEvent.click(screen.getByRole('button', { name: /Refresh from OpenClaw/i }));
    });

    await waitFor(() => {
      expect(modelsDiscoverMock).toHaveBeenCalled();
      expect(screen.getByText('Proxy Model 1')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save & Activate/i }));
    });

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('awareness-claw-config') || '{}');
      expect(stored.providerKey).toBe('proxy-hub');
      expect(stored.modelId).toBe('proxy-model-1');
      expect(stored.providerProfiles['proxy-hub']).toBeDefined();
      expect(stored.providerProfiles['proxy-hub'].baseUrl).toBe('https://proxy.example/v1');
      expect(stored.providerProfiles['proxy-hub'].models[0].id).toBe('proxy-model-1');
    });

    expect(saveConfigMock).toHaveBeenCalled();
  });

  it('refreshes a provider catalog from OpenClaw and preserves manual models', async () => {
    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      modelsReadProviders: () => Promise.resolve({ success: true, providers: [], primaryModel: '' }),
      modelsDiscover: vi.fn().mockResolvedValue({
        success: true,
        models: [{ id: 'gpt-4.1', name: 'GPT-4.1' }],
      }),
    };

    await act(async () => { render(<Models />); });

    await waitAndClick(/OpenAI/i);

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Add model ID, for example gpt-4.1-mini'), { target: { value: 'manual-model' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add Model/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Refresh from OpenClaw/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/Model list refreshed/i)).toBeInTheDocument();
      expect(screen.getByText('manual-model')).toBeInTheDocument();
      expect(screen.getByText('GPT-4.1')).toBeInTheDocument();
    });
  });

  it('filters obviously unrelated models during refresh', async () => {
    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      modelsReadProviders: () => Promise.resolve({ success: true, providers: [], primaryModel: '' }),
      modelsDiscover: vi.fn().mockResolvedValue({
        success: true,
        models: [
          { id: 'gpt-4.1', name: 'GPT-4.1' },
          { id: 'text-embedding-3-large', name: 'text-embedding-3-large' },
          { id: 'tts-1', name: 'tts-1' },
        ],
      }),
    };

    await act(async () => { render(<Models />); });

    await waitAndClick(/OpenAI/i);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Refresh from OpenClaw/i }));
    });

    await waitFor(() => {
      expect(screen.getByText('GPT-4.1')).toBeInTheDocument();
    });

    expect(screen.queryByText('text-embedding-3-large')).not.toBeInTheDocument();
    expect(screen.queryByText('tts-1')).not.toBeInTheDocument();
  });

  it('does not perpetuate historically polluted model ids during refresh', async () => {
    localStorage.setItem('awareness-claw-config', JSON.stringify({
      language: 'en',
      providerKey: 'openai',
      modelId: 'deepseek-v3',
      providerProfiles: {
        openai: {
          apiKey: 'sk-openai',
          baseUrl: 'https://api.openai.com/v1',
          models: [
            { id: 'deepseek-v3', label: 'deepseek-v3' },
            { id: 'gpt-4o', label: 'GPT-4o' },
          ],
        },
      },
    }));

    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      modelsReadProviders: () => Promise.resolve({ success: true, providers: [], primaryModel: '' }),
      modelsDiscover: vi.fn().mockResolvedValue({
        success: true,
        models: [
          { id: 'gpt-4.1', name: 'GPT-4.1' },
        ],
      }),
    };

    await act(async () => { render(<Models />); });
    await waitAndClick(/OpenAI/i);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Refresh from OpenClaw/i }));
    });

    await waitFor(() => {
      expect(screen.getByText('GPT-4.1')).toBeInTheDocument();
    });

    expect(screen.queryByText('deepseek-v3', { selector: '.text-sm.font-medium.text-slate-100.truncate' })).not.toBeInTheDocument();
  });

  it('does not auto-activate cross-vendor models returned by a mixed endpoint', async () => {
    localStorage.setItem('awareness-claw-config', JSON.stringify({
      language: 'en',
      providerKey: 'qwen',
      modelId: 'qwen-plus-latest',
      providerProfiles: {
        qwen: {
          apiKey: 'qwen-key',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          models: [{ id: 'qwen-plus-latest', label: 'Qwen Plus' }],
        },
      },
    }));

    const saveConfigMock = vi.fn().mockResolvedValue({ success: true });
    const modelsDiscoverMock = vi.fn().mockResolvedValue({
      success: true,
      models: [{ id: 'vanchin/deepseek-v3', name: 'DeepSeek V3' }],
    });

    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      saveConfig: saveConfigMock,
      modelsReadProviders: () => Promise.resolve({ success: true, providers: [], primaryModel: '' }),
      modelsDiscover: modelsDiscoverMock,
    };

    await act(async () => { render(<Models />); });
    await waitAndClick(/Qwen/i);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Refresh from OpenClaw/i }));
    });

    await waitFor(() => {
      expect(modelsDiscoverMock).toHaveBeenCalled();
      expect(screen.getByText(/other vendors/i)).toBeInTheDocument();
    });

    expect(screen.queryByText('DeepSeek V3')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save & Activate/i }));
    });

    await waitFor(() => {
      expect(saveConfigMock).toHaveBeenCalled();
    });

    const stored = JSON.parse(localStorage.getItem('awareness-claw-config') || '{}');
    expect(stored.providerKey).toBe('qwen');
    expect(stored.modelId).toBe('qwen-plus-latest');
    expect(stored.providerProfiles.qwen.models.some((model: { id: string }) => model.id === 'vanchin/deepseek-v3')).toBe(false);
  });

  it('accepts network-discovered models when the endpoint provides matching provider ownership metadata', async () => {
    localStorage.setItem('awareness-claw-config', JSON.stringify({
      language: 'en',
      providerKey: 'qwen',
      modelId: 'qwen-plus-latest',
      providerProfiles: {
        qwen: {
          apiKey: 'qwen-key',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          models: [{ id: 'qwen-plus-latest', label: 'Qwen Plus' }],
        },
      },
    }));

    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      modelsReadProviders: () => Promise.resolve({ success: true, providers: [], primaryModel: '' }),
      modelsDiscover: vi.fn().mockResolvedValue({
        success: true,
        models: [{ id: 'wan2.2-t2v-turbo', name: 'Wan 2.2 Turbo', ownedBy: 'qwen' }],
      }),
    };

    await act(async () => { render(<Models />); });
    await waitAndClick(/Qwen/i);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Refresh from OpenClaw/i }));
    });

    await waitFor(() => {
      expect(screen.getByText('Wan 2.2 Turbo')).toBeInTheDocument();
    });
  });

  it('updates the api type preset immediately for an existing provider', async () => {
    await act(async () => { render(<Models />); });

    await waitAndClick(/OpenAI/i);

    expect(screen.getByRole('combobox', { name: 'API Type' })).toHaveValue('openai-completions');

    await act(async () => {
      fireEvent.change(screen.getByRole('combobox', { name: 'API Type' }), { target: { value: 'anthropic' } });
    });

    expect(screen.getByRole('combobox', { name: 'API Type' })).toHaveValue('anthropic');
    expect(screen.getByText(/Anthropic-style request and header conventions/i)).toBeInTheDocument();
  });

  it('persists edited baseUrl for existing provider after save and rerender', async () => {
    const saveConfigMock = vi.fn().mockResolvedValue({ success: true });
    const modelsDiscoverMock = vi.fn().mockResolvedValue({
      success: true,
      models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
    });
    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      saveConfig: saveConfigMock,
      modelsReadProviders: () => Promise.resolve({ success: true, providers: [], primaryModel: '' }),
      modelsDiscover: modelsDiscoverMock,
    };

    const { unmount } = render(<Models />);

    await waitAndClick(/OpenAI/i);

    await act(async () => {
      fireEvent.change(screen.getByLabelText('API Base URL'), {
        target: { value: 'https://ai-gateway.vercel.sh/v1' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Refresh from OpenClaw/i }));
    });

    await waitFor(() => {
      expect(modelsDiscoverMock).toHaveBeenCalled();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save & Activate/i }));
    });

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('awareness-claw-config') || '{}');
      expect(stored.providerProfiles.openai.baseUrl).toBe('https://ai-gateway.vercel.sh/v1');
      expect(stored.baseUrl).toBe('https://ai-gateway.vercel.sh/v1');
    });

    unmount();

    await act(async () => {
      render(<Models />);
    });

    await waitAndClick(/OpenAI/i);

    expect(screen.getByLabelText('API Base URL')).toHaveValue('https://ai-gateway.vercel.sh/v1');
    expect(saveConfigMock).toHaveBeenCalled();
  });

  it('keeps presets simple and allows custom api types in advanced settings', async () => {
    await act(async () => { render(<Models />); });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add Custom Provider/i }));
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('My Provider'), { target: { value: 'Anthropic Proxy' } });
      fireEvent.change(screen.getByPlaceholderText('https://api.example.com/v1'), { target: { value: 'https://anthropic-proxy.example/v1' } });
      fireEvent.change(screen.getByPlaceholderText('Paste your API Key...'), { target: { value: 'proxy-key' } });
      fireEvent.change(screen.getByRole('combobox', { name: 'API Type' }), { target: { value: 'anthropic' } });
    });

    expect(screen.getByText(/Anthropic-style request and header conventions/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Advanced Settings/i }));
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Custom API type'), { target: { value: 'proxy-anthropic' } });
    });

    expect(screen.getByLabelText('Custom API type')).toHaveValue('proxy-anthropic');
  });

  it('blocks saving until endpoint validation succeeds for a custom endpoint', async () => {
    const saveConfigMock = vi.fn().mockResolvedValue({ success: true });
    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      saveConfig: saveConfigMock,
      modelsReadProviders: () => Promise.resolve({ success: true, providers: [], primaryModel: '' }),
      modelsDiscover: vi.fn().mockResolvedValue({
        success: true,
        models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
      }),
    };

    await act(async () => { render(<Models />); });

    await waitAndClick(/OpenAI/i);

    await act(async () => {
      fireEvent.change(screen.getByLabelText('API Base URL'), {
        target: { value: 'https://ai-gateway.vercel.sh/v1' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save & Activate/i }));
    });

    expect(screen.getByText(/Endpoint not validated yet/i)).toBeInTheDocument();
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it('does not auto-save provider selection during silent endpoint validation', async () => {
    const saveConfigMock = vi.fn().mockResolvedValue({ success: true });
    const modelsDiscoverMock = vi.fn().mockResolvedValue({
      success: true,
      models: [{ id: 'gpt-4.1', name: 'GPT-4.1' }],
    });

    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      saveConfig: saveConfigMock,
      modelsReadProviders: () => Promise.resolve({ success: true, providers: [], primaryModel: '' }),
      modelsDiscover: modelsDiscoverMock,
    };

    await act(async () => { render(<Models />); });
    await waitAndClick(/OpenAI/i);

    await act(async () => {
      fireEvent.change(screen.getByLabelText('API Base URL'), {
        target: { value: 'https://ai-gateway.vercel.sh/v1' },
      });
    });

    await waitFor(() => {
      expect(modelsDiscoverMock).toHaveBeenCalled();
    });

    expect(saveConfigMock).not.toHaveBeenCalled();

    const stored = JSON.parse(localStorage.getItem('awareness-claw-config') || '{}');
    expect(stored.providerKey).toBe('openai');
    expect(stored.modelId).toBe('gpt-4o');
  });
});