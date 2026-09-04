#!/usr/bin/env node
/**
 * Phase 4.5 (finding F-04) — bundle hostname tripwire.
 *
 * Extracts every `http(s)://<host>` literal from the built `main.js` and
 * fails when one of them is neither egress-allowed nor on the explicit
 * "documented but never fetched" list in `src/core/egress-hosts.json`
 * (the same file `src/core/egress-policy.ts` reads, so the runtime policy
 * and this check can never drift apart).
 *
 * Why it exists: an auto-update or an unreviewed upstream merge can add a
 * new destination without touching anything a human would notice. A new
 * hostname in the bundle is the cheapest possible signal for that, and it
 * is one `grep` away from being checkable in CI.
 *
 * Two categories deserve explanation:
 *   - `knownDocHosts` are hosts the bundle mentions but never fetches
 *     (documentation links, links opened in the user's browser,
 *     placeholders). `ai-gateway.vercel.sh` — the `ai` SDK's built-in
 *     default gateway — lives there deliberately: the tripwire tolerates
 *     the string, the runtime policy still blocks the request.
 *   - `knownRuntimePrefixes` are truncated literals such as
 *     `https://oidc.` that appear because the AWS region is concatenated
 *     at runtime; the scanner can only ever see the prefix.
 *
 * Usage:
 *   node scripts/check-bundle-hosts.mjs                 # checks ./main.js
 *   node scripts/check-bundle-hosts.mjs path/to/main.js
 *
 * Exit codes: 0 = clean, 1 = at least one unaccounted host (listed).
 *
 * No dependencies — plain ESM + node: builtins, so it runs in CI before
 * any install step that could itself be compromised.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Same shape the bundle scan produced in the security assessment. */
const URL_LITERAL = /https?:\/\/[a-zA-Z0-9.-]+/g;

/** A single DNS label as it may appear in a region / tenant slot. */
const HOST_LABEL = /^[a-z0-9-]+$/;

/**
 * Every distinct host literal in `source`, lower-cased and sorted.
 * Pure — takes a string, returns an array; no I/O.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function extractBundleHosts(source) {
  const hosts = new Set();
  for (const match of source.matchAll(URL_LITERAL)) {
    hosts.add(match[0].replace(/^https?:\/\//, '').toLowerCase());
  }
  return [...hosts].sort();
}

/**
 * True when `host` matches `prefix + <single label> + suffix`.
 *
 * @param {string} host
 * @param {{ prefix: string, suffix: string }} pattern
 */
function matchesHostPattern(host, pattern) {
  const { prefix, suffix } = pattern;
  if (!host.startsWith(prefix) || !host.endsWith(suffix)) return false;
  const middle = host.slice(prefix.length, host.length - suffix.length);
  return HOST_LABEL.test(middle);
}

/**
 * Is this bundle host accounted for by the egress host data?
 *
 * @param {string} host lower-cased host literal from the bundle
 * @param {{ allowlist: string[], hostPatterns: Array<{prefix: string, suffix: string}>,
 *           loopbackHosts: string[], knownDocHosts: string[], knownRuntimePrefixes: string[] }} hosts
 * @returns {boolean}
 */
export function isAcceptedBundleHost(host, hosts) {
  if (hosts.allowlist.includes(host)) return true;
  if (hosts.knownDocHosts.includes(host)) return true;
  if (hosts.loopbackHosts.includes(host)) return true;
  if (hosts.knownRuntimePrefixes.includes(host)) return true;
  return hosts.hostPatterns.some((pattern) => matchesHostPattern(host, pattern));
}

/**
 * Hosts present in `source` that nothing accounts for, sorted.
 *
 * @param {string} source
 * @param {Parameters<typeof isAcceptedBundleHost>[1]} hosts
 * @returns {string[]}
 */
export function findOffendingHosts(source, hosts) {
  return extractBundleHosts(source).filter((host) => !isAcceptedBundleHost(host, hosts));
}

/**
 * Read the shared host data. Defaults to the file the runtime policy imports.
 *
 * @param {string} [hostsPath]
 */
export function loadEgressHosts(hostsPath = resolve(HERE, '../src/core/egress-hosts.json')) {
  return JSON.parse(readFileSync(hostsPath, 'utf8'));
}

/**
 * Scan a built bundle on disk.
 *
 * @param {{ bundlePath?: string, hostsPath?: string }} [opts]
 * @returns {{ bundlePath: string, hosts: string[], offenders: string[] }}
 */
export function checkBundleFile(opts = {}) {
  const bundlePath = resolve(opts.bundlePath ?? resolve(HERE, '../main.js'));
  const source = readFileSync(bundlePath, 'utf8');
  const egressHosts = loadEgressHosts(opts.hostsPath);
  return {
    bundlePath,
    hosts: extractBundleHosts(source),
    offenders: findOffendingHosts(source, egressHosts),
  };
}

function main() {
  let result;
  try {
    result = checkBundleFile({ bundlePath: process.argv[2] });
  } catch (err) {
    console.error(`✗ check-bundle-hosts: ${err.message}`);
    process.exit(1);
    return;
  }
  if (result.offenders.length > 0) {
    console.error(`✗ check-bundle-hosts: ${result.offenders.length} unaccounted host(s) in ${result.bundlePath}:`);
    for (const host of result.offenders) console.error(`    ${host}`);
    console.error('');
    console.error('  Every host in the bundle must be either fetch-allowlisted or listed as');
    console.error('  documentation-only in src/core/egress-hosts.json. If the host is genuinely');
    console.error('  fetched, add it to `allowlist`; if it only appears in a doc string or a link');
    console.error('  opened in the browser, add it to `knownDocHosts`. If you cannot explain it,');
    console.error('  treat it as a supply-chain finding and do not ship the build.');
    process.exit(1);
    return;
  }
  console.log(`✓ check-bundle-hosts: ${result.hosts.length} host(s) in ${result.bundlePath}, all accounted for`);
}

// Run only when invoked directly, so the pure helpers above stay importable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
