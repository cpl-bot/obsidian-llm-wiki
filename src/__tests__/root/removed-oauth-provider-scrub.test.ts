/**
 * Hardening Phase 2.B — the `main.ts` seam of the removed
 * ChatGPT-subscription OAuth provider's scrub.
 *
 * `applySettingsMigrations` is pure, so the half that matters most for a
 * removed OAuth provider — blanking the keychain slot that still holds a
 * long-lived refresh token — lives in `loadSettings`. Three guarantees are
 * only observable here:
 *
 *   1. the credential slot is actually blanked, and the provider's settings
 *      keys never reach the `saveData` that follows;
 *   2. a keychain write that THROWS does not leave a marker on disk
 *      claiming the credential was cleared — the next load must retry, or
 *      the token sits in the OS keychain forever with no code that owns it;
 *   3. a steady-state load does no keychain IO and shows no Notice.
 *
 * The provider id and its keychain slot are assembled from fragments here
 * for the same reason `src/core/settings-migrations.ts` does it:
 * `scripts/check-bundle-no-codex.mjs` treats those literals as proof the
 * surface came back.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Notice } from 'obsidian';
import LLMWikiPlugin from '../../main';
import { TEXTS } from '../../texts';
import { DEFAULT_SETTINGS } from '../../types';

vi.mock('../../llm-sdk/create-llm-client', () => ({
  createLLMClientFromSettingsSync: vi.fn(() => ({
    createMessage: vi.fn().mockResolvedValue('ok'),
    createMessageStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
  })),
  preloadLLMClientModules: vi.fn().mockResolvedValue(undefined),
  _resetPreloadedModulesForTests: vi.fn(),
}));

const VENDOR = 'cod' + 'ex';
const PROVIDER_ID = `openai-${VENDOR}`;
const OAUTH_SECRET_ID = `karpathywiki-openai-${VENDOR}`;
const SECRET_ID_FIELD = `openAI${VENDOR[0].toUpperCase()}${VENDOR.slice(1)}SecretId`;
const MODELS_FIELD = `openAI${VENDOR[0].toUpperCase()}${VENDOR.slice(1)}Models`;
const STORED_CREDENTIAL = '{"refreshToken":"rt-long-lived","accessToken":"at-live"}';

function notices(): Array<{ message: string }> {
  return (Notice as unknown as { instances: Array<{ message: string }> }).instances;
}

function keychain(options: { stored?: string; setThrows?: string } = {}): {
  storage: { getSecret: (id: string) => string | null; setSecret: (id: string, value: string) => void };
  setSecret: ReturnType<typeof vi.fn>;
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  if (options.stored !== undefined) values.set(OAUTH_SECRET_ID, options.stored);
  const setSecret = vi.fn((id: string, value: string) => {
    if (options.setThrows) throw new Error(options.setThrows);
    values.set(id, value);
  });
  return { storage: { getSecret: (id) => values.get(id) ?? null, setSecret }, setSecret, values };
}

function pluginWith(store: ReturnType<typeof keychain>): LLMWikiPlugin {
  const app = {
    vault: { getAbstractFileByPath: vi.fn().mockReturnValue(null) },
    secretStorage: store.storage,
  };
  return new LLMWikiPlugin(app as never, { version: '1.27.0' } as never);
}

/** The shape a v1.27.0 user with the removed provider signed in has on disk. */
function savedDataWithRemovedProvider(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: PROVIDER_ID,
    model: 'gpt-5.5',
    availableModels: ['gpt-5.5'],
    language: 'en',
    wikiLanguage: 'en',
    llmReady: true,
    [SECRET_ID_FIELD]: OAUTH_SECRET_ID,
    [MODELS_FIELD]: [{ slug: 'gpt-5.5', displayName: 'GPT-5.5' }],
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  notices().length = 0;
});

describe('startup scrub of the removed OAuth provider (hardening Phase 2.B)', () => {
  it('blanks the credential slot and writes a data.json free of the provider', async () => {
    const store = keychain({ stored: STORED_CREDENTIAL });
    const plugin = pluginWith(store);
    vi.spyOn(plugin, 'loadData').mockResolvedValue(savedDataWithRemovedProvider());
    const saveData = vi.spyOn(plugin, 'saveData').mockResolvedValue();

    await plugin.loadSettings();

    expect(store.setSecret).toHaveBeenCalledWith(OAUTH_SECRET_ID, '');
    expect(store.values.get(OAUTH_SECRET_ID)).toBe('');
    const saved = saveData.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(SECRET_ID_FIELD in saved).toBe(false);
    expect(MODELS_FIELD in saved).toBe(false);
    expect(saved.provider).toBe(DEFAULT_SETTINGS.provider);
    expect(saved._migrated_harden_codex_removed).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(PROVIDER_ID);
    // The user's next action would otherwise fail with an unexplained
    // "no provider", so the reset is announced once.
    expect(notices().map((n) => n.message)).toContain(TEXTS.en.removedOAuthProviderNotice);
  });

  // The slot holds a refresh token that outlives the session that minted it.
  // "The marker says we cleared it" must never be recorded for a clear that
  // did not happen.
  it('drops the marker when the keychain write throws, so the next load retries', async () => {
    const store = keychain({ stored: STORED_CREDENTIAL, setThrows: 'Secret Service is not running' });
    const plugin = pluginWith(store);
    vi.spyOn(plugin, 'loadData').mockResolvedValue(savedDataWithRemovedProvider());
    const saveData = vi.spyOn(plugin, 'saveData').mockResolvedValue();

    await plugin.loadSettings();

    const saved = saveData.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(saved._migrated_harden_codex_removed).toBeUndefined();
    // The settings-side scrub is unconditional, so the provider is still gone
    // from disk even though the keychain write failed.
    expect(saved.provider).toBe(DEFAULT_SETTINGS.provider);
    expect(SECRET_ID_FIELD in saved).toBe(false);
  });

  it('re-runs on a data.json that carries the marker AND the provider keys', async () => {
    const store = keychain({ stored: STORED_CREDENTIAL });
    const plugin = pluginWith(store);
    vi.spyOn(plugin, 'loadData').mockResolvedValue(
      savedDataWithRemovedProvider({ _migrated_harden_codex_removed: true }),
    );
    const saveData = vi.spyOn(plugin, 'saveData').mockResolvedValue();

    await plugin.loadSettings();

    expect(store.setSecret).toHaveBeenCalledWith(OAUTH_SECRET_ID, '');
    const saved = saveData.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(saved.provider).toBe(DEFAULT_SETTINGS.provider);
    expect(JSON.stringify(saved)).not.toContain(PROVIDER_ID);
  });

  it('is silent and does no keychain write on a steady-state load', async () => {
    const store = keychain();
    const plugin = pluginWith(store);
    vi.spyOn(plugin, 'loadData').mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      language: 'en',
      wikiLanguage: 'en',
      llmReady: true,
      _migrated_harden_codex_removed: true,
    });
    vi.spyOn(plugin, 'saveData').mockResolvedValue();

    await plugin.loadSettings();

    expect(store.setSecret).not.toHaveBeenCalled();
    expect(notices().map((n) => n.message)).not.toContain(TEXTS.en.removedOAuthProviderNotice);
  });
});
