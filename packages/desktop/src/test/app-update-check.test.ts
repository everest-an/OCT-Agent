import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  compareSemver,
  shouldShowDesktopUpdate,
  fetchLatestDesktopVersion,
} from '../../electron/app-update-check';

describe('compareSemver', () => {
  it('returns 1 when a is newer', () => {
    expect(compareSemver('0.2.0', '0.1.0')).toBe(1);
    expect(compareSemver('1.0.0', '0.9.9')).toBe(1);
    expect(compareSemver('0.1.10', '0.1.2')).toBe(1);
  });

  it('returns -1 when a is older', () => {
    expect(compareSemver('0.1.0', '0.2.0')).toBe(-1);
    expect(compareSemver('0.0.5', '0.1.0')).toBe(-1);
  });

  it('returns 0 when equal', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('ignores leading v', () => {
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('v1.2.4', 'v1.2.3')).toBe(1);
  });

  it('strips pre-release suffix', () => {
    expect(compareSemver('1.0.0-beta.1', '1.0.0-alpha.5')).toBe(0);
  });

  it('treats missing segments as 0', () => {
    expect(compareSemver('1', '1.0.0')).toBe(0);
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
  });
});

describe('shouldShowDesktopUpdate', () => {
  it('returns null when no latest info', () => {
    expect(shouldShowDesktopUpdate('0.1.0', null)).toBeNull();
  });

  it('returns null when current version missing', () => {
    expect(shouldShowDesktopUpdate(null, { latestVersion: '0.2.0', downloadUrl: 'x' })).toBeNull();
  });

  it('returns null when equal', () => {
    expect(
      shouldShowDesktopUpdate('0.1.0', { latestVersion: '0.1.0', downloadUrl: 'x' }),
    ).toBeNull();
  });

  it('returns null when current is newer (dev build)', () => {
    expect(
      shouldShowDesktopUpdate('0.3.0', { latestVersion: '0.2.0', downloadUrl: 'x' }),
    ).toBeNull();
  });

  it('returns latest info when a newer version exists', () => {
    const latest = { latestVersion: '0.2.0', downloadUrl: 'https://awareness.market/' };
    expect(shouldShowDesktopUpdate('0.1.0', latest)).toEqual(latest);
  });
});

/**
 * Build a fake https.get() that returns a mock IncomingMessage emitting given
 * statusCode + body, so we can exercise fetchLatestDesktopVersion without real I/O.
 */
function makeFakeHttpsGet(statusCode: number, body: string) {
  return vi.fn((_url: any, _opts: any, cb: any) => {
    const res: any = new EventEmitter();
    res.statusCode = statusCode;
    res.setEncoding = () => {};
    res.resume = () => {};
    const req: any = new EventEmitter();
    req.destroy = () => {};
    // Deliver asynchronously so caller attaches listeners first
    setImmediate(() => {
      cb(res);
      setImmediate(() => {
        res.emit('data', body);
        res.emit('end');
      });
    });
    return req;
  });
}

describe('fetchLatestDesktopVersion', () => {
  it('parses a valid 200 response', async () => {
    const fake = makeFakeHttpsGet(
      200,
      JSON.stringify({
        app: 'awarenessclaw',
        latestVersion: '0.5.0',
        downloadUrl: 'https://awareness.market/download',
        releaseNotes: 'Fixes',
        mandatory: false,
      }),
    );
    const result = await fetchLatestDesktopVersion(1000, 'https://awareness.market/api/v1', fake as any);
    expect(result).toEqual({
      latestVersion: '0.5.0',
      downloadUrl: 'https://awareness.market/download',
      releaseNotes: 'Fixes',
      mandatory: false,
    });
  });

  it('returns null on non-200 status', async () => {
    const fake = makeFakeHttpsGet(500, 'server error');
    const result = await fetchLatestDesktopVersion(1000, 'https://awareness.market/api/v1', fake as any);
    expect(result).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    const fake = makeFakeHttpsGet(200, 'not-json{{');
    const result = await fetchLatestDesktopVersion(1000, 'https://awareness.market/api/v1', fake as any);
    expect(result).toBeNull();
  });

  it('returns null when latestVersion missing', async () => {
    const fake = makeFakeHttpsGet(200, JSON.stringify({ app: 'awarenessclaw' }));
    const result = await fetchLatestDesktopVersion(1000, 'https://awareness.market/api/v1', fake as any);
    expect(result).toBeNull();
  });

  it('defaults downloadUrl when server omits it', async () => {
    const fake = makeFakeHttpsGet(200, JSON.stringify({ latestVersion: '0.2.0' }));
    const result = await fetchLatestDesktopVersion(1000, 'https://awareness.market/api/v1', fake as any);
    expect(result?.latestVersion).toBe('0.2.0');
    expect(result?.downloadUrl).toBe('https://awareness.market/');
  });
});
