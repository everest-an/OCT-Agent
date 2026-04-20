/**
 * F-063 · Reverse converter — OpenClaw workspace (multi-file) → single
 * Claude-Code-style markdown with frontmatter.
 *
 * Used by the "分享我的 Agent" flow: a user has crafted an agent locally
 * in `~/.openclaw/workspace-<slug>/` (SOUL.md + AGENTS.md + IDENTITY.md +
 * TOOLS.md plus optional HEARTBEAT/MEMORY/USER). We reverse that into the
 * catalog format so the community marketplace can re-install it on any
 * other machine.
 *
 * Pure function. No IO. Unit tested.
 */

export interface WorkspaceFiles {
  /** All readable *.md files in the workspace keyed by uppercase basename. */
  [filename: string]: string;
}

export interface AgentDescriptor {
  slug: string;
  name: string;
  emoji?: string;
  color?: string;
}

export interface ReverseConvertInput {
  agent: AgentDescriptor;
  files: WorkspaceFiles;
  /** Optional description override — otherwise inferred from IDENTITY body. */
  description?: string;
  /** Optional tool whitelist override — otherwise parsed from TOOLS.md. */
  tools?: string[];
}

/**
 * Section order when folding workspace files into a single markdown body.
 * Matches the heading order agency-agents / our seed library use.
 */
const SECTION_ORDER = [
  { file: "IDENTITY", heading: null }, // identity drops into opening paragraph
  { file: "SOUL", heading: null }, // SOUL already contains ## sub-headings
  { file: "AGENTS", heading: null }, // AGENTS also has ## headings
  { file: "MEMORY", heading: "## Memory" },
  { file: "USER", heading: "## User Context" },
  { file: "HEARTBEAT", heading: "## Heartbeat" },
];

const DEFAULT_TOOLS = ["Read", "Write", "Edit"];

function stripLeadingH1(md: string): string {
  return md.replace(/^#\s+[^\n]*\n+/, "");
}

function parseToolsMd(md: string | undefined): string[] {
  if (!md) return [];
  const tools: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    // Match bullet points `- Read`, `* Read`, `1. Read`
    const m = line.match(/^\s*(?:[-*]|\d+\.)\s+([A-Z][A-Za-z0-9_]+)\s*$/);
    if (m) tools.push(m[1]);
  }
  return [...new Set(tools)];
}

function pickDescription(identityMd: string | undefined, fallback: string): string {
  if (!identityMd) return fallback;
  // Strip frontmatter that the user might have pasted in IDENTITY.md by mistake.
  const clean = identityMd.replace(/^---[\s\S]*?---\n+/, "");
  // Pick the first non-heading, non-empty line.
  for (const line of clean.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    // Max 400 chars to fit our backend validator.
    return trimmed.slice(0, 380);
  }
  return fallback;
}

function normalizeFiles(files: WorkspaceFiles): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, body] of Object.entries(files)) {
    const key = name.replace(/\.md$/i, "").toUpperCase();
    out[key] = body.replace(/\r\n/g, "\n").trim();
  }
  return out;
}

export function convertWorkspaceToMarkdown(input: ReverseConvertInput): {
  markdown: string;
  description: string;
  tools: string[];
} {
  const normalized = normalizeFiles(input.files);

  const toolsFromFile = parseToolsMd(normalized.TOOLS);
  const tools =
    input.tools && input.tools.length > 0
      ? input.tools
      : toolsFromFile.length > 0
      ? toolsFromFile
      : DEFAULT_TOOLS;

  const description = input.description?.trim()
    || pickDescription(normalized.IDENTITY, `${input.agent.name} agent`);

  const emoji = (input.agent.emoji && input.agent.emoji.trim()) || "🤖";
  const color = (input.agent.color && input.agent.color.trim()) || "slate";

  // Build frontmatter.
  const fmLines: string[] = ["---"];
  fmLines.push(`name: ${input.agent.name}`);
  fmLines.push(`description: ${escapeYamlScalar(description)}`);
  fmLines.push(`color: ${color}`);
  fmLines.push(`emoji: ${emoji}`);
  if (tools.length > 0) {
    fmLines.push(`tools: ${tools.join(", ")}`);
  }
  fmLines.push("---");
  fmLines.push("");

  // Compose body: start with H1 + identity snippet, then each section.
  const bodyParts: string[] = [`# ${input.agent.name}`];

  for (const section of SECTION_ORDER) {
    const raw = normalized[section.file];
    if (!raw) continue;
    const content = stripLeadingH1(raw).trim();
    if (!content) continue;
    if (section.heading) {
      bodyParts.push("", section.heading, "", content);
    } else {
      bodyParts.push("", content);
    }
  }

  const markdown = fmLines.join("\n") + bodyParts.join("\n") + "\n";
  return { markdown, description, tools };
}

function escapeYamlScalar(value: string): string {
  // Reuse the same logic as our forward converter's `_escape` helper.
  if (/[:\n"#]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}
