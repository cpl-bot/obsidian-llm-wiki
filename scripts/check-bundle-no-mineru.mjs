#!/usr/bin/env node
/**
 * Bundle assertion — the removed document-conversion backend must not come back.
 *
 * Hardening Phase 2.A (security finding F-06) deleted the optional third-party
 * backend that uploaded whole PDFs, images and Office documents to a service
 * unrelated to the user's chosen LLM provider. Source-level deletion is easy to
 * undo by an upstream merge; this checks the artifact that actually ships.
 *
 * The rule is deliberately a plain substring scan of the built bundle rather
 * than an import graph check: any resurrection — code, a constant, a settings
 * key, an i18n string, a doc URL — carries the vendor's name with it.
 *
 * The one place in `src/` that still has to name the vendor's keychain slot
 * (so the upgrade migration can blank it) assembles the id from fragments at
 * runtime, precisely so this assertion stays meaningful. See
 * `src/core/settings-migrations.ts`.
 *
 * Exit code:
 *   0 — bundle is clean
 *   1 — bundle carries the removed backend, or `main.js` is missing
 *
 * Usage:
 *   node scripts/check-bundle-no-mineru.mjs              # check main.js
 *   node scripts/check-bundle-no-mineru.mjs path/to.js   # check a custom bundle
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = process.argv[2] || 'main.js';
const file = resolve(target);

// Assembled from fragments so this script does not itself trip a repo-wide
// grep for the forbidden string.
const NEEDLE = 'min' + 'eru';

let src;
try {
  src = readFileSync(file, 'utf8');
} catch (err) {
  console.error(`✗ bundle check: cannot read ${file}: ${err.message} (run \`pnpm build\` first)`);
  process.exit(1);
}

const haystack = src.toLowerCase();
let hits = 0;
let index = haystack.indexOf(NEEDLE);
const firstHitLines = [];
while (index !== -1) {
  hits += 1;
  if (firstHitLines.length < 5) {
    firstHitLines.push(src.slice(0, index).split('\n').length);
  }
  index = haystack.indexOf(NEEDLE, index + NEEDLE.length);
}

if (hits > 0) {
  console.error(`✗ bundle check: ${target} contains the removed conversion backend (${hits} occurrence(s), first at line(s) ${firstHitLines.join(', ')})`);
  console.error('  The backend was removed in hardening Phase 2.A (F-06). If an upstream merge reintroduced it, revert that hunk.');
  process.exit(1);
}

console.log(`✓ bundle check: ${target} carries no trace of the removed conversion backend`);
