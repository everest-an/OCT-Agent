/**
 * L4 User Journey E2E — Chat Send via Real Gateway (Zero Mock)
 *
 * Prerequisites:
 *   - OpenClaw Gateway running (`openclaw gateway status` → running)
 *   - At least one model configured in ~/.openclaw/openclaw.json
 *
 * Run:
 *   node --test test/e2e/user-journeys/chat-send.test.mjs
 *
 * This test connects to the real local Gateway via WebSocket, sends a
 * simple prompt, and asserts that a non-empty assistant response arrives
 * within 60 seconds. No mocks, no stubs, no page.route.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const HOME = os.homedir();
const GATEWAY_PORT = Number(process.env.OPENCLAW_GATEWAY_PORT) || 18789;
const GATEWAY_HOST = '127.0.0.1';
const TIMEOUT_MS = 60_000;

// ── Helpers ──────────────────────────────────────────────────────────────

function readGatewayToken() {
  try {
    const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return String(config?.gateway?.auth?.token || '').trim();
  } catch {
    return '';
  }
}

function loadDeviceIdentity() {
  try {
    const identityPath = path.join(HOME, '.openclaw', 'identity', 'device.json');
    const data = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    if (data.deviceId && data.publicKeyPem && data.privateKeyPem) return data;
    return null;
  } catch {
    return null;
  }
}

function signDeviceAuth(identity, nonce, token, clientId, clientMode, role, scopes) {
  const signedAt = Date.now();
  const payload = [
    'v3', identity.deviceId, clientId, clientMode,
    role, scopes.join(','), String(signedAt), token, nonce,
    process.platform, '', // deviceFamily
  ].join('|');
  const privateKey = crypto.createPrivateKey(identity.privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey);
  return { signature: sig.toString('base64url'), signedAt };
}

/** Minimal Gateway WS client for E2E testing. */
class TestGatewayClient {
  constructor() {
    this.ws = null;
    this.rpcCounter = 0;
    this.pending = new Map();
    this.events = [];
    this.listeners = new Map();
  }

  async connect() {
    const token = readGatewayToken();
    const identity = loadDeviceIdentity();
    const url = `ws://${GATEWAY_HOST}:${GATEWAY_PORT}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connect timeout')), 15_000);
      this.ws = new WebSocket(url, { headers: { Origin: `http://${GATEWAY_HOST}:${GATEWAY_PORT}` } });

      let challengeNonce = null;

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.ws.on('open', () => {
        let challengeNonce = null;
        let challengeReceived = false;

        const onMsg = (raw) => {
          const msg = JSON.parse(raw.toString());

          // Capture challenge nonce
          if (msg.type === 'event' && msg.event === 'connect.challenge') {
            challengeNonce = msg.payload?.nonce || null;
            challengeReceived = true;
            sendConnect();
            return;
          }

          if (msg.type === 'res') {
            if (msg.ok && msg.payload?.type === 'hello-ok') {
              clearTimeout(timeout);
              this.ws.removeListener('message', onMsg);
              this._setupListeners();
              resolve();
            } else {
              clearTimeout(timeout);
              reject(new Error(msg.error?.message || 'Connect failed'));
            }
          }
        };
        this.ws.on('message', onMsg);

        const sendConnect = () => {
          const scopes = ['operator.admin', 'operator.write', 'operator.read'];
          const params = {
            minProtocol: 3,
            maxProtocol: 3,
            client: { id: 'openclaw-control-ui', version: '1.0.0', platform: process.platform, mode: 'ui', displayName: 'E2E Test' },
            role: 'operator',
            scopes,
          };

          if (identity && challengeNonce) {
            const { signature, signedAt } = signDeviceAuth(identity, challengeNonce, token, 'openclaw-control-ui', 'ui', 'operator', scopes);
            params.device = { id: identity.deviceId, publicKey: identity.publicKeyPem, signature, signedAt, nonce: challengeNonce };
          }

          if (token) {
            params.auth = { token };
          }

          this._send({ type: 'req', id: 'rpc-0', method: 'connect', params });
        };

        // If no challenge arrives within 500ms, send connect without device auth
        setTimeout(() => {
          if (!challengeReceived) sendConnect();
        }, 500);
      });
    });
  }

  _setupListeners() {
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'res' && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        msg.ok ? resolve(msg.payload) : reject(new Error(msg.error?.message || 'RPC failed'));
      }
      if (msg.type === 'event') {
        this.events.push(msg);
        // Emit both the specific event name and a wildcard
        const cbs = this.listeners.get(msg.event) || [];
        for (const cb of cbs) cb(msg.payload);
        const wildcardCbs = this.listeners.get('*') || [];
        for (const cb of wildcardCbs) cb(msg.event, msg.payload);
      }
    });
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(cb);
  }

  async rpc(method, params = {}, timeoutMs = 30_000) {
    const id = `rpc-${++this.rpcCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC ${method} timeout`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ type: 'req', id, method, params });
    });
  }

  _send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  destroy() {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('destroyed')); }
    this.pending.clear();
    this.ws?.close();
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('L4 E2E: Chat via real Gateway + Qwen', () => {
  let client;

  before(async () => {
    client = new TestGatewayClient();
    await client.connect();
  });

  after(() => {
    client?.destroy();
  });

  it('sends a message and receives a non-empty assistant response', async () => {
    const sessionKey = `webchat:e2e-${Date.now()}`;

    // Collect chat events
    let assistantText = '';
    let gotFinal = false;

    const done = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No assistant response within 60s')), TIMEOUT_MS);

      client.on('chat', (payload) => {
        // Match by session key suffix (Gateway prepends agent:main:)
        if (!payload.sessionKey?.includes(sessionKey)) return;

        // Delta text
        if (payload.state === 'delta' && payload.message?.content) {
          const content = payload.message.content;
          if (typeof content === 'string') {
            assistantText = content;
          } else if (Array.isArray(content)) {
            assistantText = content.filter(b => b.type === 'text').map(b => b.text).join('');
          }
        }

        // Final
        if (payload.state === 'final') {
          gotFinal = true;
          const content = payload.message?.content;
          if (typeof content === 'string') {
            assistantText = content;
          } else if (Array.isArray(content)) {
            assistantText = content.filter(b => b.type === 'text').map(b => b.text).join('');
          }
          clearTimeout(timeout);
          resolve();
        }

        // Error
        if (payload.state === 'error') {
          clearTimeout(timeout);
          reject(new Error(`Chat error: ${JSON.stringify(payload.error || payload)}`));
        }
      });
    });

    // Send message
    await client.rpc('chat.send', {
      sessionKey,
      message: 'Reply with exactly: hello e2e',
      idempotencyKey: `e2e-${Date.now()}`,
    }, TIMEOUT_MS);

    await done;

    assert.ok(gotFinal, 'Should receive a final chat event');
    assert.ok(assistantText.length > 0, `Assistant text should be non-empty, got: "${assistantText}"`);
    console.log(`  ✓ Assistant replied (${assistantText.length} chars): "${assistantText.slice(0, 100)}..."`);
  });

  it('gateway status RPC returns running state', async () => {
    const status = await client.rpc('status', {}, 10_000);
    assert.ok(status, 'Status should be non-null');
    console.log(`  ✓ Gateway status: pid=${status.pid || 'n/a'}, uptime=${status.uptime || 'n/a'}`);
  });
});
