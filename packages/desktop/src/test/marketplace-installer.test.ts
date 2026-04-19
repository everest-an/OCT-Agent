import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installMarketplaceAgent } from '../../electron/agent-marketplace/installer';
import type { InstallDeps } from '../../electron/agent-marketplace/installer';

const SAMPLE_MD = `---
name: Test Writer
description: A writer agent for testing.
color: rose
emoji: ✍️
tools: Read, Write, Edit
---

# Test Writer

## Identity & Memory
Remembers the user's voice.

## Core Mission
Draft essays.

## Communication Style
Friendly.
`;

function makeDeps(homeDir: string, overrides: Partial<InstallDeps> = {}): InstallDeps {
  return {
    home: homeDir,
    runSpawnAsync: vi.fn(async () => 'ok') as any,
    applyAgentIdentityFallback: vi.fn(() => ({ success: true })),
    addAgentToConfigFallback: vi.fn(() => ({ success: true })),
    isSlugInUse: vi.fn(() => false),
    ...overrides,
  };
}

describe('installMarketplaceAgent — happy path', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-'));
    fs.mkdirSync(path.join(tmpHome, '.openclaw'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('creates workspace with 4 files', async () => {
    const deps = makeDeps(tmpHome);
    const result = await installMarketplaceAgent(
      { slug: 'test-writer', markdown: SAMPLE_MD },
      deps
    );
    expect(result.success).toBe(true);
    expect(result.agentId).toBe('test-writer');

    const wsDir = path.join(tmpHome, '.openclaw', 'workspace-test-writer');
    expect(fs.existsSync(path.join(wsDir, 'SOUL.md'))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, 'IDENTITY.md'))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, 'TOOLS.md'))).toBe(true);
  });

  it('calls openclaw agents add with correct slug', async () => {
    const spawn = vi.fn(async () => 'ok') as any;
    const deps = makeDeps(tmpHome, { runSpawnAsync: spawn });
    await installMarketplaceAgent(
      { slug: 'test-writer', markdown: SAMPLE_MD },
      deps
    );
    expect(spawn).toHaveBeenCalledWith(
      'openclaw',
      expect.arrayContaining(['agents', 'add', 'test-writer']),
      expect.any(Number)
    );
  });

  it('applies identity after successful add', async () => {
    const applyIdentity = vi.fn(() => ({ success: true }));
    const deps = makeDeps(tmpHome, { applyAgentIdentityFallback: applyIdentity });
    await installMarketplaceAgent(
      { slug: 'test-writer', markdown: SAMPLE_MD },
      deps
    );
    expect(applyIdentity).toHaveBeenCalledWith(
      tmpHome,
      'test-writer',
      expect.objectContaining({ name: 'Test Writer', emoji: '✍️' })
    );
  });
});

describe('installMarketplaceAgent — already installed (idempotent)', () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-'));
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns alreadyInstalled without calling CLI', async () => {
    const spawn = vi.fn(async () => 'ok') as any;
    const deps = makeDeps(tmpHome, {
      runSpawnAsync: spawn,
      isSlugInUse: () => true,
    });
    const result = await installMarketplaceAgent(
      { slug: 'test-writer', markdown: SAMPLE_MD },
      deps
    );
    expect(result.success).toBe(true);
    expect(result.alreadyInstalled).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('installMarketplaceAgent — CLI timeout fallback', () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-'));
    fs.mkdirSync(path.join(tmpHome, '.openclaw'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('uses fallback when spawn times out', async () => {
    const spawn = vi.fn(async () => {
      throw new Error('Command timed out after 120000ms');
    }) as any;
    const fallback = vi.fn(() => ({ success: true }));
    const deps = makeDeps(tmpHome, {
      runSpawnAsync: spawn,
      addAgentToConfigFallback: fallback,
    });
    const result = await installMarketplaceAgent(
      { slug: 'test-writer', markdown: SAMPLE_MD },
      deps
    );
    expect(result.success).toBe(true);
    expect(fallback).toHaveBeenCalledWith(
      tmpHome,
      'test-writer',
      { model: null }
    );
  });

  it('bubbles non-timeout CLI errors', async () => {
    const spawn = vi.fn(async () => {
      throw new Error('ENOENT: openclaw not found');
    }) as any;
    const deps = makeDeps(tmpHome, { runSpawnAsync: spawn });
    const result = await installMarketplaceAgent(
      { slug: 'test-writer', markdown: SAMPLE_MD },
      deps
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ENOENT/);
  });
});

describe('installMarketplaceAgent — validation', () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-'));
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('rejects invalid slug', async () => {
    const deps = makeDeps(tmpHome);
    const result = await installMarketplaceAgent(
      { slug: 'BAD SLUG', markdown: SAMPLE_MD },
      deps
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid slug/);
  });

  it('rejects malformed frontmatter', async () => {
    const deps = makeDeps(tmpHome);
    const result = await installMarketplaceAgent(
      { slug: 'test-writer', markdown: 'no frontmatter here' },
      deps
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/convert failed/);
  });
});
