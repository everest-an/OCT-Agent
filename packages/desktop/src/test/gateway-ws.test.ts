import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readJsonFileWithBomMock = vi.hoisted(() => vi.fn());
const fsReadFileSyncMock = vi.hoisted(() => vi.fn());
const wsInstances = vi.hoisted(() => [] as any[]);

vi.mock('os', () => ({
  homedir: () => 'C:\\Users\\test',
}));

vi.mock('fs', () => ({
  readFileSync: fsReadFileSyncMock,
}));

vi.mock('../../electron/json-file', () => ({
  readJsonFileWithBom: readJsonFileWithBomMock,
}));

vi.mock('ws', () => {
  const { EventEmitter } = require('events');

  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = MockWebSocket.OPEN;
    url: string;
    options: Record<string, unknown>;
    sent: string[] = [];

    constructor(url: string, options: Record<string, unknown>) {
      super();
      this.url = url;
      this.options = options;
      wsInstances.push(this);
    }

    send(payload: string) {
      this.sent.push(payload);
    }

    close() {
      this.readyState = 3;
    }
  }

  return { WebSocket: MockWebSocket };
});

import { GatewayClient } from '../../electron/gateway-ws';

describe('GatewayClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    wsInstances.length = 0;
    readJsonFileWithBomMock.mockReset();
    fsReadFileSyncMock.mockReset();

    readJsonFileWithBomMock.mockReturnValue({
      gateway: {
        port: 18789,
        auth: {
          token: 'test-gateway-token',
        },
      },
    });

    fsReadFileSyncMock.mockImplementation((filePath: string) => {
      if (String(filePath).endsWith('device.json')) {
        throw new Error('ENOENT');
      }
      throw new Error(`Unexpected fs.readFileSync(${String(filePath)})`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects over 127.0.0.1 loopback origin and forwards gateway auth token', async () => {
    const client = new GatewayClient();
    const connectPromise = client.connect();

    expect(wsInstances).toHaveLength(1);
    const ws = wsInstances[0];
    expect(ws.url).toBe('ws://127.0.0.1:18789');
    expect(ws.options).toMatchObject({
      headers: {
        Origin: 'http://127.0.0.1:18789',
      },
    });

    ws.emit('open');
    await vi.advanceTimersByTimeAsync(5100);

    expect(ws.sent).toHaveLength(1);
    const request = JSON.parse(ws.sent[0]);
    expect(request.method).toBe('connect');
    expect(request.params.auth).toEqual({ token: 'test-gateway-token' });
    expect(request.params.client.id).toBe('openclaw-control-ui');

    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'res',
      id: 'rpc-1',
      ok: true,
      payload: {
        type: 'hello-ok',
        server: {
          connId: 'conn-1',
        },
      },
    })));

    await expect(connectPromise).resolves.toBeUndefined();
    expect(client.isConnected).toBe(true);
  });

  it('downgrades sessions.patch to a no-op after Gateway denies operator.write', async () => {
    const client = new GatewayClient();
    const rpcSpy = vi.spyOn(client, 'rpc').mockRejectedValue(new Error('missing scope: operator.write'));

    (client as any).requestedScopes = ['operator.admin', 'operator.write', 'operator.read'];

    const result = await client.sessionPatch('session-1', { model: 'openai/gpt-4o' });

    expect(result).toEqual({ skipped: true, reason: 'write-scopes-unavailable' });
    expect(rpcSpy).toHaveBeenCalledWith('sessions.patch', { key: 'session-1', model: 'openai/gpt-4o' }, 10000);
    expect((client as any).writeScopesUnsupported).toBe(true);
    expect((client as any).requestedScopes).toEqual(['operator.read']);

    rpcSpy.mockReset();
    const second = await client.sessionPatch('session-1', { verboseLevel: 'full' });
    expect(second).toEqual({ skipped: true, reason: 'write-scopes-unavailable' });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it('retries reconnect with exponential backoff until a later attempt succeeds', async () => {
    const client = new GatewayClient();
    const connectSpy = vi.spyOn(client, 'connect')
      .mockRejectedValueOnce(new Error('gateway still loading'))
      .mockRejectedValueOnce(new Error('gateway still loading'))
      .mockResolvedValue(undefined);

    (client as any).scheduleReconnect();

    await vi.advanceTimersByTimeAsync(3000);
    expect(connectSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6000);
    expect(connectSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(12000);
    expect(connectSpy).toHaveBeenCalledTimes(3);
    expect((client as any).reconnectAttempts).toBe(0);
  });

  it('stops scheduling reconnect after max attempts', async () => {
    const client = new GatewayClient();
    const connectSpy = vi.spyOn(client, 'connect').mockRejectedValue(new Error('gateway down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    (client as any).reconnectAttempts = 8;
    (client as any).scheduleReconnect();

    await vi.runOnlyPendingTimersAsync();

    expect(connectSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[gateway-ws] Giving up reconnect after 8 attempts');

    warnSpy.mockRestore();
  });
});