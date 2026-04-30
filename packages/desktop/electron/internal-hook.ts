import fs from 'fs';
import http from 'http';
import path from 'path';

export const HOOK_VERSION = '1.0.0';

export function ensureInternalHook(homedir: string) {
  try {
    const hooksDir = path.join(homedir, '.openclaw', 'hooks');
    if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });

    const hookPath = path.join(hooksDir, 'awareness-memory-backup.mjs');

    // Check if hook exists and is current version
    if (fs.existsSync(hookPath)) {
      const existing = fs.readFileSync(hookPath, 'utf8');
      if (existing.includes(`HOOK_VERSION=${HOOK_VERSION}`)) return;
    }

    const hookContent = `#!/usr/bin/env node
/**
 * Awareness Memory backup hook — captures message:sent events as fallback.
 * Deployed by OCT installer. Source: openclaw-hook
 * HOOK_VERSION=${HOOK_VERSION}
 *
 * OpenClaw Internal Hook format: receives JSON events on stdin (one per line).
 * This acts as a backup to the plugin's agent_end hook.
 */
import http from 'node:http';

const DAEMON_URL = 'http://127.0.0.1:37800/mcp';
const TIMEOUT_MS = 5000;

function postToDaemon(payload) {
  return new Promise((resolve) => {
    try {
      const data = JSON.stringify({
        jsonrpc: '2.0', id: Date.now(),
        method: 'tools/call',
        params: {
          name: 'awareness_record',
          arguments: {
            action: 'remember',
            content: payload.content,
            event_type: 'message_backup',
            source: 'openclaw-hook',
            session_id: payload.sessionId || '',
          },
        },
      });
      const req = http.request(DAEMON_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: TIMEOUT_MS,
      }, (res) => { res.resume(); resolve(); });
      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.write(data);
      req.end();
    } catch { resolve(); }
  });
}

// Buffer messages and flush every 3s or when buffer reaches 3 items
const buffer = [];
let flushTimer = null;

async function flush() {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0);
  const combined = batch.map(m => \`[\${m.role}] \${m.content}\`).join('\\n---\\n');
  if (combined.length > 20) {
    await postToDaemon({ content: combined, sessionId: batch[0]?.sessionId });
  }
}

import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  try {
    const evt = JSON.parse(line);
    if (evt.event !== 'message:sent' && evt.event !== 'message:received') return;
    if (!evt.content || evt.content.length < 15) return;
    buffer.push({ role: evt.role || 'unknown', content: evt.content.slice(0, 1500), sessionId: evt.sessionId });
    if (flushTimer) clearTimeout(flushTimer);
    if (buffer.length >= 3) { flush(); }
    else { flushTimer = setTimeout(flush, 3000); }
  } catch { /* ignore non-JSON lines */ }
});

rl.on('close', () => flush());
`;

    fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
    console.log('[startup] Deployed awareness-memory-backup hook');
  } catch (err) {
    console.warn('[startup] Failed to deploy internal hook:', err);
  }
}