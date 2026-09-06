#!/usr/bin/env node
/**
 * Bundle assertion — the removed ChatGPT-subscription OAuth provider must not
 * come back.
 *
 * Hardening Phase 2.B deleted the provider that ran a loopback HTTP listener on
 * the user's machine to catch an OAuth callback, drove a device-code flow, and
 * sent every completion to a backend unrelated to the documented API surface.
 * Source-level deletion is easy to undo by an upstream merge; this checks the
 * artifact that actually ships.
 *
 * Why three needles rather than the single vendor name (the shape
 * `check-bundle-no-mineru.mjs` uses):
 *
 *   The bundled `@ai-sdk/openai` dependency legitimately ships MODEL IDS that
 *   contain the vendor's name — `gpt-5-codex`, `gpt-5.1-codex-max`,
 *   `gpt-5.3-codex` and friends appear in its model-id union and its JSDoc.
 *   Those are OpenAI Platform models reachable with an ordinary API key; they
 *   have nothing to do with the removed OAuth surface, and the plugin cannot
 *   drop them without vendoring the SDK. A bare `codex` needle would therefore
 *   fail on a clean tree.
 *
 *   So the assertion names the three strings that identify the removed surface
 *   and nothing else:
 *
 *     - `chatgpt.com`      — the completions/model-catalogue backend it called
 *     - `auth.openai.com`  — the OAuth issuer, token and device endpoints
 *     - `openai-codex`     — the provider id, its settings keys and its module
 *                            path; the one thing a re-merge cannot avoid
 *                            reintroducing
 *
 *   The two hosts are also removed from `src/core/egress-hosts.json`, so a
 *   resurrection would have to defeat this check AND `check:bundle-hosts`.
 *
 * The one place in `src/` that still has to name the provider's keychain slot
 * (so the upgrade migration can blank it) assembles the id from fragments at
 * runtime, precisely so this assertion stays meaningful. See
 * `src/core/settings-migrations.ts`. The migration marker
 * `_migrated_harden_codex_removed` does carry the vendor name — it is the
 * on-disk key that tells an upgraded install the scrub already ran, so it
 * cannot be renamed without replaying the migration; that is the other reason
 * a bare `codex` needle is not usable here.
 *
 * Exit code:
 *   0 — bundle is clean
 *   1 — bundle carries the removed provider, or `main.js` is missing
 *
 * Usage:
 *   node scripts/check-bundle-no-codex.mjs              # check main.js
 *   node scripts/check-bundle-no-codex.mjs path/to.js   # check a custom bundle
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = process.argv[2] || 'main.js';
const file = resolve(target);

/**
 * Assembled from fragments so this script does not itself trip a repo-wide
 * grep for the forbidden strings.
 */
const VENDOR = 'cod' + 'ex';
const NEEDLES = [
  { needle: 'chat' + 'gpt.com', what: 'the removed provider\'s backend host' },
  { needle: 'auth.' + 'openai.com', what: 'the removed provider\'s OAuth issuer' },
  { needle: 'openai-' + VENDOR, what: 'the removed provider id' },
];

let src;
try {
  src = readFileSync(file, 'utf8');
} catch (err) {
  console.error(`✗ bundle check: cannot read ${file}: ${err.message} (run \`pnpm build\` first)`);
  process.exit(1);
}

const haystack = src.toLowerCase();
let failed = false;

for (const { needle, what } of NEEDLES) {
  let hits = 0;
  const firstHitLines = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    hits += 1;
    if (firstHitLines.length < 5) firstHitLines.push(src.slice(0, index).split('\n').length);
    index = haystack.indexOf(needle, index + needle.length);
  }
  if (hits > 0) {
    failed = true;
    console.error(`✗ bundle check: ${target} contains ${what} (${hits} occurrence(s), first at line(s) ${firstHitLines.join(', ')})`);
  }
}

if (failed) {
  console.error('');
  console.error('  The ChatGPT-subscription OAuth provider was removed in hardening Phase 2.B.');
  console.error('  If an upstream merge reintroduced it, revert that hunk. If a dependency now');
  console.error('  ships one of these strings for an unrelated reason, verify it is genuinely');
  console.error('  unreachable before narrowing this check.');
  process.exit(1);
}

console.log(`✓ bundle check: ${target} carries no trace of the removed OAuth provider`);
