/**
 * Tests for the pure helpers in `scripts/verify-reproducible-build.mjs`
 * (HARDENING-PLAN Phase 6.5 — F-01 detection).
 *
 * The script's I/O half (spawn esbuild twice, hash the outputs) is exercised
 * by `pnpm check:reproducible` itself. What is worth unit-testing is the
 * decision point: `compareDigests` is the single function that decides whether
 * a release matches a rebuild, and it is shared with `verify-release.mjs`. A
 * comparison that returns "match" for an empty or missing digest would make
 * both checks report success while proving nothing — the exact failure mode a
 * verification tool must not have.
 */

import { describe, it, expect } from 'vitest';
import {
  compareDigests,
  digestFromSha256Sums,
  firstDifferenceOffset,
  sha256Hex,
} from '../../../scripts/verify-reproducible-build.mjs';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('sha256Hex', () => {
  it('produces the known digest of the empty input', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('agrees for a string and its byte-identical buffer', () => {
    expect(sha256Hex('main.js')).toBe(sha256Hex(Buffer.from('main.js', 'utf8')));
  });
});

describe('compareDigests', () => {
  it('matches two identical digests', () => {
    const verdict = compareDigests({ label: 'build-1', digest: A }, { label: 'build-2', digest: A });
    expect(verdict.match).toBe(true);
    expect(verdict.reason).toBe('identical');
  });

  it('does not match two different digests, and names both sides', () => {
    const verdict = compareDigests({ label: 'released', digest: A }, { label: 'rebuilt', digest: B });
    expect(verdict.match).toBe(false);
    expect(verdict.reason).toBe('released != rebuilt');
    expect(verdict.left).toBe(A);
    expect(verdict.right).toBe(B);
  });

  it('ignores case and surrounding whitespace, which a pasted hash carries', () => {
    const verdict = compareDigests(
      { label: 'released', digest: `  ${A.toUpperCase()}\n` },
      { label: 'rebuilt', digest: A },
    );
    expect(verdict.match).toBe(true);
  });

  it('never reports a match when a digest is empty', () => {
    for (const empty of ['', '   ', '\n']) {
      const verdict = compareDigests(
        { label: 'released', digest: empty },
        { label: 'rebuilt', digest: A },
      );
      expect(verdict.match).toBe(false);
      expect(verdict.reason).toContain('missing digest');
    }
  });

  it('never reports a match when a digest is absent entirely', () => {
    expect(compareDigests({ label: 'a', digest: undefined as unknown as string }, { label: 'b', digest: A }).match)
      .toBe(false);
    expect(compareDigests({ label: 'a', digest: A }, { label: 'b', digest: null as unknown as string }).match)
      .toBe(false);
  });

  it('does not report a match when both sides are empty', () => {
    // Two missing hashes are not agreement; without this the check would pass
    // on a release with no artifact at all.
    expect(compareDigests({ label: 'a', digest: '' }, { label: 'b', digest: '' }).match).toBe(false);
  });
});

describe('firstDifferenceOffset', () => {
  it('returns -1 for identical buffers', () => {
    expect(firstDifferenceOffset(Buffer.from('abc'), Buffer.from('abc'))).toBe(-1);
  });

  it('points at the first differing byte', () => {
    expect(firstDifferenceOffset(Buffer.from('abcd'), Buffer.from('abXd'))).toBe(2);
  });

  it('points at the truncation point when one buffer is a prefix of the other', () => {
    expect(firstDifferenceOffset(Buffer.from('abc'), Buffer.from('abcdef'))).toBe(3);
  });
});

describe('digestFromSha256Sums', () => {
  const manifest = `${A}  main.js\n${B}  styles.css\n`;

  it('reads the digest for a named file', () => {
    expect(digestFromSha256Sums(manifest, 'main.js')).toBe(A);
    expect(digestFromSha256Sums(manifest, 'styles.css')).toBe(B);
  });

  it('returns null for a file the manifest does not list', () => {
    expect(digestFromSha256Sums(manifest, 'manifest.json')).toBeNull();
  });

  it('accepts the binary-mode `*name` form and single-space text mode', () => {
    expect(digestFromSha256Sums(`${A} *main.js`, 'main.js')).toBe(A);
    expect(digestFromSha256Sums(`${A} main.js`, 'main.js')).toBe(A);
  });

  it('lower-cases an upper-case digest so comparison is stable', () => {
    expect(digestFromSha256Sums(`${A.toUpperCase()}  main.js`, 'main.js')).toBe(A);
  });

  it('ignores lines that are not sha256 entries', () => {
    expect(digestFromSha256Sums(`# comment\nnot-a-hash main.js\n${A}  main.js`, 'main.js')).toBe(A);
  });

  it('does not match a file whose name merely contains the requested one', () => {
    expect(digestFromSha256Sums(`${A}  vendor/main.js`, 'main.js')).toBeNull();
  });
});
