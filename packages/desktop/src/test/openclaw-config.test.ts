import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  enforceDesktopChannelSessionIsolation,
  getExecApprovalSettings,
  hardenWhatsAppDmPolicy,
  hasExplicitExecApprovalConfig,
  migrateLegacyChannelConfig,
  writeDesktopExecApprovalDefaults,
} from '../../electron/openclaw-config';

describe('openclaw-config exec approvals', () => {
  let tempHome = '';

  afterEach(() => {
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
      tempHome = '';
    }
  });

  it('preserves allowlist host approval mode from exec-approvals.json', () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-claw-'));
    const openclawDir = path.join(tempHome, '.openclaw');
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(path.join(openclawDir, 'exec-approvals.json'), JSON.stringify({
      version: 1,
      defaults: {
        security: 'allowlist',
        ask: 'always',
        askFallback: 'allowlist',
      },
      agents: {
        main: {
          allowlist: [
            { pattern: 'dir *' },
          ],
        },
      },
    }, null, 2));

    expect(getExecApprovalSettings(tempHome)).toMatchObject({
      security: 'allowlist',
      ask: 'always',
      askFallback: 'allowlist',
      allowlist: [{ pattern: 'dir *' }],
    });
    expect(hasExplicitExecApprovalConfig(tempHome)).toBe(true);
  });

  it('treats missing or empty exec approvals files as no explicit host exec config', () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-claw-'));

    expect(hasExplicitExecApprovalConfig(tempHome)).toBe(false);

    const openclawDir = path.join(tempHome, '.openclaw');
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(path.join(openclawDir, 'exec-approvals.json'), JSON.stringify({ version: 1 }, null, 2));

    expect(hasExplicitExecApprovalConfig(tempHome)).toBe(false);
  });

  it('writes the full desktop host exec defaults instead of only ask=off', () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-claw-'));

    writeDesktopExecApprovalDefaults(tempHome);

    expect(getExecApprovalSettings(tempHome)).toMatchObject({
      security: 'full',
      ask: 'off',
      askFallback: 'full',
      autoAllowSkills: true,
    });
    expect(hasExplicitExecApprovalConfig(tempHome)).toBe(true);
  });

  it('normalizes missing, main, and invalid dmScope to per-channel-peer', () => {
    const missingSessionConfig: any = {};
    const withMainScope: any = { session: { dmScope: 'main' } };
    const withInvalidScope: any = { session: { dmScope: 'legacy-mode' } };

    expect(enforceDesktopChannelSessionIsolation(missingSessionConfig)).toBe(true);
    expect(enforceDesktopChannelSessionIsolation(withMainScope)).toBe(true);
    expect(enforceDesktopChannelSessionIsolation(withInvalidScope)).toBe(true);

    expect(missingSessionConfig.session?.dmScope).toBe('per-channel-peer');
    expect(withMainScope.session?.dmScope).toBe('per-channel-peer');
    expect(withInvalidScope.session?.dmScope).toBe('per-channel-peer');
  });

  it('preserves valid non-main session isolation scopes', () => {
    const perPeer: any = { session: { dmScope: 'per-peer' } };
    const perAccountPeer: any = { session: { dmScope: 'per-account-channel-peer' } };

    expect(enforceDesktopChannelSessionIsolation(perPeer)).toBe(false);
    expect(enforceDesktopChannelSessionIsolation(perAccountPeer)).toBe(false);
    expect(perPeer.session?.dmScope).toBe('per-peer');
    expect(perAccountPeer.session?.dmScope).toBe('per-account-channel-peer');
  });

  it('removes legacy channels.whatsapp.errorPolicy during migration', () => {
    const config: Record<string, any> = {
      channels: {
        whatsapp: {
          dmPolicy: 'pairing',
          errorPolicy: 'silent',
        },
      },
    };

    const changed = migrateLegacyChannelConfig(config);

    expect(changed).toBe(true);
    expect(config.channels.whatsapp.errorPolicy).toBeUndefined();
  });

  it('normalizes invalid WhatsApp allowlist policy without allowFrom to pairing', () => {
    const config: Record<string, any> = {
      channels: {
        whatsapp: {
          dmPolicy: 'allowlist',
        },
      },
    };

    const changed = hardenWhatsAppDmPolicy(config);

    expect(changed).toBe(true);
    expect(config.channels.whatsapp.dmPolicy).toBe('pairing');
  });

  it('normalizes invalid Telegram allowlist policy without allowFrom to pairing', () => {
    const config: Record<string, any> = {
      channels: {
        telegram: {
          dmPolicy: 'allowlist',
          botToken: '123456:abc',
        },
      },
    };

    const changed = hardenWhatsAppDmPolicy(config);

    expect(changed).toBe(true);
    expect(config.channels.telegram.dmPolicy).toBe('pairing');
  });

  it('normalizes legacy Slack dm.policy=open without wildcard allowFrom', () => {
    const config: Record<string, any> = {
      channels: {
        slack: {
          dm: {
            policy: 'open',
          },
          botToken: 'xoxb-test',
          appToken: 'xapp-test',
        },
      },
    };

    const changed = hardenWhatsAppDmPolicy(config);

    expect(changed).toBe(true);
    expect(config.channels.slack.dm.policy).toBe('open');
    expect(config.channels.slack.dm.allowFrom).toEqual(['*']);
  });

  it('keeps WhatsApp allowlist policy when allowFrom is configured', () => {
    const config: Record<string, any> = {
      channels: {
        whatsapp: {
          dmPolicy: 'allowlist',
          allowFrom: ['+15550001111'],
        },
      },
    };

    const changed = hardenWhatsAppDmPolicy(config);

    expect(changed).toBe(false);
    expect(config.channels.whatsapp.dmPolicy).toBe('allowlist');
  });

  it('normalizes invalid account-level allowlist policy when effective allowFrom is empty', () => {
    const config: Record<string, any> = {
      channels: {
        whatsapp: {
          dmPolicy: 'pairing',
          accounts: {
            default: {
              dmPolicy: 'allowlist',
            },
          },
        },
      },
    };

    const changed = hardenWhatsAppDmPolicy(config);

    expect(changed).toBe(true);
    expect(config.channels.whatsapp.accounts.default.dmPolicy).toBe('pairing');
  });
});