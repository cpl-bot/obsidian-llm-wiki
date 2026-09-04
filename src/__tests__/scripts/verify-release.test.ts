/**
 * Tests for the pure helpers in `scripts/verify-release.mjs`
 * (HARDENING-PLAN Phase 6.5 — F-01).
 *
 * `parseOwnerRepo` decides where the tool downloads a release artifact from.
 * Getting it wrong on an unfamiliar remote shape would either 404 confusingly
 * or, worse, silently point the comparison at somebody else's repository — a
 * "verified" result that verified nothing. It therefore refuses to guess: a
 * non-GitHub or unparseable remote throws instead of producing a URL.
 */

import { describe, it, expect } from 'vitest';
import {
  VerifyReleaseError,
  parseOwnerRepo,
  releaseAssetUrl,
} from '../../../scripts/verify-release.mjs';

describe('parseOwnerRepo', () => {
  it.each([
    ['https://github.com/cpl-bot/obsidian-llm-wiki.git'],
    ['https://github.com/cpl-bot/obsidian-llm-wiki'],
    ['ssh://git@github.com/cpl-bot/obsidian-llm-wiki.git'],
    ['git@github.com:cpl-bot/obsidian-llm-wiki.git'],
    ['git@github.com:cpl-bot/obsidian-llm-wiki'],
    ['git://github.com/cpl-bot/obsidian-llm-wiki.git'],
  ])('reads owner/repo from %s', (url) => {
    expect(parseOwnerRepo(url)).toEqual({ owner: 'cpl-bot', repo: 'obsidian-llm-wiki' });
  });

  it('tolerates the trailing newline `git remote get-url` emits', () => {
    expect(parseOwnerRepo('https://github.com/cpl-bot/obsidian-llm-wiki.git\n'))
      .toEqual({ owner: 'cpl-bot', repo: 'obsidian-llm-wiki' });
  });

  it('refuses a non-GitHub remote rather than building a wrong URL', () => {
    expect(() => parseOwnerRepo('https://gitlab.com/cpl-bot/obsidian-llm-wiki.git'))
      .toThrow(VerifyReleaseError);
    expect(() => parseOwnerRepo('git@codeberg.org:cpl-bot/obsidian-llm-wiki.git'))
      .toThrow(/not github\.com/);
  });

  it('refuses an empty or unparseable remote', () => {
    expect(() => parseOwnerRepo('')).toThrow(/empty/);
    expect(() => parseOwnerRepo('   ')).toThrow(/empty/);
    expect(() => parseOwnerRepo('not a url')).toThrow(VerifyReleaseError);
  });

  it('refuses a GitHub URL with no repository path', () => {
    expect(() => parseOwnerRepo('https://github.com/cpl-bot')).toThrow(/owner\/repo/);
  });
});

describe('releaseAssetUrl', () => {
  it('builds the public download URL for an asset', () => {
    expect(releaseAssetUrl({
      owner: 'cpl-bot',
      repo: 'obsidian-llm-wiki',
      tag: 'v1.27.0',
      asset: 'main.js',
    })).toBe('https://github.com/cpl-bot/obsidian-llm-wiki/releases/download/v1.27.0/main.js');
  });

  it('escapes a tag that contains URL-significant characters', () => {
    expect(releaseAssetUrl({
      owner: 'cpl-bot',
      repo: 'obsidian-llm-wiki',
      tag: 'release/1.0',
      asset: 'SHA256SUMS',
    })).toContain('/releases/download/release%2F1.0/SHA256SUMS');
  });

  it('refuses to build a URL with a missing part', () => {
    expect(() => releaseAssetUrl({
      owner: 'cpl-bot',
      repo: 'obsidian-llm-wiki',
      tag: '',
      asset: 'main.js',
    })).toThrow(/missing tag/);
  });
});
