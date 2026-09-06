/**
 * Tests for `scripts/check-bundle-no-codex.mjs` (hardening Phase 2.B).
 *
 * The check is the structural half of the removal: source deletion is easy
 * for an upstream merge to undo, so `gate:1` asserts the artifact that
 * actually ships carries no trace of the ChatGPT-subscription OAuth
 * provider. A guard like that has exactly two ways to be worthless — it
 * never fires (so a resurrection ships), or it always fires (so someone
 * narrows it until it does not). Both are pinned here:
 *
 *   - NEGATIVE: each of the three needles, on its own, fails the check.
 *   - POSITIVE: a bundle carrying the OpenAI model ids that legitimately
 *     contain the vendor's name (`gpt-5-codex` and friends, shipped inside
 *     `@ai-sdk/openai`) passes. That is the whole reason the check names
 *     three specific strings instead of the bare vendor name, and it is the
 *     case a future "just grep for the vendor" simplification would break.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NEEDLES, findRemovedProviderHits, main } from '../../../scripts/check-bundle-no-codex.mjs';

// Assembled from fragments for the same reason the script itself does it:
// this file must not be the thing that puts the forbidden literals back.
const VENDOR = 'cod' + 'ex';
const PROVIDER_ID = 'openai-' + VENDOR;
const BACKEND_HOST = 'chat' + 'gpt.com';
const ISSUER_HOST = 'auth.' + 'openai.com';

/** A bundle line that looks like the real thing, minus the removed provider. */
const CLEAN_BUNDLE = [
  'var PREDEFINED_PROVIDERS={anthropic:{id:"anthropic",baseUrl:"https://api.anthropic.com"}};',
  'var EGRESS_ALLOWLIST=new Set(["api.anthropic.com","api.openai.com"]);',
].join('\n');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-bundle-check-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function bundle(contents: string): string {
  const file = join(dir, 'main.js');
  writeFileSync(file, contents, 'utf8');
  return file;
}

describe('NEEDLES', () => {
  it('names the provider id and the two hosts it fetched, and nothing else', () => {
    expect(NEEDLES.map((n: { needle: string }) => n.needle).sort())
      .toEqual([ISSUER_HOST, BACKEND_HOST, PROVIDER_ID].sort());
  });
});

describe('findRemovedProviderHits — negative fixtures (the check must fire)', () => {
  it.each([
    ['the provider id', `var provider="${PROVIDER_ID}";`],
    ['the backend host', `fetch("https://${BACKEND_HOST}/backend-api/codex/responses");`],
    ['the OAuth issuer', `var ISSUER="https://${ISSUER_HOST}";`],
  ])('flags %s', (_label, line) => {
    const hits = findRemovedProviderHits(`${CLEAN_BUNDLE}\n${line}\n`);

    expect(hits).toHaveLength(1);
    expect(hits[0].hits).toBe(1);
    // The report has to say where to look, or the failure is unactionable.
    expect(hits[0].lines).toEqual([3]);
  });

  it('is case-insensitive, so a re-cased re-merge cannot slip through', () => {
    expect(findRemovedProviderHits(`var p="OpenAI-${VENDOR.toUpperCase()}";`)).toHaveLength(1);
  });

  it('counts every occurrence, not just the first', () => {
    const hits = findRemovedProviderHits(`"${PROVIDER_ID}" "${PROVIDER_ID}" "${PROVIDER_ID}"`);

    expect(hits[0].hits).toBe(3);
  });

  it('exits 1 on a bundle that carries the removed provider', () => {
    expect(main(bundle(`var provider="${PROVIDER_ID}";`))).toBe(1);
  });

  it('exits 1 when the bundle is missing (never reports a clean tree it did not read)', () => {
    expect(main(join(dir, 'does-not-exist.js'))).toBe(1);
  });
});

describe('findRemovedProviderHits — positive fixtures (the check must stay quiet)', () => {
  it('passes a clean bundle', () => {
    expect(findRemovedProviderHits(CLEAN_BUNDLE)).toEqual([]);
    expect(main(bundle(CLEAN_BUNDLE))).toBe(0);
  });

  // This is the fixture that justifies the three-needle shape. `@ai-sdk/openai`
  // ships these model ids in its id union and its JSDoc; they are ordinary
  // OpenAI Platform models reachable with an API key, unrelated to the removed
  // OAuth surface, and the plugin cannot drop them without vendoring the SDK.
  it('passes the OpenAI catalogue model ids that contain the vendor name', () => {
    const sdkModelIds = `type OpenAIModelId="gpt-5-${VENDOR}"|"gpt-5.1-${VENDOR}-max"|"gpt-5.3-${VENDOR}";`;

    expect(findRemovedProviderHits(`${CLEAN_BUNDLE}\n${sdkModelIds}\n`)).toEqual([]);
    expect(main(bundle(`${CLEAN_BUNDLE}\n${sdkModelIds}\n`))).toBe(0);
  });

  // `api.openai.com` is still fetched and still allowlisted; only the issuer
  // host went away. A needle that matched the shared suffix would fail the
  // build on a tree that is exactly right.
  it('passes the OpenAI API host that is still on the egress allowlist', () => {
    expect(findRemovedProviderHits('fetch("https://api.openai.com/v1/responses");')).toEqual([]);
  });

  // The migration marker is an on-disk key: it cannot be renamed without
  // replaying the scrub on every install, so it ships in the bundle and the
  // check has to tolerate it. That is the other reason for three needles.
  it('passes the migration marker whose key carries the vendor name', () => {
    expect(findRemovedProviderHits('settings._migrated_harden_codex_removed=true;')).toEqual([]);
  });
});
