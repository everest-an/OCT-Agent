/**
 * F-063 · L4-ish end-to-end test for marketplace install flow.
 *
 * Zero IPC mocking. Real HTTP server (local), real file writes for SOUL/AGENTS/TOOLS,
 * real converter. Only the `openclaw agents add` subprocess is stubbed (same as
 * the real IPC handler's fallback path).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';

import { MarketplaceClient } from '../../electron/agent-marketplace/api';
import { installMarketplaceAgent } from '../../electron/agent-marketplace/installer';

const SAMPLE_AGENT = {
  slug: 'e2e-agent',
  name: 'E2E Agent',
  name_zh: '端到端 agent',
  description: 'End-to-end test agent.',
  description_zh: '端到端测试用',
  category: 'test',
  tier: 'consumer' as const,
  emoji: '🧪',
  color: 'slate',
  tags: ['testing'],
  tools: ['Read', 'Write'],
  featured: true,
  install_count: 42,
};

const SAMPLE_MD = `---
name: E2E Agent
description: End-to-end test agent.
color: slate
emoji: 🧪
tools: Read, Write
---

# E2E Agent

## Identity & Memory
Remembers the test session.

## Core Mission
Be testable.

## Communication Style
Terse.
`;

function makeServer(responder: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  return new Promise<http.Server>((resolve) => {
    const server = http.createServer((req, res) => responder(req, res));
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('marketplace E2E — happy path', () => {
  let server: http.Server;
  let port: number;
  let tmpHome: string;
  let pingCalled = false;

  beforeAll(async () => {
    server = await makeServer((req, res) => {
      const url = req.url || '';
      if (url === '/api/v1/marketplace/agents' || url.startsWith('/api/v1/marketplace/agents?')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents: [SAMPLE_AGENT], total: 1 }));
        return;
      }
      if (url.startsWith('/api/v1/marketplace/agents/e2e-agent/install-ping')) {
        pingCalled = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ slug: 'e2e-agent', install_count: 43 }));
        return;
      }
      if (url === '/api/v1/marketplace/agents/e2e-agent') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...SAMPLE_AGENT, markdown: SAMPLE_MD }));
        return;
      }
      res.writeHead(404);
      res.end('{"detail":"not found"}');
    });
    const addr = server.address() as AddressInfo;
    port = addr.port;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-e2e-'));
    fs.mkdirSync(path.join(tmpHome, '.openclaw'), { recursive: true });
    pingCalled = false;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('list → detail → install → workspace exists', async () => {
    const client = new MarketplaceClient({ apiBase: `http://127.0.0.1:${port}/api/v1` });

    // 1. Browse
    const listing = await client.list();
    expect(listing.agents).toHaveLength(1);
    expect(listing.agents[0].slug).toBe('e2e-agent');

    // 2. Open detail (as user clicks card)
    const detail = await client.detail('e2e-agent');
    expect(detail.markdown).toContain('# E2E Agent');

    // 3. Install (real file writes; only `openclaw agents add` stubbed)
    const runSpawnAsync = vi.fn(async () => 'ok') as any;
    const result = await installMarketplaceAgent(
      {
        slug: detail.slug,
        markdown: detail.markdown,
        displayNameOverride: detail.name_zh || detail.name,
        emojiOverride: detail.emoji,
      },
      {
        home: tmpHome,
        runSpawnAsync,
        applyAgentIdentityFallback: () => ({ success: true }),
        addAgentToConfigFallback: () => ({ success: true }),
        isSlugInUse: () => false,
      }
    );

    expect(result.success).toBe(true);
    expect(result.agentId).toBe('e2e-agent');

    // 4. Workspace files actually written
    const wsDir = path.join(tmpHome, '.openclaw', 'workspace-e2e-agent');
    expect(fs.readdirSync(wsDir).sort()).toEqual(
      ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'TOOLS.md']
    );

    // 5. CLI spawned with expected args
    expect(runSpawnAsync).toHaveBeenCalledWith(
      'openclaw',
      expect.arrayContaining(['agents', 'add', 'e2e-agent', '--non-interactive']),
      expect.any(Number)
    );
  });

  it('install-ping fires on successful install', async () => {
    const client = new MarketplaceClient({ apiBase: `http://127.0.0.1:${port}/api/v1` });
    await client.installPing('e2e-agent');
    expect(pingCalled).toBe(true);
  });
});

describe('marketplace E2E — chaos (backend 5xx)', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = await makeServer((req, res) => {
      res.writeHead(502);
      res.end('<html>bad gateway</html>');
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
  });

  it('list rejects gracefully on 502', async () => {
    const client = new MarketplaceClient({
      apiBase: `http://127.0.0.1:${port}/api/v1`,
      timeoutMs: 1500,
    });
    await expect(client.list()).rejects.toThrow(/HTTP 502/);
  });

  it('detail rejects gracefully on 502', async () => {
    const client = new MarketplaceClient({
      apiBase: `http://127.0.0.1:${port}/api/v1`,
      timeoutMs: 1500,
    });
    await expect(client.detail('anything')).rejects.toThrow(/HTTP 502/);
  });
});

describe('marketplace E2E — chaos (timeout)', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    // Never responds — forces timeout.
    server = await makeServer(() => {
      /* hang */
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
  });

  it('client times out within budget', async () => {
    const client = new MarketplaceClient({
      apiBase: `http://127.0.0.1:${port}/api/v1`,
      timeoutMs: 500,
    });
    const start = Date.now();
    await expect(client.list()).rejects.toThrow(/timeout/);
    expect(Date.now() - start).toBeLessThan(2500);
  }, 4000);
});
