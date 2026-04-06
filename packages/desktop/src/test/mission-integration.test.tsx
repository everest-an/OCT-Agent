/**
 * Integration test for Mission (multi-agent workflow).
 *
 * Simulates the full flow:
 * 1. User enters goal → mission created
 * 2. Gateway events fire → streaming text appears
 * 3. Sub-agent spawned → step dynamically added
 * 4. Sub-agent completes → step marked done
 * 5. Main agent completes → mission done with result
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import TaskCenter from '../pages/TaskCenter';

// Mock Gateway responses
const mockMissionStart = vi.fn().mockResolvedValue({ success: true, sessionKey: 'ac-mission-test' });
const mockOnMissionProgress = vi.fn();

// Capture the progress callback so we can simulate events
let progressCallback: ((data: any) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
  progressCallback = null;

  mockOnMissionProgress.mockImplementation((callback: any) => {
    progressCallback = callback;
    return () => { progressCallback = null; };
  });

  (window as any).electronAPI = {
    agentsList: vi.fn().mockResolvedValue({
      agents: [
        { id: 'main', name: 'Main', emoji: '🤖', isDefault: true },
        { id: 'coder', name: 'Coder', emoji: '💻' },
        { id: 'tester', name: 'QA Tester', emoji: '🧪' },
      ],
    }),
    workflowConfig: vi.fn().mockResolvedValue({
      maxSpawnDepth: 2, maxChildrenPerAgent: 5, agentToAgentEnabled: true,
    }),
    workflowEnableCollaboration: vi.fn().mockResolvedValue({ success: true }),
    missionStart: mockMissionStart,
    missionCancel: vi.fn(),
    onMissionProgress: mockOnMissionProgress,
    onTaskStatusUpdate: vi.fn().mockReturnValue(() => {}),
    onTaskSubagentLinked: vi.fn().mockReturnValue(() => {}),
    taskPickDirectory: vi.fn().mockResolvedValue({ cancelled: false, path: '/Users/test/project' }),
  };
});

describe('Mission Integration', () => {
  it('creates mission and shows planning state', async () => {
    render(<TaskCenter />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/What do you want your team to do/)).toBeTruthy();
    });

    // Enter goal
    const textarea = screen.getByPlaceholderText(/What do you want your team to do/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Build a login page' } });

    // Submit
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(mockMissionStart).toHaveBeenCalledTimes(1);
    });

    // Verify mission was created with correct params
    const call = mockMissionStart.mock.calls[0][0];
    expect(call.goal).toBe('Build a login page');
    expect(call.agents).toHaveLength(3);
    expect(call.agents.map((a: any) => a.id)).toEqual(['main', 'coder', 'tester']);
  });

  it('shows streaming text from Gateway delta events', async () => {
    render(<TaskCenter />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/What do you want/)).toBeTruthy();
    });

    const textarea = screen.getByPlaceholderText(/What do you want/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Build login' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(mockMissionStart).toHaveBeenCalled();
    });

    const missionId = mockMissionStart.mock.calls[0][0].missionId;

    // Click the mission card to see detail
    await waitFor(() => {
      const card = screen.getByText('Build login');
      fireEvent.click(card);
    });

    // Simulate streaming delta from Gateway
    expect(progressCallback).toBeTruthy();
    act(() => {
      progressCallback!({ missionId, streamDelta: 'Analyzing task...' });
    });

    await waitFor(() => {
      expect(screen.getByText(/Analyzing task/)).toBeTruthy();
    });

    // More streaming
    act(() => {
      progressCallback!({ missionId, streamDelta: ' I will spawn the coder agent.' });
    });

    await waitFor(() => {
      expect(screen.getByText(/spawn the coder/)).toBeTruthy();
    });
  });

  it('dynamically adds steps when sub-agents are spawned', async () => {
    render(<TaskCenter />);

    await waitFor(() => expect(screen.getByPlaceholderText(/What do you want/)).toBeTruthy());

    const textarea = screen.getByPlaceholderText(/What do you want/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Fix bug' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(mockMissionStart).toHaveBeenCalled());
    const missionId = mockMissionStart.mock.calls[0][0].missionId;

    // Click the mission card
    await waitFor(() => {
      const card = screen.getByText('Fix bug');
      fireEvent.click(card);
    });

    // Initially: no steps, just planning indicator
    expect(screen.getByText(/AI is analyzing/)).toBeTruthy();

    // Simulate sub-agent spawn event
    act(() => {
      progressCallback!({
        missionId,
        newStep: {
          agentId: 'coder',
          agentName: 'Coder',
          agentEmoji: '💻',
          sessionKey: 'agent:coder:subagent:abc123',
          status: 'running',
          startedAt: new Date().toISOString(),
        },
      });
    });

    // Step should appear (multiple elements with "Coder" text = role + agentName)
    await waitFor(() => {
      expect(screen.getAllByText('Coder').length).toBeGreaterThan(0);
    });

    // Simulate step completion
    act(() => {
      progressCallback!({
        missionId,
        stepUpdate: {
          sessionKey: 'agent:coder:subagent:abc123',
          status: 'done',
          result: 'Fixed the login validation bug.',
          completedAt: new Date().toISOString(),
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Done')).toBeTruthy();
    });
  });

  it('shows final result when mission completes', async () => {
    render(<TaskCenter />);

    await waitFor(() => expect(screen.getByPlaceholderText(/What do you want/)).toBeTruthy());

    const textarea = screen.getByPlaceholderText(/What do you want/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Review code' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(mockMissionStart).toHaveBeenCalled());
    const missionId = mockMissionStart.mock.calls[0][0].missionId;

    // Click mission card
    await waitFor(() => {
      const card = screen.getByText('Review code');
      fireEvent.click(card);
    });

    // Simulate mission completion
    act(() => {
      progressCallback!({
        missionId,
        streamDelta: null,
        missionPatch: {
          status: 'done',
          completedAt: new Date().toISOString(),
          result: 'Code review complete. Found 2 issues and fixed them.',
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/Code review complete/)).toBeTruthy();
      expect(screen.getByText('Summary')).toBeTruthy();
    });
  });

  it('shows error when mission fails', async () => {
    render(<TaskCenter />);

    await waitFor(() => expect(screen.getByPlaceholderText(/What do you want/)).toBeTruthy());

    const textarea = screen.getByPlaceholderText(/What do you want/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Deploy' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(mockMissionStart).toHaveBeenCalled());
    const missionId = mockMissionStart.mock.calls[0][0].missionId;

    await waitFor(() => {
      const card = screen.getByText('Deploy');
      fireEvent.click(card);
    });

    // Simulate failure
    act(() => {
      progressCallback!({
        missionId,
        missionPatch: {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: 'Gateway error: connection refused',
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/Gateway error/)).toBeTruthy();
    });
  });

  it('selects workspace directory', async () => {
    render(<TaskCenter />);

    await waitFor(() => {
      expect(screen.getByText(/Select workspace/)).toBeTruthy();
    });

    // Click workspace selector
    fireEvent.click(screen.getByText(/Select workspace/));

    await waitFor(() => {
      // After picking directory, it should show the folder name
      expect(screen.getByText('project')).toBeTruthy();
    });

    // Submit goal with workspace
    const textarea = screen.getByPlaceholderText(/What do you want/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Build feature' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(mockMissionStart).toHaveBeenCalled();
      const call = mockMissionStart.mock.calls[0][0];
      expect(call.workDir).toBe('/Users/test/project');
    });
  });
});
