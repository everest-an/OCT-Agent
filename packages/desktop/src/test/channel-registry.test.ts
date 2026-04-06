import { describe, it, expect, beforeAll } from 'vitest';
import {
  getAllChannels, getChannel, getChannelByOpenclawId,
  toOpenclawId, toFrontendId, isOneClick, hasBrandIcon,
  buildCLIFlags, mergeCatalog, mergeChannelOptions,
  getBuiltinChannels, serializeRegistry, loadFromSerialized,
  parseChannelCapabilitiesJson, applyChannelCapabilities,
  parseCliHelp, applyCliHelp,
} from '../lib/channel-registry';

const MOCK_CAPABILITIES_OUTPUT = `18:21:14+08:00 [plugins] Awareness memory plugin initialized (cloud)
{
  "channels": [
    {
      "plugin": {
        "id": "discord",
        "setupWizard": {
          "credentials": [
            {
              "inputKey": "token",
              "credentialLabel": "Discord bot token",
              "preferredEnvVar": "DISCORD_BOT_TOKEN",
              "inputPrompt": "Enter Discord bot token"
            }
          ]
        }
      }
    },
    {
      "plugin": {
        "id": "slack",
        "setupWizard": {
          "credentials": [
            {
              "inputKey": "botToken",
              "credentialLabel": "Slack bot token",
              "preferredEnvVar": "SLACK_BOT_TOKEN"
            },
            {
              "inputKey": "appToken",
              "credentialLabel": "Slack app token",
              "preferredEnvVar": "SLACK_APP_TOKEN"
            }
          ]
        }
      }
    }
  ]
}`;

// Simulate the real `openclaw channels add --help` output
const MOCK_CLI_HELP = `Usage: openclaw channels add [options]

Add or update a channel account

Options:
  --access-token <token>       Matrix access token
  --account <id>               Account id (default when omitted)
  --app-token <token>          Slack app token (xapp-...)
  --audience <value>           Google Chat audience value (app URL or project
                               number)
  --audience-type <type>       Google Chat audience type
                               (app-url|project-number)
  --auth-dir <path>            WhatsApp auth directory override
  --bot-token <token>          Slack bot token (xoxb-...)
  --channel <name>             Channel
                               (telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|line)
  --code <code>                Tlon login code
  --homeserver <url>           Matrix homeserver URL
  --http-url <url>             Signal HTTP daemon base URL
  --password <password>        Matrix password
  --private-key <key>          Nostr private key (nsec... or hex)
  --ship <ship>                Tlon ship name (~sampel-palnet)
  --signal-number <e164>       Signal account number (E.164)
  --token <token>              Bot token (Telegram/Discord)
  --url <url>                  Tlon ship URL
  --user-id <id>               Matrix user ID
  --webhook-path <path>        Webhook path (Google Chat/BlueBubbles)
  --webhook-url <url>          Google Chat webhook URL
  -h, --help                   Display help for command`;

describe('Channel Registry', () => {
  // Apply CLI help parsing before all tests (simulates app startup)
  beforeAll(() => {
    const { cliChannels, channelFields } = parseCliHelp(MOCK_CLI_HELP);
    applyCliHelp(cliChannels, channelFields);
    // Then merge catalog (simulates loading channel-catalog.json)
    mergeCatalog([
      { name: '@openclaw/telegram', openclaw: { channel: { id: 'telegram', label: 'Telegram' }, install: { npmSpec: '@openclaw/telegram' } } },
      { name: '@openclaw/whatsapp', openclaw: { channel: { id: 'whatsapp', label: 'WhatsApp' }, install: { npmSpec: '@openclaw/whatsapp' } } },
      { name: '@openclaw/slack', openclaw: { channel: { id: 'slack', label: 'Slack' }, install: { npmSpec: '@openclaw/slack' } } },
      { name: '@openclaw/discord', openclaw: { channel: { id: 'discord', label: 'Discord' }, install: { npmSpec: '@openclaw/discord' } } },
      { name: '@openclaw/signal', openclaw: { channel: { id: 'signal', label: 'Signal' }, install: { npmSpec: '@openclaw/signal' } } },
      { name: '@openclaw/imessage', openclaw: { channel: { id: 'imessage', label: 'iMessage' }, install: { npmSpec: '@openclaw/imessage' } } },
      { name: '@openclaw/matrix', openclaw: { channel: { id: 'matrix', label: 'Matrix' }, install: { npmSpec: '@openclaw/matrix' } } },
      { name: '@openclaw/googlechat', openclaw: { channel: { id: 'googlechat', label: 'Googlechat' }, install: { npmSpec: '@openclaw/googlechat' } } },
      { name: '@openclaw/nostr', openclaw: { channel: { id: 'nostr', label: 'Nostr' }, install: { npmSpec: '@openclaw/nostr' } } },
      { name: '@openclaw/tlon', openclaw: { channel: { id: 'tlon', label: 'Tlon' }, install: { npmSpec: '@openclaw/tlon' } } },
      { name: '@openclaw/bluebubbles', openclaw: { channel: { id: 'bluebubbles', label: 'BlueBubbles' }, install: { npmSpec: '@openclaw/bluebubbles' } } },
      { name: '@openclaw/feishu', openclaw: { channel: { id: 'feishu', label: 'Feishu' }, install: { npmSpec: '@openclaw/feishu' } } },
      { name: '@openclaw/line', openclaw: { channel: { id: 'line', label: 'LINE' }, install: { npmSpec: '@openclaw/line' } } },
    ]);
    mergeChannelOptions(['twitch', 'msteams', 'qqbot']);
  });

  describe('parseCliHelp', () => {
    it('extracts CLI-supported channel enum', () => {
      const { cliChannels } = parseCliHelp(MOCK_CLI_HELP);
      expect(cliChannels).toContain('telegram');
      expect(cliChannels).toContain('slack');
      expect(cliChannels).toContain('googlechat');
      expect(cliChannels).not.toContain('msteams');
      expect(cliChannels).not.toContain('nostr');
    });

    it('extracts channel enum from inline help format', () => {
      const inlineHelp = `
Options:
  --channel <name> Channel (telegram | whatsapp | discord)
  --token <token>  Bot token (Telegram/Discord)`;
      const { cliChannels } = parseCliHelp(inlineHelp);

      expect(cliChannels).toContain('telegram');
      expect(cliChannels).toContain('whatsapp');
      expect(cliChannels).toContain('discord');
    });

    it('extracts per-channel config fields from flag descriptions', () => {
      const { channelFields } = parseCliHelp(MOCK_CLI_HELP);

      // Slack: 2 fields (bot-token + app-token)
      expect(channelFields.get('slack')).toBeDefined();
      expect(channelFields.get('slack')!.length).toBe(2);
      expect(channelFields.get('slack')!.map(f => f.cliFlag)).toContain('--bot-token');
      expect(channelFields.get('slack')!.map(f => f.cliFlag)).toContain('--app-token');

      // Matrix: homeserver + user-id + password (+ access-token = 4)
      const matrixFields = channelFields.get('matrix')!;
      expect(matrixFields.length).toBeGreaterThanOrEqual(3);
      expect(matrixFields.map(f => f.cliFlag)).toContain('--homeserver');
      expect(matrixFields.map(f => f.cliFlag)).toContain('--user-id');
      expect(matrixFields.map(f => f.cliFlag)).toContain('--password');

      // Nostr: private-key
      expect(channelFields.get('nostr')!.map(f => f.cliFlag)).toContain('--private-key');

      // Tlon: ship + url + code
      const tlonFields = channelFields.get('tlon')!;
      expect(tlonFields.map(f => f.cliFlag)).toContain('--ship');
      expect(tlonFields.map(f => f.cliFlag)).toContain('--url');
      expect(tlonFields.map(f => f.cliFlag)).toContain('--code');

      // Telegram: token
      expect(channelFields.get('telegram')!.map(f => f.cliFlag)).toContain('--token');
    });

    it('detects field types correctly (password vs text)', () => {
      const { channelFields } = parseCliHelp(MOCK_CLI_HELP);
      const slackBot = channelFields.get('slack')!.find(f => f.cliFlag === '--bot-token')!;
      expect(slackBot.type).toBe('password');

      const matrixHome = channelFields.get('matrix')!.find(f => f.cliFlag === '--homeserver')!;
      expect(matrixHome.type).toBe('text');

      const nostrKey = channelFields.get('nostr')!.find(f => f.cliFlag === '--private-key')!;
      expect(nostrKey.type).toBe('password');
    });
  });

  describe('parseChannelCapabilitiesJson', () => {
    it('extracts official setup credentials even when logs precede the JSON payload', () => {
      const { channelFields } = parseChannelCapabilitiesJson(MOCK_CAPABILITIES_OUTPUT);

      expect(channelFields.get('discord')).toEqual([
        expect.objectContaining({
          key: 'token',
          cliFlag: '--token',
          type: 'password',
          placeholder: 'DISCORD_BOT_TOKEN',
        }),
      ]);
      expect(channelFields.get('slack')).toEqual([
        expect.objectContaining({ key: 'botToken', cliFlag: '--bot-token' }),
        expect.objectContaining({ key: 'appToken', cliFlag: '--app-token' }),
      ]);
    });

    it('lets official capabilities override help-derived fallback fields', () => {
      const { channelFields } = parseChannelCapabilitiesJson(MOCK_CAPABILITIES_OUTPUT);
      applyChannelCapabilities(channelFields);

      const slack = getChannel('slack')!;
      expect(slack.configFields.map((field) => field.key)).toEqual(['botToken', 'appToken']);
    });
  });

  describe('Builtin channels', () => {
    it('has only 2 builtins: local + wechat', () => {
      const builtins = getBuiltinChannels();
      expect(builtins).toHaveLength(2);
      expect(builtins.map(c => c.id).sort()).toEqual(['local', 'wechat']);
    });

    it('only WeChat uses json-direct (builtin)', () => {
      const jsonDirect = getBuiltinChannels().filter(c => c.saveStrategy === 'json-direct');
      expect(jsonDirect).toHaveLength(1);
      expect(jsonDirect[0].id).toBe('wechat');
    });
  });

  describe('Dynamic channels — save strategy', () => {
    it('telegram uses CLI (in --channel enum)', () => {
      expect(getChannel('telegram')!.saveStrategy).toBe('cli');
    });

    it('msteams uses json-direct (NOT in --channel enum)', () => {
      expect(getChannel('msteams')!.saveStrategy).toBe('json-direct');
    });

    it('nostr uses json-direct (NOT in --channel enum)', () => {
      expect(getChannel('nostr')!.saveStrategy).toBe('json-direct');
    });
  });

  describe('Dynamic channels — config fields from CLI help', () => {
    it('slack has 2 dynamic fields', () => {
      const sl = getChannel('slack')!;
      expect(sl.connectionType).toBe('multi-field');
      expect(sl.configFields.length).toBe(2);
      expect(sl.configFields.map(f => f.cliFlag).sort()).toEqual(['--app-token', '--bot-token']);
    });

    it('matrix has 3+ dynamic fields', () => {
      const m = getChannel('matrix')!;
      expect(m.connectionType).toBe('multi-field');
      expect(m.configFields.length).toBeGreaterThanOrEqual(3);
      const flags = m.configFields.map(f => f.cliFlag);
      expect(flags).toContain('--homeserver');
      expect(flags).toContain('--user-id');
      expect(flags).toContain('--password');
    });

    it('googlechat has webhook fields', () => {
      const g = getChannel('googlechat')!;
      const flags = g.configFields.map(f => f.cliFlag);
      expect(flags).toContain('--webhook-url');
    });

    it('telegram has single token field', () => {
      const tg = getChannel('telegram')!;
      expect(tg.connectionType).toBe('token');
      expect(tg.configFields).toHaveLength(1);
      expect(tg.configFields[0].cliFlag).toBe('--token');
    });

    it('tlon has 3 fields', () => {
      const t = getChannel('tlon')!;
      expect(t.configFields.length).toBe(3);
      expect(t.configFields.map(f => f.cliFlag).sort()).toEqual(['--code', '--ship', '--url']);
    });
  });

  describe('One-click channels', () => {
    it.each(['whatsapp', 'signal', 'imessage'])('%s is one-click', (id) => {
      expect(isOneClick(id)).toBe(true);
      expect(getChannel(id)!.configFields).toHaveLength(0);
    });

    it.each(['telegram', 'slack', 'discord'])('%s is NOT one-click', (id) => {
      expect(isOneClick(id)).toBe(false);
    });
  });

  describe('Known overrides — visual only', () => {
    it('googlechat label override', () => {
      expect(getChannel('googlechat')!.label).toBe('Google Chat');
    });

    it('msteams label override', () => {
      expect(getChannel('msteams')!.label).toBe('Microsoft Teams');
    });

    it('brand icons for known channels', () => {
      for (const id of ['telegram', 'discord', 'slack', 'whatsapp', 'signal', 'imessage', 'feishu', 'line', 'matrix', 'googlechat']) {
        expect(hasBrandIcon(id)).toBe(true);
      }
    });

    it('no brand icon for unknown channels', () => {
      expect(hasBrandIcon('twitch')).toBe(false);
      expect(hasBrandIcon('qqbot')).toBe(false);
    });
  });

  describe('ID mapping', () => {
    it('wechat ↔ openclaw-weixin', () => {
      expect(toOpenclawId('wechat')).toBe('openclaw-weixin');
      expect(toFrontendId('openclaw-weixin')).toBe('wechat');
    });

    it('unknown returns itself', () => {
      expect(toOpenclawId('xxx')).toBe('xxx');
      expect(toFrontendId('xxx')).toBe('xxx');
    });
  });

  describe('buildCLIFlags', () => {
    it('single token', () => {
      const ch = getChannel('telegram')!;
      expect(buildCLIFlags(ch, { token: 'abc' })).toBe('--token "abc"');
    });

    it('multi-field (slack)', () => {
      const ch = getChannel('slack')!;
      // Order depends on configFields order (parsed from help output)
      const result = buildCLIFlags(ch, { botToken: 'xoxb', appToken: 'xapp' });
      expect(result).toContain('--bot-token "xoxb"');
      expect(result).toContain('--app-token "xapp"');
    });

    it('escapes quotes', () => {
      const ch = getChannel('telegram')!;
      expect(buildCLIFlags(ch, { token: 'a"b' })).toBe('--token "a\\"b"');
    });
  });

  describe('Serialization', () => {
    it('round-trips correctly', () => {
      const serialized = serializeRegistry();
      expect(serialized.length).toBeGreaterThanOrEqual(12);
      loadFromSerialized(serialized);
      expect(getChannel('wechat')).toBeDefined();
      expect(getChannel('telegram')).toBeDefined();
    });
  });
});
