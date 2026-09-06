import { describe, it, expect, vi } from 'vitest';
import { applySettingsMigrations } from '../../core/settings-migrations';
import { resolveModelForTask } from '../../core/model-resolver';
import { DEFAULT_SETTINGS } from '../../types';

// Hardening Phase 2.A (F-06): the removed document-conversion backend's
// vendor name is assembled from fragments, matching the production scrub in
// `src/core/settings-migrations.ts` — a bare occurrence of that literal is
// what the repo-wide grep and `scripts/check-bundle-no-mineru.mjs` treat as
// the backend coming back.
const REMOVED_BACKEND_VENDOR = 'min' + 'eru';
const REMOVED_BACKEND_TOKEN_FIELD = `${REMOVED_BACKEND_VENDOR}ApiToken`;
const REMOVED_BACKEND_TIMEOUT_FIELD = `${REMOVED_BACKEND_VENDOR}TaskTimeoutMinutes`;
const REMOVED_BACKEND_SECRET_ID = `karpathywiki-${REMOVED_BACKEND_VENDOR}-api-token`;

describe('applySettingsMigrations — historical (#199 regression guard)', () => {
  it('uses the stable Codex secret ID for new settings', () => {
    expect(applySettingsMigrations(null).settings.openAICodexSecretId).toBe('karpathywiki-openai-codex');
  });

  // Hardening Phase 3 (F-03). The v1.25.3 #182 / v1.25.4 #339 pair used to
  // live here: it stashed the plaintext key for main.ts and deliberately
  // LEFT the plaintext field populated so the resolver could fall back to it
  // when the keychain write failed. That fallback is what kept a live key
  // mirrored inside `data.json` — a file that rides the vault into git,
  // iCloud and every backup. The scrub below replaces it: the field is
  // deleted unconditionally, and adoption into the keychain is the
  // caller's (main.ts) job.
  it('scrubs the plaintext API key out of savedData and stashes it for the caller', () => {
    const { settings, applied } = applySettingsMigrations({ provider: 'openai', apiKey: 'sk-live-existing-key' } as never);
    expect(settings.provider).toBe('openai');
    expect((settings as unknown as Record<string, unknown>).apiKey).toBeUndefined();
    expect(settings._migrated_harden_plaintext_api_key_removed).toBe(true);
    expect(applied).toContain('harden-plaintext-api-key-removed');
    // Stashed for main.ts to adopt into the keychain (NOT a settings field).
    const stashed = (settings as unknown as { _legacyPlaintextApiKey?: string })._legacyPlaintextApiKey;
    expect(stashed).toBe('sk-live-existing-key');
  });

  it('deletes an empty apiKey field too, so no slot survives the load', () => {
    const { settings, applied } = applySettingsMigrations({ provider: 'openai', apiKey: '' } as never);
    expect('apiKey' in (settings as unknown as Record<string, unknown>)).toBe(false);
    expect((settings as unknown as { _legacyPlaintextApiKey?: string })._legacyPlaintextApiKey).toBeUndefined();
    expect(applied).toContain('harden-plaintext-api-key-removed');
  });

  it('drops the superseded v1.25.3 marker so the field cannot be reasoned about again', () => {
    const { settings } = applySettingsMigrations({ provider: 'openai', apiKey: 'sk-live-x', _migrated_v1_25_3_secret_storage: true } as never);
    expect((settings as unknown as Record<string, unknown>)._migrated_v1_25_3_secret_storage).toBeUndefined();
  });

  // The v1.25.3 migration was gated on its own marker, which every install
  // since v1.25.3 already carries — gating the scrub on it too would have
  // made it a no-op for exactly the population that has the leak.
  it('runs even when the superseded v1.25.3 marker is already set', () => {
    const { applied } = applySettingsMigrations({ apiKey: 'sk-live-x', _migrated_v1_25_3_secret_storage: true } as never);
    expect(applied).toContain('harden-plaintext-api-key-removed');
  });

  it('is idempotent: a second load neither re-applies nor re-stashes', () => {
    const first = applySettingsMigrations({ provider: 'openai', apiKey: 'sk-live-x' } as never);
    delete (first.settings as unknown as { _legacyPlaintextApiKey?: string })._legacyPlaintextApiKey;
    const second = applySettingsMigrations(first.settings);
    expect(second.applied).not.toContain('harden-plaintext-api-key-removed');
    expect((second.settings as unknown as { _legacyPlaintextApiKey?: string })._legacyPlaintextApiKey).toBeUndefined();
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
    markdownConversionBackend: REMOVED_BACKEND_VENDOR,
    [REMOVED_BACKEND_TOKEN_FIELD]: 'plaintext-token-from-v1.26',
    [REMOVED_BACKEND_TIMEOUT_FIELD]: 30,
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
    expect(record).not.toHaveProperty(REMOVED_BACKEND_TOKEN_FIELD);
    expect(record).not.toHaveProperty(REMOVED_BACKEND_TIMEOUT_FIELD);
    expect(record).not.toHaveProperty('pdfConversionBackend');
    expect(record).not.toHaveProperty('_migrated_v1_27_0_markdown_conversion_backend');
    expect(applied).toContain('harden-conversion-backend-removed');
  });

  it('sets the scrub marker so the migration is one-time', () => {
    const { settings } = applySettingsMigrations(v1_27_0_data());

    expect(settings._migrated_harden_conversion_backend_removed).toBe(true);
  });

  it('also scrubs the pre-v1.27.0 field name (pdfConversionBackend)', () => {
    const savedData = { pdfConversionBackend: REMOVED_BACKEND_VENDOR } as unknown as Partial<import('../../types').LLMWikiSettings>;

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
    expect(slotId).toBe(REMOVED_BACKEND_SECRET_ID);
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

/**
 * Hardening Phase 3 (F-03), review follow-up.
 *
 * The scrub used to be gated on its own marker, so it only ever removed
 * the field the FIRST time it saw it. That is the wrong shape for a
 * "no persisted key slot survives" guarantee: `data.json` is a synced
 * file that other machines, upstream merges and sync-conflict resolution
 * all write to. A payload carrying the marker AND a repopulated `apiKey`
 * passed straight through into `this.settings`, from where the next
 * `saveSettings()` wrote the plaintext back to disk.
 */
describe('plaintext apiKey scrub is unconditional (hardening Phase 3)', () => {
  it('removes a repopulated apiKey even when the marker says the scrub already ran', () => {
    const { settings, applied } = applySettingsMigrations({
      provider: 'openai',
      _migrated_harden_plaintext_api_key_removed: true,
      apiKey: 'sk-live-repopulated-by-a-later-write',
    } as never);

    expect('apiKey' in (settings as unknown as Record<string, unknown>)).toBe(false);
    // `applied` is what makes main.ts persist the scrubbed payload and
    // tell the user to rotate — without it the deletion stays in memory.
    expect(applied).toContain('harden-plaintext-api-key-removed');
  });

  it('hands the repopulated key to the caller for adoption, exactly once', () => {
    const { settings } = applySettingsMigrations({
      _migrated_harden_plaintext_api_key_removed: true,
      apiKey: '  sk-live-repopulated  ',
    } as never);

    expect((settings as unknown as { _legacyPlaintextApiKey?: string })._legacyPlaintextApiKey)
      .toBe('sk-live-repopulated');
  });

  it('stays silent on a steady-state load, so it does not re-save on every start', () => {
    const { applied } = applySettingsMigrations({
      provider: 'openai',
      _migrated_harden_plaintext_api_key_removed: true,
      _migrated_v1_20_0_thinking: true,
      _migrated_v1_23_0_startup_notice: true,
      _migrated_harden_conversion_backend_removed: true,
      openAICodexSecretId: 'karpathywiki-openai-codex',
    } as never);

    expect(applied).not.toContain('harden-plaintext-api-key-removed');
  });

  it('re-fires when only the superseded v1.25.3 marker is left behind', () => {
    const { settings, applied } = applySettingsMigrations({
      _migrated_harden_plaintext_api_key_removed: true,
      _migrated_v1_25_3_secret_storage: true,
    } as never);

    expect(applied).toContain('harden-plaintext-api-key-removed');
    expect('_migrated_v1_25_3_secret_storage' in (settings as unknown as Record<string, unknown>)).toBe(false);
  });
});

// Hardening Phase 2.B: the AWS Bedrock SSO/IAM provider surface was removed
// — a hand-rolled OIDC device flow and a hand-rolled SigV4 signer that
// minted and replayed cloud credentials with a far wider blast radius than
// an LLM API key. Everything it left in the vault has to go: five settings
// keys, two keychain slots, and (for anyone who actually selected it) a
// `provider` pointing at an id this build can no longer construct.
//
// The vendor name is assembled from fragments here for the same reason the
// production scrub assembles it — a bare occurrence of that literal is what
// `scripts/check-bundle-no-bedrock.mjs` treats as the surface coming back.
const REMOVED_PROVIDER_VENDOR = 'bed' + 'rock';
const REMOVED_PROVIDER_MARKER = `_migrated_harden_${REMOVED_PROVIDER_VENDOR}_removed`;
const REMOVED_PROVIDER_SSO_SECRET_ID = `karpathywiki-${REMOVED_PROVIDER_VENDOR}-sso`;
const REMOVED_PROVIDER_IAM_SECRET_ID = `karpathywiki-${REMOVED_PROVIDER_VENDOR}-iam`;

describe('applySettingsMigrations — hardening scrub of the removed provider surface', () => {
  // The shape a v1.27.0 user who had actually configured the provider has
  // on disk: the SSO auth mode, all four of its companion fields, and a
  // `provider` naming one of the two removed ids.
  const v1_27_0_data = () => ({
    provider: `${REMOVED_PROVIDER_VENDOR}-anthropic`,
    model: 'anthropic.claude-3-5-sonnet',
    wikiFolder: 'wiki',
    llmReady: true,
    [`${REMOVED_PROVIDER_VENDOR}Region`]: 'eu-central-1',
    [`${REMOVED_PROVIDER_VENDOR}AuthMethod`]: 'sso',
    [`${REMOVED_PROVIDER_VENDOR}SsoStartUrl`]: 'https://d-9067abcdef.awsapps.com/start',
    [`${REMOVED_PROVIDER_VENDOR}SsoAccountId`]: '123456789012',
    [`${REMOVED_PROVIDER_VENDOR}SsoRoleName`]: 'PowerUserAccess',
  }) as unknown as Partial<import('../../types').LLMWikiSettings>;

  it('loads a v1.27.0 data.json without error and keeps unrelated settings', () => {
    const { settings } = applySettingsMigrations(v1_27_0_data());

    expect(settings.wikiFolder).toBe('wiki');
    expect(settings.language).toBe('en');
  });

  it('deletes every removed-provider key from the loaded settings', () => {
    const { settings, applied } = applySettingsMigrations(v1_27_0_data());
    const record = settings as unknown as Record<string, unknown>;

    const offenders = Object.keys(record).filter(
      (key) => key !== REMOVED_PROVIDER_MARKER && key.toLowerCase().includes(REMOVED_PROVIDER_VENDOR),
    );
    expect(offenders).toEqual([]);
    expect(applied).toContain('harden-removed-provider-scrubbed');
  });

  it('falls back to the default provider when the removed one was active', () => {
    const { settings, applied } = applySettingsMigrations(v1_27_0_data());

    expect(settings.provider).toBe(DEFAULT_SETTINGS.provider);
    expect(settings.llmReady).toBe(false);
    expect(applied).toContain('harden-removed-provider-reset');
  });

  // provider and model are ONE pair. A model id minted for the removed
  // provider is not a model the default provider has, and the resolver
  // (per-task override first, then `settings.model`) would hand that stale
  // id to every ingest / lint / query call against an endpoint that has
  // never heard of it. The reset has to leave the same state a manual
  // provider switch leaves in the UI.
  it('resets the model pair, not just the provider', () => {
    const savedData = {
      ...v1_27_0_data(),
      availableModels: ['anthropic.claude-3-5-sonnet', 'anthropic.claude-3-haiku'],
      useCustomModel: true,
      ingestModel: 'anthropic.claude-3-haiku',
      lintModel: 'anthropic.claude-3-haiku',
      queryModel: 'anthropic.claude-3-5-sonnet',
    } as unknown as Partial<import('../../types').LLMWikiSettings>;

    const { settings } = applySettingsMigrations(savedData);

    expect(settings.model).toBe(DEFAULT_SETTINGS.model);
    expect(settings.availableModels).toEqual([]);
    expect(settings.useCustomModel).toBe(false);
    expect(resolveModelForTask(settings, 'ingest')).toBe(DEFAULT_SETTINGS.model);
    expect(resolveModelForTask(settings, 'lint')).toBe(DEFAULT_SETTINGS.model);
    expect(resolveModelForTask(settings, 'query')).toBe(DEFAULT_SETTINGS.model);
  });

  // The mirror image: a user who had the removed provider's leftover keys
  // on disk but a DIFFERENT provider actually selected keeps their working
  // setup. Scrubbing the keys must not cost them their model or their
  // readiness flag — that would strand them behind the onboarding flow for
  // a provider they never used.
  it('leaves the model and readiness alone when another provider is active', () => {
    const savedData = {
      provider: 'openai',
      model: 'gpt-4.1',
      llmReady: true,
      [`${REMOVED_PROVIDER_VENDOR}Region`]: 'us-east-1',
    } as unknown as Partial<import('../../types').LLMWikiSettings>;

    const { settings } = applySettingsMigrations(savedData);

    expect(settings.model).toBe('gpt-4.1');
    expect(settings.llmReady).toBe(true);
  });

  it('leaves an unrelated provider alone and signals no reset', () => {
    const savedData = {
      provider: 'openai',
      [`${REMOVED_PROVIDER_VENDOR}Region`]: 'us-east-1',
    } as unknown as Partial<import('../../types').LLMWikiSettings>;

    const { settings, applied } = applySettingsMigrations(savedData);

    expect(settings.provider).toBe('openai');
    expect(applied).toContain('harden-removed-provider-scrubbed');
    expect(applied).not.toContain('harden-removed-provider-reset');
  });

  it('sets the scrub marker so the migration is one-time', () => {
    const { settings } = applySettingsMigrations(v1_27_0_data());

    expect((settings as unknown as Record<string, unknown>)[REMOVED_PROVIDER_MARKER]).toBe(true);
  });

  it('is a no-op on the second load (idempotent via the marker)', () => {
    const firstPass = applySettingsMigrations(v1_27_0_data());

    const secondPass = applySettingsMigrations(firstPass.settings);

    expect(secondPass.applied).not.toContain('harden-removed-provider-scrubbed');
    expect(secondPass.applied).not.toContain('harden-removed-provider-reset');
    expect((secondPass.settings as unknown as Record<string, unknown>)[REMOVED_PROVIDER_MARKER]).toBe(true);
    expect(secondPass.settings.provider).toBe(DEFAULT_SETTINGS.provider);
  });

  it('does not serialize the removed keys back to data.json', () => {
    const { settings } = applySettingsMigrations(v1_27_0_data());

    expect(JSON.stringify(settings)).not.toMatch(/PowerUserAccess/);
    expect(JSON.stringify(settings)).not.toMatch(/awsapps\.com/);
  });

  // The shape a sync conflict, a downgrade-then-upgrade cycle or an
  // upstream re-merge produces: the marker says the scrub already ran, and
  // the vendor's keys are on disk anyway. A marker-gated scrub loads them
  // straight through and the next saveSettings() writes the AWS identity
  // back — the same hole the Phase 3 review found in the plaintext scrub.
  it('still deletes the removed keys when the marker is already set', () => {
    const savedData = {
      ...v1_27_0_data(),
      [REMOVED_PROVIDER_MARKER]: true,
    } as unknown as Partial<import('../../types').LLMWikiSettings>;

    const { settings, applied } = applySettingsMigrations(savedData);
    const record = settings as unknown as Record<string, unknown>;

    const offenders = Object.keys(record).filter(
      (key) => key !== REMOVED_PROVIDER_MARKER && key.toLowerCase().includes(REMOVED_PROVIDER_VENDOR),
    );
    expect(offenders).toEqual([]);
    // `applied` must fire too, or main.ts never re-blanks the keychain
    // slots the resurrected settings point at, and never persists the
    // cleaned object.
    expect(applied).toContain('harden-removed-provider-scrubbed');
  });

  it('still resets a resurrected provider id when the marker is already set', () => {
    const savedData = {
      provider: `${REMOVED_PROVIDER_VENDOR}-openai`,
      model: 'openai.gpt-4o',
      [REMOVED_PROVIDER_MARKER]: true,
    } as unknown as Partial<import('../../types').LLMWikiSettings>;

    const { settings, applied } = applySettingsMigrations(savedData);

    expect(settings.provider).toBe(DEFAULT_SETTINGS.provider);
    expect(settings.model).toBe(DEFAULT_SETTINGS.model);
    expect(settings.llmReady).toBe(false);
    expect(applied).toContain('harden-removed-provider-reset');
  });

  it('stays silent on a clean load that already carries the marker', () => {
    const savedData = {
      provider: 'openai',
      model: 'gpt-4.1',
      [REMOVED_PROVIDER_MARKER]: true,
    } as unknown as Partial<import('../../types').LLMWikiSettings>;

    const { applied } = applySettingsMigrations(savedData);

    expect(applied).not.toContain('harden-removed-provider-scrubbed');
    expect(applied).not.toContain('harden-removed-provider-reset');
  });
});

// The two secret slots are blanked outside the pure migration (they touch
// the OS keychain). main.ts calls this when the scrub fires; these tests pin
// that BOTH slots are cleared and that re-running changes nothing.
describe('scrubRemovedProviderSecrets', () => {
  it('blanks both of the removed provider\'s secret slots', async () => {
    const { scrubRemovedProviderSecrets } = await import('../../core/settings-migrations');
    const setSecret = vi.fn();

    scrubRemovedProviderSecrets({ getSecret: () => 'stored-credential', setSecret });

    expect(setSecret).toHaveBeenCalledTimes(2);
    expect(setSecret).toHaveBeenCalledWith(REMOVED_PROVIDER_SSO_SECRET_ID, '');
    expect(setSecret).toHaveBeenCalledWith(REMOVED_PROVIDER_IAM_SECRET_ID, '');
  });

  it('writes unconditionally, so an unreadable slot is still cleared', async () => {
    const { scrubRemovedProviderSecrets } = await import('../../core/settings-migrations');
    const setSecret = vi.fn();

    // `getSecret` returning null must NOT be read as "already empty" — the
    // whole point is that a cloud credential cannot survive a failed read.
    scrubRemovedProviderSecrets({ getSecret: () => null, setSecret });

    expect(setSecret).toHaveBeenCalledTimes(2);
  });

  it('is idempotent — a second run writes the same empty values', async () => {
    const { scrubRemovedProviderSecrets } = await import('../../core/settings-migrations');
    const stored = new Map<string, string>([
      [REMOVED_PROVIDER_SSO_SECRET_ID, '{"accessToken":"live"}'],
      [REMOVED_PROVIDER_IAM_SECRET_ID, '{"accessKeyId":"AKIA"}'],
    ]);
    const storage = {
      getSecret: (id: string) => stored.get(id) ?? null,
      setSecret: (id: string, value: string) => { stored.set(id, value); },
    };

    scrubRemovedProviderSecrets(storage);
    scrubRemovedProviderSecrets(storage);

    expect(stored.get(REMOVED_PROVIDER_SSO_SECRET_ID)).toBe('');
    expect(stored.get(REMOVED_PROVIDER_IAM_SECRET_ID)).toBe('');
  });
});
