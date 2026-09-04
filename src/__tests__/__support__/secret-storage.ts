// Hardening Phase 3 (F-03): shared SecretStorage stubs for tests.
//
// Why this exists. `resolveProviderApiKey` fails closed when there is no
// store at all — `manifest.minAppVersion` is 1.11.4 and `App.secretStorage`
// is `@since 1.11.4`, so an absent store is a broken host, not an empty
// slot. Fixtures that used to omit the store were therefore exercising a
// path production can never reach. These helpers give them a real store
// whose contents the test controls.

import type { ProviderSecretStorage } from '../../llm-sdk/provider-secret-store';

/**
 * A working keychain with nothing in it — the "user has not typed a key
 * yet" state. Reads return null; writes are kept so a test can assert on
 * what was stored.
 */
export function emptySecretStorage(): ProviderSecretStorage {
  const values = new Map<string, string>();
  return {
    getSecret: (id: string) => values.get(id) ?? null,
    setSecret: (id: string, value: string) => { values.set(id, value); },
  };
}

/** A working keychain holding `value` in every slot the test reads. */
export function secretStorageWith(value: string): ProviderSecretStorage {
  const values = new Map<string, string>();
  return {
    getSecret: (id: string) => values.get(id) ?? value,
    setSecret: (id: string, next: string) => { values.set(id, next); },
  };
}
