import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import Dashboard from '../pages/Dashboard';

describe('Dashboard - model and file attachment', () => {
  beforeEach(() => {
    localStorage.clear();
    // Set config with a model
    localStorage.setItem('awareness-claw-config', JSON.stringify({
      language: 'en',
      providerKey: 'qwen-portal',
      modelId: 'qwen-turbo-latest',
      apiKey: 'test-key',
      thinkingLevel: 'low',
    }));
  });

  it('passes model to chatSend', async () => {
    const chatSendFn = vi.fn(() => Promise.resolve({
      success: true,
      text: 'response',
      sessionId: 'test',
    }));

    const origApi = (window as any).electronAPI;
    (window as any).electronAPI = {
      ...origApi,
      chatSend: chatSendFn,
    };

    await act(async () => { render(<Dashboard />); });

    const textarea = screen.getByPlaceholderText(/message|输入/) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'hello' } });
    });

    // Find send button
    const buttons = screen.getAllByRole('button');
    const sendBtn = buttons[buttons.length - 1];
    await act(async () => { fireEvent.click(sendBtn); });

    await waitFor(() => {
      expect(chatSendFn).toHaveBeenCalled();
      const args = chatSendFn.mock.calls[0] as any[];
      // args[0] = message, args[1] = sessionId, args[2] = options
      const options = args[2];
      // Model is NOT passed per-message — OpenClaw reads from openclaw.json, not --model flag
      expect(options.thinkingLevel).toBe('low');
    });

    (window as any).electronAPI = origApi;
  });

  it('does not append file paths to message text', async () => {
    const chatSendFn = vi.fn(() => Promise.resolve({
      success: true,
      text: 'response',
      sessionId: 'test',
    }));

    const origApi = (window as any).electronAPI;
    (window as any).electronAPI = {
      ...origApi,
      chatSend: chatSendFn,
    };

    await act(async () => { render(<Dashboard />); });

    const textarea = screen.getByPlaceholderText(/message|输入/) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'check this file' } });
    });

    const buttons = screen.getAllByRole('button');
    const sendBtn = buttons[buttons.length - 1];
    await act(async () => { fireEvent.click(sendBtn); });

    await waitFor(() => {
      expect(chatSendFn).toHaveBeenCalled();
      const message = (chatSendFn.mock.calls[0] as any[])[0];
      // Message should NOT contain [附件:
      expect(message).not.toContain('[附件');
      expect(message).toBe('check this file');
    });

    (window as any).electronAPI = origApi;
  });
});
