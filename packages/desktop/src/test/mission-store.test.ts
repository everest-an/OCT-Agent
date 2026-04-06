import { describe, it, expect, beforeEach } from 'vitest';
import {
  createMission,
  updateMission,
  updateMissionStep,
  removeMission,
  loadMissions,
  saveMissions,
  getNextStepIndex,
  isMissionComplete,
  hasMissionFailed,
  missionProgress,
  formatElapsed,
  guessAgentRole,
  sortAgentsForWorkflow,
  MISSION_TEMPLATES,
} from '../lib/mission-store';
import type { Mission, AgentInfo } from '../lib/mission-store';

const TEST_AGENTS: AgentInfo[] = [
  { id: 'main', name: 'Main', emoji: '🤖' },
  { id: 'coder', name: 'Coder', emoji: '💻' },
  { id: 'tester', name: 'Tester', emoji: '🧪' },
  { id: 'reviewer', name: 'Reviewer', emoji: '🔍' },
];

beforeEach(() => {
  localStorage.clear();
});

describe('mission-store', () => {
  // ----------- createMission -----------

  describe('createMission', () => {
    it('creates a mission with all agents as steps', () => {
      const m = createMission('Build login page', TEST_AGENTS);
      expect(m.goal).toBe('Build login page');
      expect(m.status).toBe('planning');
      expect(m.steps).toHaveLength(4);
      expect(m.currentStepIndex).toBe(-1);
      expect(m.id).toMatch(/^mission-/);
    });

    it('assigns roles based on agent names', () => {
      const m = createMission('test', TEST_AGENTS);
      const roles = m.steps.map(s => s.role);
      expect(roles).toContain('Developer'); // 'Coder' → Developer
      expect(roles).toContain('Tester');
      expect(roles).toContain('Reviewer');
    });

    it('sorts agents in workflow order', () => {
      // Reverse order input — should still sort correctly
      const reversed = [...TEST_AGENTS].reverse();
      const m = createMission('test', reversed);
      const roleOrder = m.steps.map(s => s.role);
      // Developer should come before Tester, Tester before Reviewer
      const devIdx = roleOrder.indexOf('Developer');
      const testIdx = roleOrder.indexOf('Tester');
      const revIdx = roleOrder.indexOf('Reviewer');
      expect(devIdx).toBeLessThan(testIdx);
      expect(testIdx).toBeLessThan(revIdx);
    });

    it('handles single agent', () => {
      const m = createMission('quick task', [{ id: 'main', name: 'Main' }]);
      expect(m.steps).toHaveLength(1);
      expect(m.steps[0].agentId).toBe('main');
    });
  });

  // ----------- guessAgentRole -----------

  describe('guessAgentRole', () => {
    it('detects planner role', () => {
      expect(guessAgentRole({ id: 'planner', name: 'Planner Agent' }).role).toBe('Planner');
    });

    it('detects developer role from "code" keyword', () => {
      expect(guessAgentRole({ id: 'coder' }).role).toBe('Developer');
    });

    it('detects developer role from "engineer" keyword', () => {
      expect(guessAgentRole({ id: 'engineer', name: 'Software Engineer' }).role).toBe('Developer');
    });

    it('detects tester role', () => {
      expect(guessAgentRole({ id: 'qa', name: 'QA Tester' }).role).toBe('Tester');
    });

    it('detects reviewer role', () => {
      expect(guessAgentRole({ id: 'reviewer' }).role).toBe('Reviewer');
    });

    it('defaults to Assistant for unknown roles', () => {
      expect(guessAgentRole({ id: 'main', name: 'Main' }).role).toBe('Assistant');
    });

    it('detects researcher role', () => {
      expect(guessAgentRole({ id: 'research', name: 'Research Analyst' }).role).toBe('Researcher');
    });

    it('detects writer role', () => {
      expect(guessAgentRole({ id: 'writer', name: 'Doc Writer' }).role).toBe('Writer');
    });
  });

  // ----------- sortAgentsForWorkflow -----------

  describe('sortAgentsForWorkflow', () => {
    it('puts planner first, reviewer last', () => {
      const agents: AgentInfo[] = [
        { id: 'reviewer', name: 'Reviewer' },
        { id: 'coder', name: 'Coder' },
        { id: 'planner', name: 'Planner' },
      ];
      const sorted = sortAgentsForWorkflow(agents);
      expect(sorted[0].id).toBe('planner');
      expect(sorted[sorted.length - 1].id).toBe('reviewer');
    });
  });

  // ----------- updateMission -----------

  describe('updateMission', () => {
    it('updates mission status immutably', () => {
      const m = createMission('test', TEST_AGENTS);
      const missions = [m];
      const updated = updateMission(missions, m.id, { status: 'running' });
      expect(updated[0].status).toBe('running');
      expect(missions[0].status).toBe('planning'); // original unchanged
    });

    it('ignores non-matching ids', () => {
      const m = createMission('test', TEST_AGENTS);
      const updated = updateMission([m], 'non-existent', { status: 'done' });
      expect(updated[0].status).toBe('planning');
    });
  });

  // ----------- updateMissionStep -----------

  describe('updateMissionStep', () => {
    it('updates a specific step immutably', () => {
      const m = createMission('test', TEST_AGENTS);
      const missions = [m];
      const updated = updateMissionStep(missions, m.id, 1, {
        status: 'running',
        sessionKey: 'agent:main:subagent:abc',
      });
      expect(updated[0].steps[1].status).toBe('running');
      expect(updated[0].steps[1].sessionKey).toBe('agent:main:subagent:abc');
      expect(updated[0].steps[0].status).toBe('waiting'); // other steps unchanged
      expect(missions[0].steps[1].status).toBe('waiting'); // original unchanged
    });
  });

  // ----------- removeMission -----------

  describe('removeMission', () => {
    it('removes mission by id', () => {
      const m1 = createMission('task1', TEST_AGENTS);
      const m2 = createMission('task2', TEST_AGENTS);
      const result = removeMission([m1, m2], m1.id);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(m2.id);
    });
  });

  // ----------- Progress helpers -----------

  describe('progress helpers', () => {
    it('getNextStepIndex returns first waiting step', () => {
      const m = createMission('test', TEST_AGENTS);
      expect(getNextStepIndex(m)).toBe(0);

      const updated = updateMissionStep([m], m.id, 0, { status: 'done' });
      expect(getNextStepIndex(updated[0])).toBe(1);
    });

    it('getNextStepIndex returns -1 when all done', () => {
      let missions: readonly Mission[] = [createMission('test', [{ id: 'a' }, { id: 'b' }])];
      missions = updateMissionStep(missions, missions[0].id, 0, { status: 'done' });
      missions = updateMissionStep(missions, missions[0].id, 1, { status: 'done' });
      expect(getNextStepIndex(missions[0])).toBe(-1);
    });

    it('isMissionComplete returns true when all done', () => {
      let missions: readonly Mission[] = [createMission('test', [{ id: 'a' }])];
      expect(isMissionComplete(missions[0])).toBe(false);
      missions = updateMissionStep(missions, missions[0].id, 0, { status: 'done' });
      expect(isMissionComplete(missions[0])).toBe(true);
    });

    it('hasMissionFailed returns true when any step failed', () => {
      let missions: readonly Mission[] = [createMission('test', [{ id: 'a' }, { id: 'b' }])];
      expect(hasMissionFailed(missions[0])).toBe(false);
      missions = updateMissionStep(missions, missions[0].id, 0, { status: 'failed' });
      expect(hasMissionFailed(missions[0])).toBe(true);
    });

    it('missionProgress calculates percentage correctly', () => {
      let missions: readonly Mission[] = [createMission('test', TEST_AGENTS)];
      expect(missionProgress(missions[0])).toBe(0);

      missions = updateMissionStep(missions, missions[0].id, 0, { status: 'done' });
      expect(missionProgress(missions[0])).toBe(25);

      missions = updateMissionStep(missions, missions[0].id, 1, { status: 'done' });
      expect(missionProgress(missions[0])).toBe(50);
    });

    it('missionProgress handles empty steps', () => {
      const m: Mission = {
        id: 'test',
        goal: 'test',
        status: 'planning',
        steps: [],
        createdAt: new Date().toISOString(),
        currentStepIndex: -1,
      };
      expect(missionProgress(m)).toBe(0);
    });
  });

  // ----------- formatElapsed -----------

  describe('formatElapsed', () => {
    it('returns empty string without startedAt', () => {
      expect(formatElapsed()).toBe('');
    });

    it('formats seconds', () => {
      const start = new Date(Date.now() - 30000).toISOString();
      const end = new Date().toISOString();
      expect(formatElapsed(start, end)).toMatch(/30s/);
    });

    it('formats minutes and seconds', () => {
      const start = new Date(Date.now() - 125000).toISOString();
      const end = new Date().toISOString();
      expect(formatElapsed(start, end)).toMatch(/2m 5s/);
    });
  });

  // ----------- localStorage persistence -----------

  describe('persistence', () => {
    it('saves and loads missions from localStorage', () => {
      const m = createMission('test', TEST_AGENTS);
      saveMissions([m]);
      const loaded = loadMissions();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].goal).toBe('test');
      expect(loaded[0].steps).toHaveLength(4);
    });

    it('returns empty array on corrupt localStorage', () => {
      localStorage.setItem('awareness-claw-missions', 'not-json');
      expect(loadMissions()).toEqual([]);
    });

    it('returns empty array when no data', () => {
      expect(loadMissions()).toEqual([]);
    });
  });

  // ----------- templates -----------

  describe('templates', () => {
    it('has 4 built-in templates', () => {
      expect(MISSION_TEMPLATES).toHaveLength(4);
    });

    it('includes feature, bugfix, review, and custom templates', () => {
      const ids = MISSION_TEMPLATES.map(t => t.id);
      expect(ids).toContain('feature');
      expect(ids).toContain('bugfix');
      expect(ids).toContain('review');
      expect(ids).toContain('custom');
    });
  });
});
