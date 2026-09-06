// Fixture tests for the Phase 2.B bundle assertion
// (`scripts/check-bundle-no-bedrock.mjs`, wired into `gate:1` as
// `pnpm check:bundle-bedrock`).
//
// The script is the structural proof that the removed cloud-provider auth
// surface cannot be quietly re-merged from upstream: it scans the artifact
// that actually ships, not the source tree. That makes it a security
// control, and an untested security control is a control that can silently
// stop failing — a typo'd needle, an early `return`, or an exit code that
// never reaches 1 all look exactly like "the bundle is clean" from CI.
//
// So both directions are pinned per needle: a clean bundle exits 0, and a
// bundle carrying ANY ONE of the forbidden strings exits 1 and names it.
// The script has no exported helpers (it runs at import time and calls
// `process.exit`), so it is exercised as a process — the same way
// `tools/dev-instrument`'s exit contract is.
//
// The needles are assembled from fragments here for the same reason the
// production scrub and the script itself assemble them: a bare literal in
// a checked-in file is what a repo-wide grep treats as the surface coming
// back.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Vitest runs from the repo root (same assumption as the dev-instrument
// exit-contract test).
const SCRIPT = join(process.cwd(), 'scripts/check-bundle-no-bedrock.mjs');

/** Every string the shipped bundle may not contain, in fragments. */
const NEEDLES: Record<string, string> = {
  'vendor name': 'bed' + 'rock',
  'data-plane hostname suffix': 'amazon' + 'aws.com',
  'SSO portal hostname suffix': 'aws' + 'apps.com',
  'signing algorithm name': 'sig' + 'v4',
};

let dir: string;

function runOn(contents: string): { status: number | null; stdout: string; stderr: string } {
  const file = join(dir, `fixture-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(file, contents, 'utf8');
  const result = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bundle-check-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('check-bundle-no-bedrock.mjs', () => {
  it('exits 0 on a bundle that mentions only retained providers', () => {
    const clean = [
      'const a = "https://api.anthropic.com/v1";',
      'const b = "https://api.openai.com/v1";',
      'const c = "karpathywiki-provider-api-key";',
    ].join('\n');

    const { status, stdout } = runOn(clean);

    expect(status).toBe(0);
    expect(stdout).toContain('carries no trace');
  });

  it.each(Object.entries(NEEDLES))('exits 1 when the bundle carries the %s', (_label, needle) => {
    const { status, stderr } = runOn(`const x = "prefix-${needle}-suffix";`);

    expect(status).toBe(1);
    expect(stderr).toContain('contains the removed provider surface');
  });

  it('matches case-insensitively — a camelCased resurrection still fails', () => {
    const camel = `const s = { ${'bed' + 'Rock'}Region: 'us-east-1' };`;

    expect(runOn(camel).status).toBe(1);
  });

  it('reports every occurrence, not just the first', () => {
    const needle = NEEDLES['vendor name'];
    const { status, stderr } = runOn(`"${needle}";\n"${needle}";\n"${needle}";`);

    expect(status).toBe(1);
    expect(stderr).toContain('3 occurrence(s)');
  });

  it('exits 1 when the bundle is missing — a skipped check is not a pass', () => {
    const result = spawnSync(process.execPath, [SCRIPT, join(dir, 'no-such-bundle.js')], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot read');
  });
});
