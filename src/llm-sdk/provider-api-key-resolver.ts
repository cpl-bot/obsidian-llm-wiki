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
 * @param secretStorage - the live Obsidian SecretStorage, or null/undefined
 *   in environments where it's not available (some unit tests, server-side
 *   fixtures). With no store there is no source at all, so the result is
 *   ''. That is distinct from a store that exists and fails to answer,
 *   which throws — "there is no keychain here" and "the keychain is
 *   broken" are different situations for the user.
 * @param pendingKey - optional in-memory buffer (Settings UI's
 *   `pendingApiKey`). When non-empty (after trim) it wins over
 *   SecretStorage. Pass `undefined` to skip this tier entirely.
 * @throws ProviderSecretStorageError when the keychain read fails.
 */
export function resolveProviderApiKey(
  settings: ApiKeySettings,
  secretStorage: ProviderSecretStorage | null | undefined,
  pendingKey?: string,
): string {
  const pending = pendingKey?.trim();
  if (pending) return pending;
  if (secretStorage === null || secretStorage === undefined) return '';
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
 * @param secretStorage - the live Obsidian SecretStorage, or null/undefined.
 * @returns the trimmed key to paint into the input, or '' when nothing
 *   is configured.
 * @throws ProviderSecretStorageError when the keychain read fails.
 */
export function resolveInitialApiKey(
  pendingKey: string,
  settings: ApiKeySettings,
  secretStorage: ProviderSecretStorage | null | undefined,
): string {
  return resolveProviderApiKey(settings, secretStorage, pendingKey);
}
