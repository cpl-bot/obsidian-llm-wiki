// v1.25.3 #182: tests for the central API-key resolver. Mirrors the
// provider-secret-store.test.ts backend factory shape.
//
// Hardening Phase 3 (F-03): the on-disk plaintext tier these tests used
// to exercise is gone — there is no on-disk slot to fall back to. What
// replaces those cases is the fail-closed contract: `''` means "no key
// configured", a throw means "the keychain could not be read".

import { describe, expect, it } from 'vitest';
import { resolveProviderApiKey, resolveInitialApiKey, MISSING_STORE_MESSAGE } from '../../llm-sdk/provider-api-key-resolver';
import { ProviderSecretStorageError, type ProviderSecretStorage } from '../../llm-sdk/provider-secret-store';

function backendWith(raw?: string): ProviderSecretStorage {
  const values = new Map<string, string>();
  if (raw !== undefined) values.set('karpathywiki-provider-api-key', raw);
  return {
    getSecret: (id) => values.get(id) ?? null,
    setSecret: (id, value) => { values.set(id, value); },
  };
}

function throwingBackend(message = 'keychain locked'): ProviderSecretStorage {
  return {
    getSecret: () => { throw new Error(message); },
    setSecret: () => {},
  };
}

const SETTINGS = { providerApiKeySecretId: 'karpathywiki-provider-api-key' };

describe('resolveProviderApiKey (#182)', () => {
  it('returns the trimmed SecretStorage value when present', () => {
    expect(resolveProviderApiKey(SETTINGS, backendWith('  sk-secret-123  '))).toBe('sk-secret-123');
  });

  it('returns empty string when the slot is empty', () => {
    expect(resolveProviderApiKey(SETTINGS, backendWith())).toBe('');
  });

  it('returns empty string when the slot holds only whitespace', () => {
    expect(resolveProviderApiKey(SETTINGS, backendWith('   '))).toBe('');
  });

});

// Hardening Phase 3 (F-03), review follow-up. "The store is missing" used
// to resolve to '' — indistinguishable from "the slot is empty". It is not
// the same thing: `manifest.minAppVersion` is 1.11.4 and
// `App.secretStorage` is `@since 1.11.4`, so the API exists on every
// Obsidian build this plugin is allowed to load into. A missing store is a
// broken host, and answering '' would tell the user to paste their key
// into something that is not there.
describe('resolveProviderApiKey with no SecretStorage at all (hardening Phase 3)', () => {
  it('throws ProviderSecretStorageError instead of reporting "no key configured"', () => {
    expect(() => resolveProviderApiKey(SETTINGS, null)).toThrow(ProviderSecretStorageError);
    expect(() => resolveProviderApiKey(SETTINGS, undefined)).toThrow(ProviderSecretStorageError);
  });

  it('says the store is unavailable, not that the slot is empty', () => {
    try {
      resolveProviderApiKey(SETTINGS, null);
      expect.unreachable('an absent store must fail closed');
    } catch (error) {
      expect((error as ProviderSecretStorageError).message).toBe(MISSING_STORE_MESSAGE);
    }
  });

  it('never returns a value on the absent-store path', () => {
    let returned: string | undefined;
    try {
      returned = resolveProviderApiKey(SETTINGS, undefined);
    } catch {
      returned = undefined;
    }
    expect(returned).toBeUndefined();
  });
});

// Hardening Phase 3 (F-03). The old behaviour swallowed a getSecret throw
// and returned the plaintext key mirrored in data.json — the exact
// path that kept a live key mirrored inside the (synced) vault. With the
// mirror deleted, swallowing the throw would report "no key configured"
// for a machine whose keychain is merely locked, and invite the user to
// paste the key into a store that cannot hold it.
describe('resolveProviderApiKey fail-closed contract (hardening Phase 3)', () => {
  it('rethrows a getSecret failure as ProviderSecretStorageError instead of returning null/empty', () => {
    expect(() => resolveProviderApiKey(SETTINGS, throwingBackend('Secret Service is not running')))
      .toThrow(ProviderSecretStorageError);
  });

  it('preserves the platform error message on the wrapper', () => {
    try {
      resolveProviderApiKey(SETTINGS, throwingBackend('Secret Service is not running'));
      expect.unreachable('resolver must not resolve when the keychain read fails');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderSecretStorageError);
      expect((error as ProviderSecretStorageError).message).toBe('Secret Service is not running');
    }
  });

  it('never returns a value on the throwing path (no silent degradation)', () => {
    let returned: string | undefined;
    try {
      returned = resolveProviderApiKey(SETTINGS, throwingBackend());
    } catch {
      returned = undefined;
    }
    expect(returned).toBeUndefined();
  });
});

// Bug fix (#v1.25.7): pendingKey wins over SecretStorage so a freshly-typed
// key in the Settings UI is honored immediately by Fetch Models / Test
// Connection, instead of being silently overridden by the stale
// SecretStorage value from the previously-active provider.
describe('pendingKey (in-memory typed buffer)', () => {
  it('returns trimmed pendingKey when non-empty, ignoring SecretStorage', () => {
    expect(
      resolveProviderApiKey(SETTINGS, backendWith('sk-stale-from-old-provider'), '  sk-new-typed  '),
    ).toBe('sk-new-typed');
  });

  it('falls through to SecretStorage when pendingKey is undefined', () => {
    expect(resolveProviderApiKey(SETTINGS, backendWith('sk-stored'), undefined)).toBe('sk-stored');
  });

  it('falls through to SecretStorage when pendingKey is empty string', () => {
    expect(resolveProviderApiKey(SETTINGS, backendWith('sk-stored'), '')).toBe('sk-stored');
  });

  it('falls through to SecretStorage when pendingKey is whitespace-only', () => {
    expect(resolveProviderApiKey(SETTINGS, backendWith('sk-stored'), '   ')).toBe('sk-stored');
  });

  it('returns empty string when both the buffer and the slot are empty', () => {
    expect(resolveProviderApiKey(SETTINGS, backendWith(), undefined)).toBe('');
  });

  // The short-circuit is what keeps Test Connection usable on a machine
  // whose keychain is broken: the typed key is answered from memory and
  // the keychain is never touched, so it cannot throw.
  it('short-circuits before the keychain read, so a broken keychain does not throw', () => {
    expect(resolveProviderApiKey(SETTINGS, throwingBackend(), 'sk-typed')).toBe('sk-typed');
  });
});

describe('resolveInitialApiKey (Settings UI paint)', () => {
  it('prefers the typed buffer over the stored key', () => {
    expect(resolveInitialApiKey('  sk-typed  ', SETTINGS, backendWith('sk-stored'))).toBe('sk-typed');
  });

  it('paints the stored key when the buffer is empty', () => {
    expect(resolveInitialApiKey('', SETTINGS, backendWith('  sk-stored  '))).toBe('sk-stored');
  });

  it('paints an empty box when the slot is empty', () => {
    expect(resolveInitialApiKey('', SETTINGS, backendWith())).toBe('');
  });

  it('throws rather than painting a blank box when there is no store at all', () => {
    expect(() => resolveInitialApiKey('', SETTINGS, null)).toThrow(ProviderSecretStorageError);
  });

  it('throws rather than painting a blank box when the keychain is unreadable', () => {
    expect(() => resolveInitialApiKey('', SETTINGS, throwingBackend())).toThrow(ProviderSecretStorageError);
  });
});
