// Phase 5 (F-08) — the write-gate against Obsidian's REAL `normalizePath`.
//
// Every other vault-writer test runs against the global Obsidian stub, where
// `normalizePath` is the identity function (`__support__/setup.ts`). That is
// deliberate — it proves the gate's rules are the gate's own — but it leaves
// one question unanswered: the shipped `normalizePath` is NOT the identity.
// It collapses separator runs, strips leading/trailing slashes, folds the
// string to NFC and rewrites non-breaking spaces. So the string the gate
// checks and the string the caller wrote can differ in production, and only
// here can that be tested.
//
// This file re-mocks `obsidian` with that production shape and pins the two
// properties that follow:
//
//   * the gate returns the CALLER's form, not the NFC-folded one — writing
//     the folded form would retarget an NFD filename that `wiki-engine.ts`
//     resolved on an APFS vault;
//   * containment must hold for BOTH forms, so `normalizePath`'s rewrite can
//     neither pull an out-of-scope path in nor push an in-scope path out.

import { describe, it, expect, vi } from 'vitest';

// Obsidian's own implementation, as shipped: separator collapse, leading and
// trailing slash strip, NFC fold, non-breaking-space rewrite.
vi.mock('obsidian', () => ({
  normalizePath: (path: string): string =>
    path
      .replace(/([\\/])+/g, '/')
      .replace(/(^\/+|\/+$)/g, '')
      .normalize('NFC')
      .replace(/\u00a0|\u202f/g, ' '),
}));

import {
  assertWithinScope,
  VaultWriteScopeError,
  type VaultWriteScope,
} from '../../core/vault-writer';

const NFC_CAFE = 'wiki-caf\u00e9';        // e-acute as one codepoint
const NFD_CAFE = 'wiki-cafe\u0301';       // e + combining acute
const NBSP = '\u00a0';    // U+00A0, which normalizePath rewrites to a space

function expectRejected(fn: () => unknown, reason: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(VaultWriteScopeError);
  expect((caught as VaultWriteScopeError).reason).toBe(reason);
}

describe('assertWithinScope under the real normalizePath — returned form', () => {
  it('hands back the caller s NFD path, not normalizePath s NFC fold', () => {
    const scope: VaultWriteScope = { wikiFolder: NFC_CAFE };
    const written = assertWithinScope(`${NFD_CAFE}/note.md`, scope);
    expect(written).toBe(`${NFD_CAFE}/note.md`);
    // The NFC fold is what a naive implementation would return; on an APFS
    // vault that names a different file than the caller resolved.
    expect(written).not.toBe(`${NFC_CAFE}/note.md`);
  });

  it('accepts an NFC path against an NFD-configured folder, unchanged', () => {
    expect(assertWithinScope(`${NFC_CAFE}/note.md`, { wikiFolder: NFD_CAFE }))
      .toBe(`${NFC_CAFE}/note.md`);
  });

  it('still collapses `.` and duplicate separators in the returned path', () => {
    expect(assertWithinScope('wiki//a/./b.md', { wikiFolder: 'wiki' })).toBe('wiki/a/b.md');
    expect(assertWithinScope('wiki/sub/', { wikiFolder: 'wiki' })).toBe('wiki/sub');
  });
});

describe('assertWithinScope under the real normalizePath — both forms must be in scope', () => {
  it('refuses a path that only normalizePath s rewrite would pull into scope', () => {
    // `wiki<NBSP>notes/x.md` is NOT inside `wiki notes/` — the folder name
    // differs by one character. Obsidian's non-breaking-space rewrite makes
    // the two look identical; the raw form, which is what would actually be
    // written, still points at a different folder, so the gate refuses.
    expectRejected(
      () => assertWithinScope(`wiki${NBSP}notes/x.md`, { wikiFolder: 'wiki notes' }),
      'out-of-scope'
    );
  });

  it('still accepts the path when the configured folder carries the same rewrite', () => {
    // The legitimate counterpart: the user's folder really does contain the
    // non-breaking space, so both forms agree and the write lands.
    const scope: VaultWriteScope = { wikiFolder: `wiki${NBSP}notes` };
    expect(assertWithinScope(`wiki${NBSP}notes/x.md`, scope)).toBe(`wiki${NBSP}notes/x.md`);
  });

  it('rejects traversal that survives the real normaliser', () => {
    expectRejected(() => assertWithinScope('wiki/../../etc/passwd', { wikiFolder: 'wiki' }), 'parent-traversal');
  });

  it('rejects a path that normalises away to nothing', () => {
    // normalizePath('///') strips to '' — the gate must not read that as the
    // vault root and let a rootless write through.
    expectRejected(() => assertWithinScope('///', { wikiFolder: 'wiki' }), 'absolute-path');
    expectRejected(() => assertWithinScope('./', { wikiFolder: 'wiki' }), 'empty-path');
  });

  it('still denies the sibling-prefix folder', () => {
    expectRejected(() => assertWithinScope('wiki-backup/x.md', { wikiFolder: 'wiki' }), 'out-of-scope');
    expectRejected(() => assertWithinScope(`${NFD_CAFE}-backup/x.md`, { wikiFolder: NFC_CAFE }), 'out-of-scope');
  });

  it('the vault root as the wiki folder still accepts every relative path', () => {
    expect(assertWithinScope('Inbox/note.md', { wikiFolder: '' })).toBe('Inbox/note.md');
    expect(assertWithinScope('Inbox/note.md', { wikiFolder: '/' })).toBe('Inbox/note.md');
    expectRejected(() => assertWithinScope('../out.md', { wikiFolder: '' }), 'parent-traversal');
  });
});
