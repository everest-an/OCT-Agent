import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { handleMock, sendMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  sendMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
  },
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: sendMock } }],
  },
}));

import {
  buildAutoInstallSpecsFromMissingBins,
  parseWingetSearchIds,
  registerSkillHandlers,
} from '../../electron/ipc/register-skill-handlers';

const tempDirs: string[] = [];

function createTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(
  rootDir: string,
  skillName: string,
  frontmatterExtra = '',
  body = '# Skill\n',
) {
  const skillDir = path.join(rootDir, skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  const lines = [
    '---',
    `name: ${skillName}`,
    `description: ${skillName} description`,
    frontmatterExtra,
    '---',
    '',
    body,
  ].filter(Boolean);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), lines.join('\n'));
  return skillDir;
}

function getHandler<T extends (...args: any[]) => Promise<any>>(channel: string): T {
  const match = handleMock.mock.calls.find(([registered]) => registered === channel);
  if (!match) throw new Error(`${channel} handler not registered`);
  return match[1] as T;
}

function getInstallDepsHandler() {
  return getHandler<(event: unknown, installSpecs: unknown, skillName?: string) => Promise<any>>('skill:install-deps');
}

describe('registerSkillHandlers helpers', () => {
  beforeEach(() => {
    handleMock.mockReset();
    sendMock.mockReset();
    delete process.env.OPENCLAW_BUNDLED_SKILLS_DIR;
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('parses winget ids from command search output', () => {
    const output = `
Failed when searching source; results will not be included: msstore
Name                  Id                          Version  Match        Source
-----------------------------------------------------------------------------
1Password CLI         AgileBits.1Password.CLI     2.33.1   Command: op  winget
  AWS Copilot CLI       Amazon.CopilotCLI           1.34.1   Command: copilot  winget
`;

    expect(parseWingetSearchIds(output)).toEqual([
      'AgileBits.1Password.CLI',
      'Amazon.CopilotCLI',
    ]);
  });

  it('creates fallback auto-install specs only for bins not attempted yet', () => {
    expect(buildAutoInstallSpecsFromMissingBins(['op', 'ffmpeg'], ['op'])).toEqual([
      {
        id: 'auto-ffmpeg-0',
        kind: 'auto',
        label: 'Install ffmpeg',
        bins: ['ffmpeg'],
        package: 'ffmpeg',
      },
    ]);
  });

  it.skipIf(process.platform !== 'win32')('auto-matches Windows package ids via winget command search', async () => {
    let installedOp = false;
    const runSpawnAsync = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'where') {
        const target = args[0];
        if (target === 'winget') return 'C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe';
        if (target === 'npm') return 'C:\\Program Files\\nodejs\\npm.cmd';
        if (target === 'op') {
          if (installedOp) return 'C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Links\\op.exe';
          throw new Error('not found');
        }
        throw new Error(`missing ${target}`);
      }

      if (cmd === 'winget' && args[0] === 'search') {
        return `
Name                  Id                          Version  Match        Source
-----------------------------------------------------------------------------
1Password CLI         AgileBits.1Password.CLI     2.33.1   Command: op  winget
`;
      }

      throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
    });

    const runAsyncWithProgress = vi.fn(async (command: string, _timeoutMs: number, onLine: (line: string, stream: 'stdout' | 'stderr') => void) => {
      expect(command).toContain('AgileBits.1Password.CLI');
      installedOp = true;
      onLine('Found 1Password CLI [AgileBits.1Password.CLI] Version 2.33.1', 'stdout');
      onLine('Successfully installed', 'stdout');
      return 'Successfully installed';
    });

    registerSkillHandlers({
      home: process.env.TEMP || process.env.TMP || 'C:/Temp',
      runAsync: vi.fn(async () => ''),
      runAsyncWithProgress,
      runSpawnAsync,
      readShellOutputAsync: vi.fn(async () => null),
    });

    const handler = getInstallDepsHandler();
    const result = await handler({}, [{ id: 'auto-op', kind: 'auto', label: 'Install op', bins: ['op'], package: 'op' }]);

    expect(result).toMatchObject({ success: true });
    expect(result.verified).toContain('op');
    expect(runAsyncWithProgress).toHaveBeenCalledWith(
      expect.stringContaining('AgileBits.1Password.CLI'),
      300000,
      expect.any(Function),
    );
    expect(sendMock).toHaveBeenCalledWith('skill:install-progress', expect.objectContaining({ stage: 'matching' }));
  });

  it('falls back to filesystem using official precedence and config gating', async () => {
    const home = createTempDir('awarenessclaw-skills-home-');
    const workspaceDir = path.join(home, 'workspace-main');
    const bundledDir = createTempDir('awarenessclaw-bundled-');
    const extraDir = path.join(home, 'extra-skills');
    const managedDir = path.join(home, '.openclaw', 'skills');
    const personalDir = path.join(home, '.agents', 'skills');
    const projectDir = path.join(workspaceDir, '.agents', 'skills');
    const workspaceSkillsDir = path.join(workspaceDir, 'skills');
    fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    fs.mkdirSync(extraDir, { recursive: true });
    fs.mkdirSync(managedDir, { recursive: true });
    fs.mkdirSync(personalDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(workspaceSkillsDir, { recursive: true });
    process.env.OPENCLAW_BUNDLED_SKILLS_DIR = bundledDir;

    writeSkill(bundledDir, 'shared-skill');
    writeSkill(managedDir, 'shared-skill', '', '# Managed version\n');
    writeSkill(projectDir, 'shared-skill', '', '# Project version\n');
    writeSkill(workspaceSkillsDir, 'shared-skill', '', '# Workspace version\n');
    writeSkill(bundledDir, 'blocked-bundled');
    writeSkill(workspaceSkillsDir, 'env-skill', 'metadata: {"openclaw":{"primaryEnv":"ENV_KEY","requires":{"env":["ENV_KEY"]}}}');
    writeSkill(workspaceSkillsDir, 'special-name', 'metadata: {"openclaw":{"skillKey":"special-key"}}');
    writeSkill(extraDir, 'extra-only');

    fs.writeFileSync(path.join(home, '.openclaw', 'openclaw.json'), JSON.stringify({
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
      skills: {
        allowBundled: ['shared-skill'],
        load: {
          extraDirs: [extraDir],
        },
        entries: {
          'env-skill': {
            env: {
              ENV_KEY: 'present',
            },
          },
          'special-key': {
            enabled: false,
          },
        },
      },
    }, null, 2));

    registerSkillHandlers({
      home,
      runAsync: vi.fn(async () => ''),
      runAsyncWithProgress: vi.fn(async () => ''),
      runSpawnAsync: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'npm' && args.join(' ') === 'root -g') return path.join(home, 'node_modules');
        throw new Error('not found');
      }),
      readShellOutputAsync: vi.fn(async () => null),
    });

    const handler = getHandler<() => Promise<any>>('skill:list-installed');
    const result = await handler();

    expect(result.success).toBe(true);
    const skills = result.report.skills as Array<Record<string, any>>;
    expect(skills.find((skill) => skill.name === 'shared-skill')).toMatchObject({
      source: 'openclaw-workspace',
      bundled: false,
    });
    expect(skills.find((skill) => skill.name === 'blocked-bundled')).toMatchObject({
      blockedByAllowlist: true,
      eligible: false,
    });
    expect(skills.find((skill) => skill.name === 'env-skill')).toMatchObject({
      eligible: true,
      skillKey: 'env-skill',
    });
    expect(skills.find((skill) => skill.name === 'special-name')).toMatchObject({
      skillKey: 'special-key',
      disabled: true,
      eligible: false,
    });
    expect(skills.find((skill) => skill.name === 'extra-only')).toMatchObject({
      source: 'openclaw-extra',
    });
  });

  it('merges install specs from single-line metadata in SKILL.md', async () => {
    const home = createTempDir('awarenessclaw-skill-info-home-');
    const skillRoot = createTempDir('awarenessclaw-skill-info-skill-');
    const skillDir = writeSkill(
      skillRoot,
      'onepassword',
      'metadata: {"openclaw":{"install":[{"id":"brew","kind":"brew","label":"Install 1Password CLI","formula":"1password-cli","bins":["op"]}]}}',
    );

    registerSkillHandlers({
      home,
      runAsync: vi.fn(async () => ''),
      runAsyncWithProgress: vi.fn(async () => ''),
      runSpawnAsync: vi.fn(async () => ''),
      readShellOutputAsync: vi.fn(async () => JSON.stringify({
        name: 'onepassword',
        filePath: path.join(skillDir, 'SKILL.md'),
        install: [{ id: 'brew', kind: 'brew', label: 'Install 1Password CLI', bins: ['op'] }],
      })),
    });

    const handler = getHandler<(event: unknown, name: string) => Promise<any>>('skill:local-info');
    const result = await handler({}, 'onepassword');

    expect(result).toMatchObject({ success: true });
    expect(result.info.install[0]).toMatchObject({
      formula: '1password-cli',
      bins: ['op'],
    });
  });
});