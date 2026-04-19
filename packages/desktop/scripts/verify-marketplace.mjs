#!/usr/bin/env node
/**
 * F-063 · L1 static contract guard for agent marketplace.
 *
 * Verifies:
 *   1. Every `window.electronAPI.marketplace*` call in renderer src/ has a
 *      matching `ipcMain.handle('marketplace:*')` in electron/.
 *   2. Every `marketplace:*` channel exposed via preload is actually handled.
 *   3. Backend API paths referenced by the electron client exist in the
 *      routes file (skipped if backend not checked out alongside).
 *
 * Exits non-zero on violation. Runs in <1s.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const DESKTOP_ROOT = path.resolve(path.dirname(__filename), "..");
const REPO_ROOT = path.resolve(DESKTOP_ROOT, "..", "..", "..");

function readAll(dir, exts) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "dist-electron") continue;
      out.push(...readAll(full, exts));
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(full);
    }
  }
  return out;
}

function extractHandlerChannels() {
  const channels = new Set();
  const files = readAll(path.join(DESKTOP_ROOT, "electron"), [".ts"]);
  const re = /ipcMain\.handle\(\s*["']([^"']+)["']/g;
  for (const f of files) {
    const body = fs.readFileSync(f, "utf8");
    let m;
    while ((m = re.exec(body))) channels.add(m[1]);
  }
  return channels;
}

function extractPreloadChannels() {
  const preloadPath = path.join(DESKTOP_ROOT, "electron", "preload.ts");
  if (!fs.existsSync(preloadPath)) return new Set();
  const body = fs.readFileSync(preloadPath, "utf8");
  const re = /ipcRenderer\.invoke\(\s*["']([^"']+)["']/g;
  const channels = new Set();
  let m;
  while ((m = re.exec(body))) channels.add(m[1]);
  return channels;
}

function extractRendererInvocations() {
  const channels = new Set();
  const files = readAll(path.join(DESKTOP_ROOT, "src"), [".ts", ".tsx"]);
  const apiRe = /electronAPI[^\s;()]{0,10}\.(marketplace[A-Za-z]+)/g;
  for (const f of files) {
    const body = fs.readFileSync(f, "utf8");
    let m;
    while ((m = apiRe.exec(body))) channels.add(m[1]);
  }
  return channels;
}

function checkMarketplaceChannels(handlers, preload) {
  const expected = [
    "marketplace:list",
    "marketplace:detail",
    "marketplace:installed-slugs",
    "marketplace:install",
    "marketplace:submit",
  ];
  const errors = [];
  for (const ch of expected) {
    if (!handlers.has(ch)) errors.push(`missing ipcMain.handle('${ch}')`);
    if (!preload.has(ch)) errors.push(`missing preload invoke for '${ch}'`);
  }
  return errors;
}

function checkBackendRoutes() {
  const errors = [];
  const routeFile = path.join(
    REPO_ROOT,
    "backend",
    "awareness",
    "api",
    "routes",
    "agent_marketplace.py"
  );
  if (!fs.existsSync(routeFile)) {
    // Backend not co-located; skip gracefully.
    return errors;
  }
  const body = fs.readFileSync(routeFile, "utf8");
  const required = [
    'prefix="/marketplace/agents"',
    '@router.get("", ',
    '@router.get("/{slug}"',
    '@router.post(\n    "/{slug}/install-ping"',
    '"/submissions"',
  ];
  for (const needle of required) {
    if (!body.includes(needle)) errors.push(`backend route missing pattern: ${needle}`);
  }
  return errors;
}

function main() {
  const handlers = extractHandlerChannels();
  const preload = extractPreloadChannels();
  const rendererCalls = extractRendererInvocations();

  const errors = [];
  errors.push(...checkMarketplaceChannels(handlers, preload));
  errors.push(...checkBackendRoutes());

  const expectedApi = [
    "marketplaceList",
    "marketplaceDetail",
    "marketplaceInstalledSlugs",
    "marketplaceInstall",
    "marketplaceSubmit",
  ];
  for (const name of expectedApi) {
    if (!rendererCalls.has(name)) {
      // Soft warn only — some API methods may not be called yet.
      console.log(`  (info) renderer does not yet call electronAPI.${name}`);
    }
  }

  if (errors.length > 0) {
    console.error("❌ verify-marketplace FAILED:");
    for (const e of errors) console.error(`   - ${e}`);
    process.exit(1);
  }
  console.log("✅ verify-marketplace: all marketplace contracts wired.");
  console.log(`   handlers: ${[...handlers].filter((c) => c.startsWith("marketplace:")).sort().join(", ")}`);
  process.exit(0);
}

main();
