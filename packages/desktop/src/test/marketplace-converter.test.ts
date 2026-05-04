import { describe, it, expect } from 'vitest';
import {
  parseAgentMarkdown,
  convertAgentToWorkspace,
  slugify,
} from '../../electron/agent-marketplace/converter';

describe('parseAgentMarkdown', () => {
  it('extracts frontmatter and body', () => {
    const src = '---\nname: Foo\ndescription: Bar\n---\n\nhello';
    const { frontmatter, body } = parseAgentMarkdown(src);
    expect(frontmatter.name).toBe('Foo');
    expect(frontmatter.description).toBe('Bar');
    expect(body).toBe('hello');
  });

  it('parses comma lists for tools', () => {
    const src = '---\nname: x\ndescription: y\ntools: Read, Write, Edit\n---\n\nbody';
    const { frontmatter } = parseAgentMarkdown(src);
    expect(frontmatter.tools).toEqual(['Read', 'Write', 'Edit']);
  });

  it('handles quoted values with colons', () => {
    const src = '---\nname: "Colon: Thing"\ndescription: x\n---\n\nbody';
    const { frontmatter } = parseAgentMarkdown(src);
    expect(frontmatter.name).toBe('Colon: Thing');
  });

  it('returns empty frontmatter when missing', () => {
    const src = '# Foo\n\nno frontmatter';
    const { frontmatter, body } = parseAgentMarkdown(src);
    expect(frontmatter.name).toBe('');
    expect(body).toContain('# Foo');
  });

  it('handles CRLF line endings', () => {
    const src = '---\r\nname: Foo\r\ndescription: Bar\r\n---\r\n\r\nbody';
    const { frontmatter, body } = parseAgentMarkdown(src);
    expect(frontmatter.name).toBe('Foo');
    expect(body).toBe('body');
  });
});

describe('slugify', () => {
  it('lowercases and replaces spaces', () => {
    expect(slugify('Code Reviewer')).toBe('code-reviewer');
  });

  it('strips non-ASCII', () => {
    expect(slugify('代码 Reviewer')).toBe('reviewer');
  });

  it('collapses multiple dashes', () => {
    expect(slugify('A -- B')).toBe('a-b');
  });
});

describe('convertAgentToWorkspace — happy path', () => {
  const SAMPLE = `---
name: Code Reviewer
description: Reviews code with kindness.
color: purple
emoji: 👁️
vibe: Mentor, not gatekeeper.
tools: Read, Grep
---

# Code Reviewer

## Identity & Memory
You remember the codebase.

## Core Mission
Find real issues.

## Critical Rules
- Rate severity

## Review Checklist
- 1. Security
- 2. Readability

## Communication Style
Warm and direct.
`;

  it('produces all 4 workspace files', () => {
    const out = convertAgentToWorkspace(SAMPLE);
    expect(out.soulMd).not.toBe('');
    expect(out.agentsMd).not.toBe('');
    expect(out.identityMd).not.toBe('');
    expect(out.toolsMd).not.toBe('');
  });

  it('routes Identity/Critical/Communication headings into SOUL', () => {
    const out = convertAgentToWorkspace(SAMPLE);
    expect(out.soulMd).toContain('## Identity & Memory');
    expect(out.soulMd).toContain('## Critical Rules');
    expect(out.soulMd).toContain('## Communication Style');
  });

  it('routes Core Mission and Checklist into AGENTS', () => {
    const out = convertAgentToWorkspace(SAMPLE);
    expect(out.agentsMd).toContain('## Core Mission');
    expect(out.agentsMd).toContain('## Review Checklist');
    expect(out.agentsMd).not.toContain('## Identity & Memory');
  });

  it('IDENTITY.md contains emoji + name + vibe', () => {
    const out = convertAgentToWorkspace(SAMPLE);
    expect(out.identityMd).toContain('👁️');
    expect(out.identityMd).toContain('Code Reviewer');
    expect(out.identityMd).toContain('Mentor');
  });

  it('TOOLS.md lists each tool as a bullet', () => {
    const out = convertAgentToWorkspace(SAMPLE);
    expect(out.toolsMd).toContain('- Read');
    expect(out.toolsMd).toContain('- Grep');
  });

  it('slug is derived from name', () => {
    const out = convertAgentToWorkspace(SAMPLE);
    expect(out.slug).toBe('code-reviewer');
  });

  it('carries emoji + color + name through identity', () => {
    const out = convertAgentToWorkspace(SAMPLE);
    expect(out.identity.emoji).toBe('👁️');
    expect(out.identity.color).toBe('purple');
    expect(out.identity.name).toBe('Code Reviewer');
  });
});

describe('convertAgentToWorkspace — fallbacks', () => {
  it('fills in SOUL when no matching ## headings present', () => {
    const src = `---
name: Quirky
description: Does quirky things.
---

# Quirky

## Whatever Section
Stuff here.
`;
    const out = convertAgentToWorkspace(src);
    // SOUL should have at least the description fallback seeded
    expect(out.soulMd.length).toBeGreaterThan(0);
    expect(out.soulMd.toLowerCase()).toContain('quirky');
  });

  it('provides default emoji when missing', () => {
    const src = '---\nname: x\ndescription: y\n---\n\nbody';
    const out = convertAgentToWorkspace(src);
    expect(out.identity.emoji).toBe('🤖');
  });

  it('falls back to default emoji when frontmatter emoji is invalid unicode text', () => {
    const src = '---\nname: x\ndescription: y\nemoji: [禹]\n---\n\nbody';
    const out = convertAgentToWorkspace(src);
    expect(out.identity.emoji).toBe('🤖');
  });

  it('provides default tools when missing', () => {
    const src = '---\nname: x\ndescription: y\n---\n\nbody';
    const out = convertAgentToWorkspace(src);
    expect(out.toolsMd).toContain('- Read');
  });
});

describe('convertAgentToWorkspace — errors', () => {
  it('throws when name is missing', () => {
    const src = '---\ndescription: only desc\n---\n\nbody';
    expect(() => convertAgentToWorkspace(src)).toThrow(/name/);
  });

  it('throws when description is missing', () => {
    const src = '---\nname: foo\n---\n\nbody';
    expect(() => convertAgentToWorkspace(src)).toThrow(/description/);
  });

  it('throws on empty string', () => {
    expect(() => convertAgentToWorkspace('')).toThrow();
  });
});

describe('convertAgentToWorkspace — heading heuristic edge cases', () => {
  it('matches "Rules You Must Follow" → SOUL', () => {
    const src = `---
name: x
description: y
---

## Rules You Must Follow
- rule 1
`;
    const out = convertAgentToWorkspace(src);
    expect(out.soulMd).toContain('## Rules You Must Follow');
  });

  it('matches emojified identity heading', () => {
    const src = `---
name: x
description: y
---

## 🧠 Your Identity & Memory
stuff
`;
    const out = convertAgentToWorkspace(src);
    expect(out.soulMd).toContain('Identity & Memory');
  });
});
