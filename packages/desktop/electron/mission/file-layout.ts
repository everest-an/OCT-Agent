/**
 * Mission file-layout helpers — pure fs, no Electron imports so it can be unit-
 * tested against a tmp dir without spinning up the main process.
 *
 * Spec: docs/features/team-tasks/02-FILE-LAYOUT.md
 *
 * Layout:
 *   <root>/missions/<missionId>/
 *     mission.json
 *     plan.json          (Plan B uses JSON not YAML)
 *     MEMORY.md          (shared context, append-only)
 *     HEARTBEAT.md       (S2 runtime heartbeat)
 *     artifacts/T{n}-<slug>.md
 *     logs/<name>.log
 *
 * Default root: ~/.awarenessclaw/
 * Test override: pass `root` explicitly.
 *
 * Security: all paths are sanitized. Mission ids, step ids, and slugs must
 * match /^[A-Za-z0-9._-]+$/ — defends against path traversal ("../etc/passwd")
 * and Windows reserved characters (<>:"|?*).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseJsonWithBom } from '../json-file';
import type {
  ArtifactFrontmatter,
  Heartbeat,
  Mission,
  Plan,
} from './types';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

export function defaultRoot(): string {
  return path.join(os.homedir(), '.awarenessclaw');
}

/**
 * Validate that an id segment cannot escape the mission dir. Throws on unsafe
 * input so callers fail loudly rather than leak file writes elsewhere.
 */
export function assertSafeId(id: string, kind: string): void {
  if (!id || typeof id !== 'string') {
    throw new Error(`${kind} id is empty or not a string`);
  }
  if (!SAFE_ID_RE.test(id)) {
    throw new Error(`${kind} id "${id}" contains unsafe characters (allowed: A-Z a-z 0-9 . _ -)`);
  }
  if (id === '.' || id === '..') {
    throw new Error(`${kind} id "${id}" is reserved`);
  }
}

export function getMissionsDir(root: string = defaultRoot()): string {
  return path.join(root, 'missions');
}

export function getMissionDir(missionId: string, root: string = defaultRoot()): string {
  assertSafeId(missionId, 'mission');
  return path.join(getMissionsDir(root), missionId);
}

export function missionJsonPath(missionId: string, root?: string): string {
  return path.join(getMissionDir(missionId, root), 'mission.json');
}

export function planJsonPath(missionId: string, root?: string): string {
  return path.join(getMissionDir(missionId, root), 'plan.json');
}

export function memoryMdPath(missionId: string, root?: string): string {
  return path.join(getMissionDir(missionId, root), 'MEMORY.md');
}

export function heartbeatMdPath(missionId: string, root?: string): string {
  return path.join(getMissionDir(missionId, root), 'HEARTBEAT.md');
}

export function artifactsDir(missionId: string, root?: string): string {
  return path.join(getMissionDir(missionId, root), 'artifacts');
}

export function logsDir(missionId: string, root?: string): string {
  return path.join(getMissionDir(missionId, root), 'logs');
}

/**
 * Slugify a step title into a safe filename fragment.
 * Rules (deterministic, so tests can assert):
 *   - lowercase
 *   - replace whitespace and any disallowed char with a single "-"
 *   - collapse consecutive "-"
 *   - trim leading/trailing "-"
 *   - truncate to 40 chars (room for `<stepId>-` prefix and `.md` suffix)
 *   - fall back to "step" if the result is empty
 */
export function slugify(input: string): string {
  const lower = String(input || '').toLowerCase();
  const replaced = lower.replace(/[^a-z0-9]+/g, '-');
  const collapsed = replaced.replace(/-+/g, '-');
  const trimmed = collapsed.replace(/^-+|-+$/g, '');
  const capped = trimmed.slice(0, 40);
  return capped || 'step';
}

export function artifactPath(
  missionId: string,
  stepId: string,
  title: string,
  root?: string,
): string {
  assertSafeId(stepId, 'step');
  const slug = slugify(title);
  return path.join(artifactsDir(missionId, root), `${stepId}-${slug}.md`);
}

export function logPath(missionId: string, name: string, root?: string): string {
  assertSafeId(name, 'log name');
  return path.join(logsDir(missionId, root), `${name}.log`);
}

// ---------------------------------------------------------------------------
// Atomic write — tmp + rename
// ---------------------------------------------------------------------------

/**
 * Write a file atomically: write to a pid-suffixed tmp path, then rename into
 * place. On POSIX and Windows both, `rename` is atomic within the same dir.
 *
 * Guarantees: after a crash the target is either the previous version or the
 * new one in full — never a half-written file.
 */
export function writeFileAtomic(filePath: string, content: string | Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup of the tmp file if rename failed.
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Mission CRUD
// ---------------------------------------------------------------------------

export function ensureMissionSkeleton(missionId: string, root?: string): void {
  fs.mkdirSync(getMissionDir(missionId, root), { recursive: true });
  fs.mkdirSync(artifactsDir(missionId, root), { recursive: true });
  fs.mkdirSync(logsDir(missionId, root), { recursive: true });
}

export function missionExists(missionId: string, root?: string): boolean {
  try {
    return fs.existsSync(missionJsonPath(missionId, root));
  } catch {
    return false;
  }
}

export function readMission(missionId: string, root?: string): Mission | null {
  const p = missionJsonPath(missionId, root);
  if (!fs.existsSync(p)) return null;
  try {
    return parseJsonWithBom<Mission>(fs.readFileSync(p, 'utf8'));
  } catch {
    return null; // corrupt JSON — caller decides how to surface
  }
}

export function writeMission(mission: Mission, root?: string): void {
  if (mission.version !== 1) {
    throw new Error(`unsupported mission.json version ${mission.version}`);
  }
  ensureMissionSkeleton(mission.id, root);
  writeFileAtomic(
    missionJsonPath(mission.id, root),
    JSON.stringify(mission, null, 2),
  );
}

export function listMissions(root: string = defaultRoot()): string[] {
  const dir = getMissionsDir(root);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && SAFE_ID_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Remove a mission directory recursively. Guards against path traversal via
 * assertSafeId inside getMissionDir.
 */
export function deleteMission(missionId: string, root?: string): void {
  const dir = getMissionDir(missionId, root);
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export function readPlan(missionId: string, root?: string): Plan | null {
  const p = planJsonPath(missionId, root);
  if (!fs.existsSync(p)) return null;
  try {
    return parseJsonWithBom<Plan>(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writePlan(missionId: string, plan: Plan, root?: string): void {
  ensureMissionSkeleton(missionId, root);
  writeFileAtomic(planJsonPath(missionId, root), JSON.stringify(plan, null, 2));
}

// ---------------------------------------------------------------------------
// MEMORY.md — append-only shared context
// ---------------------------------------------------------------------------

/**
 * Append a block to MEMORY.md. Creates the file with a header if missing.
 *
 * We use `appendFileSync` (single syscall, atomic for small writes on POSIX,
 * and atomic enough on NTFS for our size). The header ensures first read shows
 * a proper markdown document even on partial reads.
 */
export function appendMemory(
  missionId: string,
  block: string,
  root?: string,
): void {
  ensureMissionSkeleton(missionId, root);
  const p = memoryMdPath(missionId, root);
  const exists = fs.existsSync(p);
  const prefix = exists ? '\n' : '# Mission Memory\n\n> Shared context across all agents in this mission.\n> Each step appends a summary here when it completes.\n\n';
  fs.appendFileSync(p, `${prefix}${block.trimEnd()}\n`);
}

export function readMemory(missionId: string, root?: string): string {
  const p = memoryMdPath(missionId, root);
  if (!fs.existsSync(p)) return '';
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export function writeHeartbeat(
  missionId: string,
  beat: Heartbeat,
  root?: string,
): void {
  ensureMissionSkeleton(missionId, root);
  const lines = [
    '# Mission Heartbeat',
    '',
    `- **Runner PID**: ${beat.runnerPid}`,
    `- **Last beat**: ${beat.lastBeatAt}`,
    beat.currentStepId ? `- **Current step**: ${beat.currentStepId}` : '',
    beat.stepStartedAt ? `- **Step started at**: ${beat.stepStartedAt}` : '',
    beat.lastEvent ? `- **Last event**: ${beat.lastEvent}` : '',
    beat.gatewaySessionKey ? `- **Gateway session**: ${beat.gatewaySessionKey}` : '',
    '',
  ].filter(Boolean).join('\n');
  writeFileAtomic(heartbeatMdPath(missionId, root), lines);
}

export function readHeartbeat(missionId: string, root?: string): string {
  const p = heartbeatMdPath(missionId, root);
  if (!fs.existsSync(p)) return '';
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export interface WriteArtifactInput {
  readonly missionId: string;
  readonly stepId: string;
  readonly title: string;       // used for filename slug + markdown H1
  readonly body: string;        // markdown content WITHOUT frontmatter
  readonly frontmatter: ArtifactFrontmatter;
  readonly root?: string;
}

export function writeArtifact(input: WriteArtifactInput): string {
  const p = artifactPath(input.missionId, input.stepId, input.title, input.root);
  fs.mkdirSync(path.dirname(p), { recursive: true });

  const fmLines = [
    '---',
    `stepId: ${input.frontmatter.stepId}`,
    `agentId: ${input.frontmatter.agentId}`,
    `createdAt: ${input.frontmatter.createdAt}`,
  ];
  if (typeof input.frontmatter.durationSeconds === 'number') {
    fmLines.push(`durationSeconds: ${input.frontmatter.durationSeconds}`);
  }
  fmLines.push('---', '');

  const content = `${fmLines.join('\n')}${input.body.trimEnd()}\n`;
  writeFileAtomic(p, content);
  return path.relative(getMissionDir(input.missionId, input.root), p);
}

export function readArtifact(
  missionId: string,
  stepId: string,
  title: string,
  root?: string,
): string | null {
  const p = artifactPath(missionId, stepId, title, root);
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * List artifact file names (not full paths) for a mission, sorted by step id.
 * Useful for UI "all artifacts" listing.
 */
export function listArtifacts(missionId: string, root?: string): string[] {
  const dir = artifactsDir(missionId, root);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort();
  } catch {
    return [];
  }
}
