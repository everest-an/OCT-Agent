# OpenClaw Channel Compatibility Audit (2026-04-07)

## Goal

This audit reviews whether OCT-Agent Desktop can safely keep supporting official OpenClaw chat channels after customer upgrades on Windows, macOS, and Linux.

Sources used:

- Official OpenClaw channel docs
- OpenClaw GitHub issues / regressions visible on 2026-04-07
- Local OCT-Agent runtime and Doctor behavior

## Executive Summary

- Upstream desktop-safe defaults in official docs: Telegram, WhatsApp, Discord, Slack
- OCT-Agent release-gate minimum matrix: Telegram, WhatsApp, Discord, WeChat
- Supported but currently higher risk: Feishu
- Supported with extra host dependency: Signal
- Supported with extra infrastructure requirement: LINE
- Do not position as normal cross-platform desktop channel: iMessage (legacy)
- Recommended iMessage path: BlueBubbles on a Mac server, not legacy `imessage`

## Compatibility Matrix

| Channel | Official upstream status | Windows desktop | macOS desktop | Linux desktop | Main requirement / risk |
|---|---|---|---|---|---|
| Telegram | Production-ready | Yes | Yes | Yes | Low-friction token setup; recent upstream regressions still exist around duplicate delivery and reconnect loops |
| WhatsApp | Production-ready | Yes | Yes | Yes | QR login + persistent Web session; recent reconnect/proxy regressions |
| Discord | Ready for DMs + guilds | Yes | Yes | Yes | Stable default choice; voice path has separate upstream issues |
| WeChat | Official plugin `@tencent-weixin/openclaw-weixin` | Yes | Yes | Yes | Requires OpenClaw / plugin version match, QR login, and gateway restart after login |
| Slack | Production-ready | Yes | Yes | Yes | Stable default choice; streaming / Socket Mode still have upstream bugs |
| Feishu | Bundled plugin | Yes, but elevated risk | Yes | Yes | WebSocket mode is desktop-friendly, but Windows-specific and bundled-plugin regressions exist |
| Signal | External CLI integration | Manual / elevated risk | Manual / elevated risk | Best-supported path | Requires `signal-cli` on host or external daemon |
| LINE | Bundled plugin | Conditional | Conditional | Conditional | Requires public HTTPS webhook endpoint; not true local-only one-click |
| iMessage (legacy) | Legacy external CLI integration | No | macOS only | No | Legacy `imsg`, may be removed upstream; not suitable as a normal desktop default |
| BlueBubbles | Bundled plugin, recommended for iMessage | Conditional | Best fit | Conditional | Requires BlueBubbles Mac server + webhook path; better than legacy iMessage |

## Channel Notes

### Telegram

- Official docs mark Telegram as production-ready.
- Correct flow is token/config first, then first DM triggers pairing if `dmPolicy=pairing`.
- Current upstream risks worth tracking:
  - `#62038` Telegram provider reconnect zombie crash-loop on `2026.4.5`
  - `#61758` duplicate Telegram inbound ingestion
  - `#61222` duplicate Telegram group message delivery
  - `#61363` bundled Telegram plugin missing npm dependencies in `2026.4.4`

Product decision:

- Keep as tier-1 supported desktop channel on all three OSes.
- After upgrades, always run compatibility audit + binding repair + pairing-friendly UI copy.

### WhatsApp

- Official docs mark WhatsApp as production-ready.
- Desktop viability is good on all three OSes when QR login succeeds and session state remains intact.
- Current upstream risks worth tracking:
  - `#61825` proxy environments can break WhatsApp login handshake
  - `#60337` Baileys 499 reconnect loop
  - `#56127` runtime unavailable because bundled deps are missing
  - `#61686` / `#61787` bundled-plugin dependency regressions also affect WhatsApp upgrades

Product decision:

- Keep as tier-1 supported desktop channel on all three OSes.
- Preserve QR diagnostics, reconnect visibility, and post-upgrade plugin compatibility checks.

### Discord

- Official docs mark Discord as ready for DMs and guild channels.
- Core DM/guild flow is compatible with Windows, macOS, and Linux desktop installs.
- Current upstream risks worth tracking:
  - `#60780` thread-bound ACP replies can duplicate
  - `#58602` `/new` slash command timeout
  - `#57212` Discord voice receive pipeline silent
  - `#39825` native `/vc join` failure

Product decision:

- Keep as tier-1 supported desktop channel on all three OSes.
- Treat voice as an advanced capability with separate smoke coverage.

### WeChat

- OCT-Agent uses the official plugin path `@tencent-weixin/openclaw-weixin`, not a forked channel implementation.
- Current plugin docs state the active `2.x` line requires OpenClaw `>=2026.3.22` and uses QR login through `openclaw channels login --channel openclaw-weixin`.
- Desktop viability is good on all three OSes when plugin version matches the host version and gateway is restarted after login.
- Main product risks worth tracking:
  - OpenClaw upgrade leaves host version below the plugin compatibility floor
  - `plugins.entries.openclaw-weixin.enabled` is false after config churn or upgrade cleanup
  - login succeeds but gateway is not restarted, leaving a fake "configured but not really active" state

Product decision:

- Treat WeChat as a release-gate tier-1 channel for OCT-Agent because it is customer-critical and already first-class in the Desktop Channels UX.
- Minimum smoke coverage must include Windows, macOS, and Linux login + first reply + restart persistence.

### Slack

- Official docs mark Slack as production-ready.
- Core DM/channel flow is compatible with all three desktop OSes.
- Current upstream risks worth tracking:
  - `#61072` Socket Mode stale-socket restart behavior
  - `#59687` native streaming can leak reasoning blocks
  - `#56675` streaming mode mutual exclusion causes duplicates / stale previews / thread misrouting
  - `#54857` preview streaming race can cause double messages
  - `#57844` inbound Socket Mode events dropped on some versions

Product decision:

- Keep as tier-1 supported desktop channel on all three OSes.
- Do not market Slack native streaming as fully risk-free until upstream noise drops.

### Feishu

- Official docs support Feishu as a bundled plugin and recommend WebSocket/long connection, which is desktop-friendly.
- Core channel is nominally cross-platform, but current upstream defects make it higher risk than Telegram/Slack/Discord.
- Current upstream risks worth tracking:
  - `#62059` card streaming duplicates
  - `#61994` group chats can terminate abnormally and stop responding
  - `#61614` Windows crash caused by dual jiti/ESM runtime split
  - `#61686` / `#61787` bundled-plugin dependency regressions can break Feishu on upgrade

Product decision:

- Keep supported, but not in the most beginner-friendly default set until Windows regression risk is lower.
- Upgrade flow must audit stale plugin config and bundled plugin dependency fallout.

### Signal

- Official docs define Signal as an external `signal-cli` integration, not a fully embedded channel.
- Linux is the clearest official setup path; desktop use on Windows/macOS is possible only with extra manual host preparation or an external daemon.
- Current upstream risks worth tracking:
  - `#61434` Signal SSE connection repeatedly fails with `fetch failed`

Product decision:

- Do not present Signal as zero-decision one-click for normal desktop customers.
- Gate it behind explicit prerequisite checks: `signal-cli` or `channels.signal.httpUrl`.

### LINE

- Official docs support LINE as a bundled plugin.
- LINE requires a public HTTPS webhook endpoint to the gateway.
- That means LINE is not a pure local-loopback desktop channel on any OS.

Product decision:

- Keep it supported, but label it as an advanced channel requiring webhook exposure.
- Desktop should warn users that local install alone is insufficient without tunnel / reverse proxy / public gateway.

### iMessage (legacy)

- Official docs explicitly warn: for new deployments, use BlueBubbles instead.
- `imessage` is legacy, macOS-only, and may be removed in a future release.
- Current upstream risks worth tracking:
  - `#61632` / `#61629` enabled but unavailable state
  - `#60940` sent messages echoed back as inbound
  - `#53794` config accepted but provider never starts on macOS

Product decision:

- Do not market legacy `imessage` as a normal supported cross-platform desktop channel.
- Treat it as macOS-only legacy maintenance mode.

### BlueBubbles

- Official docs recommend BlueBubbles over legacy `imessage` for new iMessage deployments.
- It still requires a Mac server plus webhook routing, so it is not the same as a pure local desktop channel.
- Official docs note current macOS 26 Tahoe limitations for edit / group icon sync.

Product decision:

- Use BlueBubbles as the recommended iMessage story.
- Position it as a managed remote/Mac-backed channel, not as a generic one-click local desktop channel.

## Cross-Platform Release Policy

### Tier 1: release-gate minimum for OCT-Agent desktop

- Telegram
- WhatsApp
- Discord
- WeChat

Requirement:

- Windows, macOS, Linux smoke coverage must stay green after upgrade.
- Current execution script: `docs/OPENCLAW_TIER1_CHANNEL_SMOKE_MATRIX_2026-04-07.md`

Note:

- Slack remains officially supported and desktop-safe, but it is outside the minimum four-channel release gate because WeChat is the higher-priority customer channel for this product.

### Tier 2: ship as supported, but with explicit prerequisites/warnings

- Feishu
- Signal
- LINE
- BlueBubbles

Requirement:

- UI must disclose host or infra prerequisites before setup succeeds.
- Upgrade path must run a compatibility audit after OpenClaw updates.

### Tier 3: legacy / not normal customer default

- iMessage (`imessage` / `imsg`)

Requirement:

- macOS-only warning
- recommend BlueBubbles instead

## OCT-Agent Changes Implemented In This Round

1. Added a lightweight Doctor `channel-compatibility` audit.
2. Auto-repair now fixes upgrade-sensitive stale channel plugin config:
   - restores `plugins.allow` for active channels when OpenClaw upgrade leaves them out
   - re-enables active channel plugin entries that were disabled
   - removes stale enabled channel plugin entries / allowlist entries that can drag broken bundled plugins into every CLI run
3. Manual warnings now cover:
   - Signal without `signal-cli` or external daemon
   - LINE without acknowledging public HTTPS webhook requirement
   - legacy iMessage positioning and non-macOS misuse
4. OpenClaw upgrade flow now runs the compatibility audit automatically after `openclaw doctor --fix`.

## Recommended Next Steps

1. Split Channels UI into `easy`, `advanced`, and `legacy` groups so customer expectations match official upstream reality.
2. Run `docs/OPENCLAW_TIER1_CHANNEL_SMOKE_MATRIX_2026-04-07.md` after every OpenClaw upgrade bump.
3. Add advanced prerequisite copy in the channel wizard for Signal, LINE, and BlueBubbles.
4. Add release gating against upstream bundled-plugin regressions (`#61686`, `#61787`) before bumping OpenClaw again.