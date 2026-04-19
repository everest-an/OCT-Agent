/**
 * F-063 · Marketplace IPC handlers.
 *
 * Thin layer that exposes the cloud marketplace + local installer to the
 * renderer. Heavy lifting lives in electron/agent-marketplace/*.ts.
 */

import { ipcMain } from "electron";
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
} from "../agent-marketplace/installer";

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

function isSlugInUse(home: string, slug: string): boolean {
  return readInstalledSlugs(home).includes(slug);
}

export function registerMarketplaceHandlers(deps: MarketplaceHandlerDeps): void {
  const client = new MarketplaceClient({ apiBase: deps.apiBase });

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
    "marketplace:install",
    async (
      _e,
      slug: string
    ): Promise<{ success: boolean; agentId?: string; error?: string; alreadyInstalled?: boolean }> => {
      try {
        const detail = await client.detail(slug);
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
            displayNameOverride: detail.name_zh || detail.name,
            emojiOverride: detail.emoji,
          },
          installDeps
        );
        if (result.success && !result.alreadyInstalled) {
          // fire-and-forget install ping (analytics)
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
