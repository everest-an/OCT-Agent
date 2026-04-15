import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DashboardHeader } from '../components/dashboard/DashboardHeader';

const providers = [
  {
    key: 'qwen',
    name: 'Qwen',
    emoji: 'q',
    needsKey: true,
    models: [
      { id: 'qwen-plus-latest', label: 'Qwen Plus' },
      { id: 'qwen-max-latest', label: 'Qwen Max' },
    ],
  },
  {
    key: 'openai',
    name: 'OpenAI',
    emoji: 'o',
    needsKey: true,
    models: [{ id: 'gpt-4o', label: 'GPT-4o' }],
  },
];

function renderHeader(configOverrides?: Record<string, any>) {
  const config = {
    providerKey: 'qwen',
    modelId: 'qwen-plus-latest',
    providerProfiles: {
      qwen: { apiKey: 'qwen-key', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [] },
      openai: { apiKey: 'openai-key', baseUrl: 'https://api.openai.com/v1', models: [] },
    },
    ...configOverrides,
  };

  render(
    <DashboardHeader
      t={(_key, fallback) => fallback || _key}
      logoUrl="/logo.png"
      showSidebar
      projectRoot=""
      projectRootName=""
      config={config}
      allProviders={providers}
      showModelSelector
      onToggleSidebar={vi.fn()}
      onSelectProjectRoot={vi.fn()}
      onToggleModelSelector={vi.fn()}
      onCloseModelSelector={vi.fn()}
      onNavigateModels={vi.fn()}
      onSelectModel={vi.fn()}
      onOpenDashboard={vi.fn()}
      dashboardOpening={false}
    />,
  );
}

describe('DashboardHeader', () => {
  it('shows models from all providers in the quick model switcher', () => {
    renderHeader();

    expect(screen.getByText('Qwen')).toBeInTheDocument();
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('Open Models to switch provider')).toBeInTheDocument();
    expect(screen.getAllByText('Qwen Plus')).toHaveLength(2);
    expect(screen.getByText('Qwen Max')).toBeInTheDocument();
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
  });

  it('shows the full current model id when the current provider catalog does not have a matching label', () => {
    renderHeader({ modelId: 'vanchin/deepseek-v3.1-terminus' });

    expect(screen.getByRole('button', { name: /vanchin\/deepseek-v3\.1-terminus/i })).toBeInTheDocument();
  });
});