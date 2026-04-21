/**
 * F-063 · HTTPS client for the cloud marketplace API.
 *
 * Uses Node's native `https` module — zero npm dependencies,
 * consistent with `app-update-check.ts` pattern.
 */

import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { URL } from "url";

export interface AgentMeta {
  slug: string;
  name: string;
  name_zh?: string | null;
  description: string;
  description_zh?: string | null;
  category: string;
  tier: "consumer" | "prosumer" | "engineering";
  emoji: string;
  color: string;
  tags: string[];
  tools: string[];
  featured: boolean;
  install_count: number;
  compat?: string[];
  source?: string;
  author?: string;
}

export interface AgentDetail extends AgentMeta {
  /** Single-file composed view (Claude sub-agent export + legacy fallback). */
  markdown: string;
  /** F-063 per-file structured fields — maps 1:1 to OpenClaw workspace layout.
   *  Installer prefers these over heuristic split of `markdown`. */
  soul_md?: string | null;
  agents_md?: string | null;
  vibe?: string | null;
  memory_md?: string | null;
  user_md?: string | null;
  heartbeat_md?: string | null;
  /** BOOT.md — gateway-restart checklist (distinct from BOOTSTRAP). */
  boot_md?: string | null;
  /** BOOTSTRAP.md — one-time Q&A seeded for new users; OpenClaw deletes after. */
  bootstrap_md?: string | null;
}

export interface AgentListResponse {
  agents: AgentMeta[];
  total: number;
}

export interface MarketplaceClientOptions {
  apiBase?: string;
  timeoutMs?: number;
}

/** Production marketplace API base. Override at runtime via `AWARENESS_API_BASE`
 *  env var or `~/.awareness/marketplace-config.json` (dev). */
const DEFAULT_API_BASE = "https://awareness.market/api/v1";

/** GET endpoints (list/detail) — fast, safe to give up after 12s. */
const DEFAULT_TIMEOUT_MS = 12000;

/** Write endpoints (submit) — prod sometimes takes 10-25s due to LLM-backed
 *  validation + DB write + rate-limit check. 12s is too aggressive here and
 *  was actually firing on real users mid-submission (F-063 0.4.4 bug). */
const SUBMIT_TIMEOUT_MS = 45000;

/**
 * Returns `true` if running inside a packaged DMG/exe, `false` in
 * `npm run dev:electron` or in vitest. Packaged builds must ALWAYS hit
 * prod — no env or config override allowed — so a dev's stale
 * `~/.awareness/marketplace-config.json` can never leak into a shipped
 * app. (Happened to F-063 0.4.2-0.4.5 on the dev machine.)
 */
function isPackagedApp(): boolean {
  try {
    // Electron import is lazy + guarded so vitest/CLI callers don't fail.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require("electron");
    return app?.isPackaged === true;
  } catch {
    return false;
  }
}

/**
 * Optional per-user override (DEV ONLY — ignored in packaged DMG):
 *   ~/.awareness/marketplace-config.json
 *     { "apiBase": "http://localhost:8000/api/v1" }
 *
 * Useful for dogfooding against a local backend before prod deploy,
 * or for running the desktop against a staging/preview cluster.
 * Missing / malformed file is silently ignored.
 */
function readConfigFileApiBase(): string | null {
  try {
    const cfgPath = path.join(
      os.homedir(),
      ".awareness",
      "marketplace-config.json"
    );
    if (!fs.existsSync(cfgPath)) return null;
    const raw = fs.readFileSync(cfgPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.apiBase === "string" && parsed.apiBase.trim()) {
      return parsed.apiBase.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function getJson<T>(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
  return new Promise((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }

    const httpLib: typeof https = parsedUrl.protocol === "http:" ? (http as any) : https;
    const req = httpLib.get(
      parsedUrl,
      { timeout: timeoutMs, headers: { accept: "application/json" } },
      (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body) as T);
          } catch (err) {
            reject(
              new Error(
                `Failed to parse JSON from ${url}: ${(err as Error).message}`
              )
            );
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
  });
}

function postEmpty(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }

    const httpLib: typeof https = parsedUrl.protocol === "http:" ? (http as any) : https;
    const req = httpLib.request(
      parsedUrl,
      { method: "POST", timeout: timeoutMs, headers: { accept: "application/json" } },
      (res) => {
        if (!res.statusCode || res.statusCode >= 500) {
          res.resume();
          reject(new Error(`POST ${url} -> HTTP ${res.statusCode}`));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch {
            resolve({});
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

function postJson(
  url: string,
  payload: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }

    const data = Buffer.from(JSON.stringify(payload), "utf8");
    const httpLib: typeof https = parsedUrl.protocol === "http:" ? (http as any) : https;
    const req = httpLib.request(
      parsedUrl,
      {
        method: "POST",
        timeout: timeoutMs,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "content-length": String(data.length),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode || 0, body: body ? JSON.parse(body) : {} });
          } catch {
            resolve({ status: res.statusCode || 0, body });
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function qs(params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return pairs.length ? `?${pairs.join("&")}` : "";
}

export class MarketplaceClient {
  private apiBase: string;
  private timeoutMs: number;

  constructor(options: MarketplaceClientOptions = {}) {
    const packaged = isPackagedApp();

    // Packaged DMG MUST always hit prod. Env + config overrides are a dev
    // convenience only — in shipped builds they're a footgun (stale
    // ~/.awareness/marketplace-config.json silently redirected submits to
    // localhost on a dev machine for weeks).
    const explicit = options.apiBase;
    const envOverride = packaged ? undefined : process.env.AWARENESS_API_BASE;
    const fileOverride = packaged ? null : readConfigFileApiBase();
    const base = explicit || envOverride || fileOverride || DEFAULT_API_BASE;
    this.apiBase = base.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

    // Print the resolved apiBase + its source so every user/dev can spot
    // "why is submit hitting X?" in the devtools console (View → Toggle
    // Developer Tools) without digging through code.
    const source = explicit
      ? "constructor"
      : envOverride
      ? "env AWARENESS_API_BASE (dev only)"
      : fileOverride
      ? "~/.awareness/marketplace-config.json (dev only)"
      : packaged
      ? "default (prod, packaged build — overrides disabled)"
      : "default (prod)";
    // eslint-disable-next-line no-console
    console.log(
      `[marketplace] apiBase=${this.apiBase} (source: ${source})`
    );
  }

  list(params: {
    tier?: string;
    category?: string;
    q?: string;
    featured?: boolean;
    installed?: string[];
  } = {}): Promise<AgentListResponse> {
    const query = qs({
      tier: params.tier,
      category: params.category,
      q: params.q,
      featured: params.featured ? "true" : undefined,
      installed: params.installed && params.installed.length > 0 ? params.installed.join(",") : undefined,
    });
    return getJson<AgentListResponse>(
      `${this.apiBase}/marketplace/agents${query}`,
      this.timeoutMs
    );
  }

  detail(slug: string): Promise<AgentDetail> {
    return getJson<AgentDetail>(
      `${this.apiBase}/marketplace/agents/${encodeURIComponent(slug)}`,
      this.timeoutMs
    );
  }

  installPing(slug: string): Promise<void> {
    return postEmpty(
      `${this.apiBase}/marketplace/agents/${encodeURIComponent(slug)}/install-ping`,
      this.timeoutMs
    ).then(() => undefined);
  }

  submit(payload: {
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
  }): Promise<{ status: number; body: any }> {
    // Override the default GET timeout with a generous submit-specific one.
    // Prod latency for POST /submissions is 10-25s (LLM validation + DB write).
    return postJson(
      `${this.apiBase}/marketplace/agents/submissions`,
      payload,
      SUBMIT_TIMEOUT_MS
    );
  }
}
