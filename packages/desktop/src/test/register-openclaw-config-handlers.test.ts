import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ipcHandleMock } = vi.hoisted(() => ({
  ipcHandleMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: ipcHandleMock,
  },
}));

import { registerOpenClawConfigHandlers } from '../../electron/ipc/register-openclaw-config-handlers';
import { mergeDesktopOpenClawConfig } from '../../electron/desktop-openclaw-config';

function getRegisteredHandlers() {
  return Object.fromEntries(
    ipcHandleMock.mock.calls.map(([channel, handler]) => [channel, handler]),
  ) as Record<string, (...args: any[]) => Promise<any>>;
}

describe('registerOpenClawConfigHandlers', () => {
  let tempHome = '';

  beforeEach(() => {
    ipcHandleMock.mockReset();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'awarenessclaw-config-handlers-'));
    fs.mkdirSync(path.join(tempHome, '.openclaw'), { recursive: true });
  });

  afterEach(() => {
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
      tempHome = '';
    }
  });

  it('routes permission allowlist updates through desktop config merge and enforces coding profile', async () => {
    const configPath = path.join(tempHome, '.openclaw', 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify({
      tools: {
        profile: 'default',
        alsoAllow: ['awareness_init'],
      },
      plugins: {
        allow: ['openclaw-memory'],
      },
    }, null, 2));

    registerOpenClawConfigHandlers({
      home: tempHome,
      mergeOpenClawConfig: (existing, incoming) => mergeDesktopOpenClawConfig(existing, incoming, tempHome),
    });

    const handlers = getRegisteredHandlers();
    const result = await handlers['permissions:update']({}, {
      alsoAllow: ['awareness_init', 'exec', 'web_search', 'web_fetch', 'browser'],
      denied: [],
      execSecurity: 'full',
      execAsk: 'off',
      execAskFallback: 'full',
      execAutoAllowSkills: true,
    });

    expect(result).toEqual({ success: true });

    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(saved.tools).toMatchObject({
      profile: 'coding',
      alsoAllow: ['awareness_init', 'exec', 'web_search', 'web_fetch', 'browser'],
    });
    expect(saved.tools.denied).toBeUndefined();
    expect(saved.browser?.enabled).toBe(true);
    expect(saved.tools?.web?.search).toMatchObject({
      enabled: true,
      provider: 'duckduckgo',
    });
    expect(saved.tools?.web?.fetch?.enabled).toBe(true);
    expect(saved.plugins?.allow).toEqual(expect.arrayContaining(['browser']));

    const execApprovalsPath = path.join(tempHome, '.openclaw', 'exec-approvals.json');
    const execApprovals = JSON.parse(fs.readFileSync(execApprovalsPath, 'utf8'));
    expect(execApprovals.defaults).toMatchObject({
      security: 'full',
      ask: 'off',
      askFallback: 'full',
      autoAllowSkills: true,
    });
  });
});