/**
 * F-063 · Agent installer — turns a marketplace payload into a functioning
 * OpenClaw sub-agent.
 *
 * Steps:
 *   1. Convert markdown → 4-file workspace layout
 *   2. Ensure workspace directory exists at ~/.openclaw/workspace-<slug>/
 *   3. Write SOUL.md / AGENTS.md / IDENTITY.md / TOOLS.md
 *   4. Call `openclaw agents add <slug> --non-interactive --workspace <wsDir>`
 *      (with fallback to direct config write if CLI stalls, mirroring the
 *      existing `agents:add` handler behaviour).
 *   5. Patch openclaw.json identity block with display name + emoji
 *
 * Kept in its own module so `register-marketplace-handlers.ts` stays thin.
 */

import * as fs from "fs";
import * as path from "path";

import { convertAgentToWorkspace } from "./converter";

export type InstallStage =
  | "converting"
  | "writing-workspace"
  | "registering"
  | "applying-identity"
  | "done";

export interface InstallInput {
  slug: string;
  /** Fallback path: single-file markdown + keyword heuristic (legacy 0.4.0). */
  markdown: string;
  /** Preferred path (F-063 0.4.1+): pre-split per-file content straight from DB.
   *  When any of these is provided, installer skips the keyword heuristic and
   *  writes each file verbatim for 100% round-trip fidelity. */
  structured?: {
    soul_md?: string | null;
    agents_md?: string | null;
    vibe?: string | null;
    memory_md?: string | null;
    user_md?: string | null;
    heartbeat_md?: string | null;
  };
  displayNameOverride?: string;
  emojiOverride?: string;
  onProgress?: (stage: InstallStage) => void;
}

export interface InstallDeps {
  home: string;
  runSpawnAsync: (cmd: string, args: string[], timeoutMs?: number) => Promise<string>;
  applyAgentIdentityFallback: (
    home: string,
    agentId: string,
    patch: { name?: string; emoji?: string; avatar?: string; theme?: string }
  ) => { success: boolean; error?: string };
  addAgentToConfigFallback: (
    home: string,
    agentId: string,
    opts: { model: string | null }
  ) => { success: boolean; alreadyExists?: boolean; error?: string };
  isSlugInUse: (home: string, slug: string) => boolean;
}

export interface InstallResult {
  success: boolean;
  agentId?: string;
  error?: string;
  alreadyInstalled?: boolean;
}

const SLUG_RE = /^[a-z][a-z0-9-]{2,63}$/;

export async function installMarketplaceAgent(
  input: InstallInput,
  deps: InstallDeps
): Promise<InstallResult> {
  if (!SLUG_RE.test(input.slug)) {
    return { success: false, error: `invalid slug: ${input.slug}` };
  }

  const progress = (stage: InstallStage) => {
    try {
      input.onProgress?.(stage);
    } catch {
      /* never let a progress callback crash the install */
    }
  };

  progress("converting");
  let converted;
  try {
    converted = convertAgentToWorkspace(input.markdown);
  } catch (err) {
    return { success: false, error: `convert failed: ${(err as Error).message}` };
  }

  // If the server provided structured per-file content, it wins over the
  // keyword-heuristic output. This is the F-063 0.4.1+ path where admin
  // edits separate fields and the client writes them verbatim.
  if (input.structured) {
    const s = input.structured;
    if (s.soul_md && s.soul_md.trim()) converted.soulMd = s.soul_md;
    if (s.agents_md && s.agents_md.trim()) converted.agentsMd = s.agents_md;
    // IDENTITY.md is always `# emoji name\n\nvibe` — override vibe if given
    if (s.vibe && s.vibe.trim()) {
      converted.identityMd = `# ${converted.identity.emoji} ${converted.identity.name}\n\n${s.vibe.trim()}\n`;
    }
  }

  const slug = input.slug; // trust server slug over the name-derived one
  const displayName = (input.displayNameOverride ?? converted.identity.name).trim();
  const emoji = (input.emojiOverride ?? converted.identity.emoji).trim() || "🤖";

  if (deps.isSlugInUse(deps.home, slug)) {
    return { success: true, agentId: slug, alreadyInstalled: true };
  }

  progress("writing-workspace");
  const wsDir = path.join(deps.home, ".openclaw", `workspace-${slug}`);
  fs.mkdirSync(wsDir, { recursive: true });

  // Write the 4-file layout BEFORE CLI add so openclaw sees them when seeding.
  fs.writeFileSync(path.join(wsDir, "SOUL.md"), converted.soulMd, "utf-8");
  fs.writeFileSync(path.join(wsDir, "AGENTS.md"), converted.agentsMd, "utf-8");
  fs.writeFileSync(path.join(wsDir, "IDENTITY.md"), converted.identityMd, "utf-8");
  fs.writeFileSync(path.join(wsDir, "TOOLS.md"), converted.toolsMd, "utf-8");

  // Optional workspace files (F-063 0.4.1+) — only written when the agent
  // actually has content for them. OpenClaw happily accepts them alongside
  // the mandatory 4-file layout.
  if (input.structured?.memory_md && input.structured.memory_md.trim()) {
    fs.writeFileSync(path.join(wsDir, "MEMORY.md"), input.structured.memory_md, "utf-8");
  }
  if (input.structured?.user_md && input.structured.user_md.trim()) {
    fs.writeFileSync(path.join(wsDir, "USER.md"), input.structured.user_md, "utf-8");
  }
  if (input.structured?.heartbeat_md && input.structured.heartbeat_md.trim()) {
    fs.writeFileSync(path.join(wsDir, "HEARTBEAT.md"), input.structured.heartbeat_md, "utf-8");
  }

  progress("registering");
  const spawnArgs = [
    "agents",
    "add",
    slug,
    "--non-interactive",
    "--workspace",
    wsDir,
  ];

  let cliAdded = false;
  try {
    await deps.runSpawnAsync("openclaw", spawnArgs, 120000);
    cliAdded = true;
  } catch (cliErr: any) {
    const raw = cliErr?.message || String(cliErr || "");
    // Idempotent: another concurrent install (or an aborted UI session whose
    // main-process spawn finished in the background) already added the agent.
    // Treat as success — installation is idempotent by design.
    if (/already exists/i.test(raw)) {
      return { success: true, agentId: slug, alreadyInstalled: true };
    }
    if (/timed? ?out|timeout/i.test(raw)) {
      const fallback = deps.addAgentToConfigFallback(deps.home, slug, {
        model: null,
      });
      if (!fallback.success && !fallback.alreadyExists) {
        return {
          success: false,
          error: `install timed out and fallback failed: ${fallback.error || "unknown"}`,
        };
      }
    } else {
      return {
        success: false,
        error: `openclaw agents add failed: ${raw.slice(0, 200)}`,
      };
    }
  }

  // Strip the auto-seeded workspace field so sub-agent isn't confined.
  try {
    const cfgPath = path.join(deps.home, ".openclaw", "openclaw.json");
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      const list: any[] = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
      const entry = list.find((a) => a?.id === slug);
      if (entry && entry.workspace === wsDir) {
        delete entry.workspace;
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");
      }
    }
  } catch {
    // Non-fatal.
  }

  progress("applying-identity");
  // Write display name + emoji into openclaw.json identity block.
  const identityResult = deps.applyAgentIdentityFallback(deps.home, slug, {
    name: displayName || undefined,
    emoji: emoji || undefined,
  });
  if (!identityResult.success) {
    // Non-fatal; agent is usable even without identity branding.
    // Log only.
    console.warn(
      `[marketplace] identity patch failed for ${slug}: ${identityResult.error || "unknown"}`
    );
  }

  progress("done");
  return { success: true, agentId: slug, alreadyInstalled: false };
}
