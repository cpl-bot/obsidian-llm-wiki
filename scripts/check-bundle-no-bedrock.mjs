#!/usr/bin/env node
/**
 * Bundle assertion — the removed cloud-provider auth surface must not come back.
 *
 * Hardening Phase 2.B deleted the AWS Bedrock SSO/IAM provider: a hand-rolled
 * IAM Identity Center OIDC device flow, a hand-rolled SigV4 request signer,
 * two SecretStorage credential stores, and the two `bedrock-*` provider ids
 * that drove them. What made it worth removing is not the code size but the
 * blast radius of what it minted: an SSO session token and a set of role
 * credentials are cloud-account credentials, not an LLM API key, and the
 * whole path was verified against a real AWS account for only three of its
 * constants. Source-level deletion is easy to undo by an upstream merge;
 * this checks the artifact that actually ships.
 *
 * The rule is deliberately a plain substring scan of the built bundle rather
 * than an import-graph check: any resurrection — code, a constant, a settings
 * key, an i18n string, a doc URL — carries the vendor's name, one of its two
 * hostname suffixes, or the name of its signing algorithm with it. Both suffixes are checked alongside the
 * vendor name because a URL is exactly what survives a code purge: the SSO
 * portal placeholder lived only in a translated settings description, and
 * `*.awsapps.com` is a namespace anyone can self-register under, so a single
 * surviving literal there is a ready-made allowlisted destination.
 *
 * The one place in `src/` that still has to name the vendor (so the upgrade
 * migration can recognise its settings keys, its provider ids and its two
 * keychain slots) assembles every one of those strings from fragments at
 * module load, precisely so this assertion stays meaningful. See
 * `src/core/settings-migrations.ts`.
 *
 * No retained provider's model catalog contains any of these needles, so a
 * hit is always a resurrection and never a false positive.
 *
 * Exit code:
 *   0 — bundle is clean
 *   1 — bundle carries the removed provider, or `main.js` is missing
 *
 * Usage:
 *   node scripts/check-bundle-no-bedrock.mjs              # check main.js
 *   node scripts/check-bundle-no-bedrock.mjs path/to.js   # check a custom bundle
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = process.argv[2] || 'main.js';
const file = resolve(target);

// Assembled from fragments so this script does not itself trip a repo-wide
// grep for the forbidden strings.
const NEEDLES = [
  'bed' + 'rock',
  'amazon' + 'aws.com',
  'aws' + 'apps.com',
  // The signing algorithm's own name. The signer is the one piece of the
  // removed surface that carries no vendor name and no hostname of its own
  // — a re-merged `sigv4.ts` would satisfy the three needles above while
  // shipping the credential-signing code itself, so it gets its own.
  'sig' + 'v4',
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

for (const needle of NEEDLES) {
  let hits = 0;
  const firstHitLines = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    hits += 1;
    if (firstHitLines.length < 5) {
      firstHitLines.push(src.slice(0, index).split('\n').length);
    }
    index = haystack.indexOf(needle, index + needle.length);
  }
  if (hits > 0) {
    failed = true;
    console.error(`✗ bundle check: ${target} contains the removed provider surface (${hits} occurrence(s) of a forbidden needle, first at line(s) ${firstHitLines.join(', ')})`);
  }
}

if (failed) {
  console.error('  The AWS provider surface was removed in hardening Phase 2.B. If an upstream merge reintroduced it, revert that hunk.');
  console.error('  If a retained provider legitimately needs one of these strings, it must be justified in the hardening plan first — a hostname');
  console.error('  under a self-registrable suffix is never acceptable in the shipped bundle.');
  process.exit(1);
}

console.log(`✓ bundle check: ${target} carries no trace of the removed provider surface`);
