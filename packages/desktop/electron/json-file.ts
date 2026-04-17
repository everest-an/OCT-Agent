import fs from 'fs';
import path from 'path';

export function stripUtf8Bom(input: string): string {
  return input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input;
}

export function parseJsonWithBom<T = any>(input: string): T {
  return JSON.parse(stripUtf8Bom(input)) as T;
}

export function readJsonFileWithBom<T = any>(filePath: string): T {
  return parseJsonWithBom<T>(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Minimum size ratio for write protection.  If the new JSON content is smaller
 * than this ratio compared to the existing file, the write is rejected unless
 * explicitly opted-out via `skipSizeCheck`.  This catches accidental config
 * truncation (e.g. OpenClaw stripping desktop-specific fields on gateway startup,
 * or ConvertTo-Json depth truncation on Windows).
 */
const DEFAULT_MIN_SIZE_RATIO = 0.4;

/**
 * Safely write JSON to a file with backup and size-drop protection.
 *
 * 1. Creates a `.desktop-bak` backup of the existing file before writing.
 * 2. Rejects writes that shrink the file below `minSizeRatio` (default 40%),
 *    logging a warning instead of silently truncating.
 * 3. Writes to a `.tmp` file first, then renames (atomic on most file systems).
 *
 * Cross-platform: works on Windows (NTFS), macOS (APFS/HFS+), Linux (ext4/xfs).
 */
export function safeWriteJsonFile(
  filePath: string,
  data: Record<string, any>,
  options?: {
    /** Minimum new/old size ratio.  Below this the write is rejected.  Default 0.4. */
    minSizeRatio?: number;
    /** Bypass the size-drop check (use when the caller intentionally removes fields). */
    skipSizeCheck?: boolean;
  },
): { written: boolean; reason?: string } {
  const newContent = JSON.stringify(data, null, 2);
  const newSize = Buffer.byteLength(newContent, 'utf8');

  const dir = path.dirname(filePath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* dir may already exist */ }

  // Size-drop protection: compare against existing file.
  if (!options?.skipSizeCheck && fs.existsSync(filePath)) {
    try {
      const oldSize = fs.statSync(filePath).size;
      const ratio = options?.minSizeRatio ?? DEFAULT_MIN_SIZE_RATIO;
      if (oldSize > 0 && newSize / oldSize < ratio) {
        // Only reject for non-trivial configs. Small files (< 500 bytes) can legitimately
        // shrink by large ratios (e.g. deduplicating bindings from 3→1).
        // The guard is designed to catch Gateway stripping desktop fields from
        // a full config (~10KB → ~3KB), not small-file fluctuations.
        if (oldSize >= 500) {
          console.warn(
            `[config-guard] Rejected write to ${path.basename(filePath)}: ` +
            `size would drop from ${oldSize} to ${newSize} bytes ` +
            `(ratio ${(newSize / oldSize).toFixed(2)} < threshold ${ratio}). ` +
            `This usually means OpenClaw or an external process stripped desktop-specific fields.`,
          );
          return { written: false, reason: 'size-drop-rejected' };
        }
      }
    } catch {
      // stat failed — proceed with write (file may have been deleted concurrently).
    }
  }

  // Backup existing file before overwriting.
  if (fs.existsSync(filePath)) {
    const bakPath = filePath + '.desktop-bak';
    try {
      fs.copyFileSync(filePath, bakPath);
    } catch {
      // Best-effort backup; don't block the write.
    }
  }

  // Atomic write: write to .tmp then rename.
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, newContent, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Fallback: direct write (rename can fail on Windows if antivirus locks the file).
    fs.writeFileSync(filePath, newContent, 'utf8');
    // Clean up tmp if it still exists.
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }

  return { written: true };
}

/**
 * Restore openclaw.json from the desktop backup if the current file appears
 * corrupted (too small compared to the backup).  Returns the restored config
 * object, or null if no restoration was needed/possible.
 *
 * Called after Gateway startup to recover from OpenClaw's config normalization
 * that strips desktop-specific fields.
 */
export function restoreConfigFromBackupIfNeeded(
  configPath: string,
  minSizeRatio = DEFAULT_MIN_SIZE_RATIO,
): Record<string, any> | null {
  const bakPath = configPath + '.desktop-bak';
  if (!fs.existsSync(bakPath) || !fs.existsSync(configPath)) return null;

  try {
    const currentSize = fs.statSync(configPath).size;
    const bakSize = fs.statSync(bakPath).size;

    // Only restore if backup is significantly larger than current file
    // AND the current file is suspiciously small.
    if (bakSize > 0 && currentSize > 0 && currentSize / bakSize < minSizeRatio) {
      const bakContent = readJsonFileWithBom<Record<string, any>>(bakPath);
      // Validate backup is a valid object with expected structure.
      if (bakContent && typeof bakContent === 'object' && !Array.isArray(bakContent)) {
        console.log(
          `[config-guard] Restoring config from backup: current=${currentSize}B, backup=${bakSize}B`,
        );
        // Write backup content back to config (use direct write since we already validated size).
        fs.writeFileSync(configPath, JSON.stringify(bakContent, null, 2), 'utf8');
        return bakContent;
      }
    }
  } catch (err) {
    console.warn('[config-guard] Backup restoration failed:', err);
  }

  return null;
}
