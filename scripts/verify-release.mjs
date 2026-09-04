#!/usr/bin/env node
/**
 * verify-release — prove that a published release artifact was built from the
 * source at its tag.
 *
 * Why (HARDENING-PLAN Phase 6.5, finding F-01): Obsidian reviews a community
 * plugin once, at submission. Every release after that ships a `main.js` from
 * the author's GitHub Releases with no reproducibility check, into an Electron
 * renderer with Node access, holding provider secrets and full vault read
 * access. A malicious update needs no new capability — exfiltration looks
 * exactly like normal operation. Build provenance proves CI produced the file;
 * it does not prove the file corresponds to the source anyone reviewed. This
 * script is the missing half: download the released artifact, rebuild the tag
 * from scratch in a throwaway worktree, and diff the hashes.
 *
 * A mismatch is not automatically an attack — it is the signal to stop and
 * find out why (different toolchain, dirty release tree, a tag moved after the
 * build). A match, together with a source diff of the tag range, is the only
 * thing that justifies installing an upstream build you did not produce.
 *
 * Usage:
 *   node scripts/verify-release.mjs <tag> [--asset main.js] [--keep]
 *   pnpm verify:release v1.27.0
 *
 * Requires network access (GitHub release download + `pnpm install` in the
 * temporary worktree) and the tag to exist locally — run `git fetch --tags`
 * first. Every network failure is reported as itself; nothing is silently
 * treated as "verified".
 *
 * Exit codes: 0 = hashes match, 1 = hashes differ, 2 = could not complete the
 * comparison (network, missing tag, failed build) — never confuse 1 with 2.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { compareDigests, digestFromSha256Sums, sha256Hex } from './verify-reproducible-build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** Thrown for every condition that makes the comparison impossible (exit 2). */
export class VerifyReleaseError extends Error {}

/**
 * Extract `{ owner, repo }` from a git remote URL. Pure.
 *
 * Handles the four shapes `git remote get-url origin` actually emits:
 *   https://github.com/owner/repo(.git)
 *   ssh://git@github.com/owner/repo(.git)
 *   git@github.com:owner/repo(.git)
 *   git://github.com/owner/repo(.git)
 *
 * A non-GitHub remote throws rather than guessing: the release URL this feeds
 * is github.com-specific, and quietly building a wrong URL would surface as a
 * confusing 404 several steps later.
 *
 * @param {string} remoteUrl
 * @returns {{ owner: string, repo: string }}
 */
export function parseOwnerRepo(remoteUrl) {
  const url = String(remoteUrl ?? '').trim();
  if (url === '') {
    throw new VerifyReleaseError('git remote URL is empty — is `origin` configured?');
  }

  const scp = /^(?:[^@/]+@)?([^:/]+):([^/].*)$/.exec(url);
  let host;
  let path;
  if (scp && !url.includes('://')) {
    host = scp[1];
    path = scp[2];
  } else {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new VerifyReleaseError(`cannot parse git remote URL: ${url}`);
    }
    host = parsed.hostname;
    path = parsed.pathname;
  }

  if (host.toLowerCase() !== 'github.com') {
    throw new VerifyReleaseError(
      `remote host is ${host}, not github.com — this check only knows how to fetch GitHub releases`,
    );
  }

  const segments = path.replace(/^\/+/, '').replace(/\.git$/, '').split('/').filter(Boolean);
  if (segments.length < 2) {
    throw new VerifyReleaseError(`cannot read owner/repo from git remote URL: ${url}`);
  }
  return { owner: segments[0], repo: segments[1] };
}

/**
 * The public download URL for a release asset. Pure.
 *
 * @param {{ owner: string, repo: string, tag: string, asset: string }} spec
 * @returns {string}
 */
export function releaseAssetUrl({ owner, repo, tag, asset }) {
  for (const [name, value] of Object.entries({ owner, repo, tag, asset })) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new VerifyReleaseError(`releaseAssetUrl: missing ${name}`);
    }
  }
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}

/**
 * Run a command, returning stdout. Throws VerifyReleaseError on failure so the
 * caller can exit 2 ("could not check") rather than 1 ("does not match").
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, quiet?: boolean }} [options]
 * @returns {string}
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
  });
  if (result.error) {
    throw new VerifyReleaseError(`${command} could not be started: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim();
    throw new VerifyReleaseError(
      `${command} ${args.join(' ')} failed (exit ${result.status})${detail ? `: ${detail}` : ''}`,
    );
  }
  return result.stdout ?? '';
}

/**
 * Download a release asset. Network problems and HTTP failures are surfaced
 * verbatim — a release that cannot be downloaded is an unfinished check, never
 * a passing one.
 *
 * @param {string} url
 * @param {{ optional?: boolean }} [options]
 * @returns {Promise<Buffer | null>}
 */
async function download(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (cause) {
    throw new VerifyReleaseError(
      `network error fetching ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (response.status === 404) {
    if (options.optional) return null;
    throw new VerifyReleaseError(
      `${url} returned 404 — no such release, or the asset is not attached to it`,
    );
  }
  if (!response.ok) {
    throw new VerifyReleaseError(`${url} returned HTTP ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Check out `tag` into a throwaway worktree, install from the lockfile, build,
 * and return the sha256 of the produced asset.
 *
 * @param {string} tag
 * @param {string} asset
 * @param {string} worktreeDir
 * @returns {string}
 */
function rebuildFromTag(tag, asset, worktreeDir) {
  try {
    run('git', ['rev-parse', '--verify', `${tag}^{commit}`], { quiet: true });
  } catch {
    throw new VerifyReleaseError(
      `tag ${tag} is not present locally — run \`git fetch --tags\` and try again`,
    );
  }

  console.log(`Checking out ${tag} into ${worktreeDir} ...`);
  run('git', ['worktree', 'add', '--detach', worktreeDir, tag]);

  console.log('Installing from the lockfile (network) ...');
  run('pnpm', ['install', '--frozen-lockfile'], { cwd: worktreeDir });

  console.log('Building ...');
  run('pnpm', ['build'], { cwd: worktreeDir });

  return sha256Hex(readFileSync(join(worktreeDir, asset)));
}

async function main(argv) {
  const args = argv.filter((a) => a !== '');
  const keep = args.includes('--keep');
  const assetIndex = args.indexOf('--asset');
  const asset = assetIndex >= 0 ? args[assetIndex + 1] : 'main.js';
  const tag = args.find((a, i) => !a.startsWith('--') && (assetIndex < 0 || i !== assetIndex + 1));

  if (!tag) {
    console.error('usage: node scripts/verify-release.mjs <tag> [--asset main.js] [--keep]');
    return 2;
  }
  if (!asset) {
    console.error('--asset needs a file name');
    return 2;
  }

  const { owner, repo } = parseOwnerRepo(run('git', ['remote', 'get-url', 'origin'], { quiet: true }));
  console.log(`Repository: ${owner}/${repo}`);
  console.log(`Tag:        ${tag}`);
  console.log(`Asset:      ${asset}\n`);

  const assetUrl = releaseAssetUrl({ owner, repo, tag, asset });
  console.log(`Downloading ${assetUrl} ...`);
  const released = await download(assetUrl);
  const releasedDigest = sha256Hex(released);
  console.log(`  sha256 ${releasedDigest}  (${released.length} bytes)`);

  // SHA256SUMS is published from v1.27.0 onward (Phase 6.5). When it exists,
  // cross-check it: a release whose own manifest disagrees with its own asset
  // is broken regardless of what a rebuild produces.
  const sums = await download(
    releaseAssetUrl({ owner, repo, tag, asset: 'SHA256SUMS' }),
    { optional: true },
  );
  if (sums) {
    const claimed = digestFromSha256Sums(sums.toString('utf8'), asset);
    if (claimed === null) {
      console.warn(`  SHA256SUMS is attached but does not list ${asset}`);
    } else {
      const manifestVerdict = compareDigests(
        { label: 'downloaded asset', digest: releasedDigest },
        { label: 'SHA256SUMS entry', digest: claimed },
      );
      if (!manifestVerdict.match) {
        console.error(`\nRelease is internally inconsistent: ${manifestVerdict.reason}`);
        console.error(`  asset       ${manifestVerdict.left}`);
        console.error(`  SHA256SUMS  ${manifestVerdict.right}`);
        return 1;
      }
      console.log('  SHA256SUMS entry agrees with the downloaded asset');
    }
  } else {
    console.log('  (no SHA256SUMS attached to this release — pre-Phase-6 tag)');
  }

  const scratch = mkdtempSync(join(tmpdir(), 'verify-release-'));
  const worktreeDir = join(scratch, 'src');
  try {
    const rebuiltDigest = rebuildFromTag(tag, asset, worktreeDir);
    console.log(`\nRebuilt ${asset}`);
    console.log(`  sha256 ${rebuiltDigest}`);

    const verdict = compareDigests(
      { label: 'released', digest: releasedDigest },
      { label: 'rebuilt', digest: rebuiltDigest },
    );
    if (verdict.match) {
      console.log(`\nMATCH — the released ${asset} was built from the source at ${tag}.`);
      return 0;
    }

    console.error(`\nMISMATCH — the released ${asset} does NOT match a rebuild of ${tag}.`);
    console.error(`  released ${verdict.left}`);
    console.error(`  rebuilt  ${verdict.right}`);
    console.error(
      '\nDo not install this artifact until the difference is explained.\n' +
      'Check first that `pnpm check:reproducible` is green on this tag: if the\n' +
      'build itself is non-deterministic, the mismatch says nothing either way.',
    );
    if (keep) {
      const releasedCopy = join(scratch, `released-${asset}`);
      writeFileSync(releasedCopy, released);
      console.error(`\nKept for inspection:\n  ${releasedCopy}\n  ${join(worktreeDir, asset)}`);
    }
    return 1;
  } finally {
    if (keep) {
      console.error(`\n(--keep) worktree left at ${worktreeDir}; remove with:\n` +
        `  git worktree remove --force ${worktreeDir}`);
    } else {
      spawnSync('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: REPO_ROOT });
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof VerifyReleaseError) {
      console.error(`\nCannot verify: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}
