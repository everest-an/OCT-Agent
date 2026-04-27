import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import Channels from '../pages/Channels';

describe('Channels Page', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('awareness-claw-config', JSON.stringify({ language: 'en' }));
  });

  it('renders channels header', async () => {
    await act(async () => { render(<Channels />); });
    expect(screen.getByText(/Channels/)).toBeInTheDocument();
  });

  it('renders local chat as connected', async () => {
    await act(async () => { render(<Channels />); });
    expect(screen.getByText(/Local Chat/)).toBeInTheDocument();
  });

  it('renders configured channels as connected', async () => {
    await act(async () => { render(<Channels />); });
    await waitFor(() => {
      const telegramElements = screen.getAllByText('Telegram');
      expect(telegramElements.length).toBeGreaterThan(0);
    });
  });

  it('renders unconfigured channels as available', async () => {
    await act(async () => { render(<Channels />); });
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('Discord')).toBeInTheDocument();
  });

  it('opens wizard when clicking available channel', async () => {
    await act(async () => { render(<Channels />); });
    const discordBtn = screen.getByText('Discord').closest('button');
    if (discordBtn) {
      await act(async () => { fireEvent.click(discordBtn); });
      expect(screen.getByText(/Connect Discord/)).toBeInTheDocument();
    }
  });

  it('shows disconnect button on configured channels (not on local)', async () => {
    await act(async () => { render(<Channels />); });
    // Wait for registry to load and channels to render
    await waitFor(() => {
      const disconnectBtns = screen.queryAllByTitle('Disconnect');
      expect(disconnectBtns.length).toBeGreaterThan(0);
    });
    // At least one disconnect button exists (for configured non-local channels)
    const disconnectBtns = screen.getAllByTitle('Disconnect');
    expect(disconnectBtns.length).toBeGreaterThanOrEqual(1);
    // Local Chat should NOT have a disconnect button — its parent has no such button
    const localText = screen.getByText('Local Chat');
    const localCard = localText.closest('div[class*="rounded-xl"]');
    expect(localCard).toBeTruthy();
    expect(localCard?.querySelector('button[title="Disconnect"]')).toBeNull();
  });

  it('shows confirmation dialog when clicking disconnect', async () => {
    await act(async () => { render(<Channels />); });
    await waitFor(() => {
      expect(screen.queryAllByTitle('Disconnect').length).toBeGreaterThan(0);
    });

    const disconnectBtn = screen.getAllByTitle('Disconnect')[0];
    await act(async () => { fireEvent.click(disconnectBtn); });

    // Confirmation dialog should appear
    expect(screen.getByText('Disconnect Channel')).toBeInTheDocument();
    expect(screen.getByText(/stop the channel bot worker/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('calls channelDisconnect when confirmed', async () => {
    const api = window.electronAPI as any;
    api.channelDisconnect = vi.fn().mockResolvedValue({ success: true });

    await act(async () => { render(<Channels />); });
    await waitFor(() => {
      expect(screen.queryAllByTitle('Disconnect').length).toBeGreaterThan(0);
    });

    // Click disconnect
    const disconnectBtn = screen.getAllByTitle('Disconnect')[0];
    await act(async () => { fireEvent.click(disconnectBtn); });

    // Confirm dialog visible
    expect(screen.getByText('Disconnect Channel')).toBeInTheDocument();

    // Find confirm button (the red one in the dialog, not the title tooltip button)
    const confirmDialog = screen.getByText('Disconnect Channel').closest('div[class*="fixed"]');
    const confirmBtn = confirmDialog?.querySelector('button[class*="bg-red"]') as HTMLElement;
    expect(confirmBtn).toBeTruthy();

    await act(async () => { fireEvent.click(confirmBtn); });

    // channelDisconnect should have been called
    expect(api.channelDisconnect).toHaveBeenCalled();
  });

  it('closes confirmation dialog when cancel is clicked', async () => {
    await act(async () => { render(<Channels />); });
    await waitFor(() => {
      expect(screen.queryAllByTitle('Disconnect').length).toBeGreaterThan(0);
    });

    const disconnectBtn = screen.getAllByTitle('Disconnect')[0];
    await act(async () => { fireEvent.click(disconnectBtn); });

    // Dialog visible
    expect(screen.getByText('Disconnect Channel')).toBeInTheDocument();

    // Click cancel
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    await act(async () => { fireEvent.click(cancelBtn); });

    // Dialog should be gone
    expect(screen.queryByText('Disconnect Channel')).not.toBeInTheDocument();
  });

  it('opens official OpenClaw tutorial link and disables the button while opening', async () => {
    const api = window.electronAPI as any;
    let resolveOpen: (() => void) | null = null;
    api.openExternal = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
      resolveOpen = resolve;
    }));

    await act(async () => { render(<Channels />); });

    const discordBtn = screen.getByText('Discord').closest('button');
    expect(discordBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(discordBtn as HTMLButtonElement);
    });

    const tutorialButton = screen.getByRole('button', { name: /View detailed tutorial/i });

    await act(async () => {
      fireEvent.click(tutorialButton);
    });

    expect(api.openExternal).toHaveBeenCalledWith('https://docs.openclaw.ai/channels/discord');
    expect(tutorialButton).toBeDisabled();

    await act(async () => {
      resolveOpen?.();
    });

    await waitFor(() => {
      expect(tutorialButton).not.toBeDisabled();
    });
  });

  it('shows generic timeout hint for WeChat one-click connection failures', async () => {
    const api = window.electronAPI as any;
    api.channelSetup = vi.fn().mockResolvedValue({ success: false, error: 'Command timed out' });

    await act(async () => { render(<Channels />); });

    const wechatBtn = screen.getByText('WeChat').closest('button');
    expect(wechatBtn).toBeTruthy();
    await act(async () => { fireEvent.click(wechatBtn as HTMLButtonElement); });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Connect$/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/Connection timed out while OpenClaw was still loading/i)).toBeInTheDocument();
      expect(screen.getByText(/This is usually not a credential issue/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/If Telegram sent a pairing code/i)).not.toBeInTheDocument();
  });

  it('shows Telegram-specific timeout hint when Telegram token flow times out', async () => {
    const api = window.electronAPI as any;
    api.channelSave = vi.fn().mockResolvedValue({ success: true });
    api.channelTest = vi.fn().mockResolvedValue({ success: false, error: 'Command timed out' });

    await act(async () => { render(<Channels />); });

    const telegramBtn = screen.getAllByText('Telegram')[0]?.closest('button');
    expect(telegramBtn).toBeTruthy();
    await act(async () => { fireEvent.click(telegramBtn as HTMLButtonElement); });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Next/i })); });

    const tokenInput = document.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(tokenInput).toBeTruthy();
    await act(async () => {
      fireEvent.change(tokenInput as HTMLInputElement, { target: { value: 'fake-token' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Connect$/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/Connection timed out while OpenClaw was still loading/i)).toBeInTheDocument();
      expect(screen.getByText(/If Telegram sent a pairing code, approve it first/i)).toBeInTheDocument();
    });
  });

  it('shows Telegram first-message notice after token setup succeeds', async () => {
    const api = window.electronAPI as any;
    api.channelSave = vi.fn().mockResolvedValue({ success: true });
    api.channelTest = vi.fn().mockResolvedValue({
      success: true,
      output: 'Telegram is connected. To generate a pairing code, open Telegram and send your bot a first direct message. OpenClaw only creates the code after that inbound message arrives.',
    });

    await act(async () => { render(<Channels />); });

    const telegramBtn = screen.getAllByText('Telegram')[0]?.closest('button');
    expect(telegramBtn).toBeTruthy();
    await act(async () => { fireEvent.click(telegramBtn as HTMLButtonElement); });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Next/i })); });

    const tokenInput = document.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(tokenInput).toBeTruthy();
    await act(async () => {
      fireEvent.change(tokenInput as HTMLInputElement, { target: { value: 'fake-token' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Connect$/i }));
    });

    await waitFor(() => {
      expect(screen.getAllByText(/send your bot a first direct message/i).length).toBeGreaterThan(0);
      expect(screen.getByText(/telegram still needs one more step/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Paste code or full approve line/i)).toBeInTheDocument();
    });
  });

  it('shows telegram pairing code input and triggers one-click approve', async () => {
    const api = window.electronAPI as any;
    api.channelPairingApprove = vi.fn().mockResolvedValue({
      success: true,
      message: 'Pairing approved and telegram is ready.',
      connectivity: { ready: true },
    });
    api.channelTest = vi.fn().mockResolvedValue({ success: true, output: 'ok' });

    await act(async () => { render(<Channels />); });

    const telegramBtn = screen.getAllByText('Telegram')[0]?.closest('button');
    expect(telegramBtn).toBeTruthy();
    await act(async () => { fireEvent.click(telegramBtn as HTMLButtonElement); });

    const nextBtn = screen.getByRole('button', { name: /Next/i });
    await act(async () => { fireEvent.click(nextBtn); });

    expect(screen.getByPlaceholderText(/Paste code or full approve line/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/Paste code or full approve line/i), { target: { value: 'C4AVKKA9' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });

    expect(api.channelPairingApprove).toHaveBeenCalledWith('telegram', 'C4AVKKA9');
  });

  it('silently extracts pairing code when user pastes full approve command', async () => {
    const api = window.electronAPI as any;
    api.channelPairingApprove = vi.fn().mockResolvedValue({ success: true, connectivity: { ready: true } });
    api.channelTest = vi.fn().mockResolvedValue({ success: true });

    await act(async () => { render(<Channels />); });

    const telegramBtn = screen.getAllByText('Telegram')[0]?.closest('button');
    expect(telegramBtn).toBeTruthy();
    await act(async () => { fireEvent.click(telegramBtn as HTMLButtonElement); });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Next/i })); });

    const pairingInput = screen.getByPlaceholderText(/Paste code or full approve line/i) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(pairingInput, { target: { value: 'openclaw pairing approve telegram C4AVKKA9' } });
    });

    expect(pairingInput.value).toBe('C4AVKKA9');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });

    expect(api.channelPairingApprove).toHaveBeenCalledWith('telegram', 'C4AVKKA9');
  });

  it('auto-fills latest pairing code and still allows manual edit', async () => {
    const api = window.electronAPI as any;
    api.channelPairingLatestCode = vi.fn().mockResolvedValue({
      success: true,
      code: 'LJK9MNP2',
      codes: ['LJK9MNP2'],
    });

    await act(async () => { render(<Channels />); });

    const telegramBtn = screen.getAllByText('Telegram')[0]?.closest('button');
    expect(telegramBtn).toBeTruthy();
    await act(async () => { fireEvent.click(telegramBtn as HTMLButtonElement); });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Next/i })); });

    const pairingInput = screen.getByPlaceholderText(/Paste code or full approve line/i) as HTMLInputElement;

    await waitFor(() => {
      expect(api.channelPairingLatestCode).toHaveBeenCalledWith('telegram');
      expect(pairingInput.value).toBe('LJK9MNP2');
    });

    await act(async () => {
      fireEvent.change(pairingInput, { target: { value: 'ABCD2345' } });
    });

    expect(pairingInput.value).toBe('ABCD2345');
  });

  it('supports WhatsApp pairing approval from configured channel wizard', async () => {
    const api = window.electronAPI as any;
    api.channelListConfigured = vi.fn().mockResolvedValue({ success: true, configured: ['telegram', 'whatsapp'] });
    api.channelPairingLatestCode = vi.fn().mockResolvedValue({
      success: true,
      code: 'KGHQJ8SK',
      codes: ['KGHQJ8SK'],
    });
    api.channelPairingApprove = vi.fn().mockResolvedValue({ success: true, connectivity: { ready: true } });
    api.channelTest = vi.fn().mockResolvedValue({ success: true });

    await act(async () => { render(<Channels />); });

    const whatsappBtn = screen.getAllByText('WhatsApp')[0]?.closest('button');
    expect(whatsappBtn).toBeTruthy();
    await act(async () => { fireEvent.click(whatsappBtn as HTMLButtonElement); });

    const pairingInput = await screen.findByPlaceholderText(/Paste code or full approve line/i) as HTMLInputElement;
    await waitFor(() => {
      expect(api.channelPairingLatestCode).toHaveBeenCalledWith('whatsapp');
      expect(pairingInput.value).toBe('KGHQJ8SK');
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });

    expect(api.channelPairingApprove).toHaveBeenCalledWith('whatsapp', 'KGHQJ8SK');
  });

  it('supports Feishu pairing approval from the channel wizard without requiring terminal usage', async () => {
    const api = window.electronAPI as any;
    api.channelGetRegistry = vi.fn().mockResolvedValue({ channels: [
      { id: 'local', openclawId: 'local', label: 'Local Chat', color: '#6366F1', iconType: 'svg', connectionType: 'one-click', configFields: [], saveStrategy: 'cli', order: 0, source: 'builtin' },
      { id: 'telegram', openclawId: 'telegram', label: 'Telegram', color: '#26A5E4', iconType: 'svg', connectionType: 'token', configFields: [{ key: 'token', label: 'Token', type: 'password', required: true, cliFlag: '--token' }], saveStrategy: 'cli', order: 1, source: 'openclaw-dynamic' },
      { id: 'feishu', openclawId: 'feishu', label: 'Feishu', color: '#3370FF', iconType: 'svg', connectionType: 'multi-field', configFields: [{ key: 'appId', label: 'appId', type: 'text', required: true, cliFlag: '--app-id' }, { key: 'appSecret', label: 'appSecret', type: 'password', required: true, cliFlag: '--app-secret' }], saveStrategy: 'json-direct', order: 8, source: 'openclaw-dynamic' },
      { id: 'discord', openclawId: 'discord', label: 'Discord', color: '#5865F2', iconType: 'svg', connectionType: 'token', configFields: [{ key: 'token', label: 'Token', type: 'password', required: true, cliFlag: '--token' }], saveStrategy: 'cli', order: 2, source: 'openclaw-dynamic' },
    ] });
    api.channelSave = vi.fn().mockResolvedValue({ success: true });
    api.channelTest = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        output: 'Open Feishu and send your bot a direct message. If OpenClaw asks for access approval, copy the pairing code from the card and approve it below.',
      })
      .mockResolvedValueOnce({ success: true, output: 'ok' });
    api.channelPairingApprove = vi.fn().mockResolvedValue({
      success: true,
      message: 'Pairing approved and feishu is ready.',
      connectivity: { ready: true },
    });

    await act(async () => { render(<Channels />); });

  const feishuBtn = await screen.findByText('Feishu / Lark').then((node) => node.closest('button'));
    expect(feishuBtn).toBeTruthy();
    await act(async () => { fireEvent.click(feishuBtn as HTMLButtonElement); });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Next/i })); });

    const appIdInput = screen.getAllByRole('textbox')[0] as HTMLInputElement;
    const secretInput = document.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(secretInput).toBeTruthy();

    await act(async () => {
      fireEvent.change(appIdInput, { target: { value: 'cli_a94ff56e9af89cc6' } });
      fireEvent.change(secretInput as HTMLInputElement, { target: { value: 'secret_xyz' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Connect$/i }));
    });

    await waitFor(() => {
      expect(screen.getAllByText(/copy the pairing code from the card and approve it below/i).length).toBeGreaterThan(0);
      expect(screen.getByText(/AwarenessClaw will approve it for you/i)).toBeInTheDocument();
    });

    const pairingInput = screen.getByPlaceholderText(/Paste code or full approve line/i) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(pairingInput, { target: { value: 'openclaw pairing approve feishu 5MQFD7PH' } });
    });

    expect(pairingInput.value).toBe('5MQFD7PH');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });

    expect(api.channelPairingApprove).toHaveBeenCalledWith('feishu', '5MQFD7PH');
  });

  it('shows the latest-QR hint when WeChat QR url events arrive', async () => {
    const api = window.electronAPI as any;
    let qrListener: ((art: string) => void) | null = null;
    let qrUrlListener: ((url: string) => void) | null = null;
    api.channelSetup = vi.fn().mockImplementation(() => new Promise(() => {}));

    api.onChannelQR = vi.fn((callback: (art: string) => void) => {
      qrListener = callback;
    });
    api.onChannelQrUrl = vi.fn((callback: (url: string) => void) => {
      qrUrlListener = callback;
    });

    await act(async () => { render(<Channels />); });

    const wechatBtn = screen.getByText('WeChat').closest('button');
    expect(wechatBtn).toBeTruthy();
    await act(async () => { fireEvent.click(wechatBtn as HTMLButtonElement); });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Connect$/i }));
    });

    await act(async () => {
      qrUrlListener?.('https://liteapp.weixin.qq.com/q/fresh-code');
      qrListener?.('██\n██');
    });

    expect(screen.getByText(/always shows the latest QR code/i)).toBeInTheDocument();
  });

  it('clears the previous WeChat QR on refresh status and shows the replacement QR when it arrives', async () => {
    const api = window.electronAPI as any;
    let qrListener: ((art: string) => void) | null = null;
    let qrUrlListener: ((url: string) => void) | null = null;
    let statusListener: ((status: string) => void) | null = null;
    api.channelSetup = vi.fn().mockImplementation(() => new Promise(() => {}));

    api.onChannelQR = vi.fn((callback: (art: string) => void) => {
      qrListener = callback;
    });
    api.onChannelQrUrl = vi.fn((callback: (url: string) => void) => {
      qrUrlListener = callback;
    });
    api.onChannelStatus = vi.fn((callback: (status: string) => void) => {
      statusListener = callback;
    });

    await act(async () => { render(<Channels />); });

    const wechatBtn = screen.getByText('WeChat').closest('button');
    expect(wechatBtn).toBeTruthy();
    await act(async () => { fireEvent.click(wechatBtn as HTMLButtonElement); });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Connect$/i }));
    });

    await act(async () => {
      qrUrlListener?.('https://liteapp.weixin.qq.com/q/old-code');
      qrListener?.('OLD-QR');
    });

    expect(screen.getByText('OLD-QR')).toBeInTheDocument();

    await act(async () => {
      statusListener?.('channels.status.qrRefreshing::1');
    });

    expect(screen.queryByText('OLD-QR')).not.toBeInTheDocument();
    expect(screen.getByText(/refreshing a new one/i)).toBeInTheDocument();

    await act(async () => {
      qrUrlListener?.('https://liteapp.weixin.qq.com/q/new-code');
      qrListener?.('NEW-QR');
    });

    expect(screen.getByText('NEW-QR')).toBeInTheDocument();
    expect(screen.queryByText('OLD-QR')).not.toBeInTheDocument();
  });
});
