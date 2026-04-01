#!/usr/bin/env node
/**
 * Debug script: connect to local OpenClaw Gateway via WebSocket,
 * send a test message, and print ALL events to understand the actual format.
 *
 * Usage: node scripts/debug-gateway-events.mjs "your test message"
 */
import WebSocket from 'ws';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const message = process.argv[2] || 'hello, please list files on my desktop using exec tool';
const configPath = join(homedir(), '.openclaw', 'openclaw.json');

let port = 18789;
let token = '';
try {
  if (existsSync(configPath)) {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    port = cfg?.gateway?.port || 18789;
    token = cfg?.gateway?.token || process.env.OPENCLAW_GATEWAY_TOKEN || '';
  }
} catch {}

const url = `ws://127.0.0.1:${port}`;
console.log(`Connecting to ${url}...`);

const ws = new WebSocket(url);
let rpcCounter = 0;
const pending = new Map();
const sid = `debug-${Date.now()}`;

function nextId() { return `rpc-${++rpcCounter}-${Date.now()}`; }

function rpc(method, params = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${method} timeout`)); }, timeout);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

ws.on('open', async () => {
  console.log('WebSocket connected. Waiting for challenge...');
});

ws.on('message', async (data) => {
  const msg = JSON.parse(data.toString());

  // --- Handle auth challenge ---
  if (msg.type === 'event' && msg.event === 'connect.challenge') {
    console.log('[auth] Got challenge, sending connect RPC...');
    try {
      const result = await rpc('connect', { token, minProtocol: 3, maxProtocol: 3 });
      console.log('[auth] Connected:', JSON.stringify(result).slice(0, 200));

      // Now send the test message
      console.log(`\n=== Sending message: "${message}" to session ${sid} ===\n`);
      const sendResult = await rpc('chat.send', {
        sessionKey: sid,
        message: message,
        idempotencyKey: `dbg-${Date.now()}`,
      }, 120000);
      console.log('[chat.send] RPC result:', JSON.stringify(sendResult));
    } catch (err) {
      console.error('[auth/send] Error:', err.message);
    }
    return;
  }

  // --- Handle RPC responses ---
  if (msg.type === 'res') {
    const p = pending.get(msg.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.payload);
      else p.reject(new Error(msg.error?.message || 'RPC failed'));
    }
    return;
  }

  // --- Handle ALL events (the important part) ---
  if (msg.type === 'event') {
    const eventName = msg.event;
    const payload = msg.payload;

    // Pretty print with structure details
    console.log(`\n${'='.repeat(60)}`);
    console.log(`EVENT: ${eventName}`);
    console.log(`${'='.repeat(60)}`);

    if (eventName === 'chat') {
      const state = payload?.state;
      const role = payload?.message?.role;
      const content = payload?.message?.content;
      console.log(`  state: ${state}`);
      console.log(`  sessionKey: ${payload?.sessionKey}`);
      console.log(`  role: ${role}`);

      if (Array.isArray(content)) {
        console.log(`  content: Array[${content.length}]`);
        content.forEach((block, i) => {
          console.log(`    [${i}] type=${block.type}`, JSON.stringify(block).slice(0, 300));
        });
      } else if (typeof content === 'string') {
        console.log(`  content (string): "${content.slice(0, 200)}"`);
      } else {
        console.log(`  content:`, JSON.stringify(content).slice(0, 300));
      }

      // Check for tool/thinking fields at message level
      const msgKeys = Object.keys(payload?.message || {}).filter(k => !['role', 'content'].includes(k));
      if (msgKeys.length > 0) {
        console.log(`  extra message fields: ${msgKeys.join(', ')}`);
        msgKeys.forEach(k => console.log(`    ${k}:`, JSON.stringify(payload.message[k]).slice(0, 200)));
      }

      // Check for extra payload fields
      const payloadKeys = Object.keys(payload || {}).filter(k => !['state', 'message', 'sessionKey', 'key'].includes(k));
      if (payloadKeys.length > 0) {
        console.log(`  extra payload fields: ${payloadKeys.join(', ')}`);
        payloadKeys.forEach(k => console.log(`    ${k}:`, JSON.stringify(payload[k]).slice(0, 200)));
      }

      if (state === 'final' || state === 'error' || state === 'aborted') {
        console.log('\n=== DONE ===');
        setTimeout(() => process.exit(0), 1000);
      }
    } else {
      // Non-chat event — print everything
      console.log(`  payload:`, JSON.stringify(payload).slice(0, 500));
    }
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  console.log('WebSocket closed');
  process.exit(0);
});

// Timeout after 60 seconds
setTimeout(() => {
  console.log('\n=== TIMEOUT (60s) ===');
  process.exit(1);
}, 60000);
