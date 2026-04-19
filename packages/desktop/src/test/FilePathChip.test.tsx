import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FilePathChip, looksLikeAbsolutePath } from '../components/dashboard/FilePathChip';

describe('looksLikeAbsolutePath', () => {
  it('recognizes Unix / macOS absolute paths (with and without spaces)', () => {
    expect(looksLikeAbsolutePath('/Users/edwinhao/Documents/New project/snake-game.html')).toBe(true);
    expect(looksLikeAbsolutePath('/tmp/x.log')).toBe(true);
    expect(looksLikeAbsolutePath('/opt/homebrew/bin/node')).toBe(true);
  });

  it('recognizes tilde-prefixed home paths', () => {
    expect(looksLikeAbsolutePath('~/Documents/foo.md')).toBe(true);
    expect(looksLikeAbsolutePath('~\\Documents\\foo.md')).toBe(true);
  });

  it('recognizes Windows drive-letter paths with both slash styles', () => {
    expect(looksLikeAbsolutePath('C:\\Users\\foo\\bar.txt')).toBe(true);
    expect(looksLikeAbsolutePath('D:/projects/app/index.ts')).toBe(true);
    expect(looksLikeAbsolutePath('c:\\Program Files\\app.exe')).toBe(true);
  });

  it('recognizes Windows UNC paths', () => {
    expect(looksLikeAbsolutePath('\\\\fileserver\\share\\doc.xlsx')).toBe(true);
  });

  it('rejects non-path strings that commonly appear in inline code', () => {
    expect(looksLikeAbsolutePath('useState')).toBe(false);
    expect(looksLikeAbsolutePath('memory_id')).toBe(false);
    expect(looksLikeAbsolutePath('mem_20260417_002209_1c9f')).toBe(false);
    expect(looksLikeAbsolutePath('foo/bar')).toBe(false);
    expect(looksLikeAbsolutePath('./relative/path')).toBe(false);
    expect(looksLikeAbsolutePath('../parent')).toBe(false);
    expect(looksLikeAbsolutePath('')).toBe(false);
    expect(looksLikeAbsolutePath('   ')).toBe(false);
  });

  it('rejects URLs that might slip into inline code', () => {
    expect(looksLikeAbsolutePath('http://localhost:37800')).toBe(false);
    expect(looksLikeAbsolutePath('https://awareness.market/')).toBe(false);
    expect(looksLikeAbsolutePath('file:///etc/hosts')).toBe(false);
  });
});

describe('<FilePathChip />', () => {
  const samplePath = '/Users/edwinhao/Documents/New project/snake-game.html';
  let showItemInFolder: ReturnType<typeof vi.fn>;
  let openPath: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    showItemInFolder = vi.fn().mockResolvedValue({ ok: true });
    openPath = vi.fn().mockResolvedValue({ ok: true });
    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      showItemInFolder,
      openPath,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a button with the full path in the title tooltip', () => {
    render(<FilePathChip path={samplePath} />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('title') || '').toContain(samplePath);
  });

  it('shows a shortened filename for long paths', () => {
    render(<FilePathChip path={samplePath} />);
    const text = screen.getByRole('button').textContent || '';
    // Filename must be visible; the long prefix may be truncated with an ellipsis.
    expect(text).toContain('snake-game.html');
  });

  it('plain click triggers showItemInFolder (reveal), not openPath', async () => {
    render(<FilePathChip path={samplePath} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(showItemInFolder).toHaveBeenCalledWith(samplePath));
    expect(openPath).not.toHaveBeenCalled();
  });

  it('meta-click (macOS) triggers openPath with the full path', async () => {
    render(<FilePathChip path={samplePath} />);
    fireEvent.click(screen.getByRole('button'), { metaKey: true });
    await waitFor(() => expect(openPath).toHaveBeenCalledWith(samplePath));
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it('ctrl-click (Windows) triggers openPath with the full path', async () => {
    render(<FilePathChip path={'C:\\Users\\foo\\bar.txt'} />);
    fireEvent.click(screen.getByRole('button'), { ctrlKey: true });
    await waitFor(() => expect(openPath).toHaveBeenCalledWith('C:\\Users\\foo\\bar.txt'));
  });

  it('surfaces "not found" state when main process returns file-not-found', async () => {
    showItemInFolder.mockResolvedValueOnce({ ok: false, error: 'file not found' });
    render(<FilePathChip path={samplePath} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('button').textContent || '').toContain('not found'));
  });

  it('surfaces a generic failure state on unexpected IPC errors', async () => {
    showItemInFolder.mockRejectedValueOnce(new Error('boom'));
    render(<FilePathChip path={samplePath} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('button').textContent || '').toContain('failed'));
  });
});
