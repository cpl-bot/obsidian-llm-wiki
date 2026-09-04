/**
 * v1.25.7 PATCH regression test for the "API key self-restore" bug.
 *
 * Bug: when switching LLM providers in the Settings tab, any key the user
 * typed into the API Key input was silently overwritten by the stale
 * SecretStorage value from the previously-active provider on every
 * `tab.display()` re-render. Two independent causes were fixed:
 *
 *   1. provider-section.ts input initial value (now `resolveInitialApiKey`):
 *      a non-empty typed buffer wins over SecretStorage. Without this,
 *      every re-render painted the OLD provider's key over the
 *      freshly-typed value. (Hardening Phase 3 (F-03) moved that buffer
 *      off the settings object to `LLMWikiSettingTab.pendingApiKey`, so
 *      it is now the helper's first argument.)
 *   2. resolveProviderApiKey gained an optional `pendingKey` parameter
 *      that wins over SecretStorage. Wired into Fetch Models /
 *      Test Connection / createLLMClient so the freshly-typed key
 *      reaches the wire.
 *
 * This file pins both contracts by calling the production helpers
 * directly (no mirror, no drift risk).
 */

import { describe, it, expect } from 'vitest';
import {
  resolveProviderApiKey,
  resolveInitialApiKey,
} from '../../llm-sdk/provider-api-key-resolver';
import { ProviderSecretStorageError, type ProviderSecretStorage } from '../../llm-sdk/provider-secret-store';

const SETTINGS = { providerApiKeySecretId: 'karpathywiki-provider-api-key' };

function backendWith(raw?: string): ProviderSecretStorage {
  const values = new Map<string, string>();
  if (raw !== undefined) values.set('karpathywiki-provider-api-key', raw);
  return {
    getSecret: (id) => values.get(id) ?? null,
    setSecret: (id, value) => { values.set(id, value); },
  };
}

describe('v1.25.7 PATCH: resolveInitialApiKey input precedence', () => {
  it('prefers the typed buffer over SecretStorage (typed key survives re-render)', () => {
    expect(
      resolveInitialApiKey('sk-cp-minimax-xxx', SETTINGS, backendWith('sk-deepseek-old')),
    ).toBe('sk-cp-minimax-xxx');
  });

  it('falls back to SecretStorage when the typed buffer is empty', () => {
    expect(
      resolveInitialApiKey('', SETTINGS, backendWith('sk-stored')),
    ).toBe('sk-stored');
  });

  it('falls back to SecretStorage when the typed buffer is whitespace-only', () => {
    expect(
      resolveInitialApiKey('   ', SETTINGS, backendWith('sk-stored')),
    ).toBe('sk-stored');
  });

  it('returns empty string when both sources are empty', () => {
    expect(
      resolveInitialApiKey('', SETTINGS, backendWith()),
    ).toBe('');
  });

  // Hardening Phase 3 (F-03), review follow-up: an ABSENT store is not
  // "no key". `manifest.minAppVersion` is 1.11.4 and `App.secretStorage`
  // is `@since 1.11.4`, so the API exists on every build this plugin can
  // load into — its absence is a broken host and fails closed like a
  // throwing keychain, rather than painting an empty box that reads as
  // "your key is gone".
  it('throws rather than painting an empty box when there is no SecretStorage at all', () => {
    expect(() => resolveInitialApiKey('', SETTINGS, null)).toThrow(ProviderSecretStorageError);
  });

  it('trims whitespace from the typed buffer', () => {
    expect(
      resolveInitialApiKey('  sk-cp-new  ', SETTINGS, backendWith('sk-stored')),
    ).toBe('sk-cp-new');
  });

  // Hardening Phase 3 (F-03) inverted this case. Painting '' for a locked
  // keychain told the user their key was gone and invited them to retype
  // it into a store that could not accept it; provider-section now catches
  // the throw and says "keychain unavailable" instead.
  it('throws on a locked keychain instead of painting an empty box', () => {
    const broken: ProviderSecretStorage = {
      getSecret: () => { throw new Error('keychain locked'); },
      setSecret: () => {},
    };
    expect(() => resolveInitialApiKey('', SETTINGS, broken)).toThrow('keychain locked');
  });
});

describe('v1.25.7 PATCH: resolveProviderApiKey pendingKey precedence', () => {
  it('returns typed key (pendingKey wins over SecretStorage)', () => {
    expect(
      resolveProviderApiKey(SETTINGS, backendWith('sk-stored'), 'sk-typed'),
    ).toBe('sk-typed');
  });

  it('returns typed key when pendingKey is set even with valid SecretStorage', () => {
    // The scenario the bug describes: switch from deepseek to minimax,
    // type new key. SecretStorage still has the deepseek key.
    expect(
      resolveProviderApiKey(SETTINGS, backendWith('sk-deepseek-stale'), 'sk-minimax-new'),
    ).toBe('sk-minimax-new');
  });

  it('falls through to SecretStorage when pendingKey is empty (no pending edit)', () => {
    expect(
      resolveProviderApiKey(SETTINGS, backendWith('sk-stored'), ''),
    ).toBe('sk-stored');
  });

  it('end-to-end: switch provider + type new key → request uses new key', () => {
    // Mirror the full UI sequence:
    //   1. User switches provider from deepseek to minimax
    //   2. SecretStorage still has the deepseek key (last flush)
    //   3. User types new key into input
    //   4. Re-render triggered (display())
    //   5. Input value should be the typed key, not the stored key
    const stored = 'sk-deepseek-old';
    const typed = 'sk-cp-minimax-xxx';
    const inputValue = resolveInitialApiKey(typed, SETTINGS, backendWith(stored));
    expect(inputValue).toBe(typed);

    //   6. User clicks Fetch Models — resolver should use typed key
    const effectiveApiKey = resolveProviderApiKey(SETTINGS, backendWith(stored), typed);
    expect(effectiveApiKey).toBe(typed);
  });
});