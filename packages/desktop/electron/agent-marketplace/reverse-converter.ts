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

export interface StructuredWorkspaceFields {
  /** IDENTITY.md — emoji+name+vibe one-liner. We extract just the vibe
   *  portion because emoji+name already live as agent fields. */
  vibe?: string;
  soul_md?: string;
  agents_md?: string;
  memory_md?: string;
  user_md?: string;
  heartbeat_md?: string;
  boot_md?: string;
  bootstrap_md?: string;
}

/**
 * Read each workspace file verbatim (NO heuristic split). The caller ships
 * structured fields straight to the marketplace submission so round-trip
 * is lossless — admin review sees exactly what the user typed, and on
 * approve the backend writes each column 1:1 without re-parsing.
 */
export function extractStructuredFields(
  files: WorkspaceFiles
): StructuredWorkspaceFields {
  const normalized = normalizeFiles(files);
  const out: StructuredWorkspaceFields = {};

  if (normalized.SOUL)    out.soul_md    = stripLeadingH1(normalized.SOUL).trim() || undefined;
  if (normalized.AGENTS)  out.agents_md  = stripLeadingH1(normalized.AGENTS).trim() || undefined;
  if (normalized.MEMORY)  out.memory_md  = stripLeadingH1(normalized.MEMORY).trim() || undefined;
  if (normalized.USER)    out.user_md    = stripLeadingH1(normalized.USER).trim() || undefined;
  if (normalized.HEARTBEAT) out.heartbeat_md = stripLeadingH1(normalized.HEARTBEAT).trim() || undefined;
  if (normalized.BOOT)    out.boot_md    = stripLeadingH1(normalized.BOOT).trim() || undefined;
  if (normalized.BOOTSTRAP) out.bootstrap_md = stripLeadingH1(normalized.BOOTSTRAP).trim() || undefined;

  // IDENTITY.md format is `# {emoji} {name}\n\n{vibe}` — pull the first
  // non-heading paragraph out as vibe.
  if (normalized.IDENTITY) {
    const stripped = normalized.IDENTITY.replace(/^---[\s\S]*?---\n+/, "");
    for (const raw of stripped.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      out.vibe = line.slice(0, 480);
      break;
    }
  }

  return out;
}

export function convertWorkspaceToMarkdown(input: ReverseConvertInput): {
  markdown: string;
  description: string;
  tools: string[];
  structured: StructuredWorkspaceFields;
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
  const structured = extractStructuredFields(input.files);
  return { markdown, description, tools, structured };
}

function escapeYamlScalar(value: string): string {
  // Reuse the same logic as our forward converter's `_escape` helper.
  if (/[:\n"#]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}
