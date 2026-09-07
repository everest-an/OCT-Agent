import { describe, expect, it } from 'vitest';
import {
  readAgentList,
  upsertAgentEntry,
  removeAgentEntry,
  mutateAgentsInPlace,
  migrateLegacyAgentDefaultModels,
  isNodeVersionCompatibleWithOpenclaw,
  agentsUseEntriesShape,
} from '../../electron/openclaw-config';

describe('agents list ↔ entries compatibility (OpenClaw 2026.9+)', () => {
  describe('readAgentList', () => {
    it('reads legacy agents.list array', () => {
      const list = readAgentList({ agents: { list: [{ id: 'main' }, { id: 'research' }] } });
      expect(list).toEqual([{ id: 'main' }, { id: 'research' }]);
    });

    it('reads agents.entries keyed object and surfaces id', () => {
      const list = readAgentList({
        agents: { entries: { main: { name: 'Main' }, research: { name: 'Research' } } },
      });
      expect(list).toEqual([
        { id: 'main', name: 'Main' },
        { id: 'research', name: 'Research' },
      ]);
    });

    it('returns [] when no agents exist', () => {
      expect(readAgentList({})).toEqual([]);
      expect(readAgentList({ agents: {} })).toEqual([]);
    });
  });

  describe('agentsUseEntriesShape', () => {
    it('detects 2026.9+ entries shape', () => {
      expect(agentsUseEntriesShape({ agents: { entries: {} } })).toBe(true);
      expect(agentsUseEntriesShape({ agents: { list: [] } })).toBe(false);
      expect(agentsUseEntriesShape({})).toBe(false);
    });
  });

  describe('upsertAgentEntry', () => {
    it('writes to entries when config already uses entries shape', () => {
      const config: Record<string, any> = { agents: { entries: { main: { name: 'Main' } } } };
      upsertAgentEntry(config, { id: 'research', name: 'Research' });
      expect(config.agents.entries.research).toEqual({ name: 'Research' });
      // id must not leak as a field in entries shape (key is the id)
      expect(config.agents.entries.research.id).toBeUndefined();
      // existing entries preserved
      expect(config.agents.entries.main).toEqual({ name: 'Main' });
    });

    it('appends to legacy list when config uses list shape', () => {
      const config: Record<string, any> = { agents: { list: [{ id: 'main' }] } };
      upsertAgentEntry(config, { id: 'research', name: 'Research' });
      expect(config.agents.list).toEqual([
        { id: 'main' },
        { id: 'research', name: 'Research' },
      ]);
    });

    it('merges into existing entry rather than duplicating', () => {
      const config: Record<string, any> = { agents: { list: [{ id: 'main', name: 'Old' }] } };
      upsertAgentEntry(config, { id: 'main', name: 'New' });
      expect(config.agents.list).toEqual([{ id: 'main', name: 'New' }]);
    });
  });

  describe('removeAgentEntry', () => {
    it('removes from entries shape', () => {
      const config: Record<string, any> = { agents: { entries: { main: {}, research: {} } } };
      expect(removeAgentEntry(config, 'research')).toBe(true);
      expect(config.agents.entries.research).toBeUndefined();
      expect(config.agents.entries.main).toBeDefined();
    });

    it('removes from list shape', () => {
      const config: Record<string, any> = { agents: { list: [{ id: 'main' }, { id: 'research' }] } };
      expect(removeAgentEntry(config, 'research')).toBe(true);
      expect(config.agents.list).toEqual([{ id: 'main' }]);
    });

    it('returns false when agent is absent', () => {
      expect(removeAgentEntry({ agents: { list: [{ id: 'main' }] } }, 'nope')).toBe(false);
    });
  });

  describe('mutateAgentsInPlace', () => {
    it('applies mutations to entries shape live references', () => {
      const config: Record<string, any> = { agents: { entries: { main: { workspace: '/tmp/workspace-main' } } } };
      mutateAgentsInPlace(config, (agent) => delete agent.workspace);
      expect(config.agents.entries.main.workspace).toBeUndefined();
    });

    it('applies mutations to list shape live references', () => {
      const config: Record<string, any> = { agents: { list: [{ id: 'main', workspace: '/tmp/w' }] } };
      mutateAgentsInPlace(config, (agent) => delete agent.workspace);
      expect(config.agents.list[0].workspace).toBeUndefined();
    });

    it('handles both shapes being present', () => {
      const config: Record<string, any> = {
        agents: { entries: { main: { workspace: '/a' } }, list: [{ id: 'x', workspace: '/b' }] },
      };
      mutateAgentsInPlace(config, (agent) => delete agent.workspace);
      expect(config.agents.entries.main.workspace).toBeUndefined();
      expect(config.agents.list[0].workspace).toBeUndefined();
    });
  });

  describe('migrateLegacyAgentDefaultModels', () => {
    it('moves agents.defaults.models to modelPolicy.allow', () => {
      const config: Record<string, any> = {
        agents: { defaults: { models: { 'qwen/qwen3': {}, 't3/gpt-5': {} } } },
      };
      expect(migrateLegacyAgentDefaultModels(config)).toBe(true);
      expect(config.agents.defaults.models).toBeUndefined();
      expect(config.agents.defaults.modelPolicy.allow).toEqual(['qwen/qwen3', 't3/gpt-5']);
    });

    it('no-ops when already migrated (modelPolicy.allow present)', () => {
      const config: Record<string, any> = {
        agents: { defaults: { models: { 'a/b': {} }, modelPolicy: { allow: ['a/b'] } } },
      };
      expect(migrateLegacyAgentDefaultModels(config)).toBe(false);
      expect(config.agents.defaults.models).toBeDefined(); // untouched
    });

    it('no-ops when no legacy models map', () => {
      const config: Record<string, any> = { agents: { defaults: {} } };
      expect(migrateLegacyAgentDefaultModels(config)).toBe(false);
    });
  });
});

describe('isNodeVersionCompatibleWithOpenclaw (OpenClaw 2026.9+ gate)', () => {
  it('accepts Node 24.15.0+ for OpenClaw 2026.9', () => {
    expect(isNodeVersionCompatibleWithOpenclaw('v24.20.0', '2026.9.2')).toBe(true);
    expect(isNodeVersionCompatibleWithOpenclaw('v24.15.0', '2026.9.2')).toBe(true);
  });

  it('rejects older Node for OpenClaw 2026.9', () => {
    expect(isNodeVersionCompatibleWithOpenclaw('v22.14.0', '2026.9.2')).toBe(false);
    expect(isNodeVersionCompatibleWithOpenclaw('v20.11.1', '2026.9.2')).toBe(false);
    expect(isNodeVersionCompatibleWithOpenclaw('v22.22.2', '2026.9.2')).toBe(false);
  });

  it('accepts Node 22.22.3+ within the 22.x range', () => {
    expect(isNodeVersionCompatibleWithOpenclaw('v22.22.3', '2026.9.2')).toBe(true);
  });

  it('does not block older OpenClaw (<=2026.4.x) on Node 18/20/22', () => {
    expect(isNodeVersionCompatibleWithOpenclaw('v22.14.0', '2026.4.23')).toBe(true);
    expect(isNodeVersionCompatibleWithOpenclaw('v20.11.1', '2026.4.23')).toBe(true);
  });

  it('returns true (non-blocking) for unknown versions', () => {
    expect(isNodeVersionCompatibleWithOpenclaw(null, null)).toBe(true);
    expect(isNodeVersionCompatibleWithOpenclaw(undefined, undefined)).toBe(true);
  });
});
