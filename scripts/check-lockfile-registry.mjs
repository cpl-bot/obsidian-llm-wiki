#!/usr/bin/env node
/**
 * check-lockfile-registry — assert that every dependency in every lockfile is
 * fetched from the official npm registry.
 *
 * Why (HARDENING-PLAN F-02): the committed `package-lock.json` used to resolve
 * 358 of 434 packages from `registry.npmmirror.com`, a third-party mirror,
 * even though `.npmrc` pinned `registry=https://registry.npmjs.org/`. The pin
 * existed; it simply never propagated into the checked-in tree, and nothing
 * noticed for several releases. This check is the thing that notices: it runs
 * in `gate:1` and in PR CI, so a lockfile regenerated on a machine with a
 * mirror in `~/.npmrc` fails before review rather than after release.
 *
 * `package-lock.json` is parsed as JSON and every `packages[*].resolved` URL is
 * checked. `pnpm-lock.yaml` carries no URLs at all in its normal form — pnpm
 * records bare `<name>@<version>` keys and only emits `resolution: { tarball:
 * ... }` for non-registry sources — so it is scanned as text for any absolute
 * URL and any such URL off the official registry is an offender. Zero URLs is
 * the expected, passing state.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The only host a lockfile may name as the source of a package. */
export const OFFICIAL_REGISTRY_HOST = 'registry.npmjs.org';

/**
 * Local specifiers never leave the repository, so they are not a registry
 * question at all. npm writes these for `file:`/`link:` dependencies and for
 * workspace members.
 */
const LOCAL_PROTOCOLS = new Set(['file:', 'link:']);

/**
 * Extract the host of a `resolved` value, or null when it is not an absolute
 * URL (npm omits or blanks `resolved` for the root project and for some
 * bundled entries).
 *
 * @param {string} value
 * @returns {string | null}
 */
function hostOf(value) {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * Find every package in a parsed `package-lock.json` whose `resolved` URL does
 * not point at the official registry.
 *
 * An entry is an offender when it has a non-empty `resolved` string that is
 * either (a) an absolute URL on some other host, or (b) not an absolute URL
 * and not a local `file:`/`link:` specifier — an unparseable source is no more
 * trustworthy than a mirror.
 *
 * @param {unknown} lockJson parsed lockfile contents
 * @returns {{ path: string, resolved: string, host: string | null }[]} offenders, in lockfile order
 */
export function findNonOfficialResolved(lockJson) {
  const offenders = [];
  if (typeof lockJson !== 'object' || lockJson === null) return offenders;

  const packages = /** @type {Record<string, unknown>} */ (lockJson).packages;
  if (typeof packages !== 'object' || packages === null) return offenders;

  for (const [path, meta] of Object.entries(packages)) {
    if (typeof meta !== 'object' || meta === null) continue;
    const resolved = /** @type {Record<string, unknown>} */ (meta).resolved;
    if (typeof resolved !== 'string' || resolved === '') continue;

    const protocolMatch = /^[a-z][a-z0-9+.-]*:/i.exec(resolved);
    if (protocolMatch && LOCAL_PROTOCOLS.has(protocolMatch[0].toLowerCase())) continue;

    const host = hostOf(resolved);
    if (host === OFFICIAL_REGISTRY_HOST) continue;

    offenders.push({ path, resolved, host });
  }

  return offenders;
}

/**
 * Find every absolute http(s) URL in a text lockfile (`pnpm-lock.yaml`) that is
 * not on the official registry. pnpm normally emits no URLs, so an empty result
 * is both the common case and a pass.
 *
 * @param {string} text raw lockfile text
 * @returns {{ line: number, url: string, host: string }[]} offenders, in file order
 */
export function findNonOfficialUrlsInText(text) {
  const offenders = [];
  if (typeof text !== 'string' || text === '') return offenders;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const matches = lines[i].match(/https?:\/\/[^\s'"`,)\]}]+/gi);
    if (!matches) continue;
    for (const raw of matches) {
      // Trailing punctuation is common in YAML comments; it is not part of the host.
      const url = raw.replace(/[.,;:]+$/, '');
      const host = hostOf(url);
      if (host === null || host === OFFICIAL_REGISTRY_HOST) continue;
      offenders.push({ line: i + 1, url, host });
    }
  }

  return offenders;
}

/**
 * CLI entry point. Returns the process exit code rather than calling
 * `process.exit`, so both the pure logic above and this orchestration stay
 * testable.
 *
 * Fail-closed: a missing lockfile is a failure, not a skip. A guard that
 * reports OK because it found nothing to check is worse than no guard.
 *
 * @param {string} repoRoot
 * @returns {number} 0 on pass, 1 on any offender or missing lockfile
 */
export function main(repoRoot) {
  const npmLockPath = join(repoRoot, 'package-lock.json');
  const pnpmLockPath = join(repoRoot, 'pnpm-lock.yaml');

  let failed = false;
  let checkedNpmEntries = 0;

  if (existsSync(npmLockPath)) {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(npmLockPath, 'utf8'));
    } catch (error) {
      console.error(
        `check-lockfile-registry: package-lock.json is not valid JSON — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 1;
    }
    const packages =
      typeof parsed === 'object' && parsed !== null
        ? /** @type {Record<string, unknown>} */ (parsed).packages
        : null;
    checkedNpmEntries =
      typeof packages === 'object' && packages !== null ? Object.keys(packages).length : 0;

    const offenders = findNonOfficialResolved(parsed);
    if (offenders.length > 0) {
      failed = true;
      console.error(
        `check-lockfile-registry: ${offenders.length} package-lock.json entr${
          offenders.length === 1 ? 'y resolves' : 'ies resolve'
        } off ${OFFICIAL_REGISTRY_HOST}:`,
      );
      for (const offender of offenders) {
        console.error(`  ${offender.path} -> ${offender.resolved}`);
      }
    }
  } else {
    console.error('check-lockfile-registry: package-lock.json not found.');
    return 1;
  }

  let checkedPnpmLines = 0;
  if (existsSync(pnpmLockPath)) {
    const text = readFileSync(pnpmLockPath, 'utf8');
    checkedPnpmLines = text.split(/\r?\n/).length;
    const offenders = findNonOfficialUrlsInText(text);
    if (offenders.length > 0) {
      failed = true;
      console.error(
        `check-lockfile-registry: ${offenders.length} pnpm-lock.yaml URL${
          offenders.length === 1 ? '' : 's'
        } off ${OFFICIAL_REGISTRY_HOST}:`,
      );
      for (const offender of offenders) {
        console.error(`  pnpm-lock.yaml:${offender.line} -> ${offender.url}`);
      }
    }
  } else {
    // Fail closed, symmetrically with package-lock.json above. pnpm-lock.yaml
    // is the lockfile CI installs from; a run that silently skips it would
    // report OK while checking nothing that matters.
    console.error('check-lockfile-registry: pnpm-lock.yaml not found.');
    return 1;
  }

  if (failed) {
    console.error(
      `check-lockfile-registry: regenerate with --registry=https://${OFFICIAL_REGISTRY_HOST}/ ` +
        '(a mirror in ~/.npmrc is the usual cause).',
    );
    return 1;
  }

  console.log(
    `check-lockfile-registry: OK — ${checkedNpmEntries} package-lock.json entries and ` +
      `${checkedPnpmLines} pnpm-lock.yaml lines all resolve from ${OFFICIAL_REGISTRY_HOST}.`,
  );
  return 0;
}

// Run only when invoked directly, never on import from the test suite.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(dirname(dirname(fileURLToPath(import.meta.url)))));
}
