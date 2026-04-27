/**
 * L2 · Pending extraction relay
 *
 * Verifies the round-trip:
 *   1. Daemon returns `_extraction_instruction` on awareness_record(remember).
 *   2. Desktop stashes it to ~/.awareness-claw/pending-extraction.json.
 *   3. Next turn's bootstrap section consumes the file and asks the host LLM
 *      to call awareness_record(submit_insights, …).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  writePendingExtraction,
  consumePendingExtraction,
  buildPendingExtractionSection,
} from '../../electron/ipc/awareness-memory-utils';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pending-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('pending extraction relay', () => {
  it('writes payload to ~/.awareness-claw/pending-extraction.json', () => {
    writePendingExtraction(tmpHome, {
      instruction: 'Extract cards now',
      recorded_at: Date.now(),
      memory_id: 'm-1',
      session_id: 's-1',
    });
    const file = path.join(tmpHome, '.awareness-claw', 'pending-extraction.json');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.instruction).toContain('Extract cards now');
    expect(parsed.memory_id).toBe('m-1');
  });

  it('consume returns the payload and deletes the file (one-shot)', () => {
    writePendingExtraction(tmpHome, {
      instruction: 'A',
      recorded_at: Date.now(),
    });
    const got = consumePendingExtraction(tmpHome);
    expect(got?.instruction).toBe('A');
    expect(consumePendingExtraction(tmpHome)).toBeNull();
  });

  it('drops payloads older than 30 minutes', () => {
    writePendingExtraction(tmpHome, {
      instruction: 'stale',
      recorded_at: Date.now() - 31 * 60 * 1000,
    });
    expect(consumePendingExtraction(tmpHome)).toBeNull();
  });

  it('returns null when no pending file exists', () => {
    expect(consumePendingExtraction(tmpHome)).toBeNull();
  });

  it('section includes the submit_insights call hint', () => {
    const section = buildPendingExtractionSection({
      instruction: 'system_prompt: extract cards',
      recorded_at: Date.now(),
    });
    expect(section).toContain('Pending insight extraction');
    expect(section).toContain('awareness_record(action="submit_insights"');
    expect(section).toContain('system_prompt: extract cards');
  });

  it('handles malformed JSON file gracefully', () => {
    const file = path.join(tmpHome, '.awareness-claw', 'pending-extraction.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not-json');
    expect(consumePendingExtraction(tmpHome)).toBeNull();
  });
});
