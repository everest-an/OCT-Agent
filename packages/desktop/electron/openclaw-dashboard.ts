export const DEFAULT_OPENCLAW_DASHBOARD_URL = 'http://127.0.0.1:18789/';

const DASHBOARD_PATTERNS = [
  /Dashboard URL:\s*(http[^\s]+)/i,
  /dashboard:\s*(http[^\s]+)/i,
  /url:\s*(http[^\s]+)/i,
  /(http:\/\/(?:127\.0\.0\.1|localhost):\d+[^\s]*)/i,
];

export function extractDashboardUrl(output: string | null | undefined): string | null {
  if (!output) return null;

  for (const pattern of DASHBOARD_PATTERNS) {
    const match = output.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/^http:\/\/localhost/i, 'http://127.0.0.1');
    }
  }

  return null;
}

export async function resolveDashboardUrl(readShellOutputAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>): Promise<string> {
  const output = await readShellOutputAsync('openclaw dashboard --no-open', 10000);
  return extractDashboardUrl(output) || DEFAULT_OPENCLAW_DASHBOARD_URL;
}