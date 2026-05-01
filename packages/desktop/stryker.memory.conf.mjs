/**
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 *
 * L5 Mutation Testing configuration for OCT-Agent memory save.
 *
 * Run: npx stryker run stryker.memory.conf.mjs
 * Target: ≥ 80% mutation score on memory-related files.
 */
export default {
  packageManager: 'npm',
  reporters: ['html', 'clear-text', 'progress'],
  testRunner: 'vitest',
  vitest: {
    configFile: 'vite.config.ts',
  },
  mutate: [
    'electron/ipc/awareness-memory-utils.ts',
    'electron/memory-client.ts',
  ],
  // Only run memory-related tests (fast feedback)
  commandRunner: {
    command: 'npx vitest run src/test/memory-save-integration.test.ts src/test/memory-save-chaos.test.ts --reporter=default',
  },
  thresholds: {
    high: 90,
    low: 80,
    break: 80,
  },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
};
