# Phase 5 · L5 Mutation Testing (F-Team-Tasks)

## Goal

Verify our L2/L3 tests actually catch regressions — not just rubber-stamp the
happy path — by running Stryker mutation testing on the four core mission
modules.

## Target files

| File | Why it's core |
|---|---|
| `electron/mission/plan-schema.ts` | Runtime JSON validator — wrong narrowing silently accepts bad plans |
| `electron/mission/streaming-bridge.ts` | Gateway → MissionRunner adapter — wrong normalization silently drops tokens |
| `electron/mission/mission-runner.ts` | Orchestrator main loop — wrong branching breaks retry/cancel/idle-timeout |
| `electron/mission/awareness-bridge.ts` | Past-experience recall — wrong fallback leaks exceptions to the UI |

Planner-prompt + worker-prompt are excluded: they're 80%+ static copy. Mutating
them produces mostly equivalent mutants.

## Target mutation score

- **Hard gate:** ≥ 80% (ship-blocking)
- **Stretch:** ≥ 90% (we want to get there over time)

## How to run

```bash
cd packages/desktop
npm install --save-dev @stryker-mutator/core @stryker-mutator/vitest-runner
npx stryker run stryker.mission.conf.mjs
open reports/mutation/mission-flow.html
```

## Cadence

Quarterly or before a major release — not per PR. Expected runtime 30–60 min
on a developer laptop.

## Current status

- Config: `packages/desktop/stryker.mission.conf.mjs`
- npm script: `npm run test:mutation:mission`
- Baseline run: **pending** (requires installing Stryker dev deps; deferred to
  the first release cycle after Phase 5 lands so we don't balloon installer size).
- Last reviewed: 2026-04-17
