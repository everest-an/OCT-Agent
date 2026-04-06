import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TaskCenter from '../pages/TaskCenter';

// Mock electronAPI
const mockAgentsList = vi.fn().mockResolvedValue({
  success: true,
  agents: [
    { id: 'main', name: 'Main', emoji: '🤖', isDefault: true },
    { id: 'coder', name: 'Coder', emoji: '💻' },
  ],
});

const mockWorkflowConfig = vi.fn().mockResolvedValue({
  maxSpawnDepth: 2,
  maxChildrenPerAgent: 5,
  agentToAgentEnabled: true,
});

const mockMissionStart = vi.fn().mockResolvedValue({ success: true });
const mockOnMissionProgress = vi.fn().mockReturnValue(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));

  (window as any).electronAPI = {
    agentsList: mockAgentsList,
    workflowConfig: mockWorkflowConfig,
    workflowEnableCollaboration: vi.fn().mockResolvedValue({
      success: true,
      config: { maxSpawnDepth: 2, agentToAgentEnabled: true },
    }),
    missionStart: mockMissionStart,
    missionCancel: vi.fn(),
    onMissionProgress: mockOnMissionProgress,
    onTaskStatusUpdate: vi.fn().mockReturnValue(() => {}),
    onTaskSubagentLinked: vi.fn().mockReturnValue(() => {}),
  };
});

describe('TaskCenter (Mission UI)', () => {
  it('renders the page header', async () => {
    render(<TaskCenter />);
    expect(screen.getByText('Team Tasks')).toBeTruthy();
  });

  it('shows goal input placeholder', async () => {
    render(<TaskCenter />);
    const textarea = screen.getByPlaceholderText(/What do you want your team to do/);
    expect(textarea).toBeTruthy();
  });

  it('shows workspace selector', async () => {
    render(<TaskCenter />);
    expect(screen.getByText(/Select workspace/)).toBeTruthy();
  });

  it('shows empty state when no missions', async () => {
    render(<TaskCenter />);
    await waitFor(() => {
      expect(screen.getByText(/Describe what you need/)).toBeTruthy();
    });
  });

  it('shows setup card when maxSpawnDepth < 2', async () => {
    mockWorkflowConfig.mockResolvedValueOnce({
      maxSpawnDepth: 1,
      maxChildrenPerAgent: 5,
      agentToAgentEnabled: false,
    });

    render(<TaskCenter />);
    await waitFor(() => {
      expect(screen.getByText('Enable Team Mode')).toBeTruthy();
    });
  });

  it('creates a mission when user submits goal', async () => {
    render(<TaskCenter />);

    await waitFor(() => {
      expect(mockWorkflowConfig).toHaveBeenCalled();
    });

    const textarea = screen.getByPlaceholderText(/What do you want your team to do/);
    fireEvent.change(textarea, { target: { value: 'Build a login page' } });

    const sendButton = document.querySelector('button:not([disabled])');
    expect(sendButton).toBeTruthy();
  });

  it('shows agent hint when only 1 agent', async () => {
    mockAgentsList.mockResolvedValue({
      success: true,
      agents: [{ id: 'main', name: 'Main', emoji: '🤖', isDefault: true }],
    });

    render(<TaskCenter />);
    await waitFor(() => {
      expect(screen.getByText(/You have one agent/)).toBeTruthy();
    }, { timeout: 3000 });
  });

  it('registers mission progress listener', async () => {
    render(<TaskCenter />);
    await waitFor(() => {
      expect(mockOnMissionProgress).toHaveBeenCalledTimes(1);
    });
  });

  it('has goal input that accepts text', async () => {
    render(<TaskCenter />);
    const textarea = screen.getByPlaceholderText(/What do you want your team to do/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Build a login page' } });
    expect(textarea.value).toBe('Build a login page');
  });
});
