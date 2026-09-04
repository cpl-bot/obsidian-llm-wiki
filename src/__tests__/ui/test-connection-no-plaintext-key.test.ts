/**
 * Hardening Phase 3 (F-03), task 3.4.
 *
 * Test Connection is the one flow that handles a freshly-typed API key
 * before the keychain has it: the user pastes a key, presses the button,
 * and the probe has to use that key while the settings object is being
 * committed and saved around it. Historically this was where the key
 * leaked — `testLLMConnection` fires a fire-and-forget `saveSettings()`,
 * and the typed key lived on the settings object it was about to write.
 *
 * The transient key now lives on `LLMWikiSettingTab.pendingApiKey`, a
 * plain field of the tab that no serialization path can reach, and it is
 * zeroed once the keychain accepts it. This file pins the observable
 * consequence: across the whole flow — before, during and after the
 * probe — no `saveData` payload contains an `sk-`-prefixed string.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../types';
import { renderTestConnectionSection } from '../../ui/settings-sections/test-connection-section';
import { LLMWikiSettingTab } from '../../ui/settings';

const { buttonClicks } = vi.hoisted(() => ({ buttonClicks: [] as Array<() => unknown> }));

vi.mock('obsidian', () => {
  class ControlMock {
    inputEl = { type: '' };
    setButtonText(): this { return this; }
    setDisabled(): this { return this; }
    onClick(callback: () => unknown): this { buttonClicks.push(callback); return this; }
  }
  class SettingMock {
    constructor(_containerEl: HTMLElement) {}
    setName(): this { return this; }
    setDesc(): this { return this; }
    addButton(callback: (control: ControlMock) => void): this { callback(new ControlMock()); return this; }
  }
  // The section under test needs `Setting`; importing the real
  // `LLMWikiSettingTab` (so the commit/flush pair is production code, not
  // a stub) drags in the rest of the module graph, hence the base classes.
  return {
    Setting: SettingMock,
    Notice: class {},
    Platform: { isMobile: false, isWin: false, isMacOS: false, isDesktopApp: true },
    requestUrl: vi.fn(),
    normalizePath: (path: string) => path,
    TFile: class {},
    TFolder: class {},
    Modal: class { constructor(_app: unknown) {} open() {} close() {} },
    ItemView: class { constructor(_leaf: unknown) {} },
    WorkspaceLeaf: class {},
    MarkdownRenderer: { renderMarkdown: async () => {} },
    Component: class {},
    PluginSettingTab: class { constructor(_app: unknown, _plugin: unknown) {} display() {} },
    Plugin: class { constructor(_app: unknown, _manifest: unknown) {} },
    FuzzySuggestModal: class { constructor() {} open() {} },
  };
});

const TYPED_KEY = 'sk-live-typed-into-the-settings-box-0123456789';
const SECRET_ID = 'karpathywiki-provider-api-key';

/** Every payload the plugin handed to `saveData`, in order. */
let savedPayloads: unknown[] = [];

function createTab(options: { probeSucceeds: boolean; keychainAccepts: boolean }): LLMWikiSettingTab {
  const keychain = new Map<string, string>();
  const pluginSettings = { ...DEFAULT_SETTINGS, provider: 'openai', model: 'gpt-4.1', providerApiKeySecretId: SECRET_ID };
  const tab = {
    tempSettings: { ...pluginSettings },
    pendingApiKey: TYPED_KEY,
    app: {
      secretStorage: {
        getSecret: (id: string) => keychain.get(id) ?? null,
        setSecret: (id: string, value: string) => {
          if (!options.keychainAccepts) throw new Error('Secret Service is not running');
          keychain.set(id, value);
        },
      },
    },
    plugin: {
      settings: pluginSettings,
      app: { secretStorage: { getSecret: (id: string) => keychain.get(id) ?? null, setSecret: () => {} } },
      initializeLLMClient: vi.fn(),
      wikiEngine: { updateSettings: vi.fn() },
      // Mirrors the real testLLMConnection closely enough for this
      // assertion: it takes the transient key as an ARGUMENT (never off
      // the settings object) and fires the same fire-and-forget save.
      testLLMConnection: vi.fn(async (pendingApiKey?: string) => {
        expect(pendingApiKey).toBe(TYPED_KEY);
        savedPayloads.push(JSON.parse(JSON.stringify(tab.plugin.settings)));
        return options.probeSucceeds
          ? { success: true, message: 'ok' }
          : { success: false, message: 'nope' };
      }),
      saveSettings: vi.fn(async () => {
        savedPayloads.push(JSON.parse(JSON.stringify(tab.plugin.settings)));
      }),
      syncCodexModelsFromPlugin: vi.fn(),
    },
    getText: (key: string) => key,
    display: vi.fn(),
    syncCodexModelsFromPlugin: vi.fn(),
    commitTempSettings: undefined as unknown,
  } as unknown as LLMWikiSettingTab;
  // Use the REAL commit/flush pair — the point of the test is that the
  // production write-through carries no key, not that a stub doesn't.
  tab.commitTempSettings = LLMWikiSettingTab.prototype.commitTempSettings.bind(tab);
  tab.flushApiKey = LLMWikiSettingTab.prototype.flushApiKey.bind(tab);
  return tab;
}

/** The shapes a persisted credential would take. */
const KEY_SHAPES = [/\bsk-[A-Za-z0-9_-]{10,}/, /\bBearer\s+\S+/i, /\bAKIA[0-9A-Z]{16}\b/];

function expectNoKeyShapedValue(payloads: unknown[]): void {
  expect(payloads.length).toBeGreaterThan(0);
  for (const payload of payloads) {
    const json = JSON.stringify(payload);
    for (const shape of KEY_SHAPES) {
      expect(json, `key-shaped value in a saveData payload: ${json.slice(0, 200)}`).not.toMatch(shape);
    }
    expect(json).not.toContain(TYPED_KEY);
  }
}

beforeEach(() => {
  buttonClicks.length = 0;
  savedPayloads = [];
});

describe('Test Connection never persists the typed key (F-03, task 3.4)', () => {
  it('keeps the typed key out of every saveData payload on the success path', async () => {
    const tab = createTab({ probeSucceeds: true, keychainAccepts: true });
    renderTestConnectionSection(tab, {} as HTMLElement);
    await buttonClicks[0]();

    expectNoKeyShapedValue(savedPayloads);
  });

  it('zeroes the in-memory buffer once the keychain has the key', async () => {
    const tab = createTab({ probeSucceeds: true, keychainAccepts: true });
    renderTestConnectionSection(tab, {} as HTMLElement);
    await buttonClicks[0]();

    expect(tab.pendingApiKey).toBe('');
  });

  it('keeps the typed key out of every saveData payload on the probe-failure rollback', async () => {
    const tab = createTab({ probeSucceeds: false, keychainAccepts: true });
    renderTestConnectionSection(tab, {} as HTMLElement);
    await buttonClicks[0]();

    expectNoKeyShapedValue(savedPayloads);
  });

  // The dangerous ordering: the keychain refuses the write, so the key is
  // still in memory when the rollback save runs.
  it('keeps the typed key out of every saveData payload when the keychain write fails', async () => {
    const tab = createTab({ probeSucceeds: true, keychainAccepts: false });
    renderTestConnectionSection(tab, {} as HTMLElement);
    await buttonClicks[0]();

    expectNoKeyShapedValue(savedPayloads);
    // Still held in memory for the user to retry — and only in memory.
    expect(tab.pendingApiKey).toBe(TYPED_KEY);
  });
});
