#!/usr/bin/env node
/**
 * ensure-esbuild — re-enable the one install script we actually want.
 *
 * `.npmrc` sets `ignore-scripts=true` (Phase 1, task 1.4) so that no package
 * in the dependency graph can execute code merely by being installed. esbuild
 * is the single legitimate exception: its postinstall (`install.js`) fetches
 * and links the platform-specific `esbuild` binary, without which
 * `pnpm build` cannot run.
 *
 * pnpm re-enables it declaratively via `onlyBuiltDependencies: [esbuild]` in
 * `pnpm-workspace.yaml`, so under pnpm this script normally finds the binary
 * already in place and does nothing. npm has no equivalent allowlist — and
 * npm's `ignore-scripts` also suppresses the root project's own lifecycle
 * scripts, including `prepare` — so after `npm ci` this script must be run
 * explicitly:
 *
 *     node scripts/ensure-esbuild.mjs
 *
 * Contract: never fail the install. If esbuild is absent (it is a
 * devDependency; a production-only install legitimately has no esbuild), or
 * if its installer is missing because upstream restructured the package, we
 * report and exit 0. A build that genuinely needs esbuild will fail loudly at
 * `pnpm build` with a far clearer message than a broken postinstall would
 * give.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Locate esbuild's `install.js`, preferring Node's own resolution (which
 * follows pnpm's symlinked `node_modules` layout correctly) and falling back
 * to the flat `node_modules/esbuild` path npm produces.
 *
 * @returns {string | null} absolute path to install.js, or null if not found
 */
function findEsbuildInstaller() {
  const require = createRequire(join(repoRoot, 'package.json'));
  try {
    const pkgJson = require.resolve('esbuild/package.json');
    const candidate = join(dirname(pkgJson), 'install.js');
    if (existsSync(candidate)) return candidate;
  } catch {
    // esbuild is not resolvable from the repo root — fall through.
  }
  const flat = join(repoRoot, 'node_modules', 'esbuild', 'install.js');
  return existsSync(flat) ? flat : null;
}

const installer = findEsbuildInstaller();

if (!installer) {
  console.log(
    'ensure-esbuild: no esbuild installer found (esbuild not installed) — nothing to do.',
  );
  process.exit(0);
}

const result = spawnSync(process.execPath, [installer], {
  cwd: dirname(installer),
  stdio: 'inherit',
});

if (result.error) {
  console.log(`ensure-esbuild: installer could not be started (${result.error.message}) — skipping.`);
  process.exit(0);
}

if (result.status !== 0) {
  console.log(
    `ensure-esbuild: installer exited ${result.status ?? 'via signal'} — skipping. ` +
      'Run `pnpm build` to see whether the esbuild binary is actually usable.',
  );
  process.exit(0);
}

console.log('ensure-esbuild: esbuild binary is in place.');
process.exit(0);
