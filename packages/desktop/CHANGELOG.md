# Changelog

## [0.3.7-preview.5] - 2026-04-18

### Added — startup sweep kills zombie running missions from a previous session
If AwarenessClaw was force-quit or crashed while a mission was running, the on-disk `mission.json` stayed at `status=running` forever. Users returning to Team Tasks saw permanent "任务进行中" cards whose runner was long dead.

New IPC `mission:sweep-stale` runs on MissionFlowShell mount (once per session):
1. List every mission dir on disk
2. Keep `done` / `failed` / `paused_awaiting_human` (user hasn't decided yet) untouched
3. For `running` / `planning` / `paused` missions with `startedAt` **before** this session's handler registration time — flip to `failed`, write `completedAt=now`, add `lastEvent: { type: 'sweep-stale' }`
4. Refresh the history list so the user sees the newly-failed zombies

Safety:
- **Never touches `paused_awaiting_human`** — user's pending plan decisions are sacred
- Missions from THIS session are immune (startedAt >= handlerStartedAt)
- Corrupt `mission.json` files are silently skipped (no crash)
- Empty missions dir returns `swept: 0` cleanly
- Idempotent (second sweep in same session returns 0)

### Testing — 9 new L2 tests for sweep
- Positive: old running / planning / paused missions flip to failed
- Safety: paused_awaiting_human untouched, already-terminal untouched
- Session boundary: current-session missions (startedAt >= handlerStartedAt) not swept
- Edge: missions without startedAt skipped, corrupted mission.json doesn't crash, empty dir OK
- Idempotency: second call returns 0

Totals: 366 → 375 mission-flow tests. 4 L1 guards still green. Real Gateway E2E smoke re-run → 54s, mission:done ✓.

## [0.3.7-preview.4] - 2026-04-18

### Fixed — done steps showed "(No output captured)" after tab switch
`useMissionFlow.stepStream` lives in React state, so when a user returned to a completed mission the live token buffer was gone and the Kanban card placeholder said "(No output captured)" — even though the artifact file on disk had the full markdown.
Fix: `MissionFlowShell` now auto-fetches the artifact body via `mission:read-artifact` for every `done` step whose live buffer is empty, strips the YAML frontmatter header, and displays the real content. Fetch is lazy (skipped if a live buffer already has text) and cached per mission.

### Added — "Agent is thinking" wait indicator
When an agent is running but hasn't streamed its first token yet, the card used to just say "正在启动..." with no timer — users couldn't tell if the agent was dead or just slow. New behaviour:
- Status pill now shows elapsed time after 3s (e.g. `进行中 · 32s`).
- After 10s with empty stream, a soft wait banner appears under the `<pre>`.
- After 60s the banner escalates to "大任务可能需要几分钟".
Backend idle timeout (15 min) still fires if truly stuck.

### Added — real E2E smoke script
`scripts/e2e-mission-smoke.mjs` connects to the running OpenClaw Gateway + real LLM and runs a 3-step micro-mission end-to-end. Verified on this dev box:
- 55s mission round-trip, 25 planner-delta + 85 step-delta events, `mission:done` ✓.
- Artifacts written to disk (~1.5KB each), MEMORY.md accumulated.
- Confirms the streaming / IPC pipeline is sound end-to-end with real infrastructure.

Run: `npm run build && node scripts/e2e-mission-smoke.mjs`

### Testing
- 366 mission-flow tests pass (+6 new): 5 wait-indicator tests in `kanban-card-stream.test.tsx`, 1 backfill-artifact test in `mission-flow-shell.test.tsx`.
- All 4 L1 guards still green.

## [0.3.7-preview.3] - 2026-04-18

### Fixed — Approve / Stop buttons had no effect on missions from a previous app session
Root cause: `MissionRunner`'s in-memory `missions` Map is lost on every app restart, but missions persist on disk at `~/.awarenessclaw/missions/`. When the UI restored a mission via `mission:get` (after a tab switch or app relaunch), the runner instance had no record of it — so `approveAndRun()` threw "mission not found" and `cancel()` silently early-returned. User clicked "出发 ✨" or "⏹ Stop" and **nothing happened**.

Fix:
- `MissionRunner.hydrateFromDisk(id)` (new public method) reads `mission.json` from disk and populates the in-memory Map.
- `cancel()` and `approveAndRun()` now hydrate-on-miss so a zombie mission (from a previous runner instance) can still be approved or stopped.
- `cancel()` is now idempotent on already-terminal missions (`done` / `failed` → no double-emit).
- `getMission()` transparently falls back to disk, so any code path that queries the runner always sees a consistent view with what's persisted.
- IPC handler `mission:cancel-flow` uses `ensureRunner()` instead of a raw null-check — used to return `"no active runner"` if the user hit Stop before the runner was lazy-initialized.

### Testing
- 360 mission-flow tests pass (+6 new): 4 zombie-mission chaos tests in `mission-failure-chaos.test.ts` + 2 IPC hydrate tests in `register-mission-handlers.test.ts`.
- All 4 L1 guards still green.

## [0.3.7-preview.2] - 2026-04-18

### Fixed — user cannot leave / interrupt a running mission
- **Planning stage now has a Cancel / Return button**: the "思考中..." / "Thinking..." screen was a dead-end — no way to back out. Added `planner-cancel` button in the Planner-stream header that calls `actions.cancel()` + `actions.reset()` to abort the gateway run and return to the composer.
- **Running stage now has a Stop button**: the Kanban header shows a red "⏹ Stop" button while the mission is running. Clicking it calls the Gateway's `chat.abort` on the active worker session and flips mission status to `failed`. The old "New mission" link still resets the UI without stopping the backend run (for users who want to start something else in parallel), but Stop is the right action to actually halt an agent.
- **Planner streaming "Thinking…" never filled in**: root-caused to a React ref/state race — `useMissionFlow.isCurrent()` required `activeIdRef.current === id`, but `activeIdRef` only updates in an effect after the `setMissionId()` commit, so the first few `planner-delta` IPC events arrived before the ref was set and got dropped. Fix: clear the ref synchronously before creating, and set it synchronously right after the IPC resolves; `isCurrent` now also accepts events when the ref is still null.

### Added — default model display in Composer
- MissionComposer shows the Planner's default model (read from main agent's `model` config in openclaw.json) so users see "🤖 Model: qwen-turbo" before hitting "Let's go ✨". Model is not editable here — it's shared with the Chat page's default, changed in Settings.

### Testing
- Mission Flow tests: 354 → all green. New: planner-cancel button tests (2), Stop button visibility + cancel wire tests (3), defaultModel display tests (2).
- All 4 L1 guards still green.

## [0.3.7-preview.1] - 2026-04-18

### Fixed — Team Tasks UI regressions (same-night hotfix)
- **Two input boxes on the Team Tasks page**: the legacy `goalInput` textarea + workspace chip + MissionCard lists are gone. The new `MissionComposer` (big "What would you like your team to do today?" box) is now the only goal input. New L1 guard `verify:no-legacy-goalinput` prevents regression.
- **Kanban + mission state lost on tab switch**: `useMissionFlow` now persists `activeMissionId` to localStorage and restores the whole stage (plan / running / done) on remount via `mission:get`. Switch to Memory tab and back — your live kanban is still there.
- **Past missions were invisible**: new `MissionHistoryList` component reads `mission:list` and shows every persisted mission from `~/.awarenessclaw/missions/` under the composer. Click a card to re-open (jumps to the right stage automatically); hover + click trash to delete.
- **Planner routed every subtask to `main`**: `buildPlannerPrompt` now includes a `<RoutingRules>` section that explicitly forbids routing every subtask to the same agent when 2+ agents are available, and tells the LLM to match agent role → subtask type. Single-agent teams relax the rule but still ask for varied roles (Designer / Developer / Tester) across subtasks.
- **Agent count < 2 warning**: `MissionComposer` shows a yellow banner + "➕ Add a teammate" link when only one agent exists. Link jumps to the Agents page via `onNavigate('agents')`. Soft warning — doesn't block submitting.
- **Pre-existing `parsed.errors` TS narrowing bug** (blocked `npm run build`): fixed with explicit `parsed.ok === false` guard in `mission-runner.ts`.

### Added — MissionComposer workspace + team preview
- Composer now shows the working-directory chip with basename + × clear, and the current team as agent avatar chips with a total count. Work dir chip opens a native folder picker on the main process.

### Testing
- Mission Flow tests: 319 → 361 (+42). New files: `mission-history-list.test.tsx` (9), expanded `mission-composer.test.tsx` (+6 workdir/team/warn tests), expanded `use-mission-flow.test.tsx` (+6 restore/reopen tests), expanded `mission-planner-prompt.test.ts` (+5 multi-agent tests).
- L1 guards: 3 → 4. New `verify-no-legacy-goalinput.mjs`. `npm run verify:mission-all` runs all four.
- Legacy `src/test/mission-integration.test.tsx` removed (tested the UI path that no longer exists; new `mission-integration.test.ts` covers the replacement MissionFlow path).

## [Unreleased]

### Added — Team Tasks Mission Flow (F-Team-Tasks · Phase 4 + 5)
- **"Team Tasks" gets a big goal box**: describe a goal in plain words ("Build me a TODO app with React and localStorage"), the team plans the steps, you click **Let's go ✨**, each sub-agent runs and streams its thinking live into a kanban card. No command line, no JSON, no clicking around 5 menus.
- **Plan preview gate**: before any sub-agent runs, you see the plan (agents, roles, expected minutes). Click **Edit plan** to tweak the raw JSON for power users. Click **Cancel** to throw it away. Nothing runs until you approve.
- **Streaming everywhere**: the planner's output + each worker's tokens stream into the UI as they arrive. No more "stare at a spinner for 3 minutes" UX.
- **One reset button**: "New mission" wipes the board and opens the composer for the next idea — no menu diving.
- **Friendly error text**: timeouts, agent crashes, permission denials all map to plain-language messages ("An agent stopped responding. Try again or rephrase your goal") instead of raw error codes.
- **Full en/zh i18n**: every new string in Simplified Chinese too.

### Testing — L1 through L5 pyramid delivered
- **319 tests** covering the whole Mission Flow (up from 189): 18 new test files for IPC handlers, React components, the `useMissionFlow` hook, 22 chaos scenarios (malformed payloads, idle-timeout auto-abort, burst 2000 deltas < 2s, awareness daemon offline, planner JSON with cycles / forbidden fields / < 3 subtasks, etc.), and end-to-end integration across `file-layout` + `plan-schema` + `planner-prompt` + `mission-runner` + `streaming-bridge` + `awareness-bridge`.
- **3 new L1 contract guards** (`npm run verify:mission-all`): IPC channel parity between main/preload/renderer, streaming `chunk` field end-to-end, planner-example JSON validates against the plan-schema validator.
- **3 Playwright-style L4 E2E specs** (zero-mock, real Gateway + real LLM): happy path, approval gate, cancel flow. Run with `npm run build && node --test test/e2e/user-journeys/mission-*.test.mjs`.
- **Stryker mutation config** in `stryker.mission.conf.mjs`, 80 %-mutation-score hard gate on the four core correctness files (plan-schema, streaming-bridge, mission-runner, awareness-bridge); quarterly cadence.

## [0.3.6] - 2026-04-18

### Fixed — Gateway crash prevention (auto-patch)
- **Plugin spawn error handler auto-fix**: Doctor now detects and automatically patches the `openclaw-memory` plugin when it lacks error handlers on spawn calls. Without this fix, `spawn("npx", ...)` throws uncaught ENOENT on Windows scheduled tasks (where PATH doesn't include npx), crashing the entire Gateway with "OpenClaw could not start the local helper runtime". The auto-fix adds `child.on("error", () => {});` before `child.unref();` — Gateway stays stable even if the daemon spawn fails.
- **New Doctor check `plugin-spawn-handler`**: runs after `plugin-installed`, checks for vulnerable `child.unref()` without preceding error handler, auto-fixable via Settings → Health → Fix All.

### Fixed — memory daemon restart loop
- **Daemon watchdog no longer crashes into EADDRINUSE forever**: if `/healthz` fails but port 37800 is still held by a dead daemon (the socket outlives the crashed process), the watchdog now runs `lsof -ti :37800` / `netstat -ano` first, kills orphans, then respawns. After repeated failures (corrupt npx cache, etc.) it backs off exponentially (60 s → 30 min cap) instead of burning CPU.
- **Auto-fix toast no longer fires on every Memory tab mount**: pre-fix, clicking the Memory tab triggered `openclaw:auto-fix-if-needed` every time because the guard ref was per-component-instance (React unmounts/remounts on tab switch). Users saw "Checking memory system health..." + "OpenClaw memory plugin was missing and has been reinstalled" repeating. The handler now memoizes its result per app launch (one real check, all subsequent calls return the cached result) and the Memory page has stopped calling it entirely — App-level startup check in App.tsx is now the single trigger. Healthy-state toast is completely silent.
- **Plugin presence check moved from CLI to filesystem**: `openclaw plugins list` was unreliable in packaged Electron builds (PATH inheritance, 10 s+ CLI load times, timeouts under CPU pressure all reported false "missing"). Replaced with `fs.existsSync(~/.openclaw/extensions/openclaw-memory/package.json)` — instant, deterministic, no shell exec.
- **Auto-fix "reinstalled" claim is now truthful**: previously reported `fixed: true` immediately after kicking off `npm run fix-openclaw`, regardless of whether the fix actually worked. Now re-checks fs presence post-install and only claims fixed when the plugin directory really exists.

### Security / Distribution
- **Signed + notarized DMG**: builds are code-signed with Developer ID Application (Beijing VGO Co;Ltd, Team 5XNDF727Y6) and notarized via Apple notary service (keychain profile `AwarenessClawNotary`, staple ticket embedded). Users no longer see any Gatekeeper warning on first launch — double-click to open.
- **Hardened runtime + entitlements**: `build/entitlements.mac.plist` grants only what Electron + openclaw child processes actually need (JIT, unsigned-executable-memory for V8, library-validation-disable for the daemon spawn, network client/server, user-selected file read/write).

### Paired with @awareness-sdk/local@0.7.2
The daemon regression that produced "no such column: local_id" log flood and broken memory UI is fixed in `@awareness-sdk/local@0.7.2`. AwarenessClaw 0.3.6 watchdog auto-upgrades users to that daemon version on next start; old `index.db` files heal themselves via idempotent migration on first open.

## [0.3.5] - 2026-04-16

### Fixed
- **Agent identity update instant**: set-identity no longer spawns OpenClaw CLI (was 15-60s, froze the machine) — writes directly to `openclaw.json`, instant response
- **Memory loading timeout**: loading spinner now auto-dismisses after 15s with a helpful message if the local daemon is slow to start
- **Memory project isolation**: all daemon HTTP requests now include `X-Awareness-Project-Dir` header, ensuring memory is scoped to the active workspace

### Added
- L2/L3 tests: project isolation header injection + chaos scenarios
- L2 tests: KanbanBoard, MissionCard, MissionDetail, TaskCreateModal components
- L1 contract guard: `verify-project-header.mjs`

## [0.3.4] - 2026-04-16

### Fixed
- **Gateway WS scope fallback**: OpenClaw 4.14 write scopes rejected by Gateway 4.10 no longer cause infinite reconnect loop — gracefully falls back to read-only scopes, chat still works
- **Models page: legacy custom model pollution**: duplicate model entries across refresh cycles eliminated; legacy custom IDs tracked separately from session-added models
- **Models page: unwanted auto-save**: background endpoint validation no longer silently overrides user's intentional model selection
- **Models: cross-vendor pollution**: provider affinity matching hardened, mixed-vendor models shown as opt-in only
- **Windows uninstaller cleanup**: tray instances + OpenClaw/daemon residual processes now killed during uninstall, preventing `.openclaw` folder lock on reinstall

### Added
- **Setup wizard refactored**: monolithic Setup.tsx split into CloudAuthStep + WorkspaceStep components for maintainability
- Setup step i18n translations
- L1 contract guard: `verify-setup-steps.mjs`
- L2 tests: CloudAuthStep, WorkspaceStep, SetupWizard flow, protocol whitelist
- Dashboard model switcher labels with provider CTA
- CLAUDE.md: 5-layer testing pyramid rules for AwarenessClaw

## [0.3.3] - 2026-04-14

### Fixed
- **CLI/Gateway version mismatch auto-repair**: detects when the running gateway bundle is older than the installed `openclaw` CLI (e.g. after `npm install -g openclaw` upgrades the binary but LaunchAgent/systemd unit still references the old path). When mismatch is detected on startup, silently runs `openclaw gateway install --force` to regenerate the service unit pointing at the new bundle. No hardcoded version comparisons — pure dynamic `openclaw --version` vs `OPENCLAW_SERVICE_VERSION` env, repaired only when CLI > Gateway. 5-minute cooldown prevents hot loops.
- Root cause for "Connecting to local Gateway..." on every chat: stuck gateway with 2026.3.8 self-induced restart loop bug (openclaw#58620), unaware CLI had already moved past it. Auto-repair closes the gap.

### Performance
- Version detection is fire-and-forget at app startup (~860ms total: lsof 133ms + pgrep 171ms + `openclaw --version` 559ms) and does NOT block UI.

## [0.3.2] - 2026-04-14

### Fixed (Critical)
- **Gateway detection was broken on macOS** (caused chat hangs / repeat spawn): v0.3.1 used `pgrep -af "gateway.*run"` to find running gateways, but macOS `pgrep` doesn't support the `-a` flag (it silently returns PIDs only) AND LaunchAgent-managed gateways rename their process to `openclaw-gateway` with no "run" in argv. Result: the detection never found real gateways, chat would either hang waiting or spawn a competing instance.
- Switched to **port ownership** as the source of truth (`lsof -tiTCP:18789` on macOS/Linux, `netstat -ano` on Windows). If port 18789 has an owner, the gateway is up — no ambiguity.
- Zombie cleanup now uses cross-platform `pgrep -f "openclaw"` + per-PID `ps -p <pid> -o args=` confirmation, plus a `isOpenClawGatewayPid` safety check that verifies the path before SIGKILL. Will never kill the port owner or unrelated processes.

### Verified
- Live end-to-end test against actual running gateway (LaunchAgent + renamed process) confirms detection works on macOS.
- Web-searched OpenClaw issues #21073, #19521, #46012, #47916 to confirm LaunchAgent/systemd supervision behavior.

## [0.3.1] - 2026-04-14

### Fixed
- **Zombie gateway processes auto-cleanup**: When a previous OpenClaw gateway crashed mid-startup or was orphaned (process alive but not bound to port 18789), the app would incorrectly treat it as "healthy" and skip starting a real gateway, causing chat to hang. Now detects and SIGKILLs zombie gateway PIDs before spawning a fresh instance.
- Test isolation: enabled `fileParallelism: false` in vitest to eliminate cross-file state races (localStorage / window.electronAPI). Previously 4 models.test.tsx tests failed intermittently under parallel execution.

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
