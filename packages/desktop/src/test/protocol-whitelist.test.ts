/**
 * L2 — Protocol whitelist guard for CloudAuthStep's XSS protection
 *
 * Verifies that the regex `/^https?:\/\//i` in CloudAuthStep.tsx
 * correctly blocks dangerous protocols and allows legitimate URLs.
 */
import { describe, it, expect } from 'vitest';

// Extract the exact guard logic from CloudAuthStep.tsx (same regex)
function safeUri(uri: string | null | undefined): string {
  return /^https?:\/\//i.test(String(uri || '')) ? String(uri) : 'about:blank';
}

describe('protocol-whitelist (CloudAuthStep XSS guard)', () => {
  it('allows https:// URLs', () => {
    expect(safeUri('https://awareness.market/activate')).toBe('https://awareness.market/activate');
  });

  it('allows http:// URLs (device-auth provider may use HTTP)', () => {
    expect(safeUri('http://localhost:8080/activate')).toBe('http://localhost:8080/activate');
  });

  it('allows HTTPS with mixed case', () => {
    expect(safeUri('HTTPS://example.com/auth')).toBe('HTTPS://example.com/auth');
  });

  it('blocks javascript: protocol', () => {
    expect(safeUri('javascript:alert(1)')).toBe('about:blank');
  });

  it('blocks data: protocol', () => {
    expect(safeUri('data:text/html,<script>alert(1)</script>')).toBe('about:blank');
  });

  it('blocks vbscript: protocol', () => {
    expect(safeUri('vbscript:msgbox(1)')).toBe('about:blank');
  });

  it('blocks bare string without protocol', () => {
    expect(safeUri('evil-site.com')).toBe('about:blank');
  });

  it('blocks empty string', () => {
    expect(safeUri('')).toBe('about:blank');
  });

  it('blocks null', () => {
    expect(safeUri(null)).toBe('about:blank');
  });

  it('blocks undefined', () => {
    expect(safeUri(undefined)).toBe('about:blank');
  });

  it('blocks ftp:// (untrusted protocol for auth callback)', () => {
    expect(safeUri('ftp://badactor.com/auth')).toBe('about:blank');
  });

  it('does not strip query params from allowed https URLs', () => {
    const url = 'https://github.com/login/device?code=ABCD-1234';
    expect(safeUri(url)).toBe(url);
  });
});
