/**
 * Stryker mutation-testing config — scoped to Mission Flow core files.
 *
 * Runs quarterly (not on every PR) because mutation runs are expensive:
 * a single file with ~300 lines × ~50 mutants × vitest round = minutes.
 *
 * Target files (core correctness surface — bugs here break every mission):
 *   - electron/mission/plan-schema.ts       (JSON validator)
 *   - electron/mission/streaming-bridge.ts  (Gateway ↔ runner adapter)
 *   - electron/mission/mission-runner.ts    (orchestrator main loop)
 *   - electron/mission/awareness-bridge.ts  (past-experience injection)
 *
 * Run:
 *   npm install --save-dev @stryker-mutator/core @stryker-mutator/vitest-runner
 *   npx stryker run stryker.mission.conf.mjs
 *
 * Gate: mutation score must be ≥ 80% before S1 ships.
 */

export default {
  $schema: 'https://unpkg.com/@stryker-mutator/core/schema/stryker-schema.json',
  packageManager: 'npm',
  testRunner: 'vitest',
  reporters: ['html', 'clear-text', 'progress'],
  coverageAnalysis: 'perTest',
  mutate: [
    'electron/mission/plan-schema.ts',
    'electron/mission/streaming-bridge.ts',
    'electron/mission/mission-runner.ts',
    'electron/mission/awareness-bridge.ts',
    // Worker prompt + planner prompt are mostly constant strings — mutating
    // those produces lots of "equivalent mutants". Skip them.
  ],
  thresholds: {
    high: 90,
    low: 80,  // hard gate: S1 ships with ≥ 80% mutation score
    break: 80,
  },
  // Limit to the L2 test files that actually exercise the mutated code
  // (speeds up runs dramatically vs the full test suite).
  vitest: {
    configFile: 'vitest.config.ts',
    // Stryker's vitest runner picks up the project's vitest config; it does
    // NOT support per-file filtering natively. We rely on `coverageAnalysis:
    // perTest` + Stryker's own filtering by covered mutants to stay fast.
  },
  tsconfigFile: 'tsconfig.electron.json',
  timeoutMS: 60_000,
  disableTypeChecks: true,
  concurrency: 4,
  ignorePatterns: [
    'dist',
    'dist-electron',
    'release',
    'node_modules',
    'reports',
  ],
  htmlReporter: {
    fileName: 'reports/mutation/mission-flow.html',
  },
};
