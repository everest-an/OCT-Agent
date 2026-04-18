/**
 * L3 Chaos: memory-client.applyProjectDirHeader must never throw TypeError
 * for CJK / emoji / fullwidth / null / control-char paths.
 *
 * Regression: Windows users with Chinese usernames and macOS users with
 * localized workspace folders were hitting "Invalid character in header
 * content ['X-Awareness-Project-Dir']" on every awareness_record call,
 * because Node http enforces ISO-8859-1 on raw header values and throws
 * synchronously from http.request(...).
 *
 * Fix: applyProjectDirHeader either sends plain header (ASCII-safe) or
 * base64 variant (any UTF-8). If even base64 encoding fails, it skips the
 * header silently rather than crashing the caller.
 */
import { describe, it, expect } from 'vitest';
import { applyProjectDirHeader } from '../../electron/memory-client';

describe('memory-client applyProjectDirHeader', () => {
  it('ASCII path → plain X-Awareness-Project-Dir header', () => {
    const headers: Record<string, string> = {};
    applyProjectDirHeader(headers, '/Users/edwinhao/Awareness');
    expect(headers['X-Awareness-Project-Dir']).toBe('/Users/edwinhao/Awareness');
    expect(headers['X-Awareness-Project-Dir-B64']).toBeUndefined();
  });

  it('Windows-style ASCII path → plain header', () => {
    const headers: Record<string, string> = {};
    applyProjectDirHeader(headers, 'C:\\Users\\Alice\\Documents\\Workspace');
    expect(headers['X-Awareness-Project-Dir']).toBe('C:\\Users\\Alice\\Documents\\Workspace');
  });

  it('CJK path → B64 header, plain header absent', () => {
    const headers: Record<string, string> = {};
    const cjk = '/Users/edwinhao/Documents/Awareness 文件夹';
    applyProjectDirHeader(headers, cjk);
    expect(headers['X-Awareness-Project-Dir']).toBeUndefined();
    expect(headers['X-Awareness-Project-Dir-B64']).toBe(Buffer.from(cjk, 'utf8').toString('base64'));
  });

  it('Windows CJK username path → B64 header', () => {
    const headers: Record<string, string> = {};
    const dir = 'C:\\Users\\张三\\Documents\\AwarenessClaw';
    applyProjectDirHeader(headers, dir);
    expect(headers['X-Awareness-Project-Dir-B64']).toBe(Buffer.from(dir, 'utf8').toString('base64'));
  });

  it('Emoji path → B64 header', () => {
    const headers: Record<string, string> = {};
    const dir = '/Users/edwinhao/Desktop/Project 🚀';
    applyProjectDirHeader(headers, dir);
    expect(headers['X-Awareness-Project-Dir-B64']).toBe(Buffer.from(dir, 'utf8').toString('base64'));
  });

  it('Fullwidth space / Japanese / Korean → B64 header', () => {
    const headers: Record<string, string> = {};
    const dir = '/Users/tanaka/作業場 워크스페이스';
    applyProjectDirHeader(headers, dir);
    expect(headers['X-Awareness-Project-Dir-B64']).toBe(Buffer.from(dir, 'utf8').toString('base64'));
  });

  it('null dir → no header added', () => {
    const headers: Record<string, string> = {};
    applyProjectDirHeader(headers, null);
    expect(headers['X-Awareness-Project-Dir']).toBeUndefined();
    expect(headers['X-Awareness-Project-Dir-B64']).toBeUndefined();
  });

  it('empty string → no header added', () => {
    const headers: Record<string, string> = {};
    applyProjectDirHeader(headers, '');
    expect(headers['X-Awareness-Project-Dir']).toBeUndefined();
    expect(headers['X-Awareness-Project-Dir-B64']).toBeUndefined();
  });

  it('CJK decodes back to original on server side (round-trip)', () => {
    const headers: Record<string, string> = {};
    const dir = '/Users/edwinhao/Documents/Awareness 文件夹';
    applyProjectDirHeader(headers, dir);
    const decoded = Buffer.from(headers['X-Awareness-Project-Dir-B64'], 'base64').toString('utf8');
    expect(decoded).toBe(dir);
  });

  it('never throws for any reasonable path input', () => {
    const ugly = [
      '/path/with/\u0000null',
      '/path/with/\tnewlines\nand\rcrs',
      '',
      '/' + 'x'.repeat(10_000), // very long
      '日本語',
      'العربية',
      '\uD83D\uDE80', // bare surrogate-pair emoji
    ];
    for (const dir of ugly) {
      expect(() => applyProjectDirHeader({}, dir)).not.toThrow();
    }
  });
});
