import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureChannelManifestMetadata } from '../../electron/ipc/channel-plugin-spec';

const tempDirs: string[] = [];

function makeTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-channel-manifest-'));
  tempDirs.push(dir);
  return dir;
}

function writeManifest(home: string, channelId: string, manifest: unknown) {
  const dir = path.join(home, '.openclaw', 'extensions', channelId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'openclaw.plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function readManifest(home: string, channelId: string) {
  return JSON.parse(
    fs.readFileSync(path.join(home, '.openclaw', 'extensions', channelId, 'openclaw.plugin.json'), 'utf8'),
  );
}

describe('ensureChannelManifestMetadata', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds channelConfigs metadata for installed channel manifests that declare a channel', () => {
    const home = makeTempHome();
    writeManifest(home, 'openclaw-weixin', {
      id: 'openclaw-weixin',
      channels: ['openclaw-weixin'],
      configSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    });

    expect(ensureChannelManifestMetadata('openclaw-weixin', home)).toBe(true);

    const manifest = readManifest(home, 'openclaw-weixin');
    expect(manifest.channelConfigs['openclaw-weixin'].label).toBe('WeChat');
    expect(manifest.channelConfigs['openclaw-weixin'].schema.properties.enabled).toEqual({ type: 'boolean' });
    expect(manifest.channelConfigs['openclaw-weixin'].schema.additionalProperties).toBe(false);
  });

  it('does not overwrite official channelConfigs metadata when it already exists', () => {
    const home = makeTempHome();
    writeManifest(home, 'official-channel', {
      id: 'official-channel',
      channels: ['official-channel'],
      configSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      channelConfigs: {
        'official-channel': {
          label: 'Official Label',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              officialOnly: { type: 'string' },
            },
          },
        },
      },
    });

    expect(ensureChannelManifestMetadata('official-channel', home)).toBe(true);

    const manifest = readManifest(home, 'official-channel');
    expect(manifest.channelConfigs['official-channel'].label).toBe('Official Label');
    expect(manifest.channelConfigs['official-channel'].schema.properties).toEqual({
      officialOnly: { type: 'string' },
    });
  });

  it('repairs a manifest created after an earlier missing-manifest check', () => {
    const home = makeTempHome();

    expect(ensureChannelManifestMetadata('openclaw-weixin', home)).toBe(true);

    writeManifest(home, 'openclaw-weixin', {
      id: 'openclaw-weixin',
      channels: ['openclaw-weixin'],
      configSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    });

    expect(ensureChannelManifestMetadata('openclaw-weixin', home)).toBe(true);

    const manifest = readManifest(home, 'openclaw-weixin');
    expect(manifest.channelConfigs['openclaw-weixin'].schema.properties.enabled).toEqual({ type: 'boolean' });
  });

  it('leaves non-channel plugin manifests unchanged', () => {
    const home = makeTempHome();
    const original = {
      id: 'provider-only',
      providers: ['provider-only'],
      configSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    };
    writeManifest(home, 'provider-only', original);

    expect(ensureChannelManifestMetadata('provider-only', home)).toBe(true);

    expect(readManifest(home, 'provider-only')).toEqual(original);
  });
});
