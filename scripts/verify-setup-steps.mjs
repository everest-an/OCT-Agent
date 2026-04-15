#!/usr/bin/env node
/**
 * L1 Static Guard — Setup.tsx step machine completeness
 *
 * Verifies that:
 * 1. All 7 canonical step names are present in Setup.tsx `type Step = ...`
 * 2. Each step name has a corresponding JSX block `{step === '<stepName>'`
 * 3. `WorkspaceStep` and `CloudAuthStep` components are imported
 * 4. All setup.workspace.* and setup.cloudauth.* i18n keys exist in i18n.ts
 *
 * Exit 0 = all checks pass. Exit 1 = at least one check failed.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const SETUP_FILE = resolve(root, 'packages/desktop/src/pages/Setup.tsx');
const I18N_FILE = resolve(root, 'packages/desktop/src/lib/i18n.ts');

const REQUIRED_STEPS = ['welcome', 'installing', 'model', 'workspace', 'memory', 'cloudauth', 'done'];

const REQUIRED_I18N_KEYS = [
  'setup.workspace.title',
  'setup.workspace.subtitle',
  'setup.workspace.current',
  'setup.workspace.change',
  'setup.workspace.privacy',
  'setup.workspace.confirm',
  'setup.workspace.skip',
  'setup.cloudauth.title',
  'setup.cloudauth.body',
  'setup.cloudauth.enter_code',
  'setup.cloudauth.reopen',
  'setup.cloudauth.waiting',
  'setup.cloudauth.cancel',
  'setup.cloudauth.retry',
  'setup.cloudauth.select_title',
  'setup.cloudauth.confirm',
];

const REQUIRED_COMPONENT_IMPORTS = ['WorkspaceStep', 'CloudAuthStep'];

let pass = true;
const failures = [];

function fail(msg) {
  pass = false;
  failures.push(msg);
}

// Read files
const setupSrc = readFileSync(SETUP_FILE, 'utf8');
const i18nSrc = readFileSync(I18N_FILE, 'utf8');

// 1. Check Step type contains all canonical steps
const stepTypeMatch = setupSrc.match(/type Step\s*=\s*([^;]+);/s);
if (!stepTypeMatch) {
  fail('Could not find `type Step = ...` in Setup.tsx');
} else {
  for (const s of REQUIRED_STEPS) {
    if (!stepTypeMatch[1].includes(`'${s}'`)) {
      fail(`Step type is missing '${s}'`);
    }
  }
}

// 2. Check each step has a JSX conditional render block
for (const s of REQUIRED_STEPS) {
  const pattern = new RegExp(`\\{step === '${s}'`);
  if (!pattern.test(setupSrc)) {
    fail(`No JSX render block found for step '${s}' — missing: {step === '${s}'`);
  }
}

// 3. Check component imports
for (const comp of REQUIRED_COMPONENT_IMPORTS) {
  const pattern = new RegExp(`import\\s+${comp}\\s+from`);
  if (!pattern.test(setupSrc)) {
    fail(`Missing import for ${comp} in Setup.tsx`);
  }
}

// 4. Check all required i18n keys in both EN and ZH sections
// We just check the flat key appears at least once (both locales use the same key string)
for (const key of REQUIRED_I18N_KEYS) {
  const count = (i18nSrc.match(new RegExp(`'${key.replace('.', '\\.')}': `, 'g')) || []).length;
  if (count === 0) {
    fail(`i18n key '${key}' not found in i18n.ts`);
  } else if (count < 2) {
    fail(`i18n key '${key}' found only ${count} time(s) — expected both EN and ZH locales`);
  }
}

// --- Report ---
if (pass) {
  console.log(`✅ verify-setup-steps: ALL CHECKS PASS`);
  console.log(`   Steps: ${REQUIRED_STEPS.join(' → ')}`);
  console.log(`   Imports: ${REQUIRED_COMPONENT_IMPORTS.join(', ')}`);
  console.log(`   i18n keys: ${REQUIRED_I18N_KEYS.length} covered`);
  process.exit(0);
} else {
  console.error(`❌ verify-setup-steps FAILED (${failures.length} issue(s)):`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
