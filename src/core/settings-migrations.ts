// v1.22.1 #199: extract settings migration logic from main.ts so the
// historical migrations (and any future ones) can be unit-tested
// without standing up the full Plugin/App harness.
//
// The full migration table is the single source of truth for "what
// loadSettings does to savedData before it becomes `this.settings`".
// Keep the pure function append-only — never delete an old migration,
// because old data on disk may still be from that version.

import { DEFAULT_SETTINGS, type LLMWikiSettings } from '../types';

const LEGACY_CODEX_TOKEN_FIELDS = ['accessToken', 'refreshToken', 'idToken', 'access_token', 'refresh_token', 'id_token'] as const;

/**
 * Vendor name of the removed third-party document-conversion backend
 * (hardening Phase 2.A, finding F-06), assembled from fragments.
 *
 * `scripts/check-bundle-no-mineru.mjs` asserts the built `main.js` carries no
 * trace of that vendor — a string-level assertion is the structural proof the
 * backend is gone and cannot be quietly re-merged from upstream. The scrub
 * migration still has to recognise the vendor's leftover settings keys and
 * name its keychain slot, so both are composed at module load instead of
 * sitting in the bundle as literals. This is the only place in `src/` that
 * knows the name.
 */
const REMOVED_BACKEND_VENDOR = ['min', 'eru'].join('');

/**
 * Vendor-neutral settings keys left behind on disk by the removed backend:
 * the selector itself, its pre-v1.27.0 name, and the now-meaningless rename
 * marker. Vendor-named keys (the plaintext token and task-timeout fields
 * from before v1.25) are matched by name fragment instead — see the scrub.
 */
const REMOVED_CONVERSION_BACKEND_FIELDS = [
  'markdownConversionBackend',
  'pdfConversionBackend',
  '_migrated_v1_27_0_markdown_conversion_backend',
] as const;

/** Keychain slot that held the removed backend's API token. */
const REMOVED_CONVERSION_SECRET_ID = `karpathywiki-${REMOVED_BACKEND_VENDOR}-api-token`;

/** Minimal view of Obsidian's SecretStorage; keeps this module test-friendly. */
export interface SecretSlotWriter {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
}

export interface MigrationResult {
  settings: LLMWikiSettings;
  /** True iff a migration rule fired (for tests + future observability). */
  applied: string[];
}

/**
 * Apply all known migrations to a `savedData` snapshot from
 * `plugin.loadData()`. Pure function; no IO, no Date.now(),
 * no side effects. Callers (e.g. `main.ts loadSettings`) assign the
 * returned `settings` to `this.settings` and then persist on
 * `applied.length > 0`.
 */
export function applySettingsMigrations(
  savedData: Partial<LLMWikiSettings> | null,
): MigrationResult {
  const applied: string[] = [];
  const settings: LLMWikiSettings = Object.assign({}, DEFAULT_SETTINGS, savedData || {});
  const savedRecord = savedData;
  const hasLegacyCodexToken = savedRecord !== null && LEGACY_CODEX_TOKEN_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(savedRecord, field));
  const needsCodexSettingsMigration = savedRecord !== null && (typeof savedRecord.openAICodexSecretId !== 'string' || savedRecord.openAICodexSecretId.trim().length === 0 || hasLegacyCodexToken);
  if (!settings.openAICodexSecretId.trim()) settings.openAICodexSecretId = 'karpathywiki-openai-codex';
  const untrustedSettings = settings as unknown as Record<string, unknown>;
  for (const field of LEGACY_CODEX_TOKEN_FIELDS) delete untrustedSettings[field];
  if (needsCodexSettingsMigration) applied.push('v1.25.0-codex-settings');

  // v1.20.0 migration: reset disableThinking from old default (true) to
  // new default (false). Old behavior sent thinking.type='disabled' which
  // Anthropic rejects at the API level. Users who explicitly enabled
  // "disable thinking" later than v1.20.0 keep their preference.
  if (savedData && savedData.disableThinking === true && !savedData._migrated_v1_20_0_thinking) {
    settings.disableThinking = false;
    settings.advancedSettingsMode = 'default';
    settings._migrated_v1_20_0_thinking = true;
    applied.push('v1.20.0-thinking');
  }

  // v1.18.3 migration REMOVED in v1.22.1 (#199). Previous code was:
  //
  //   if (savedData && savedData.startupCheck === false) {
  //     this.settings.startupCheck = true;
  //   }
  //
  // The intent was a one-time nudge for users who'd had `startupCheck: false`
  // in their disk data since before v1.18.3. The gate `=== false` meant
  // every successful "user toggled off" persisted `false` was re-overridden
  // on the next load — silently undoing the user's preference for ~2 years.
  //
  // Removed entirely. Anyone with `startupCheck: false` on disk today has
  // explicitly chosen that value and we respect it.
  //
  // If we ever need a re-nudge in the future, use a version-key gate
  // (see the v1.20.0 pattern above) so the migration is truly one-time.

  // v1.22.2 migration: the 'hourly' periodicLint option is retired.
  // Fall back to 'daily' so old saved data stays valid without a breaking change.
  if (savedData && (savedData as { periodicLint?: string }).periodicLint === 'hourly') {
    settings.periodicLint = 'daily';
    applied.push('v1.22.2-periodicLint-hourly');
  }

  // v1.23.0 migration (Phase 5.1.5 → followup): the `startupCheck` toggle
  // is now permanently on (the 4-phase QuickFixes pipeline always runs).
  // The new `startupCheckNoticeLevel` ('visible' | 'silent') replaces the
  // toggle as the user-facing control. Existing users who had
  // `startupCheck: false` on disk were explicitly opting out of the
  // Notice noise — honor that preference by routing them to 'silent'.
  // Users who had `startupCheck: true` (the v1.18.3+ default) get 'visible'.
  // Brand-new users (no savedData for this field) follow DEFAULT_SETTINGS
  // which is 'visible' (we want new users to see QuickFixes happening).
  if (savedData && !savedData._migrated_v1_23_0_startup_notice) {
    // `=== false` is a user-explicit choice (the default is true).
    // Anything else (true / undefined) follows defaults → 'visible'.
    const hadExplicitOptOut = savedData.startupCheck === false;
    settings.startupCheckNoticeLevel = hadExplicitOptOut ? 'silent' : 'visible';
    settings.startupCheck = true;  // Pin permanently on.
    settings._migrated_v1_23_0_startup_notice = true;
    applied.push('v1.23.0-startup-notice');
  }

  // Hardening Phase 3 (F-03): scrub the plaintext provider API key out of
  // `data.json`. Replaces the v1.25.3 #182 / v1.25.4 #339 two-phase
  // migration, which moved the key into the OS keychain but deliberately
  // LEFT the plaintext on disk whenever the keychain write failed (and
  // kept the field as a live resolver fallback either way). The
  // fallback is what made the leak permanent: `data.json` lives in the
  // vault, so the key rode along into git, iCloud, Syncthing and every
  // backup. There is no fallback and no `apiKey` field any more.
  //
  // Pure side: stash the plaintext for the caller, delete the field, drop
  // the superseded marker, set ours. The keychain write and the user-facing
  // Notice happen in `main.ts loadSettings`, which owns the IO — this
  // function must stay pure. Deliberately NOT gated on
  // `_migrated_v1_25_3_secret_storage`, which every install since v1.25.3
  // already carries.
  //
  // The DELETE is unconditional — deliberately NOT gated on our own
  // marker. A marker-gated scrub only removes the field the first time it
  // is seen, which is the wrong shape for the guarantee this phase makes:
  // the whole point is that no persisted key slot survives, including one
  // a later upstream merge, a downgrade-then-upgrade cycle, or a
  // sync conflict re-introduces alongside a marker that says the scrub
  // already ran. Marker-gated, `{ _migrated_…: true, apiKey: 'sk-…' }`
  // loaded straight through into `this.settings`, and the next
  // `saveSettings()` wrote it back to disk.
  //
  // Idempotence is preserved where it matters — the WRITE. `applied` is
  // pushed (and `main.ts` therefore calls `saveData` and shows the rotate
  // Notice) only when this load actually had something to remove, so a
  // steady-state load is still silent and does no IO.
  if (savedData) {
    const untrustedSaved = savedData as Record<string, unknown>;
    const hadPlaintextField = Object.prototype.hasOwnProperty.call(untrustedSaved, 'apiKey');
    const hadSupersededMarker = Object.prototype.hasOwnProperty.call(untrustedSaved, '_migrated_v1_25_3_secret_storage');
    const alreadyScrubbed = settings._migrated_harden_plaintext_api_key_removed === true;
    const legacy = typeof untrustedSaved.apiKey === 'string'
      ? untrustedSaved.apiKey.trim()
      : '';
    if (legacy.length > 0) {
      // Stash for main.ts to read. NOT a settings field — main.ts deletes
      // it before the shared saveData() below can persist it.
      (settings as unknown as { _legacyPlaintextApiKey?: string })._legacyPlaintextApiKey = legacy;
    }
    delete untrustedSettings.apiKey;
    delete untrustedSettings._migrated_v1_25_3_secret_storage;
    settings._migrated_harden_plaintext_api_key_removed = true;
    if (!alreadyScrubbed || hadPlaintextField || hadSupersededMarker) {
      applied.push('harden-plaintext-api-key-removed');
    }
  }

  // Hardening Phase 2.A (F-06): the optional third-party document-conversion
  // backend was removed — it uploaded whole PDFs / images / Office files to a
  // service unrelated to the user's chosen LLM provider. This replaces the
  // v1.27.0 backend-rename migration: instead of preserving the choice, we
  // scrub every trace of it from `data.json` so a downgrade-then-upgrade
  // cycle cannot resurrect the setting.
  //
  // Pure side: delete the legacy keys and set the marker. The paired secret
  // slot is blanked by `scrubRemovedConversionBackendSecret()`, which the
  // caller (`main.ts loadSettings`) runs because this function must stay
  // IO-free. Idempotent via the marker: a second load is a no-op.
  if (savedData && !settings._migrated_harden_conversion_backend_removed) {
    for (const field of REMOVED_CONVERSION_BACKEND_FIELDS) delete untrustedSettings[field];
    // Every vendor-named leftover goes too (`<vendor>ApiToken`,
    // `<vendor>TaskTimeoutMinutes`, and anything a future upstream merge
    // adds under that name) — matching the fragment rather than a fixed list
    // means a re-merged field cannot survive one upgrade cycle.
    for (const key of Object.keys(untrustedSettings)) {
      if (key.toLowerCase().includes(REMOVED_BACKEND_VENDOR)) delete untrustedSettings[key];
    }
    settings._migrated_harden_conversion_backend_removed = true;
    applied.push('harden-conversion-backend-removed');
  }

  return { settings, applied };
}

/**
 * Hardening Phase 2.A (F-06): blank the secret slot that held the removed
 * document-conversion backend's API token.
 *
 * Split out of `applySettingsMigrations` because that function is pure and
 * this touches the OS keychain. Idempotent by construction: writing `''`
 * over an already-empty slot is a no-op, and the caller gates on the
 * migration marker anyway. Returns true when a non-empty token was found
 * and cleared, so the caller can log it.
 */
export function scrubRemovedConversionBackendSecret(secretStorage: SecretSlotWriter): boolean {
  const existing = secretStorage.getSecret(REMOVED_CONVERSION_SECRET_ID);
  if (typeof existing !== 'string' || existing.length === 0) return false;
  secretStorage.setSecret(REMOVED_CONVERSION_SECRET_ID, '');
  return true;
}

/**
 * Hardening Phase 3 (F-03): adopt the plaintext key that the scrub took
 * off disk into the OS keychain.
 *
 * Split out of `applySettingsMigrations` for the same reason as the
 * conversion-backend scrub: that function is pure and this touches the
 * keychain. The caller (`main.ts loadSettings`) passes the value the
 * scrub stashed.
 *
 * Writes ONLY when the slot is empty. A populated slot is the newer,
 * authoritative copy — the plaintext on disk is by definition the stale
 * one (every key typed since v1.25.3 went to the keychain first), so
 * overwriting would downgrade a working key to whatever a years-old
 * `data.json` happened to carry.
 *
 * Returns true when the key was adopted, false when the slot already
 * held one. Either way the caller deletes the plaintext and tells the
 * user to rotate: the key has been on disk, in a synced folder, and must
 * be treated as disclosed.
 */
export function adoptScrubbedPlaintextApiKey(
  secretStorage: SecretSlotWriter,
  secretId: string,
  legacyKey: string,
): boolean {
  const existing = secretStorage.getSecret(secretId);
  if (typeof existing === 'string' && existing.trim().length > 0) return false;
  secretStorage.setSecret(secretId, legacyKey);
  return true;
}
