# Gateway Health Fix Acceptance Criteria

**Issue refs**: openclaw/openclaw#48766, #63548, #66675

## Journey 1: Gateway restart appears successful despite auth rejection

- **Given** Gateway is running on port 18789 but CLI probe fails with "device-required" or "pairing-required"
- **When** Desktop app starts and calls `isGatewaySnapshotHealthy(snapshot)`
- **Then** Returns `true` (alive) because auth rejection = gateway is running
- **Assert**: `packages/desktop/src/test/gateway-health.test.ts::auth rejection on busy port treated as healthy`

## Journey 2: HTTP probe with exponential backoff handles startup window

- **Given** Gateway is booting (plugin load takes 15-30s)
- **When** Desktop calls `httpProbeWithRetry(3)` during startup
- **Then** Probe retries with 1s → 2s → 4s delays, succeeds when gateway ready
- **Assert**: `packages/desktop/src/test/gateway-health.test.ts::httpProbeWithRetry retries with backoff`

## Journey 3: Pending device requests auto-approved

- **Given** subagent connection creates new entry in `~/.openclaw/devices/pending.json`
- **When** `setupPendingDeviceWatcher()` detects the change
- **Then** Calls `tryRepairGatewayPairing()` to auto-approve with full scopes
- **Assert**: `packages/desktop/src/test/gateway-health.test.ts::pending device watcher auto-approves`

---

## Failure Modes (L3)

### HTTP Probe Failures

- **If** HTTP `/healthz` returns 502 HTML
- **Then** `httpProbe()` returns false, triggers retry
- **Assert**: `gateway-health.test.ts::httpProbe handles 5xx response`

- **If** HTTP `/healthz` times out (>3s)
- **Then** `httpProbe()` returns false, triggers retry
- **Assert**: `gateway-health.test.ts::httpProbe handles timeout`

- **If** All 3 retries fail
- **Then** Falls back to CLI `openclaw gateway status` check
- **Assert**: `gateway-health.test.ts::httpProbeWithRetry exhausts retries then falls back`

### File System Failures

- **If** `~/.openclaw/devices/` directory doesn't exist
- **Then** `setupPendingDeviceWatcher()` creates it, watcher starts
- **Assert**: `gateway-health.test.ts::pending watcher creates devices dir if missing`

- **If** `pending.json` contains invalid JSON
- **Then** Logs warning, does not crash, continues watching
- **Assert**: `gateway-health.test.ts::pending watcher handles malformed JSON`

- **If** `fs.watch()` throws (permission denied)
- **Then** Logs warning, app continues without watcher
- **Assert**: `gateway-health.test.ts::pending watcher handles watch failure gracefully`

---

## User-Visible Outcomes

| Scenario | Before Fix | After Fix |
|----------|-----------|-----------|
| Gateway restart on Windows | "Gateway restart timed out" (false negative) | Returns success if port listening |
| Subagent spawn | "pairing required" rejection | Auto-approved, subagent connects |
| App startup during gateway boot | Often fails first probe | Retries succeed after plugin load |
