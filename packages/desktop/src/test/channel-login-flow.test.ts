import { describe, expect, it } from 'vitest';
import { getQrLoginProgressStatus, pickQrUrl, stripQrAnsi } from '../../electron/ipc/channel-login-flow';

describe('channel-login-flow QR progress', () => {
  it('parses official WeChat QR refresh log lines into status keys', () => {
    expect(getQrLoginProgressStatus('Starting Weixin login with bot_type=3')).toBe('channels.status.connectingWechat');
    expect(getQrLoginProgressStatus('Starting to poll QR code status...')).toBe('channels.status.waitingForScan');
    expect(getQrLoginProgressStatus('waitForWeixinLogin: QR expired, refreshing (2/3) sessionKey=default')).toBe('channels.status.qrRefreshing::2');
    expect(getQrLoginProgressStatus('waitForWeixinLogin: QR expired 3 times, giving up sessionKey=default')).toBe('channels.status.qrExpiredFinal');
  });

  it('prefers the real WeChat QR landing page over backend API urls', () => {
    const chosen = pickQrUrl([
      {
        line: 'Fetching QR code from: https://ilinkai.weixin.qq.com/some/api',
        url: 'https://ilinkai.weixin.qq.com/some/api',
      },
      {
        line: '二维码链接: https://liteapp.weixin.qq.com/q/abc123?qrcode=1&bot_type=3',
        url: 'https://liteapp.weixin.qq.com/q/abc123?qrcode=1&bot_type=3',
      },
    ]);

    expect(chosen).toBe('https://liteapp.weixin.qq.com/q/abc123?qrcode=1&bot_type=3');
  });

  it('strips ANSI control sequences from QR rows before sending them to the renderer', () => {
    expect(stripQrAnsi('\u001b[37m▄▀█\u001b[0m\r')).toBe('▄▀█');
  });
});