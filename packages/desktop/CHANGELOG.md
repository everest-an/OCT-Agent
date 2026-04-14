# Changelog

## [0.3.0] - 2026-04-14

### Fixed
- OpenClaw upgrade interruption (network issues, etc.) no longer leaves a corrupted install that blocks chat. The app now auto-detects and cleans up broken packages before reinstalling.
- ENOENT error detection expanded to catch `spawn openclaw ENOENT` (previously only caught `npx` ENOENT), enabling automatic recovery when OpenClaw binary is missing.

### Added
- **User-friendly error messages**: Chat errors from AI providers now show actionable, non-technical messages instead of raw error strings. 8 error categories with localized hints (EN + CN):
  - Provider internal error → "AI service is temporarily unavailable" + suggestion to switch models
  - Rate limit → "Too many requests" + wait suggestion
  - Auth/API key issues → "Check Settings" guidance
  - Network problems → "Check Wi-Fi" guidance
  - Model not found, context length exceeded, timeout — each with clear next steps

## [0.2.9] - 2026-04-13

### Fixed
- Model config: Provider keys now align with OpenClaw built-in IDs (`qwen-portal`→`qwen`, `zhipu`→`zai`). Existing user configs auto-migrate.
- Model config: `desc` field no longer incorrectly overwritten by `baseUrl` in the provider dialog header.
- Model config: `syncToOpenClaw` no longer writes default `baseUrl` to openclaw.json — lets OpenClaw auto-resolve built-in endpoints, preventing stale hardcoded URLs from shadowing upstream changes.

### Added
- New providers: xAI Grok, Mistral, OpenRouter added to provider catalog.
- API Base URL input now shows the OpenClaw default endpoint with hint text. Users can override for proxies/custom gateways; unchanged defaults are not written to openclaw.json.
- Legacy provider key migration (`qwen-portal`→`qwen`, `zhipu`→`zai`, `alibaba`→`qwen`) — seamless for existing users.

## [0.2.8] - 2026-04-11

### Fixed
- Memory Wiki: Root cause fixed for slow/missing topic cards. `apiListTopics` now returns `tags[]` for each topic, so TopicView can resolve members purely client-side without needing the MOC card in the preloaded cards list (previously capped at 50, cutting off older MOC cards).
- TopicView resolution now uses 3-tier priority: (1) topic.tags client-side match — instant; (2) MOC card in preloaded cards fallback; (3) daemon fetch as last resort.
- Loading indicator after first retry now shows user-friendly “Daemon is building the tag index, please wait...” message instead of cryptic Retry N/M.

## [0.2.7] - 2026-04-11

### Fixed
- i18n: Added missing tab translation keys (`memory.overview`, `memory.overviewHint`, `memory.graph`, `memory.sync`, `memory.syncHint`) — previously always showed English fallback regardless of locale.
- Memory Wiki Topic view: Client-side tag-match returning 0 results now correctly falls through to daemon fetch instead of looping through client-side retries indefinitely.

### Improved
- Memory page tabs: More compact and polished styling — smaller icon boxes, tighter padding, rounded-xl corners, 2px brand accent bar on active tab, three-state text colors.
- Topic loading: Retry delay reduced from 1500ms → 800ms, MAX_RETRIES increased 3 → 4 for faster recovery when daemon index is warming up.

## [0.2.6] - 2026-04-11

### Fixed
- i18n: Added missing translation keys for the Memory Wiki module (en + zh). All `memory.wiki.*` labels, sidebar headings, loading states, and error messages are now properly translated.
- i18n: Added `memory.settings.cloudStatus`, `memory.settings.cloudStatus.desc`, and `memory.noTasks` keys that were previously falling back to hardcoded English.

### Performance
- Memory Wiki Topic view: Clicking a topic now resolves card members **client-side** from the already-loaded cards array (tag-match), eliminating the previous `fetch /knowledge/:id` → daemon LIKE query → up to 3 × 1.5 s retries flow. Topic cards appear instantly when the preloaded list contains the MOC card.

## [0.2.5] - 2026-04-11

### Changed
- **Pulled upstream fixes from main** (commits `5fede1b`, `d1ead71`):
  - `agents:add` no longer blocks on gateway preflight; added config-fallback when OpenClaw CLI plugin loading stalls; updated timeout values.
  - Task Center now reconciles stale running missions at startup via `mission:list-active` IPC, preventing stuck cards after a crashed run.
  - Mission start now classifies gateway handshake failures and self-heals once, with explicit pairing/device error states propagated to the UI.
  - Chat fallback forces local mode when gateway is unavailable or auth-gated.
- **Bumped daemon requirement to `@awareness-sdk/local >= 0.5.16`**, which ships:
  - Perception Center full lifecycle (exposure cap / snooze / dismiss / auto-resolve / restore) with 5 new REST endpoints and 20 new tests.
  - LLM-based auto-resolve of guards/contradictions when new memories come in.
  - Lightweight EN/ZH i18n in the web dashboard (`localhost:37800`).
  - F-034 skill crystallization hint propagation through `awareness-spec.json`.

### Notes
- Still unsigned / not notarized. Test users: double-click `⚠️ 首次打开必读 First-Run Fix.command` inside the DMG window after dragging the app to Applications. See [INSTALL-macOS.md](./INSTALL-macOS.md).

## [0.2.4] - 2026-04-11

### Added
- **DMG 内置 `First-Run Fix.command` 脚本**: The DMG window now includes a one-click fix script alongside the app icon and Applications shortcut. Users who download an unsigned test build can double-click the script to automatically run `xattr -cr /Applications/AwarenessClaw.app`, clearing macOS quarantine flags so the app opens without the "application is damaged" warning. The script is a pure bash one-liner (16 lines), human-readable, makes no network calls, and modifies nothing except the quarantine attribute on the installed app.
- **INSTALL-macOS.md**: Comprehensive Chinese-language install guide covering the recommended (double-click fix script) path, the manual terminal fallback, safety FAQs, and uninstall steps. Ship this alongside the DMG when sending test builds to users.
- **DMG window layout**: Custom `dmg.window` size (640×480) and `dmg.contents` positions so the three items (app / Applications link / fix script) are visually obvious.

### Fixed
- **Topic detail no longer flashes "No cards" while daemon is warming up**: `TopicView` now auto-retries the `/knowledge/:id` fetch up to 3 times with a 1.5s delay when the daemon returns an empty `members` array AND the sidebar count says there should be cards. This covers the case where the daemon has just started but hasn't finished indexing tags yet. The empty state ("No cards in this topic yet") only renders when BOTH the fetch AND the sidebar count agree there are zero members. During retries, the spinner shows "Retry n/3" so users know the page isn't stuck.
- **TopicView loading state reset on topicId change**: Added a dedicated `useEffect([topicId])` that synchronously resets `members/loading/error/attempt` so switching topics in the sidebar never leaks stale state from the previous topic for even one render frame.
- **Sidebar count is treated as authoritative during loading**: The header count now falls back to `topic.card_count` from the sidebar whenever the detail fetch is in-flight, so users see "15 cards" instead of "0 cards" → "15 cards" flicker.

### Notes
- This version is still unsigned / not notarized. See [INSTALL-macOS.md](./INSTALL-macOS.md) for how to unblock the app.

## [0.2.3] - 2026-04-11

### Fixed
- **Topic detail shows loading spinner instead of flashing "0 cards"**: Switching topics in the Wiki sidebar now keeps the loading indicator visible until the daemon fetch completes. Previously the view would flash "0 cards" / "No cards in this topic yet" for a split second before the real list arrived, and for tag-pseudo-topics it could stay empty if `cards` hadn't loaded yet. Count fallback during loading now uses `topic.card_count` from the sidebar.
- **Timeline events are now clickable with inline expansion**: Clicking an event row in the Wiki timeline day view expands it in place, fetching the full event content from `GET /memories/:id` and rendering it as Markdown. Subsequent clicks reuse the cached detail. Loading / error / empty states are all handled.
- **Wiki tab badge shows the real total knowledge count**: The badge on the Wiki tab in Memory page header used to show `cards.length` (the pre-loaded subset, often 5-50) — it now shows `daemonHealth.stats.totalKnowledge` (the authoritative daemon count, matching the header "72 张知识卡片" text).
- **Topic sidebar counts match detail view counts**: Depends on `@awareness-sdk/local >= 0.5.15`, which live-computes MOC member counts on every `/topics` read instead of trusting stale `link_count_outgoing`. Fixes the "sidebar shows 3, clicking in shows 2" bug.

## [0.2.2] - 2026-04-11

### Fixed
- **Topic detail shows all member cards**: Clicking a topic in the Wiki sidebar now calls `GET /api/v1/knowledge/:id` which (as of `@awareness-sdk/local@0.5.14`) returns a `members` array resolved via tag-match. Previously the desktop used a keyword-heuristic that missed most cards (e.g. topic "F-031" only matched 4 of 15 real members). Depends on `@awareness-sdk/local >= 0.5.14`.
- **Wiki sidebar Timeline now populates**: `useWikiData.loadTimelineDays` now reads the daemon's `by_day` response field (was looking for non-existent `days`/`items` fields). The Timeline group in the Wiki sidebar now shows the last 30 days of activity.
- **Timeline day detail shows real events**: Clicking a day in the Wiki sidebar used to filter `knowledge_cards` by `created_at`, but the daemon's timeline is driven by the `memories` table (session/turn/tool events). The view now displays both: events from `timelineDays[date].events` (primary) and any cards created on the same day (secondary).
- **Pseudo-topic members**: Tag-fallback topics (when no MOC cards exist) are rendered by client-side tag filtering since they have no daemon-side row. Real MOC topics go through the daemon API.

### Changed
- `wiki-types.ts` exports new `TimelineEventItem` interface; `TimelineDayItem.events` is now optional.
- `WikiContentArea.tsx` imports `DAEMON_API_BASE` for daemon REST calls.

## [0.2.1] - 2026-04-11

### Added
- **Memory UI 5-tab rewrite**: collapsed 6 tabs (Timeline/Knowledge/Self-Improvement/Graph/Conflicts/Settings) into 5 (Overview/Wiki/Graph/Sync/Settings). Wiki tab has sidebar+content architecture aligned with cloud InsightsTab and local-daemon web UI.
- **Workspace-aware Memory**: Memory page now follows the chat header's workspace selection. When you pick a project directory for chat, the daemon's projectDir is hot-swapped via `POST /workspace/switch` so cards/topics/skills/timeline reflect that workspace's isolated `.awareness/` storage. When no workspace is selected, defaults to OpenClaw global workspace (`~/.openclaw`).
- **WorkspaceIndicator header chip**: top-right of Memory page shows the current workspace name, brand blue for project workspaces vs grey for OpenClaw global.
- **App startup workspace sync**: persisted workspace from `~/.awarenessclaw/active-workspace.json` is pushed to daemon at app launch (6 retries × 5s) so cold-start daemons land on the correct projectDir.
- **Wiki components**: WikiSidebar, WikiOverviewView, WikiArticleView, WikiContentArea, useWikiData hook, wiki-types.ts.

### Changed
- Self-Improvement tab removed entirely (redundant with F-032 Skill system).
- Memory.tsx rewritten (~470 lines removed, now delegates to Wiki components).
- `workspace:set-active` IPC handler is now async — writes the persisted workspace file, then switches the daemon, then broadcasts a `workspace:changed` event to all renderers.
- New preload API: `onWorkspaceChanged(callback)` returns an unsubscribe function.

### Fixed
- Memory test suite updated: 15/15 memory tests pass with fetch mock for `useWikiData` daemon REST API calls.

## [0.2.0] - 2026-04-09

### Added
- Dynamic channel registry: new channels auto-discovered from OpenClaw runtime (no hardcode needed)
- Agent Wizard with emoji avatar picker for creating/editing agents
- Cross-channel workspace injection for consistent agent behavior
- Upgrade progress real-time feedback with taskbar/Dock progress bar
- Skill dependency installer (brew/go/node/uv) with runtime scanning
- WeChat QR ASCII art display in desktop (non-URL QR support)
- WhatsApp/Signal ASCII QR detection with debounce
- Windows NSIS installer improvements (clear residual empty dirs)
- Workspace-change confirmation toast + unit tests
- Memory page hooks refactoring (useMemoryData, useCardEvolution, useMemorySearch)
- SyncConflictPanel and CardDetail components (in progress)

### Changed
- Channel binding collapsed into "Replied by" dropdown on Channels page
- Memory page significantly simplified (~470 lines removed)
- Daemon startup console window hidden on Windows
- Channel runtime deps dynamically scanned instead of hardcoded marker map
- Agent switching now preserves current conversation

### Fixed
- Mission orchestrator events dropped due to Gateway session key prefix mismatch
- Telegram plugin grammy resolution + credential detection fallback
- Discord/Slack/QQBot channel runtime dep generalization
- Slack/LINE credential field configuration
- Default agent wizard emoji avatar
- `channels login` worker lifecycle: no longer killed by stale process cleanup
- WeChat connect performance: ~70s → ~6s via scoped-config plugin isolation

### Platform
- macOS only (Windows exe and Linux AppImage not included in this release)

## [0.1.0] - 2026-03-28

### Added
- Initial release: Electron desktop app with OpenClaw + Awareness Memory integration
- Chat with streaming, model selection, thinking levels
- Multi-channel support (WeChat, WhatsApp, Telegram, Discord, etc.)
- Memory dashboard with knowledge cards, tasks, risks
- System tray with quick actions
- Settings with security audit, usage tracking, config import/export
