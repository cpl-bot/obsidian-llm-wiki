/**
 * Hardening Phase 3 (F-03), tasks 3.3 and 3.7.
 *
 * Two startup guarantees that only exist at the `main.ts` seam, where the
 * pure migration helper meets the OS keychain:
 *
 *   1. A `data.json` that still carries the pre-hardening plaintext
 *      `apiKey` is scrubbed on the first load — the value is adopted into
 *      the keychain when that slot is free, deleted from disk either way,
 *      and the user is told to rotate it. It has been sitting in a synced
 *      folder; "we moved it" is not the same as "it is still secret".
 *   2. The plugin refuses to load on Windows. The plaintext fallback this
 *      phase deleted existed solely for the Windows 10 Credential Manager
 *      failure mode (#339); with it gone, running there would degrade into
 *      "your key vanished" on every load.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Notice, Platform } from 'obsidian';
import LLMWikiPlugin from '../../main';
import { TEXTS } from '../../texts';

vi.mock('../../llm-sdk/create-llm-client', () => ({
  createLLMClientFromSettingsSync: vi.fn(() => ({
    createMessage: vi.fn().mockResolvedValue('ok'),
    createMessageStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
  })),
  preloadLLMClientModules: vi.fn().mockResolvedValue(undefined),
  _resetPreloadedModulesForTests: vi.fn(),
}));

const PROVIDER_SECRET_ID = 'karpathywiki-provider-api-key';
const PLAINTEXT_KEY = 'sk-live-plaintext-from-datajson';

type NoticeSpy = { instances: Array<{ message: string }> };

function notices(): Array<{ message: string }> {
  return (Notice as unknown as NoticeSpy).instances;
}

/** Keychain stub whose slot contents and failure mode the test controls. */
function keychain(options: { stored?: string; setThrows?: string } = {}): {
  storage: { getSecret: (id: string) => string | null; setSecret: (id: string, value: string) => void };
  setSecret: ReturnType<typeof vi.fn>;
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  if (options.stored !== undefined) values.set(PROVIDER_SECRET_ID, options.stored);
  const setSecret = vi.fn((id: string, value: string) => {
    if (options.setThrows) throw new Error(options.setThrows);
    values.set(id, value);
  });
  return {
    storage: { getSecret: (id: string) => values.get(id) ?? null, setSecret },
    setSecret,
    values,
  };
}

function pluginWith(store: ReturnType<typeof keychain>): LLMWikiPlugin {
  const app = {
    vault: { getAbstractFileByPath: vi.fn().mockReturnValue(null) },
    secretStorage: store.storage,
  };
  return new LLMWikiPlugin(app as never, { version: '1.27.0' } as never);
}

/** A pre-hardening `data.json`: v1.25.3 ran, and left the plaintext behind. */
function legacySavedData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'openai',
    model: 'gpt-4.1',
    language: 'en',
    wikiLanguage: 'en',
    llmReady: true,
    apiKey: PLAINTEXT_KEY,
    _migrated_v1_25_3_secret_storage: true,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  notices().length = 0;
});

describe('startup scrub of the plaintext API key (F-03, task 3.3)', () => {
  it('adopts the plaintext key into an empty keychain slot and deletes it from data.json', async () => {
    const store = keychain();
    const plugin = pluginWith(store);
    vi.spyOn(plugin, 'loadData').mockResolvedValue(legacySavedData());
    const saveData = vi.spyOn(plugin, 'saveData').mockResolvedValue();

    await plugin.loadSettings();

    expect(store.setSecret).toHaveBeenCalledWith(PROVIDER_SECRET_ID, PLAINTEXT_KEY);
    const saved = saveData.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect('apiKey' in saved).toBe(false);
    expect(saved._migrated_harden_plaintext_api_key_removed).toBe(true);
    // The transient stash must never reach disk either.
    expect('_legacyPlaintextApiKey' in saved).toBe(false);
    expect(JSON.stringify(saved)).not.toContain(PLAINTEXT_KEY);
  });

  it('tells the user to rotate the key', async () => {
    const store = keychain();
    const plugin = pluginWith(store);
    vi.spyOn(plugin, 'loadData').mockResolvedValue(legacySavedData());
    vi.spyOn(plugin, 'saveData').mockResolvedValue();

    await plugin.loadSettings();

    expect(notices().map((n) => n.message)).toContain(TEXTS.en.plaintextApiKeyScrubbedNotice);
    expect(TEXTS.en.plaintextApiKeyScrubbedNotice).toMatch(/rotate/i);
  });

  // The keychain copy is the newer one by construction: every key typed
  // since v1.25.3 went there first. Overwriting it with a years-old
  // data.json value would downgrade a working key.
  it('does not overwrite a populated keychain slot, but still deletes the plaintext', async () => {
    const store = keychain({ stored: 'sk-live-already-in-keychain' });
    const plugin = pluginWith(store);
    vi.spyOn(plugin, 'loadData').mockResolvedValue(legacySavedData());
    const saveData = vi.spyOn(plugin, 'saveData').mockResolvedValue();

    await plugin.loadSettings();

    expect(store.setSecret).not.toHaveBeenCalled();
    expect(store.values.get(PROVIDER_SECRET_ID)).toBe('sk-live-already-in-keychain');
    const saved = saveData.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect('apiKey' in saved).toBe(false);
    expect(notices().map((n) => n.message)).toContain(TEXTS.en.plaintextApiKeyScrubbedNotice);
  });

  // Same shape as the Phase 2.A conversion-backend scrub: a keychain write
  // that fails must not leave a marker claiming it succeeded.
  it('drops the marker when the keychain write throws, so the next load retries', async () => {
    const store = keychain({ setThrows: 'Secret Service is not running' });
    const plugin = pluginWith(store);
    vi.spyOn(plugin, 'loadData').mockResolvedValue(legacySavedData());
    const saveData = vi.spyOn(plugin, 'saveData').mockResolvedValue();

    await plugin.loadSettings();

    const saved = saveData.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(saved._migrated_harden_plaintext_api_key_removed).toBeUndefined();
    // Security wins over recoverability: the plaintext is gone regardless,
    // and the Notice already told the user to rotate.
    expect('apiKey' in saved).toBe(false);
    expect(notices().map((n) => n.message)).toContain(TEXTS.en.plaintextApiKeyScrubbedNotice);
  });

  it('is silent and does no keychain IO on a load with no plaintext key', async () => {
    const store = keychain({ stored: 'sk-live-already-in-keychain' });
    const plugin = pluginWith(store);
    vi.spyOn(plugin, 'loadData').mockResolvedValue({
      provider: 'openai', model: 'gpt-4.1', language: 'en', wikiLanguage: 'en', llmReady: true,
      _migrated_harden_plaintext_api_key_removed: true,
    });
    vi.spyOn(plugin, 'saveData').mockResolvedValue();

    await plugin.loadSettings();

    expect(store.setSecret).not.toHaveBeenCalled();
    expect(notices().map((n) => n.message)).not.toContain(TEXTS.en.plaintextApiKeyScrubbedNotice);
  });

  // Gate 3: a v1.27.0 data.json must still load, keeping every unrelated
  // field, and must come out of the load with no key-shaped value.
  it('loads a pre-hardening data.json without error and preserves unrelated settings', async () => {
    const store = keychain();
    const plugin = pluginWith(store);
    vi.spyOn(plugin, 'loadData').mockResolvedValue(legacySavedData({ wikiFolder: 'my-wiki', maxTokensPerCall: 4096 }));
    vi.spyOn(plugin, 'saveData').mockResolvedValue();

    await plugin.loadSettings();

    expect(plugin.settings.wikiFolder).toBe('my-wiki');
    expect(plugin.settings.maxTokensPerCall).toBe(4096);
    expect(plugin.settings.provider).toBe('openai');
    expect(JSON.stringify(plugin.settings)).not.toContain(PLAINTEXT_KEY);
  });
});

describe('Windows platform gate (F-03, task 3.7)', () => {
  afterEach(() => { (Platform as unknown as { isWin: boolean }).isWin = false; });

  it('returns from onload before any settings are read', async () => {
    (Platform as unknown as { isWin: boolean }).isWin = true;
    const store = keychain();
    const plugin = pluginWith(store);
    const loadData = vi.spyOn(plugin, 'loadData').mockResolvedValue(legacySavedData());
    const saveData = vi.spyOn(plugin, 'saveData').mockResolvedValue();

    await plugin.onload();

    expect(loadData).not.toHaveBeenCalled();
    expect(saveData).not.toHaveBeenCalled();
    expect(store.setSecret).not.toHaveBeenCalled();
    expect(plugin.settings).toBeUndefined();
  });

  it('says why it refused', async () => {
    (Platform as unknown as { isWin: boolean }).isWin = true;
    const plugin = pluginWith(keychain());
    vi.spyOn(plugin, 'loadData').mockResolvedValue(legacySavedData());

    await plugin.onload();

    expect(notices().map((n) => n.message)).toContain(TEXTS.en.unsupportedPlatform);
  });

  it('does not gate the supported platforms', async () => {
    (Platform as unknown as { isWin: boolean }).isWin = false;
    const plugin = pluginWith(keychain());
    const loadData = vi.spyOn(plugin, 'loadData').mockResolvedValue({ provider: 'openai', language: 'en', wikiLanguage: 'en' });
    vi.spyOn(plugin, 'saveData').mockResolvedValue();

    // onload continues into manager construction, which needs far more of
    // the Obsidian surface than this fixture stubs. Reaching loadData at
    // all is the assertion; the failure after it is the fixture's, not the
    // gate's.
    await plugin.onload().catch(() => undefined);

    expect(loadData).toHaveBeenCalled();
  });
});
