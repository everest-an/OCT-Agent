#!/usr/bin/env node

/**
 * OCT-Agent CLI — One-click setup for OpenClaw with Awareness memory
 *
 * Usage:
 *   npx @awareness.market/claw           # Interactive setup wizard
 *   npx @awareness.market/claw --help    # Show help
 *   npx @awareness.market/claw --api-key aw_xxx --memory-id xxx  # Non-interactive
 */

import { main } from '../src/index.mjs';

main(process.argv.slice(2)).catch((err) => {
  console.error('\n❌ OCT-Agent setup failed:', err.message);
  process.exit(1);
});
