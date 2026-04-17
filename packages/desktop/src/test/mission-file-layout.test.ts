/**
 * Tests for electron/mission/file-layout.ts
 *
 * Goals:
 *   - Atomic writes survive partial failure
 *   - Path traversal is rejected (../ / absolute / reserved)
 *   - Slugify is deterministic and caps length
 *   - MEMORY.md append-only (header added on first write, appended thereafter)
 *   - Mission / plan / artifact CRUD round-trip
 *   - Cross-platform basics (path.join behavior; no hardcoded "/" separators)
 *
 * Reference: docs/features/team-tasks/02-FILE-LAYOUT.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  artifactPath,
  assertSafeId,
  appendMemory,
  deleteMission,
  defaultRoot,
  ensureMissionSkeleton,
  getMissionDir,
  getMissionsDir,
  heartbeatMdPath,
  listArtifacts,
  listMissions,
  logPath,
  missionExists,
  missionJsonPath,
  memoryMdPath,
  planJsonPath,
  readArtifact,
  readHeartbeat,
  readMemory,
  readMission,
  readPlan,
  slugify,
  writeArtifact,
  writeFileAtomic,
  writeHeartbeat,
  writeMission,
  writePlan,
} from '../../electron/mission/file-layout';
import type { Mission, Plan } from '../../electron/mission/types';

let tmpRoot: string;

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'awclaw-mission-test-'));
}

beforeEach(() => {
  tmpRoot = makeTmpRoot();
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe('path helpers', () => {
  it('defaultRoot resolves under homedir', () => {
    expect(defaultRoot()).toBe(path.join(os.homedir(), '.awarenessclaw'));
  });

  it('getMissionsDir + getMissionDir use path.join (cross-platform)', () => {
    const missions = getMissionsDir(tmpRoot);
    expect(missions).toBe(path.join(tmpRoot, 'missions'));
    const m = getMissionDir('mission-1', tmpRoot);
    expect(m).toBe(path.join(tmpRoot, 'missions', 'mission-1'));
  });

  it('all file paths compose off getMissionDir', () => {
    const base = getMissionDir('m1', tmpRoot);
    expect(missionJsonPath('m1', tmpRoot)).toBe(path.join(base, 'mission.json'));
    expect(planJsonPath('m1', tmpRoot)).toBe(path.join(base, 'plan.json'));
    expect(memoryMdPath('m1', tmpRoot)).toBe(path.join(base, 'MEMORY.md'));
    expect(heartbeatMdPath('m1', tmpRoot)).toBe(path.join(base, 'HEARTBEAT.md'));
  });
});

// ---------------------------------------------------------------------------
// assertSafeId — path-traversal defense
// ---------------------------------------------------------------------------

describe('assertSafeId', () => {
  it('accepts normal ids', () => {
    expect(() => assertSafeId('mission-20260417-abc123', 'mission')).not.toThrow();
    expect(() => assertSafeId('T1', 'step')).not.toThrow();
    expect(() => assertSafeId('orchestrator.log', 'log')).not.toThrow();
  });

  it('rejects empty or non-string', () => {
    expect(() => assertSafeId('', 'mission')).toThrow(/empty/);
    // @ts-expect-error testing runtime guard
    expect(() => assertSafeId(null, 'mission')).toThrow();
  });

  it('rejects path traversal attempts', () => {
    expect(() => assertSafeId('../etc/passwd', 'mission')).toThrow(/unsafe/);
    expect(() => assertSafeId('../..', 'mission')).toThrow(/unsafe/);
    expect(() => assertSafeId('.', 'mission')).toThrow(/unsafe|reserved/);
    expect(() => assertSafeId('..', 'mission')).toThrow(/unsafe|reserved/);
  });

  it('rejects Windows reserved chars and path separators', () => {
    for (const ch of ['/', '\\', ':', '*', '?', '"', '<', '>', '|', ' ', '\t']) {
      expect(() => assertSafeId(`bad${ch}id`, 'mission')).toThrow();
    }
  });

  it('getMissionDir throws on unsafe id (defense-in-depth)', () => {
    expect(() => getMissionDir('../evil', tmpRoot)).toThrow();
    expect(() => getMissionDir('/etc/passwd', tmpRoot)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('lowercases and replaces whitespace with -', () => {
    expect(slugify('Initialize Next.js Project')).toBe('initialize-next-js-project');
  });

  it('collapses consecutive separators', () => {
    expect(slugify('hello   world!!!')).toBe('hello-world');
  });

  it('trims leading/trailing -', () => {
    expect(slugify('  hello  ')).toBe('hello');
    expect(slugify('---abc---')).toBe('abc');
  });

  it('caps at 40 chars', () => {
    const long = 'x'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(40);
  });

  it('falls back to "step" on empty / non-alnum input', () => {
    expect(slugify('')).toBe('step');
    expect(slugify('///')).toBe('step');
    expect(slugify('   ')).toBe('step');
  });

  it('handles non-ASCII by stripping (deterministic)', () => {
    // CJK becomes empty alnum → fallback
    expect(slugify('编程')).toBe('step');
    // Mixed — latin portion kept
    expect(slugify('博客 blog system')).toBe('blog-system');
  });
});

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

describe('writeFileAtomic', () => {
  it('creates parent dirs and writes content', () => {
    const p = path.join(tmpRoot, 'nested', 'deep', 'file.txt');
    writeFileAtomic(p, 'hello');
    expect(fs.readFileSync(p, 'utf8')).toBe('hello');
  });

  it('overwrites existing file', () => {
    const p = path.join(tmpRoot, 'a.txt');
    writeFileAtomic(p, 'first');
    writeFileAtomic(p, 'second');
    expect(fs.readFileSync(p, 'utf8')).toBe('second');
  });

  it('does not leave tmp file behind on success', () => {
    const p = path.join(tmpRoot, 'b.txt');
    writeFileAtomic(p, 'x');
    const files = fs.readdirSync(tmpRoot);
    expect(files.filter((f) => f.startsWith('b.txt.tmp'))).toHaveLength(0);
  });

  it('accepts Buffer content', () => {
    const p = path.join(tmpRoot, 'buf.bin');
    writeFileAtomic(p, Buffer.from([1, 2, 3]));
    expect(fs.readFileSync(p)).toEqual(Buffer.from([1, 2, 3]));
  });
});

// ---------------------------------------------------------------------------
// Mission CRUD
// ---------------------------------------------------------------------------

function sampleMission(id = 'mission-1'): Mission {
  return {
    id,
    version: 1,
    goal: 'Make a TODO app',
    status: 'planning',
    createdAt: new Date().toISOString(),
    plannerAgentId: 'main',
    steps: [],
  };
}

describe('mission CRUD', () => {
  it('missionExists is false before write', () => {
    expect(missionExists('m1', tmpRoot)).toBe(false);
  });

  it('writeMission creates skeleton + mission.json', () => {
    writeMission(sampleMission('m1'), tmpRoot);
    expect(missionExists('m1', tmpRoot)).toBe(true);
    expect(fs.existsSync(path.join(getMissionDir('m1', tmpRoot), 'artifacts'))).toBe(true);
    expect(fs.existsSync(path.join(getMissionDir('m1', tmpRoot), 'logs'))).toBe(true);
  });

  it('readMission round-trips', () => {
    const m = sampleMission('m1');
    writeMission(m, tmpRoot);
    const back = readMission('m1', tmpRoot);
    expect(back).toEqual(m);
  });

  it('readMission returns null on missing file', () => {
    expect(readMission('ghost', tmpRoot)).toBeNull();
  });

  it('readMission returns null on corrupt JSON (does not throw)', () => {
    ensureMissionSkeleton('m1', tmpRoot);
    fs.writeFileSync(missionJsonPath('m1', tmpRoot), '{ this is not json');
    expect(readMission('m1', tmpRoot)).toBeNull();
  });

  it('writeMission refuses unsupported version (future safety)', () => {
    const bad = { ...sampleMission('m1'), version: 999 as any };
    expect(() => writeMission(bad, tmpRoot)).toThrow(/version/);
  });

  it('listMissions returns only valid id directories', () => {
    writeMission(sampleMission('m1'), tmpRoot);
    writeMission(sampleMission('m2'), tmpRoot);
    // Create a non-mission file and a dir with unsafe name to ensure filtering.
    fs.writeFileSync(path.join(getMissionsDir(tmpRoot), 'notes.txt'), 'x');
    fs.mkdirSync(path.join(getMissionsDir(tmpRoot), 'has space'), { recursive: true });
    const ids = listMissions(tmpRoot).sort();
    expect(ids).toEqual(['m1', 'm2']);
  });

  it('deleteMission removes the whole mission dir', () => {
    writeMission(sampleMission('m1'), tmpRoot);
    expect(missionExists('m1', tmpRoot)).toBe(true);
    deleteMission('m1', tmpRoot);
    expect(missionExists('m1', tmpRoot)).toBe(false);
    expect(fs.existsSync(getMissionDir('m1', tmpRoot))).toBe(false);
  });

  it('deleteMission is a no-op for missing id', () => {
    expect(() => deleteMission('ghost', tmpRoot)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Plan CRUD
// ---------------------------------------------------------------------------

describe('plan CRUD', () => {
  const samplePlan: Plan = {
    summary: 'Build a TODO app',
    subtasks: [
      { id: 'T1', agentId: 'coder', role: 'Developer', title: 'Scaffold', deliverable: 'md', depends_on: [] },
      { id: 'T2', agentId: 'coder', role: 'Developer', title: 'UI', deliverable: 'md', depends_on: ['T1'] },
    ],
  };

  it('round-trips plan json', () => {
    writePlan('m1', samplePlan, tmpRoot);
    expect(readPlan('m1', tmpRoot)).toEqual(samplePlan);
  });

  it('readPlan returns null when missing', () => {
    expect(readPlan('ghost', tmpRoot)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MEMORY.md append-only
// ---------------------------------------------------------------------------

describe('appendMemory / readMemory', () => {
  it('first write creates header + block', () => {
    appendMemory('m1', 'Decision: use Next.js.', tmpRoot);
    const text = readMemory('m1', tmpRoot);
    expect(text).toContain('# Mission Memory');
    expect(text).toContain('Decision: use Next.js.');
  });

  it('subsequent writes append without duplicating the header', () => {
    appendMemory('m1', 'First block.', tmpRoot);
    appendMemory('m1', 'Second block.', tmpRoot);
    const text = readMemory('m1', tmpRoot);
    const headerCount = (text.match(/# Mission Memory/g) || []).length;
    expect(headerCount).toBe(1);
    expect(text).toContain('First block.');
    expect(text).toContain('Second block.');
    // Ordering preserved
    expect(text.indexOf('First block.')).toBeLessThan(text.indexOf('Second block.'));
  });

  it('readMemory returns empty string when missing', () => {
    expect(readMemory('ghost', tmpRoot)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

describe('heartbeat', () => {
  it('writeHeartbeat / readHeartbeat round-trips markdown form', () => {
    const now = '2026-04-17T10:00:00Z';
    writeHeartbeat('m1', {
      runnerPid: 12345,
      lastBeatAt: now,
      currentStepId: 'T2',
      stepStartedAt: '2026-04-17T09:58:00Z',
      lastEvent: 'installing next-auth',
      gatewaySessionKey: 'agent:coder:subagent:uuid-xxx',
    }, tmpRoot);
    const text = readHeartbeat('m1', tmpRoot);
    expect(text).toContain('Runner PID');
    expect(text).toContain('12345');
    expect(text).toContain('2026-04-17T10:00:00Z');
    expect(text).toContain('T2');
    expect(text).toContain('agent:coder:subagent:uuid-xxx');
  });

  it('optional fields can be omitted', () => {
    writeHeartbeat('m1', { runnerPid: 1, lastBeatAt: '2026-04-17T10:00:00Z' }, tmpRoot);
    const text = readHeartbeat('m1', tmpRoot);
    expect(text).toContain('Runner PID');
    expect(text).not.toContain('Current step');
    expect(text).not.toContain('Gateway session');
  });
});

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

describe('artifacts', () => {
  it('writeArtifact writes frontmatter + body with correct slug path', () => {
    const rel = writeArtifact({
      missionId: 'm1',
      stepId: 'T1',
      title: 'Initialize Next.js Project',
      body: '## What I did\n\nran create-next-app.',
      frontmatter: {
        stepId: 'T1',
        agentId: 'coder',
        createdAt: '2026-04-17T10:00:00Z',
        durationSeconds: 42,
      },
      root: tmpRoot,
    });

    // Returned path is RELATIVE to mission dir
    expect(rel).toBe(path.join('artifacts', 'T1-initialize-next-js-project.md'));

    const abs = artifactPath('m1', 'T1', 'Initialize Next.js Project', tmpRoot);
    const text = fs.readFileSync(abs, 'utf8');
    expect(text).toMatch(/^---\n/);
    expect(text).toContain('stepId: T1');
    expect(text).toContain('agentId: coder');
    expect(text).toContain('durationSeconds: 42');
    expect(text).toContain('ran create-next-app.');
  });

  it('writeArtifact omits durationSeconds when not provided', () => {
    writeArtifact({
      missionId: 'm1',
      stepId: 'T1',
      title: 'x',
      body: 'body',
      frontmatter: { stepId: 'T1', agentId: 'a', createdAt: '2026-04-17T10:00:00Z' },
      root: tmpRoot,
    });
    const text = readArtifact('m1', 'T1', 'x', tmpRoot)!;
    expect(text).not.toContain('durationSeconds');
  });

  it('readArtifact returns null when missing', () => {
    expect(readArtifact('m1', 'T99', 'anything', tmpRoot)).toBeNull();
  });

  it('listArtifacts returns sorted .md filenames only', () => {
    writeArtifact({
      missionId: 'm1', stepId: 'T2', title: 'Second',
      body: '.', frontmatter: { stepId: 'T2', agentId: 'a', createdAt: 'x' }, root: tmpRoot,
    });
    writeArtifact({
      missionId: 'm1', stepId: 'T1', title: 'First',
      body: '.', frontmatter: { stepId: 'T1', agentId: 'a', createdAt: 'x' }, root: tmpRoot,
    });
    // Decoy non-markdown file
    fs.writeFileSync(path.join(getMissionDir('m1', tmpRoot), 'artifacts', '.DS_Store'), '');
    const files = listArtifacts('m1', tmpRoot);
    expect(files).toEqual(['T1-first.md', 'T2-second.md']);
  });

  it('artifactPath rejects unsafe step id', () => {
    expect(() => artifactPath('m1', '../etc', 'x', tmpRoot)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Log paths
// ---------------------------------------------------------------------------

describe('logPath', () => {
  it('composes under logs/', () => {
    expect(logPath('m1', 'orchestrator', tmpRoot)).toBe(
      path.join(getMissionDir('m1', tmpRoot), 'logs', 'orchestrator.log'),
    );
  });

  it('rejects unsafe names', () => {
    expect(() => logPath('m1', '../evil', tmpRoot)).toThrow();
  });
});
