import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseJsonWithBom, readJsonFileWithBom, repairKnownInvalidOpenClawJsonText, restoreInvalidJsonFromBackupIfNeeded, stripUtf8Bom } from '../../electron/json-file';

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-json-file-'));
  tempDirs.push(dir);
  return dir;
}

describe('json-file helpers', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips UTF-8 BOM when present', () => {
    const input = '\uFEFF{"gateway":{"auth":{"token":"abc"}}}';
    const output = stripUtf8Bom(input);

    expect(output.startsWith('\uFEFF')).toBe(false);
    expect(output).toBe('{"gateway":{"auth":{"token":"abc"}}}');
  });

  it('parses JSON text that starts with BOM', () => {
    const input = '\uFEFF{"gateway":{"auth":{"token":"abc"}}}';
    const parsed = parseJsonWithBom<{ gateway: { auth: { token: string } } }>(input);

    expect(parsed.gateway.auth.token).toBe('abc');
  });

  it('restores invalid JSON from a desktop backup and preserves the corrupt file', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'openclaw.json');
    const backup = {
      channels: {
        'openclaw-weixin': {
          enabled: true,
        },
      },
    };

    fs.writeFileSync(filePath, '{"channels": {"broken": true', 'utf8');
    fs.writeFileSync(`${filePath}.desktop-bak`, JSON.stringify(backup, null, 2), 'utf8');

    const restored = restoreInvalidJsonFromBackupIfNeeded(filePath);

    expect(restored).toEqual(backup);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual(backup);
    expect(fs.readdirSync(dir).some((name) => name.startsWith('openclaw.json.corrupt-'))).toBe(true);
  });

  it('repairs known invalid agent identity name lines before JSON parsing', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'openclaw.json');
    fs.writeFileSync(filePath, `{
  "agents": {
    "list": [
      {
        "id": "social-content-creator",
        "name": "social-content-creator",
        "identity": {
          "name": "broken,
          "emoji": "phone"
        }
      }
    ]
  }
}
`, 'utf8');

    expect(repairKnownInvalidOpenClawJsonText(filePath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(parsed.agents.list[0].identity.name).toBe('social-content-creator');
  });

  it('auto-repairs known invalid openclaw.json text during reads', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'openclaw.json');
    fs.writeFileSync(filePath, `{
  "agents": {
    "list": [
      {
        "id": "xiaohongshu-specialist",
        "name": "xiaohongshu-specialist",
        "identity": {
          "name": "broken,
          "emoji": "book"
        }
      }
    ]
  }
}
`, 'utf8');

    const parsed = readJsonFileWithBom<any>(filePath);

    expect(parsed.agents.list[0].identity.name).toBe('xiaohongshu-specialist');
    expect(fs.readdirSync(dir).some((name) => name.startsWith('openclaw.json.corrupt-'))).toBe(true);
  });

  it('repairs a known-invalid desktop backup even when current JSON is valid', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'openclaw.json');
    fs.writeFileSync(filePath, '{"ok":true}', 'utf8');
    fs.writeFileSync(`${filePath}.desktop-bak`, `{
  "agents": {
    "list": [
      {
        "id": "social-content-creator",
        "name": "social-content-creator",
        "identity": {
          "name": "broken,
          "emoji": "phone"
        }
      }
    ]
  }
}
`, 'utf8');

    expect(restoreInvalidJsonFromBackupIfNeeded(filePath)).toBeNull();

    const backup = JSON.parse(fs.readFileSync(`${filePath}.desktop-bak`, 'utf8'));
    expect(backup.agents.list[0].identity.name).toBe('social-content-creator');
  });
});
