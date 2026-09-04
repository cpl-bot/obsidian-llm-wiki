// v1.25.3 #182: small helper that resolves the effective provider API
// key from Obsidian SecretStorage (the OS keychain).
//
// Hardening Phase 3 (F-03): the legacy on-disk plaintext tier is gone.
// The plugin used to mirror the key into `data.json`, which follows the
// vault into git / iCloud / Syncthing / backups. There is no on-disk
// slot left to fall back to, so this helper now has exactly two
// outcomes: a key, or a reason there is none.
//
// Why a helper instead of inline `getSecret(...)` at every call site:
//   - 7+ call sites need the same precedence — centralizing avoids
//     drift (one site forgets to trim, one forgets to handle null, one
//     re-introduces a fallback)
//   - Tests can mock the helper instead of stubbing app.secretStorage
//     in every fixture
//   - Future migrations (e.g. per-provider secretIds) only need to
//     touch this one file

import { ProviderSecretStorageError, type ProviderSecretStorage } from './provider-secret-store';

/**
 * Message carried by the fail-closed throw when `app.secretStorage` is
 * missing entirely. Exported so callers' tests can assert on the reason
 * without matching a literal in two places.
 */
export const MISSING_STORE_MESSAGE = 'Obsidian SecretStorage is unavailable on this host';

/**
 * Minimal settings shape the resolver needs. Avoids pulling the full
 * LLMWikiSettings type so the helper can be reused by callers that
 * only know the relevant subset (tests, isolated modules).
 */
export interface ApiKeySettings {
  providerApiKeySecretId: string;
}

/**
 * Resolve the effective provider API key.
 *
 * Order:
 *   1. pendingKey (optional in-memory buffer). When the user types a new key
 *      into the Settings UI, `tab.pendingApiKey` holds the pending value
 *      until `hide()` flushes it to SecretStorage. Callers that want to
 *      honor a freshly-typed key immediately (e.g. "Fetch Models" /
 *      "Test Connection" buttons) pass it as the 3rd argument so the
 *      user's intent isn't silently overridden by the stale SecretStorage
 *      value left over from the previously-active provider. A
 *      whitespace-only or undefined pendingKey falls through.
 *   2. SecretStorage.getSecret(providerApiKeySecretId) — trimmed,
 *      non-empty → returned as-is.
 *   3. '' — the slot is empty; caller treats as "no key configured".
 *
 * Hardening Phase 3 (F-03) — fail-closed contract:
 *   - `''`  means "no key configured" (recoverable: type one).
 *   - a thrown `ProviderSecretStorageError` means "the keychain could
 *     not be read"; LLM features stay disabled until it can be. The
 *     previous behaviour swallowed the throw and fell through to the
 *     plaintext key mirrored on disk. That mirror no longer exists, and
 *     inventing a confident `''` in its place would tell the user their
 *     key vanished.
 *
 * A non-empty `pendingKey` short-circuits before any keychain read, so
 * the Settings UI can still test a freshly-typed key on a machine whose
 * keychain is broken — it just cannot persist it.
 *
 * @param settings - the LLMWikiSettings-like object (only
 *   `providerApiKeySecretId` is read).
 * @param secretStorage - the live Obsidian SecretStorage. `manifest.json`
 *   pins `minAppVersion` to 1.11.4 and `App.secretStorage` is `@since
 *   1.11.4`, so on every Obsidian build this plugin is allowed to load
 *   into, the store EXISTS. An absent store is therefore not "this
 *   environment has no keychain" — it is the same class of anomaly as a
 *   keychain that refuses to answer, and it fails closed the same way:
 *   `ProviderSecretStorageError`, never a confident ''. Returning '' here
 *   would report "no key configured" and invite the user to paste their
 *   key into a store that is not there.
 * @param pendingKey - optional in-memory buffer (Settings UI's
 *   `pendingApiKey`). When non-empty (after trim) it wins over
 *   SecretStorage. Pass `undefined` to skip this tier entirely.
 * @throws ProviderSecretStorageError when the keychain read fails, or when
 *   there is no SecretStorage to read at all.
 */
export function resolveProviderApiKey(
  settings: ApiKeySettings,
  secretStorage: ProviderSecretStorage | null | undefined,
  pendingKey?: string,
): string {
  const pending = pendingKey?.trim();
  if (pending) return pending;
  if (secretStorage === null || secretStorage === undefined) {
    // Fail closed, same as a throwing store. See the @param note above:
    // minAppVersion guarantees the API exists, so its absence is a broken
    // host, not an empty slot.
    throw new ProviderSecretStorageError(undefined, MISSING_STORE_MESSAGE);
  }
  let raw: string | null;
  try {
    raw = secretStorage.getSecret(settings.providerApiKeySecretId);
  } catch (error: unknown) {
    throw new ProviderSecretStorageError(error, error instanceof Error ? error.message : undefined);
  }
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Resolve the initial value for the Settings UI's API Key input field.
 *
 * Same precedence as `resolveProviderApiKey`. Used by
 * `provider-section.ts` so the input's `setValue` honors the user's
 * freshly-typed key across `tab.display()` re-renders. Without this
 * precedence, every Fetch Models / Test Connection / provider dropdown
 * change would clobber the typed value with the stale SecretStorage key
 * from the previously-active provider.
 *
 * Inherits the fail-closed contract: a broken keychain throws rather
 * than painting a blank box that reads as "your key is gone". The
 * caller (provider-section) turns that into the keychain Notice.
 *
 * @param pendingKey - the Settings UI's in-memory typed buffer
 *   (`tab.pendingApiKey`).
 * @param settings - only `providerApiKeySecretId` is read.
 * @param secretStorage - the live Obsidian SecretStorage.
 * @returns the trimmed key to paint into the input, or '' when nothing
 *   is configured.
 * @throws ProviderSecretStorageError when the keychain read fails, or when
 *   there is no SecretStorage to read at all.
 */
export function resolveInitialApiKey(
  pendingKey: string,
  settings: ApiKeySettings,
  secretStorage: ProviderSecretStorage | null | undefined,
): string {
  return resolveProviderApiKey(settings, secretStorage, pendingKey);
}
