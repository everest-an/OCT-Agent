import fs from 'fs';
import path from 'path';

export function stripUtf8Bom(input: string): string {
  return input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input;
}

export function parseJsonWithBom<T = any>(input: string): T {
  return JSON.parse(stripUtf8Bom(input)) as T;
}

function parseJsonFileRaw<T = any>(filePath: string): T {
  return parseJsonWithBom<T>(fs.readFileSync(filePath, 'utf8'));
}

export function readJsonFileWithBom<T = any>(filePath: string): T {
  try {
    return parseJsonFileRaw<T>(filePath);
  } catch (err) {
    if (path.basename(filePath).toLowerCase() === 'openclaw.json' && repairKnownInvalidOpenClawJsonText(filePath)) {
      return parseJsonFileRaw<T>(filePath);
    }
    throw err;
  }
}

export function repairKnownInvalidOpenClawJsonText(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;

  try {
    parseJsonFileRaw(filePath);
    return false;
  } catch {
    // Continue with narrow text repair below.
  }

  const knownAgentNames: Record<string, string> = {
    'social-content-creator': 'social-content-creator',
    'xiaohongshu-specialist': 'xiaohongshu-specialist',
  };

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const idMatch = lines[i].match(/^\s+"id":\s+"([^"]+)"/);
    if (!idMatch) continue;
    const replacementName = knownAgentNames[idMatch[1]];
    if (!replacementName) continue;

    for (let j = i + 1; j < Math.min(i + 16, lines.length); j++) {
      if (!/^\s+"name":/.test(lines[j])) continue;
      if (lines[j].includes(`"name": "${replacementName}"`)) continue;
      lines[j] = `          "name": "${replacementName}",`;
      changed = true;
    }
  }

  if (!changed) return false;

  fs.copyFileSync(filePath, `${filePath}.corrupt-${Date.now()}`);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  try {
    parseJsonFileRaw(filePath);
    console.warn(`[config-guard] Repaired known invalid agent identity JSON in ${path.basename(filePath)}`);
    return true;
  } catch {
    return false;
  }
}

export function restoreInvalidJsonFromBackupIfNeeded(filePath: string): Record<string, any> | null {
  if (!fs.existsSync(filePath)) return null;

  repairKnownInvalidOpenClawJsonText(filePath);
  const bakPath = filePath + '.desktop-bak';
  if (fs.existsSync(bakPath)) {
    repairKnownInvalidOpenClawJsonText(bakPath);
  }

  try {
    readJsonFileWithBom(filePath);
    return null;
  } catch {
    // Continue to backup recovery below.
  }

  if (!fs.existsSync(bakPath)) return null;

  try {
    const backup = readJsonFileWithBom<Record<string, any>>(bakPath);
    if (!backup || typeof backup !== 'object' || Array.isArray(backup)) return null;

    const corruptPath = `${filePath}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(filePath, corruptPath);
    } catch {
      // Best-effort forensic copy only.
    }
    fs.copyFileSync(bakPath, filePath);
    console.warn(`[config-guard] Restored invalid JSON from backup: ${path.basename(filePath)}`);
    return backup;
  } catch (err) {
    console.warn('[config-guard] Invalid JSON backup restore failed:', err);
    return null;
  }
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
 * Recover desktop-specific fields that OpenClaw's Gateway may have stripped
 * from openclaw.json.  Instead of blindly restoring the entire backup (which
 * would revert legitimate schema changes after an OpenClaw upgrade), we
 * **merge** missing top-level keys from the backup into the current config.
 *
 * Returns the merged config object, or null if no merge was needed/possible.
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

    // Only act if backup is significantly larger than current file.
    if (bakSize > 0 && currentSize > 0 && currentSize / bakSize < minSizeRatio) {
      const currentContent = readJsonFileWithBom<Record<string, any>>(configPath);
      const bakContent = readJsonFileWithBom<Record<string, any>>(bakPath);
      if (!bakContent || typeof bakContent !== 'object' || Array.isArray(bakContent)) return null;
      if (!currentContent || typeof currentContent !== 'object' || Array.isArray(currentContent)) return null;

      // Merge strategy: for each top-level key in the backup that is missing
      // or empty in the current config, copy it over.  Keys that already exist
      // in the current config are LEFT UNTOUCHED — this preserves any schema
      // changes that a newer OpenClaw version introduced.
      let merged = false;
      for (const key of Object.keys(bakContent)) {
        if (!(key in currentContent) || currentContent[key] === undefined) {
          currentContent[key] = bakContent[key];
          merged = true;
        } else if (
          // Deep-merge one level for objects: restore missing sub-keys.
          // This handles e.g. plugins.installs being stripped but plugins.entries kept.
          typeof bakContent[key] === 'object' && bakContent[key] !== null && !Array.isArray(bakContent[key]) &&
          typeof currentContent[key] === 'object' && currentContent[key] !== null && !Array.isArray(currentContent[key])
        ) {
          for (const subKey of Object.keys(bakContent[key])) {
            if (!(subKey in currentContent[key]) || currentContent[key][subKey] === undefined) {
              currentContent[key][subKey] = bakContent[key][subKey];
              merged = true;
            }
          }
        }
      }

      if (merged) {
        console.log(
          `[config-guard] Merged missing fields from backup: current=${currentSize}B, backup=${bakSize}B`,
        );
        fs.writeFileSync(configPath, JSON.stringify(currentContent, null, 2), 'utf8');
        return currentContent;
      }
    }
  } catch (err) {
    console.warn('[config-guard] Backup merge failed:', err);
  }

  return null;
}
