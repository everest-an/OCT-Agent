/**
 * L4 User Journey E2E — Memory Save After Chat (Zero Mock)
 *
 * Verifies that after sending a chat message through the desktop app flow,
 * the turn is recorded in Awareness Memory via the local daemon.
 *
 * Prerequisites:
 *   - Local Awareness daemon running on port 37800 (`curl http://localhost:37800/healthz`)
 *   - OpenClaw Gateway running (`openclaw gateway status` → running)
 *   - At least one model configured
 *
 * Run:
 *   node --test test/e2e/user-journeys/memory-save.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

const DAEMON_PORT = 37800;
const DAEMON_HOST = '127.0.0.1';

// ── Helpers ──────────────────────────────────────────────────────────────

function httpJson(method, path, body = null, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const url = `http://${DAEMON_HOST}:${DAEMON_PORT}${path}`;
    const opts = { method, timeout: timeoutMs, headers: { 'Content-Type': 'application/json' } };
    const req = http.request(url, opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function callMcp(toolName, args) {
  return httpJson('POST', '/mcp', {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('L4 E2E: Memory save via daemon', () => {
  before(async () => {
    // Verify daemon is healthy
    try {
      const health = await httpJson('GET', '/healthz', null, 5000);
      assert.equal(health.status, 200, 'Daemon should be healthy');
    } catch (err) {
      throw new Error(`Awareness daemon not running on port ${DAEMON_PORT}: ${err.message}. Start it with: npx @awareness-sdk/local start`);
    }
  });

  it('awareness_record saves a turn and it appears in search', async () => {
    const uniqueMarker = `e2e-memory-save-${Date.now()}`;

    // 1. Record a turn (simulates what fireAndForgetMemorySave does)
    const recordResult = await callMcp('awareness_record', {
      action: 'remember',
      content: `Request: ${uniqueMarker}\nResult: This is a test response for memory save verification`,
      event_type: 'turn_brief',
      source: 'desktop',
    });

    assert.equal(recordResult.status, 200, 'MCP call should return 200');
    const recordPayload = recordResult.body;
    assert.ok(recordPayload?.result, 'Should have a result in JSON-RPC response');

    // 2. Wait briefly for indexing
    await new Promise(r => setTimeout(r, 1000));

    // 3. Search for the unique marker
    const searchResult = await httpJson('GET', `/api/v1/memories/search?q=${encodeURIComponent(uniqueMarker)}&limit=5`);
    assert.equal(searchResult.status, 200);

    const results = searchResult.body?.items || searchResult.body?.results || [];
    assert.ok(results.length >= 1, `Should find at least 1 result for marker "${uniqueMarker}", got ${results.length}`);

    // 4. Verify the saved content contains our marker
    const found = results.some(r =>
      (r.fts_content || r.content || r.text || r.title || '').includes(uniqueMarker)
    );
    assert.ok(found, 'Saved memory should contain the unique marker');
  });

  it('awareness_record with source=desktop is tagged correctly', async () => {
    const marker = `desktop-source-test-${Date.now()}`;

    await callMcp('awareness_record', {
      action: 'remember',
      content: `Request: ${marker}\nResult: Desktop source test response`,
      event_type: 'turn_brief',
      source: 'desktop',
    });

    await new Promise(r => setTimeout(r, 1000));

    // Query with source filter
    const result = await httpJson('GET', `/api/v1/memories?source=desktop&limit=5`);
    assert.equal(result.status, 200);

    const items = result.body?.items || result.body?.results || [];
    const found = items.some(item =>
      (item.fts_content || item.content || item.text || '').includes(marker)
    );
    assert.ok(found, 'Memory with source=desktop should be findable via source filter');
  });

  it('daemon returns graceful error for malformed MCP request', async () => {
    // L3-style: verify daemon doesn't crash on bad input
    const result = await callMcp('awareness_record', {
      // Missing required fields
    });

    assert.equal(result.status, 200, 'Should still return 200 (JSON-RPC error envelope)');
    // The daemon should not crash - just return an error in the result
  });
});
