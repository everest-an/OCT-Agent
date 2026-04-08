/**
 * App (desktop) update check helpers.
 *
 * Extracted from register-app-runtime-handlers so they can be unit-tested
 * without pulling in Electron, IPC, or the shell. Keep this file pure and
 * side-effect free.
 */

import https from 'https';

export const AWARENESS_API_BASE = 'https://awareness.market/api/v1';
export const AWARENESS_DOWNLOAD_URL = 'https://awareness.market/';

export interface LatestVersionInfo {
  latestVersion: string;
  downloadUrl: string;
  releaseNotes?: string;
  mandatory?: boolean;
}

/**
 * Compare two semver strings. Returns 1 if a>b, -1 if a<b, 0 if equal.
 * Leading "v" is ignored; non-numeric or missing segments are treated as 0;
 * pre-release suffix (-beta.1) is stripped before comparison.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (s: string) =>
    (s || '').replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = av[i] || 0;
    const y = bv[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * Decide whether to surface a desktop update banner.
 * Returns null when no update is needed or when inputs are invalid.
 */
export function shouldShowDesktopUpdate(
  currentVersion: string | null | undefined,
  latest: LatestVersionInfo | null | undefined,
): LatestVersionInfo | null {
  if (!currentVersion || !latest || !latest.latestVersion) return null;
  return compareSemver(latest.latestVersion, currentVersion) > 0 ? latest : null;
}

type HttpsGetter = typeof https.get;

/**
 * Fetch latest desktop app version from the Awareness backend.
 * Best-effort: returns null on any failure so the caller can swallow silently.
 *
 * httpsGet is injectable for unit tests.
 */
export function fetchLatestDesktopVersion(
  timeoutMs = 5000,
  apiBase: string = AWARENESS_API_BASE,
  httpsGet: HttpsGetter = https.get as HttpsGetter,
): Promise<LatestVersionInfo | null> {
  return new Promise((resolve) => {
    try {
      const url = `${apiBase}/app/latest-version?app=awarenessclaw`;
      const req = (httpsGet as any)(url, { timeout: timeoutMs }, (res: any) => {
        if (res.statusCode !== 200) {
          try { res.resume(); } catch {}
          resolve(null);
          return;
        }
        let body = '';
        try { res.setEncoding('utf8'); } catch {}
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed && typeof parsed.latestVersion === 'string') {
              resolve({
                latestVersion: parsed.latestVersion,
                downloadUrl: typeof parsed.downloadUrl === 'string' ? parsed.downloadUrl : AWARENESS_DOWNLOAD_URL,
                releaseNotes: typeof parsed.releaseNotes === 'string' && parsed.releaseNotes ? parsed.releaseNotes : undefined,
                mandatory: parsed.mandatory === true,
              });
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      });
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
      req.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}
