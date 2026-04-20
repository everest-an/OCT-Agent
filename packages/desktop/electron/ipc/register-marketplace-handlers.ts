/**
 * F-063 · Marketplace IPC handlers.
 *
 * Thin layer that exposes the cloud marketplace + local installer to the
 * renderer. Heavy lifting lives in electron/agent-marketplace/*.ts.
 *
 * Cross-navigation safety (F-063 preview.16):
 *   - In-flight installs live in a main-process set so that if the user
 *     navigates away mid-install and returns, the UI can re-query
 *     `marketplace:install-status` and restore the "installing" state
 *     without triggering a duplicate CLI call.
 *   - Progress events are broadcast via webContents for every BrowserWindow,
 *     so the overlay re-subscribes on remount and immediately shows the
 *     stage (converting / writing-workspace / registering / applying-identity
 *     / done).
 */

import { BrowserWindow, ipcMain } from "electron";
import * as fs from "fs";
import * as path from "path";

import {
  MarketplaceClient,
  AgentListResponse,
  AgentDetail,
} from "../agent-marketplace/api";
import {
  installMarketplaceAgent,
  InstallDeps,
  InstallStage,
} from "../agent-marketplace/installer";
import {
  convertWorkspaceToMarkdown,
  WorkspaceFiles,
} from "../agent-marketplace/reverse-converter";

export interface MarketplaceHandlerDeps {
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
  apiBase?: string;
}

function readInstalledSlugs(home: string): string[] {
  try {
    const cfgPath = path.join(home, ".openclaw", "openclaw.json");
    if (!fs.existsSync(cfgPath)) return [];
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    const list: any[] = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
    return list.map((a) => String(a?.id || "")).filter(Boolean);
  } catch {
    return [];
  }
}

interface LocalAgentShareable {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  hasWorkspace: boolean;
}

function readShareableAgents(home: string): LocalAgentShareable[] {
  try {
    const cfgPath = path.join(home, ".openclaw", "openclaw.json");
    if (!fs.existsSync(cfgPath)) return [];
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    const list: any[] = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
    return list
      .filter((a) => a?.id && a.id !== "main")
      .map((a) => {
        const id = String(a.id);
        const workspaceDir = path.join(home, ".openclaw", `workspace-${id}`);
        return {
          id,
          name: a?.identity?.name || a?.name || id,
          emoji: a?.identity?.emoji,
          color: a?.identity?.theme || a?.identity?.color,
          hasWorkspace: fs.existsSync(workspaceDir),
        };
      });
  } catch {
    return [];
  }
}

function readWorkspaceFiles(
  home: string,
  agentId: string
): { files: WorkspaceFiles; dir: string } {
  const dir = path.join(home, ".openclaw", `workspace-${agentId}`);
  const files: WorkspaceFiles = {};
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { files, dir };
  }
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    try {
      files[entry] = fs.readFileSync(path.join(dir, entry), "utf-8");
    } catch {
      /* unreadable — skip silently */
    }
  }
  return { files, dir };
}

function isSlugInUse(home: string, slug: string): boolean {
  return readInstalledSlugs(home).includes(slug);
}

function broadcastProgress(slug: string, stage: InstallStage) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("marketplace:install-progress", { slug, stage });
    }
  }
}

export function registerMarketplaceHandlers(deps: MarketplaceHandlerDeps): void {
  const client = new MarketplaceClient({ apiBase: deps.apiBase });

  // Tracks slugs currently being installed by this main process.
  // Key: slug, Value: latest stage (for status queries from re-mounted UI).
  const inFlight = new Map<string, InstallStage>();

  ipcMain.handle(
    "marketplace:list",
    async (
      _e,
      params: {
        tier?: string;
        category?: string;
        q?: string;
        featured?: boolean;
      } = {}
    ): Promise<{ success: boolean; data?: AgentListResponse; error?: string }> => {
      try {
        const installed = readInstalledSlugs(deps.home);
        const data = await client.list({ ...params, installed });
        return { success: true, data };
      } catch (err) {
        return {
          success: false,
          error: (err as Error).message?.slice(0, 250) || "request failed",
        };
      }
    }
  );

  ipcMain.handle(
    "marketplace:detail",
    async (
      _e,
      slug: string
    ): Promise<{ success: boolean; data?: AgentDetail; error?: string }> => {
      try {
        const data = await client.detail(slug);
        return { success: true, data };
      } catch (err) {
        return {
          success: false,
          error: (err as Error).message?.slice(0, 250) || "request failed",
        };
      }
    }
  );

  ipcMain.handle(
    "marketplace:installed-slugs",
    async (): Promise<{ success: boolean; slugs: string[] }> => {
      return { success: true, slugs: readInstalledSlugs(deps.home) };
    }
  );

  ipcMain.handle(
    "marketplace:install-status",
    async (): Promise<{
      success: boolean;
      inFlight: Array<{ slug: string; stage: InstallStage }>;
    }> => {
      return {
        success: true,
        inFlight: Array.from(inFlight.entries()).map(([slug, stage]) => ({
          slug,
          stage,
        })),
      };
    }
  );

  ipcMain.handle(
    "marketplace:install",
    async (
      _e,
      slug: string
    ): Promise<{
      success: boolean;
      agentId?: string;
      error?: string;
      alreadyInstalled?: boolean;
    }> => {
      // Guard: concurrent install already in flight for this slug.
      if (inFlight.has(slug)) {
        return {
          success: false,
          error: "install-in-progress",
        };
      }
      inFlight.set(slug, "converting");

      try {
        const detail = await client.detail(slug);
        // F-063 multi-host gate: AwarenessClaw currently only installs openclaw agents.
        // Reject early with a friendly message so UI can suggest the right host.
        const compat = Array.isArray(detail.compat) ? detail.compat : ["openclaw"];
        if (!compat.includes("openclaw")) {
          return {
            success: false,
            error: `agent only supports ${compat.join(", ")} — AwarenessClaw installs OpenClaw agents only`,
          };
        }
        const installDeps: InstallDeps = {
          home: deps.home,
          runSpawnAsync: deps.runSpawnAsync,
          applyAgentIdentityFallback: deps.applyAgentIdentityFallback,
          addAgentToConfigFallback: deps.addAgentToConfigFallback,
          isSlugInUse,
        };
        const result = await installMarketplaceAgent(
          {
            slug: detail.slug,
            markdown: detail.markdown,
            structured: {
              soul_md: detail.soul_md,
              agents_md: detail.agents_md,
              vibe: detail.vibe,
              memory_md: detail.memory_md,
              user_md: detail.user_md,
              heartbeat_md: detail.heartbeat_md,
              boot_md: detail.boot_md,
              bootstrap_md: detail.bootstrap_md,
            },
            displayNameOverride: detail.name_zh || detail.name,
            emojiOverride: detail.emoji,
            onProgress: (stage) => {
              inFlight.set(slug, stage);
              broadcastProgress(slug, stage);
            },
          },
          installDeps
        );
        if (result.success && !result.alreadyInstalled) {
          client.installPing(slug).catch(() => {
            /* ignore — ping is best effort */
          });
        }
        return result;
      } catch (err) {
        return {
          success: false,
          error: (err as Error).message?.slice(0, 250) || "install failed",
        };
      } finally {
        inFlight.delete(slug);
      }
    }
  );

  ipcMain.handle(
    "marketplace:list-shareable-agents",
    async (): Promise<{ success: boolean; agents: LocalAgentShareable[] }> => {
      return { success: true, agents: readShareableAgents(deps.home) };
    }
  );

  ipcMain.handle(
    "marketplace:compose-from-local",
    async (
      _e,
      agentId: string
    ): Promise<{
      success: boolean;
      markdown?: string;
      description?: string;
      tools?: string[];
      name?: string;
      emoji?: string;
      files?: string[];
      structured?: {
        soul_md?: string;
        agents_md?: string;
        vibe?: string;
        memory_md?: string;
        user_md?: string;
        heartbeat_md?: string;
        boot_md?: string;
        bootstrap_md?: string;
      };
      error?: string;
    }> => {
      try {
        const agents = readShareableAgents(deps.home);
        const target = agents.find((a) => a.id === agentId);
        if (!target) {
          return { success: false, error: "agent not found or is default main" };
        }
        const { files } = readWorkspaceFiles(deps.home, agentId);
        if (Object.keys(files).length === 0) {
          return {
            success: false,
            error: "agent workspace is empty — nothing to share",
          };
        }
        const composed = convertWorkspaceToMarkdown({
          agent: {
            slug: agentId,
            name: target.name,
            emoji: target.emoji,
            color: target.color,
          },
          files,
        });
        return {
          success: true,
          markdown: composed.markdown,
          description: composed.description,
          tools: composed.tools,
          name: target.name,
          emoji: target.emoji,
          files: Object.keys(files).sort(),
          structured: composed.structured,
        };
      } catch (err) {
        return {
          success: false,
          error: (err as Error).message?.slice(0, 250) || "compose failed",
        };
      }
    }
  );

  ipcMain.handle(
    "marketplace:submit",
    async (
      _e,
      payload: {
        slug: string;
        name: string;
        description: string;
        category: string;
        tier: string;
        emoji?: string;
        markdown: string;
        author_contact?: string;
        soul_md?: string;
        agents_md?: string;
        vibe?: string;
        memory_md?: string;
        user_md?: string;
        heartbeat_md?: string;
        boot_md?: string;
        bootstrap_md?: string;
      }
    ): Promise<{ success: boolean; status?: string; error?: string }> => {
      try {
        const res = await client.submit(payload);
        if (res.status >= 200 && res.status < 300) {
          return { success: true, status: res.body?.status || "pending" };
        }
        return {
          success: false,
          error:
            (res.body && (res.body.detail || res.body.error)) ||
            `HTTP ${res.status}`,
        };
      } catch (err) {
        return {
          success: false,
          error: (err as Error).message?.slice(0, 250) || "submit failed",
        };
      }
    }
  );
}
