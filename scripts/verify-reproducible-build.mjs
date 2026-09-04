#!/usr/bin/env node
/**
 * verify-reproducible-build — assert that two builds of the same tree produce
 * byte-identical output.
 *
 * Why (HARDENING-PLAN Phase 6.5, finding F-01): the plugin's whole
 * supply-chain story rests on a user being able to rebuild `main.js` from a
 * tag and compare it to the released artifact. `actions/attest-build-provenance`
 * proves the artifact came out of this repository's CI; it says nothing about
 * whether the source that went in is the source you read. The hash comparison
 * is what says that — and it only means anything if the build is deterministic
 * in the first place. A single embedded timestamp turns "the hashes differ"
 * from a security finding into background noise, and once it is noise nobody
 * checks it again.
 *
 * This runs the real production build twice and compares the sha256 of the two
 * outputs. It does not try to be clever about *why* they differ: the report
 * prints both digests and both sizes, and the first differing byte offset,
 * which is enough to point at the cause.
 *
 * Side effect worth knowing: the build writes to `main.js` (the outfile is
 * fixed in `esbuild.config.mjs`), so this script leaves a fresh PRODUCTION
 * build on disk. It deliberately does not restore whatever was there before —
 * putting a stale artifact back would be a worse outcome than replacing a dev
 * build the caller can regenerate with `pnpm build:dev`.
 *
 * Usage:
 *   node scripts/verify-reproducible-build.mjs
 *
 * Exit codes: 0 = identical, 1 = digests differ, 2 = a build failed.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/**
 * Lowercase hex sha256 of a buffer or string.
 *
 * @param {Buffer | string} data
 * @returns {string}
 */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Offset of the first differing byte between two buffers, or -1 when the
 * common prefix is identical (which, for equal-length buffers, means they are
 * equal). Pure.
 *
 * @param {Buffer | Uint8Array} a
 * @param {Buffer | Uint8Array} b
 * @returns {number}
 */
export function firstDifferenceOffset(a, b) {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : shared;
}

/**
 * Compare two named digests. Pure — the single decision point this script and
 * `verify-release.mjs` both rely on, so it is unit-tested rather than trusted.
 *
 * Comparison is case-insensitive on the hex (`sha256sum` and Node both emit
 * lowercase, but a digest pasted from a release page may not be) and tolerant
 * of surrounding whitespace, because the value often arrives from a file or a
 * shell pipeline. It is NOT tolerant of a missing or empty digest: an absent
 * hash must never read as a match.
 *
 * @param {{ label: string, digest: string }} left
 * @param {{ label: string, digest: string }} right
 * @returns {{ match: boolean, left: string, right: string, reason: string }}
 */
export function compareDigests(left, right) {
  const a = String(left?.digest ?? '').trim().toLowerCase();
  const b = String(right?.digest ?? '').trim().toLowerCase();

  if (a === '' || b === '') {
    return {
      match: false,
      left: a,
      right: b,
      reason: `missing digest (${left?.label ?? 'left'}=${a || '<empty>'}, ${right?.label ?? 'right'}=${b || '<empty>'})`,
    };
  }
  if (a === b) {
    return { match: true, left: a, right: b, reason: 'identical' };
  }
  return {
    match: false,
    left: a,
    right: b,
    reason: `${left?.label ?? 'left'} != ${right?.label ?? 'right'}`,
  };
}

/**
 * Parse the digest for `fileName` out of a `sha256sum`-format manifest
 * (`<hex>  <name>` per line, two spaces for binary mode, one for text mode).
 * Returns null when the file is not listed. Pure.
 *
 * @param {string} text
 * @param {string} fileName
 * @returns {string | null}
 */
export function digestFromSha256Sums(text, fileName) {
  for (const line of String(text).split('\n')) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match && match[2] === fileName) return match[1].toLowerCase();
  }
  return null;
}

/**
 * Run the production build once and return the sha256 of the artifact, after
 * copying it somewhere the next build cannot overwrite.
 *
 * @param {string} keepAt absolute path to copy `main.js` to
 * @returns {{ digest: string, bytes: Buffer }}
 */
function buildOnce(keepAt) {
  const result = spawnSync(process.execPath, ['esbuild.config.mjs', 'production'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) {
    console.error(`\nBuild failed (exit ${result.status}). Cannot judge reproducibility.`);
    process.exit(2);
  }
  const outfile = join(REPO_ROOT, 'main.js');
  copyFileSync(outfile, keepAt);
  const bytes = readFileSync(keepAt);
  return { digest: sha256Hex(bytes), bytes };
}

function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'repro-build-'));
  try {
    console.log('Build 1/2 ...');
    const first = buildOnce(join(scratch, 'main.1.js'));
    console.log(`  sha256 ${first.digest}  (${first.bytes.length} bytes)`);

    console.log('Build 2/2 ...');
    const second = buildOnce(join(scratch, 'main.2.js'));
    console.log(`  sha256 ${second.digest}  (${second.bytes.length} bytes)`);

    const verdict = compareDigests(
      { label: 'build-1', digest: first.digest },
      { label: 'build-2', digest: second.digest },
    );

    if (verdict.match) {
      console.log('\nReproducible: two builds of this tree are byte-identical.');
      return 0;
    }

    const offset = firstDifferenceOffset(first.bytes, second.bytes);
    console.error('\nNOT reproducible — two builds of the same tree differ.');
    console.error(`  build-1 ${verdict.left}  (${first.bytes.length} bytes)`);
    console.error(`  build-2 ${verdict.right}  (${second.bytes.length} bytes)`);
    if (offset >= 0) {
      console.error(`  first differing byte at offset ${offset}`);
    }
    console.error(
      '\nSomething in the build embeds run-varying data (a timestamp, a path, a\n' +
      'random id). Find it and remove it, or derive it from SOURCE_DATE_EPOCH.\n' +
      'Until this is green, a released main.js cannot be verified against a\n' +
      'local rebuild (HARDENING-PLAN F-01).',
    );
    return 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
