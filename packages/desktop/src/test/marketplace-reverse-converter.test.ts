import { describe, it, expect } from 'vitest';
import { convertWorkspaceToMarkdown } from '../../electron/agent-marketplace/reverse-converter';

describe('convertWorkspaceToMarkdown — happy path', () => {
  const sampleFiles = {
    'IDENTITY.md': '# 🧪 Test Agent\n\nA friendly test agent for local dev.\n',
    'SOUL.md': '## Identity\nYou are helpful.\n\n## Communication Style\nBe warm.\n',
    'AGENTS.md': '## Core Mission\nHelp with tests.\n\n## Rules You Must Follow\n- Be precise\n',
    'TOOLS.md': '# Allowed tools\n\n- Read\n- Write\n- Edit\n- WebFetch\n',
  };

  it('produces a markdown with frontmatter + name + description + tools', () => {
    const out = convertWorkspaceToMarkdown({
      agent: { slug: 'test-agent', name: 'Test Agent', emoji: '🧪', color: 'slate' },
      files: sampleFiles,
    });
    expect(out.markdown).toMatch(/^---\n/);
    expect(out.markdown).toContain('name: Test Agent');
    expect(out.markdown).toContain('emoji: 🧪');
    expect(out.markdown).toContain('color: slate');
    expect(out.markdown).toContain('tools: Read, Write, Edit, WebFetch');
  });

  it('extracts description from IDENTITY.md first non-heading line', () => {
    const out = convertWorkspaceToMarkdown({
      agent: { slug: 'test-agent', name: 'Test Agent' },
      files: sampleFiles,
    });
    expect(out.description).toContain('friendly test agent');
  });

  it('parses tools from TOOLS.md bullets', () => {
    const out = convertWorkspaceToMarkdown({
      agent: { slug: 'test-agent', name: 'Test' },
      files: sampleFiles,
    });
    expect(out.tools).toEqual(['Read', 'Write', 'Edit', 'WebFetch']);
  });

  it('includes SOUL and AGENTS section content in body', () => {
    const out = convertWorkspaceToMarkdown({
      agent: { slug: 'test-agent', name: 'Test' },
      files: sampleFiles,
    });
    expect(out.markdown).toContain('## Identity');
    expect(out.markdown).toContain('## Core Mission');
    expect(out.markdown).toContain('## Communication Style');
  });

  it('uses override description when provided', () => {
    const out = convertWorkspaceToMarkdown({
      agent: { slug: 'test-agent', name: 'Test' },
      files: sampleFiles,
      description: 'Overridden description text',
    });
    expect(out.description).toBe('Overridden description text');
    expect(out.markdown).toContain('description: Overridden description text');
  });

  it('escapes colon-containing descriptions with double quotes', () => {
    const out = convertWorkspaceToMarkdown({
      agent: { slug: 'test-agent', name: 'Test' },
      files: sampleFiles,
      description: 'Helps with: code review + SQL + pairing',
    });
    expect(out.markdown).toContain('description: "Helps with: code review + SQL + pairing"');
  });

  it('falls back to default tools when TOOLS.md missing', () => {
    const files = { ...sampleFiles };
    delete (files as any)['TOOLS.md'];
    const out = convertWorkspaceToMarkdown({
      agent: { slug: 'test', name: 'Test' },
      files,
    });
    expect(out.tools).toEqual(['Read', 'Write', 'Edit']);
  });

  it('handles MEMORY / USER / HEARTBEAT sections with named headings', () => {
    const out = convertWorkspaceToMarkdown({
      agent: { slug: 'test', name: 'Test' },
      files: {
        ...sampleFiles,
        'MEMORY.md': 'Key facts remembered across sessions.',
        'USER.md': 'User prefers short responses.',
        'HEARTBEAT.md': 'Pulse every 30s.',
      },
    });
    expect(out.markdown).toContain('## Memory');
    expect(out.markdown).toContain('## User Context');
    expect(out.markdown).toContain('## Heartbeat');
    expect(out.markdown).toContain('Key facts remembered');
  });
});

describe('convertWorkspaceToMarkdown — edge cases', () => {
  it('handles case-insensitive filenames', () => {
    const out = convertWorkspaceToMarkdown({
      agent: { slug: 'test', name: 'Test' },
      files: {
        'soul.md': '## Identity\nlower-case file\n',
        'Tools.md': '- Read\n',
      },
    });
    expect(out.markdown).toContain('## Identity');
    expect(out.tools).toEqual(['Read']);
  });

  it('strips CRLF line endings', () => {
    const out = convertWorkspaceToMarkdown({
      agent: { slug: 'test', name: 'Test' },
      files: {
        'IDENTITY.md': '# Test\r\n\r\nDescription line\r\n',
      },
    });
    expect(out.description).toBe('Description line');
  });

  it('strips leading H1 from section files before concatenating', () => {
    const out = convertWorkspaceToMarkdown({
      agent: { slug: 'test', name: 'Test' },
      files: {
        'IDENTITY.md': 'desc',
        'SOUL.md': '# Redundant H1\n\n## Identity\nbody\n',
      },
    });
    // SOUL's leading H1 should be stripped (we already output `# {name}`)
    expect(out.markdown).not.toContain('# Redundant H1');
    expect(out.markdown).toContain('## Identity');
  });

  it('defaults emoji when agent has none', () => {
    const out = convertWorkspaceToMarkdown({
      agent: { slug: 'test', name: 'Test' },
      files: { 'IDENTITY.md': 'desc' },
    });
    expect(out.markdown).toContain('emoji: 🤖');
  });

  it('does not crash on empty files map', () => {
    const out = convertWorkspaceToMarkdown({
      agent: { slug: 'test', name: 'Test' },
      files: {},
    });
    expect(out.markdown).toContain('name: Test');
    expect(out.description).toBe('Test agent');
  });
});
