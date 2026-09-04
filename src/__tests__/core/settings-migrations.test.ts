import { describe, it, expect, vi } from 'vitest';
import { applySettingsMigrations } from '../../core/settings-migrations';

describe('applySettingsMigrations — historical (#199 regression guard)', () => {
  it('uses the stable Codex secret ID for new settings', () => {
    expect(applySettingsMigrations(null).settings.openAICodexSecretId).toBe('karpathywiki-openai-codex');
  });

  it('preserves the old provider while clearing the legacy plaintext API key (v1.25.3 #182 migration, v1.25.4 #339 phase-1-only)', async () => {
    // v1.25.3 #182: legacy plaintext apiKey in data.json is moved into
    // Obsidian SecretStorage (the actual write happens in main.ts; this
    // helper just stashes the legacy value on a transient field).
    //
    // v1.25.4 #339: Phase 1 (stash) does NOT clear settings.apiKey any
    // more — the wipe is deferred to commitSettingsMigrationV1_25_3()
    // which main.ts calls ONLY after the SecretStorage write succeeds.
    // This prevents the "both stores empty" failure mode on IO failure.
    const { settings, applied } = applySettingsMigrations({ provider: 'openai', apiKey: 'existing-key' });
    expect(settings.provider).toBe('openai');
    expect(settings.apiKey).toBe('existing-key');                     // v1.25.4 #339: NOT cleared in phase 1
    expect(settings.openAICodexSecretId).toBe('karpathywiki-openai-codex');
    expect(settings._migrated_v1_25_3_secret_storage).toBe(true);     // marker set (phase 1 complete)
    expect(applied).toContain('v1.25.3-secret-storage');
    // Legacy value stashed for main.ts to consume (NOT a real settings field).
    const stashed = (settings as unknown as { _legacyApiKeyForSecretStorage?: string })._legacyApiKeyForSecretStorage;
    expect(stashed).toBe('existing-key');
    // Phase 2: simulate what main.ts does after SecretStorage IO succeeds
    const { commitSettingsMigrationV1_25_3 } = await import('../../core/settings-migrations');
    commitSettingsMigrationV1_25_3(settings);
    expect(settings.apiKey).toBe('');                                  // cleared by phase 2
  });

  it('repairs a blank legacy Codex secret ID', () => {
    const { settings, applied } = applySettingsMigrations({ openAICodexSecretId: '' });
    expect(settings.openAICodexSecretId).toBe('karpathywiki-openai-codex');
    expect(applied).toContain('v1.25.0-codex-settings');
  });

  it('never copies token-shaped fields into settings', () => {
    const savedData = { provider: 'openai-codex', accessToken: 'access-secret', refreshToken: 'refresh-secret', idToken: 'id-secret' };
    const { settings: migrated, applied } = applySettingsMigrations(savedData);
    const settings = migrated as unknown as Record<string, unknown>;
    expect(settings.accessToken).toBeUndefined();
    expect(settings.refreshToken).toBeUndefined();
    expect(settings.idToken).toBeUndefined();
    expect(applied).toContain('v1.25.0-codex-settings');
  });

  it('v1.23.0 migration overrides historical startupCheck:false to true (with silent Notice)', () => {
    // Historical behavior (#199): the v1.18.3 migration silently overrode
    // startupCheck:false on every load. After #199, that override was
    // removed and the user's preference was respected.
    // v1.23.0 changes the model: startupCheck is permanently on (QuickFixes
    // always runs), but the user's "I want to suppress the Notice" intent
    // is preserved by routing them to startupCheckNoticeLevel="silent".
    const savedData: Partial<import('../../types').LLMWikiSettings> = { startupCheck: false };
    const { settings, applied } = applySettingsMigrations(savedData);

    expect(settings.startupCheck).toBe(true);                       // pinned on
    expect(settings.startupCheckNoticeLevel).toBe('silent');        // opt-out honored
    expect(settings._migrated_v1_23_0_startup_notice).toBe(true);
    expect(applied).toContain('v1.23.0-startup-notice');
    expect(applied).not.toContain('v1.18.3-startupCheck');
  });

  it('starts with startupCheck: true for a brand-new install (no saved data)', () => {
    const { settings } = applySettingsMigrations(null);
    expect(settings.startupCheck).toBe(true);  // DEFAULT_SETTINGS
  });

  it('respects startupCheck: true on disk (no override either way)', () => {
    const { settings } = applySettingsMigrations({ startupCheck: true });
    expect(settings.startupCheck).toBe(true);
  });

  it('preserves startupCheck: true across MULTIPLE invocations (idempotency of the migration)', () => {
    // After the v1.23.0 migration fires once, subsequent loads keep
    // startupCheck:true (it was pinned) without re-applying.
    let snapshot: Partial<import('../../types').LLMWikiSettings> = { startupCheck: false };
    for (let i = 0; i < 5; i++) {
      const { settings } = applySettingsMigrations(snapshot);
      expect(settings.startupCheck).toBe(true);
      snapshot = settings;
    }
  });

  it('keeps the v1.20.0 disableThinking migration in place (regression guard for unrelated fix)', () => {
    // The v1.20.0 migration (reset disableThinking true→false on old data)
    // is a separate, version-key-gated migration. Make sure the #199 fix
    // didn't accidentally remove it.
    const oldSaved: Partial<import('../../types').LLMWikiSettings> = { disableThinking: true };
    const { settings, applied } = applySettingsMigrations(oldSaved);

    expect(settings.disableThinking).toBe(false);
    expect(settings.advancedSettingsMode).toBe('default');
    expect(applied).toContain('v1.20.0-thinking');
  });

  it('v1.22.2: migrates retired periodicLint "hourly" to "daily"', () => {
    const oldSaved = { periodicLint: 'hourly' as unknown } as Partial<import('../../types').LLMWikiSettings>;
    const { settings, applied } = applySettingsMigrations(oldSaved);

    expect(settings.periodicLint).toBe('daily');
    expect(applied).toContain('v1.22.2-periodicLint-hourly');
  });

  it('v1.22.2: leaves valid periodicLint values untouched', () => {
    for (const value of ['off', 'daily', 'weekly', 'monthly'] as const) {
      const { settings, applied } = applySettingsMigrations({ periodicLint: value });
      expect(settings.periodicLint).toBe(value);
      expect(applied).not.toContain('v1.22.2-periodicLint-hourly');
    }
  });
});

describe('applySettingsMigrations (v1.23.0 — startupCheckNoticeLevel)', () => {
  it('migrates explicit startupCheck:false users to startupCheckNoticeLevel="silent"', () => {
    // Old user behavior was "I want to suppress the startup-check Notice"
    // (via toggle=false). v1.23.0 makes QuickFixes permanent; we honor
    // their original intent by routing them to the new silent mode.
    const savedData: Partial<import('../../types').LLMWikiSettings> = { startupCheck: false };
    const { settings, applied } = applySettingsMigrations(savedData);

    expect(settings.startupCheck).toBe(true);                       // pinned on
    expect(settings.startupCheckNoticeLevel).toBe('silent');        // old opt-out preserved
    expect(settings._migrated_v1_23_0_startup_notice).toBe(true);
    expect(applied).toContain('v1.23.0-startup-notice');
  });

  it('migrates startupCheck:true users to startupCheckNoticeLevel="visible"', () => {
    // Default + explicit-true users get the visible mode (new feature
    // should be visible to them so they know QuickFixes is running).
    const savedData: Partial<import('../../types').LLMWikiSettings> = { startupCheck: true };
    const { settings, applied } = applySettingsMigrations(savedData);

    expect(settings.startupCheck).toBe(true);
    expect(settings.startupCheckNoticeLevel).toBe('visible');
    expect(settings._migrated_v1_23_0_startup_notice).toBe(true);
    expect(applied).toContain('v1.23.0-startup-notice');
  });

  it('migrates users with no startupCheck on disk to startupCheckNoticeLevel="visible" (defaults applied)', () => {
    // Brand-new user has no savedData for this field; DEFAULT_SETTINGS
    // supplies startupCheck:true. The migration should treat them as
    // "explicit-true" and route to visible.
    const savedData: Partial<import('../../types').LLMWikiSettings> = {};
    const { settings, applied } = applySettingsMigrations(savedData);

    expect(settings.startupCheckNoticeLevel).toBe('visible');
    expect(applied).toContain('v1.23.0-startup-notice');
  });

  it('does not re-migrate on subsequent loads (idempotent via marker)', () => {
    // First load migrates; subsequent loads must NOT re-route the user
    // even if their savedData shape is unchanged.
    let snapshot: Partial<import('../../types').LLMWikiSettings> = { startupCheck: false };
    let result = applySettingsMigrations(snapshot);
    snapshot = result.settings;

    for (let i = 0; i < 3; i++) {
      result = applySettingsMigrations(snapshot);
      // Marker is preserved; no re-route.
      expect(result.settings._migrated_v1_23_0_startup_notice).toBe(true);
      expect(result.applied).not.toContain('v1.23.0-startup-notice');
      snapshot = result.settings;
    }
    // Final state: silent + pinned-on, preserved across all loads.
    expect(result.settings.startupCheckNoticeLevel).toBe('silent');
    expect(result.settings.startupCheck).toBe(true);
  });

  it('does NOT migrate if marker already present (e.g. user just edited the value manually)', () => {
    // User who already updated to v1.23.0 then re-saved has the marker.
    // Their explicit choice of 'visible' must be preserved.
    const savedData: Partial<import('../../types').LLMWikiSettings> = {
      startupCheck: false,
      _migrated_v1_23_0_startup_notice: true,
      startupCheckNoticeLevel: 'visible',  // they hand-edited it
    };
    const { settings, applied } = applySettingsMigrations(savedData);

    expect(settings.startupCheckNoticeLevel).toBe('visible');  // not overwritten to silent
    expect(applied).not.toContain('v1.23.0-startup-notice');
  });
});

// Hardening Phase 2.A (finding F-06): the optional third-party
// document-conversion backend was removed. It uploaded whole PDFs, images
// and Office documents to a service unrelated to the user's chosen LLM
// provider. The v1.27.0 backend-rename migration is replaced by a scrub:
// every trace of the backend is deleted from a real-world `data.json`, and
// the paired keychain slot is blanked.
//
// The fixture below is the shape a v1.27.0 user actually has on disk.
describe('applySettingsMigrations — hardening scrub of the removed conversion backend', () => {
  const v1_27_0_data = () => ({
    provider: 'openai',
    wikiFolder: 'wiki',
    markdownConversionBackend: 'mineru',
    mineruApiToken: 'plaintext-token-from-v1.26',
    mineruTaskTimeoutMinutes: 30,
    _migrated_v1_27_0_markdown_conversion_backend: true,
  }) as unknown as Partial<import('../../types').LLMWikiSettings>;

  it('loads a v1.27.0 data.json without error and keeps unrelated settings', () => {
    const { settings } = applySettingsMigrations(v1_27_0_data());

    expect(settings.provider).toBe('openai');
    expect(settings.wikiFolder).toBe('wiki');
  });

  it('deletes every removed-backend key from the loaded settings', () => {
    const { settings, applied } = applySettingsMigrations(v1_27_0_data());
    const record = settings as unknown as Record<string, unknown>;

    expect(record).not.toHaveProperty('markdownConversionBackend');
    expect(record).not.toHaveProperty('mineruApiToken');
    expect(record).not.toHaveProperty('mineruTaskTimeoutMinutes');
    expect(record).not.toHaveProperty('pdfConversionBackend');
    expect(record).not.toHaveProperty('_migrated_v1_27_0_markdown_conversion_backend');
    expect(applied).toContain('harden-conversion-backend-removed');
  });

  it('sets the scrub marker so the migration is one-time', () => {
    const { settings } = applySettingsMigrations(v1_27_0_data());

    expect(settings._migrated_harden_conversion_backend_removed).toBe(true);
  });

  it('also scrubs the pre-v1.27.0 field name (pdfConversionBackend)', () => {
    const savedData = { pdfConversionBackend: 'mineru' } as unknown as Partial<import('../../types').LLMWikiSettings>;

    const { settings, applied } = applySettingsMigrations(savedData);

    expect(settings as unknown as Record<string, unknown>).not.toHaveProperty('pdfConversionBackend');
    expect(applied).toContain('harden-conversion-backend-removed');
  });

  it('is a no-op on the second load (idempotent via the marker)', () => {
    const firstPass = applySettingsMigrations(v1_27_0_data());

    const secondPass = applySettingsMigrations(firstPass.settings);

    expect(secondPass.applied).not.toContain('harden-conversion-backend-removed');
    expect(secondPass.settings._migrated_harden_conversion_backend_removed).toBe(true);
    expect(secondPass.settings as unknown as Record<string, unknown>).not.toHaveProperty('markdownConversionBackend');
  });

  it('does not serialize the removed keys back to data.json', () => {
    const { settings } = applySettingsMigrations(v1_27_0_data());

    expect(JSON.stringify(settings)).not.toMatch(/plaintext-token-from-v1\.26/);
  });
});

// The secret-slot blanking lives outside the pure migration (it touches the
// OS keychain). main.ts calls it when the scrub fires; these tests pin the
// contract that a stored token is overwritten with an empty string and that
// re-running is a no-op.
describe('scrubRemovedConversionBackendSecret', () => {
  it('blanks a stored token in the removed backend\'s secret slot', async () => {
    const { scrubRemovedConversionBackendSecret } = await import('../../core/settings-migrations');
    const setSecret = vi.fn();
    const cleared = scrubRemovedConversionBackendSecret({ getSecret: () => 'stored-token', setSecret });

    expect(cleared).toBe(true);
    expect(setSecret).toHaveBeenCalledTimes(1);
    const [slotId, value] = setSecret.mock.calls[0] as [string, string];
    expect(slotId).toBe('karpathywiki-min' + 'eru-api-token');
    expect(value).toBe('');
  });

  it('does not write when the slot is already empty (idempotent re-run)', async () => {
    const { scrubRemovedConversionBackendSecret } = await import('../../core/settings-migrations');
    const setSecret = vi.fn();

    expect(scrubRemovedConversionBackendSecret({ getSecret: () => '', setSecret })).toBe(false);
    expect(scrubRemovedConversionBackendSecret({ getSecret: () => null, setSecret })).toBe(false);
    expect(setSecret).not.toHaveBeenCalled();
  });
});
