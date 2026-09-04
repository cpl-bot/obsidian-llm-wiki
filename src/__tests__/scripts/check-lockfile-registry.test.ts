/**
 * Tests for `scripts/check-lockfile-registry.mjs` (HARDENING-PLAN Phase 1,
 * task 1.5 — closes F-02).
 *
 * The guard exists because a mirror URL in a lockfile is invisible: the tree
 * still installs, integrity hashes still verify, and nothing fails until
 * someone installs from a network that blocks the mirror. These tests pin the
 * two things that make the guard worth having — that it actually flags a
 * mirror host, and that it does not fire on the shapes a clean lockfile
 * legitimately contains (root entry, local `file:`/`link:` specifiers, a
 * pnpm-lock with no URLs at all).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OFFICIAL_REGISTRY_HOST,
  findNonOfficialResolved,
  findNonOfficialUrlsInText,
  main,
} from '../../../scripts/check-lockfile-registry.mjs';

describe('OFFICIAL_REGISTRY_HOST', () => {
  it('names the official npm registry', () => {
    expect(OFFICIAL_REGISTRY_HOST).toBe('registry.npmjs.org');
  });
});

describe('findNonOfficialResolved', () => {
  it('accepts a lockfile whose every entry resolves from the official registry', () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'karpathywiki', version: '1.27.0' },
        'node_modules/esbuild': {
          version: '0.28.2',
          resolved: 'https://registry.npmjs.org/esbuild/-/esbuild-0.28.2.tgz',
        },
        'node_modules/fast-uri': {
          version: '3.1.7',
          resolved: 'https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.7.tgz',
        },
      },
    };

    expect(findNonOfficialResolved(lock)).toEqual([]);
  });

  it('flags the npmmirror.com host that motivated the check (F-02)', () => {
    const lock = {
      packages: {
        'node_modules/esbuild': {
          version: '0.28.2',
          resolved: 'https://registry.npmmirror.com/esbuild/-/esbuild-0.28.2.tgz',
        },
      },
    };

    const offenders = findNonOfficialResolved(lock);

    expect(offenders).toHaveLength(1);
    expect(offenders[0].path).toBe('node_modules/esbuild');
    expect(offenders[0].host).toBe('registry.npmmirror.com');
    expect(offenders[0].resolved).toContain('npmmirror.com');
  });

  it('reports every offender, in lockfile order, alongside clean entries', () => {
    const lock = {
      packages: {
        'node_modules/a': { resolved: 'https://registry.npmmirror.com/a/-/a-1.0.0.tgz' },
        'node_modules/b': { resolved: 'https://registry.npmjs.org/b/-/b-1.0.0.tgz' },
        'node_modules/c': { resolved: 'https://evil.example.com/c/-/c-1.0.0.tgz' },
      },
    };

    expect(findNonOfficialResolved(lock).map((o) => o.path)).toEqual([
      'node_modules/a',
      'node_modules/c',
    ]);
  });

  it('does not confuse a lookalike host with the official registry', () => {
    const lock = {
      packages: {
        'node_modules/a': {
          resolved: 'https://registry.npmjs.org.evil.example/a/-/a-1.0.0.tgz',
        },
        'node_modules/b': {
          resolved: 'https://evil.example/registry.npmjs.org/b/-/b-1.0.0.tgz',
        },
      },
    };

    expect(findNonOfficialResolved(lock).map((o) => o.path)).toEqual([
      'node_modules/a',
      'node_modules/b',
    ]);
  });

  it('treats a non-default port on the official host as an offender', () => {
    const lock = {
      packages: {
        'node_modules/a': { resolved: 'https://registry.npmjs.org:8443/a/-/a-1.0.0.tgz' },
      },
    };

    expect(findNonOfficialResolved(lock)).toHaveLength(1);
  });

  it('ignores entries with no resolved field, including the root project', () => {
    const lock = {
      packages: {
        '': { name: 'karpathywiki', version: '1.27.0' },
        'node_modules/bundled': { version: '1.0.0' },
        'node_modules/blank': { version: '1.0.0', resolved: '' },
      },
    };

    expect(findNonOfficialResolved(lock)).toEqual([]);
  });

  it('exempts local file: and link: specifiers, which never leave the repo', () => {
    const lock = {
      packages: {
        'node_modules/local': { resolved: 'file:../local-pkg' },
        'node_modules/linked': { resolved: 'link:../linked-pkg' },
      },
    };

    expect(findNonOfficialResolved(lock)).toEqual([]);
  });

  it('flags a git source, which is neither the registry nor a local path', () => {
    const lock = {
      packages: {
        'node_modules/forked': {
          resolved: 'git+ssh://git@github.com/someone/forked.git#abc123',
        },
      },
    };

    expect(findNonOfficialResolved(lock)).toHaveLength(1);
  });

  it('flags an unparseable resolved value rather than silently passing it', () => {
    const lock = { packages: { 'node_modules/weird': { resolved: 'not a url at all' } } };

    const offenders = findNonOfficialResolved(lock);

    expect(offenders).toHaveLength(1);
    expect(offenders[0].host).toBeNull();
  });

  it('returns no offenders for malformed input instead of throwing', () => {
    expect(findNonOfficialResolved(null)).toEqual([]);
    expect(findNonOfficialResolved(undefined)).toEqual([]);
    expect(findNonOfficialResolved('not-an-object')).toEqual([]);
    expect(findNonOfficialResolved({})).toEqual([]);
    expect(findNonOfficialResolved({ packages: null })).toEqual([]);
    expect(findNonOfficialResolved({ packages: { 'node_modules/a': null } })).toEqual([]);
  });
});

describe('findNonOfficialUrlsInText', () => {
  it('passes a pnpm-lock that contains no URLs at all — the normal shape', () => {
    const text = [
      "lockfileVersion: '9.0'",
      'overrides:',
      '  fast-uri: 3.1.7',
      'packages:',
      '  fast-uri@3.1.7: {}',
    ].join('\n');

    expect(findNonOfficialUrlsInText(text)).toEqual([]);
  });

  it('flags a tarball: resolution pointing at a mirror, with its line number', () => {
    const text = [
      'packages:',
      '  esbuild@0.28.2:',
      '    resolution:',
      '      tarball: https://registry.npmmirror.com/esbuild/-/esbuild-0.28.2.tgz',
    ].join('\n');

    const offenders = findNonOfficialUrlsInText(text);

    expect(offenders).toHaveLength(1);
    expect(offenders[0].line).toBe(4);
    expect(offenders[0].host).toBe('registry.npmmirror.com');
  });

  it('accepts a tarball: resolution on the official registry', () => {
    const text = '      tarball: https://registry.npmjs.org/esbuild/-/esbuild-0.28.2.tgz';

    expect(findNonOfficialUrlsInText(text)).toEqual([]);
  });

  it('finds several URLs on one line', () => {
    const text = '# see https://a.example/x and https://b.example/y';

    expect(findNonOfficialUrlsInText(text).map((o) => o.host)).toEqual(['a.example', 'b.example']);
  });

  it('strips trailing sentence punctuation so the host is not mangled', () => {
    const text = '# mirror docs at https://registry.npmmirror.com/docs.';

    const offenders = findNonOfficialUrlsInText(text);

    expect(offenders).toHaveLength(1);
    expect(offenders[0].url).toBe('https://registry.npmmirror.com/docs');
  });

  it('handles CRLF line endings without shifting line numbers', () => {
    const text = 'packages:\r\n  tarball: https://registry.npmmirror.com/a.tgz\r\n';

    expect(findNonOfficialUrlsInText(text)[0].line).toBe(2);
  });

  it('returns no offenders for empty or non-string input instead of throwing', () => {
    expect(findNonOfficialUrlsInText('')).toEqual([]);
    expect(findNonOfficialUrlsInText(undefined as unknown as string)).toEqual([]);
    expect(findNonOfficialUrlsInText(null as unknown as string)).toEqual([]);
  });
});

describe('main', () => {
  const created: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Build a throwaway repo root. `undefined` for either lockfile means "do not
   * write this file at all", which is the case the fail-closed branches guard.
   */
  function repoWith(npmLock: string | undefined, pnpmLock: string | undefined): string {
    const dir = mkdtempSync(join(tmpdir(), 'lockfile-registry-'));
    created.push(dir);
    if (npmLock !== undefined) writeFileSync(join(dir, 'package-lock.json'), npmLock);
    if (pnpmLock !== undefined) writeFileSync(join(dir, 'pnpm-lock.yaml'), pnpmLock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return dir;
  }

  const CLEAN_NPM_LOCK = JSON.stringify({
    packages: {
      '': { name: 'karpathywiki' },
      'node_modules/esbuild': {
        resolved: 'https://registry.npmjs.org/esbuild/-/esbuild-0.28.2.tgz',
      },
    },
  });
  const CLEAN_PNPM_LOCK = "lockfileVersion: '9.0'\npackages:\n  esbuild@0.28.2: {}\n";

  it('passes when both lockfiles are present and resolve from the official registry', () => {
    expect(main(repoWith(CLEAN_NPM_LOCK, CLEAN_PNPM_LOCK))).toBe(0);
  });

  it('fails closed when package-lock.json is absent rather than reporting OK', () => {
    expect(main(repoWith(undefined, CLEAN_PNPM_LOCK))).toBe(1);
  });

  it('fails closed when pnpm-lock.yaml is absent rather than reporting OK', () => {
    expect(main(repoWith(CLEAN_NPM_LOCK, undefined))).toBe(1);
  });

  it('fails when package-lock.json is not valid JSON', () => {
    expect(main(repoWith('{ not json', CLEAN_PNPM_LOCK))).toBe(1);
  });

  it('fails on a mirror URL in package-lock.json and names the offending entry', () => {
    const dir = repoWith(
      JSON.stringify({
        packages: {
          'node_modules/esbuild': {
            resolved: 'https://registry.npmmirror.com/esbuild/-/esbuild-0.28.2.tgz',
          },
        },
      }),
      CLEAN_PNPM_LOCK,
    );

    expect(main(dir)).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      'node_modules/esbuild -> https://registry.npmmirror.com/esbuild/-/esbuild-0.28.2.tgz',
    );
  });

  it('fails on a mirror tarball in pnpm-lock.yaml even when package-lock.json is clean', () => {
    const dir = repoWith(
      CLEAN_NPM_LOCK,
      '      tarball: https://registry.npmmirror.com/esbuild/-/esbuild-0.28.2.tgz\n',
    );

    expect(main(dir)).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('pnpm-lock.yaml:1');
  });
});
