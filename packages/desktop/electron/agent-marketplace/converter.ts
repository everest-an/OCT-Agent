/**
 * F-063 · Agent Marketplace converter.
 *
 * Converts a Claude Code subagent markdown (frontmatter + body)
 * into the OpenClaw workspace 4-file layout:
 *
 *   ~/.openclaw/workspace-<slug>/
 *     ├── SOUL.md       — identity, memory, communication, style, critical rules
 *     ├── AGENTS.md     — mission, checklists, everything else
 *     ├── IDENTITY.md   — # <emoji> <name> + description tagline
 *     └── TOOLS.md      — allowed tools whitelist
 *
 * Heuristic (adapted from msitarzewski/agency-agents `convert_openclaw`):
 *   ## Foo — bucket by keyword match on lowercased header text.
 *
 * Pure function. No IO. Fully unit-testable.
 */

export interface AgentFrontmatter {
  name: string;
  description: string;
  color?: string;
  emoji?: string;
  vibe?: string;
  tools?: string[];
  [key: string]: unknown;
}

export interface ParsedAgent {
  frontmatter: AgentFrontmatter;
  body: string;
}

export interface ConvertedWorkspace {
  soulMd: string;
  agentsMd: string;
  identityMd: string;
  toolsMd: string;
  identity: {
    name: string;
    emoji: string;
    color: string;
  };
  slug: string;
}

const SOUL_KEYWORDS = [
  /\bidentity\b/,
  /\blearning[^a-z]*memory\b/,
  /\bmemory\b/,
  /\bcommunication\b/,
  /\bstyle\b/,
  /\bcritical[^a-z]*rule/,
  /\brules you must follow/,
];

function normaliseHeader(line: string): string {
  return line.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
}

function headerGoesToSoul(headerLine: string): boolean {
  const norm = normaliseHeader(headerLine);
  return SOUL_KEYWORDS.some((re) => re.test(norm));
}

/**
 * Parse a markdown string with `---` frontmatter.
 * Minimal YAML: `key: value` or `key: a, b, c` for list-ish fields.
 */
export function parseAgentMarkdown(text: string): ParsedAgent {
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  const fm: AgentFrontmatter = { name: "", description: "" };
  let bodyStart = 0;

  if (lines[0]?.trim() === "---") {
    let closeIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        closeIdx = i;
        break;
      }
    }
    if (closeIdx > 0) {
      for (let i = 1; i < closeIdx; i++) {
        const raw = lines[i];
        if (!raw.trim() || raw.trim().startsWith("#")) continue;
        const colonIdx = raw.indexOf(":");
        if (colonIdx < 0) continue;
        const key = raw.slice(0, colonIdx).trim();
        let value = raw.slice(colonIdx + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (key === "tools" || key === "tags") {
          fm[key] = value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        } else {
          fm[key] = value;
        }
      }
      bodyStart = closeIdx + 1;
    }
  }

  const body = lines.slice(bodyStart).join("\n").replace(/^\n+/, "");
  return { frontmatter: fm, body };
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 64);
}

/**
 * Split the body into SOUL and AGENTS buckets based on ## headings.
 * Content before the first ## goes to AGENTS (introduction).
 */
function splitBody(body: string): { soul: string; agents: string } {
  const lines = body.split("\n");
  const soulChunks: string[][] = [];
  const agentsChunks: string[][] = [];

  let currentBucket: "soul" | "agents" = "agents";
  let currentBuf: string[] = [];

  const flush = () => {
    if (currentBuf.length === 0) return;
    if (currentBucket === "soul") soulChunks.push(currentBuf);
    else agentsChunks.push(currentBuf);
    currentBuf = [];
  };

  for (const line of lines) {
    const isH2 = /^##\s+/.test(line);
    if (isH2) {
      flush();
      currentBucket = headerGoesToSoul(line) ? "soul" : "agents";
    }
    currentBuf.push(line);
  }
  flush();

  const joinChunks = (chunks: string[][]): string =>
    chunks.map((c) => c.join("\n")).join("\n\n").trim();

  return {
    soul: joinChunks(soulChunks),
    agents: joinChunks(agentsChunks),
  };
}

/**
 * Main conversion entry point.
 * Throws if frontmatter is missing required fields.
 */
export function convertAgentToWorkspace(markdown: string): ConvertedWorkspace {
  const parsed = parseAgentMarkdown(markdown);
  const fm = parsed.frontmatter;

  if (!fm.name || typeof fm.name !== "string" || !fm.name.trim()) {
    throw new Error("frontmatter missing required field: name");
  }
  if (!fm.description || typeof fm.description !== "string") {
    throw new Error("frontmatter missing required field: description");
  }

  const name = String(fm.name).trim();
  const description = String(fm.description).trim();
  const emoji = (typeof fm.emoji === "string" && fm.emoji.trim()) || "🤖";
  const color = (typeof fm.color === "string" && fm.color.trim()) || "slate";
  const vibe =
    (typeof fm.vibe === "string" && fm.vibe.trim()) || description;

  const { soul, agents } = splitBody(parsed.body);

  // Fallback: if soul is empty (headings didn't match keywords),
  // seed it with identity + description so the SOUL file is never useless.
  const soulMd =
    soul ||
    `## Identity\n\n${description}\n\n## Communication Style\n\nBe helpful and honest.\n`;

  // Agents fallback: if no body after split, ensure at least a mission line.
  const agentsMd = agents || `# ${name}\n\n${description}\n`;

  const identityMd = `# ${emoji} ${name}\n\n${vibe}\n`;

  const tools =
    Array.isArray(fm.tools) && fm.tools.length > 0
      ? (fm.tools as string[])
      : ["Read", "Write", "Edit"];

  const toolsMd = [
    `# Allowed tools for ${name}`,
    "",
    "This agent is permitted to use only the tools listed below.",
    "",
    ...tools.map((t) => `- ${t}`),
    "",
  ].join("\n");

  return {
    soulMd,
    agentsMd,
    identityMd,
    toolsMd,
    identity: { name, emoji, color },
    slug: slugify(name),
  };
}
