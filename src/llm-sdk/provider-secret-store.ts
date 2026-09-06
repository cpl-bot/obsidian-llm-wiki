// v1.25.3 #182: Persistent API key storage via Obsidian SecretStorage
// (OS keychain). Stores a single string rather than a structured
// credential object.
//
// Why this exists:
//   - Provider API keys previously lived in plain text inside data.json.
//     The user's vault often gets backed up to git/cloud-sync, which leaks
//     secrets. Obsidian's SecretStorage delegates to the OS credential
//     manager (macOS Keychain / Windows Credential Manager / Linux
//     Secret Service) and is encrypted at rest with hardware keys.
//   - One secretId across providers is enough: the user's *active*
//     provider is recorded in `settings.provider`. Switching providers
//     overwrites the same secret slot — only the most-recently-used
//     key needs to survive a restart in practice (LLM Wiki re-prompts
//     for a key when the slot is empty, same as before).

/**
 * v1.25.3 #182: minimal storage primitive matching Obsidian's
 * `App.secretStorage` surface (`getSecret(id)` / `setSecret(id, value)`).
 *
 * Hardening Phase 2.B: this interface used to be declared by the removed
 * OAuth module and re-exported from here. It is now defined in this file,
 * which is the single home of the SecretStorage contract for every
 * credential store in the plugin.
 */
export interface SecretStorageLike {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

/** Alias kept for the provider-key call sites that already use this name. */
export type ProviderSecretStorage = SecretStorageLike;

/**
 * v1.25.3 #182: provider-API-key storage contract. `load` returns the
 * trimmed key or null, `save` and `clear` are side-effecting, `hasKey`
 * is the cheap probe.
 */
export interface ProviderSecretStoreLike {
  load(): string | null;
  save(key: string): void;
  clear(): void;
  hasKey(): boolean;
}

/**
 * v1.25.4 #339: typed error for SecretStorage platform failures (macOS
 * Keychain access denied / Linux Secret Service unavailable or timed
 * out). Surfaces as a constructor so callers can `instanceof` without
 * coupling to the underlying OS error message, which varies by platform.
 *
 * Hardening Phase 3 (F-03): this is now thrown on the READ path too —
 * see `ProviderSecretStore.load()`. `isProviderSecretStorageError` is
 * the boundary-friendly predicate for callers that only want to turn it
 * into a Notice.
 */
export class ProviderSecretStorageError extends Error {
  constructor(public readonly cause: unknown, message = 'SecretStorage IO failed') {
    super(message);
    this.name = 'ProviderSecretStorageError';
  }
}

export class ProviderSecretStore implements ProviderSecretStoreLike {
  constructor(
    private readonly storage: ProviderSecretStorage,
    private readonly secretId: string,
  ) {}

  /**
   * Read the stored key, trim whitespace, and return null when nothing
   * is configured (null / empty / whitespace-only). Callers receive a
   * normalized value they can pass directly to the LLM SDK.
   *
   * Hardening Phase 3 (F-03): the read path is now **fail-closed**. The
   * two outcomes are distinct and neither of them is "use a value from
   * disk":
   *
   *   - `null`  → the slot is empty. No key is configured; the user has
   *     to type one. This is a normal, recoverable state.
   *   - throw `ProviderSecretStorageError` → the keychain itself could
   *     not be read (locked, denied, no Secret Service daemon). LLM
   *     features stay disabled until it works again.
   *
   * v1.25.4 #339 swallowed the throw and returned null so the resolver
   * fell through to the plaintext key mirrored in `data.json`. That mirror
   * is gone (it synced the key into every vault backup), so swallowing the
   * throw would now silently read as "no key configured" and invite the
   * user to paste the key again — into a keychain that cannot store it.
   * Surfacing the failure is the only honest answer.
   */
  load(): string | null {
    let raw: string | null;
    try {
      raw = this.storage.getSecret(this.secretId);
    } catch (error: unknown) {
      throw wrapStorageError(error);
    }
    if (raw === null || raw === undefined) return null;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  /**
   * Persist a key. Whitespace-only or empty input is normalized to a
   * clear: `''` is written to the secretId rather than deleting it, which
   * keeps the slot registered with the OS credential manager.
   *
   * v1.25.4 #339: rethrows setSecret platform throws as
   * `ProviderSecretStorageError`. Silent-skip would drop the user-typed
   * key on the floor — the documented #339 failure mode. Callers must
   * decide whether to surface a Notice, retry, or refuse the save.
   */
  save(key: string): void {
    const trimmed = (key ?? '').trim();
    try {
      this.storage.setSecret(this.secretId, trimmed.length === 0 ? '' : trimmed);
    } catch (error: unknown) {
      throw wrapStorageError(error);
    }
  }

  /**
   * Erase the stored key. Writes an empty string to keep the secretId
   * slot registered with the OS credential manager — Obsidian's
   * SecretStorage doesn't expose a delete API, so empty-string is the
   * canonical "clear".
   *
   * v1.25.4 #339: same throw contract as `save()`.
   */
  clear(): void {
    try {
      this.storage.setSecret(this.secretId, '');
    } catch (error: unknown) {
      throw wrapStorageError(error);
    }
  }

  /**
   * Cheap "is a key configured" probe. Inherits `load()`'s fail-closed
   * contract: a keychain that cannot be read throws rather than
   * reporting a confident `false`.
   */
  hasKey(): boolean {
    return this.load() !== null;
  }
}

function wrapStorageError(cause: unknown): ProviderSecretStorageError {
  return new ProviderSecretStorageError(cause, cause instanceof Error ? cause.message : undefined);
}
/**
 * Hardening Phase 3 (F-03): narrow an unknown catch value to the typed
 * keychain failure. Exists so UI boundaries can tell "keychain is
 * unavailable" (show the keychain Notice, keep LLM features disabled)
 * apart from every other error, without importing the class only to
 * write `instanceof` at eight call sites.
 */
export function isProviderSecretStorageError(error: unknown): error is ProviderSecretStorageError {
  return error instanceof ProviderSecretStorageError;
}
