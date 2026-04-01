import { describe, expect, it } from 'vitest';
import { parseMemoryContextResponse } from '../lib/memory-context';

describe('memory context parser', () => {
  it('extracts cards and open task count from awareness_init response', () => {
    const parsed = parseMemoryContextResponse({
      result: {
        content: [{
          text: JSON.stringify({
            knowledge_cards: [
              { id: 'kc_1', category: 'decision', title: 'Use summary recall', summary: 'Desktop should not jump to full recall.' },
              { id: 'kc_2', category: 'workflow', title: 'Init first', summary: 'Use awareness_init before assembling context.' },
            ],
            open_tasks: [
              { id: 'task_1', title: 'Finish smoke test' },
              { id: 'task_2', title: 'Verify Memory page' },
            ],
          }),
        }],
      },
    });

    expect(parsed.cards).toHaveLength(2);
    expect(parsed.openTasks).toBe(2);
    expect(parsed.hasStructuredContext).toBe(true);
  });

  it('marks empty context as non-usable so UI can fall back to old endpoints', () => {
    const parsed = parseMemoryContextResponse({
      result: {
        content: [{ text: JSON.stringify({ knowledge_cards: [], open_tasks: [] }) }],
      },
    });

    expect(parsed.cards).toEqual([]);
    expect(parsed.openTasks).toBe(0);
    expect(parsed.hasStructuredContext).toBe(false);
  });
});