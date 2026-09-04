// Phase 4.2 / 4.3 (F-04) — Settings-tab egress gates.
//
//   * model-section  : the one direct `requestUrl` call outside the fetch
//                      bridge (Fetch Models) must be policy-gated, and the
//                      denial must reach the user as a Notice.
//   * provider-section: a Base URL that violates the policy must NOT be
//                      written into tempSettings — the previous value stays.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../types';
import { renderModelSection } from '../../ui/settings-sections/model-section';
import { renderProviderSection } from '../../ui/settings-sections/provider-section';
import { registerEgressSettings } from '../../core/egress-policy';
import type { LLMWikiSettingTab } from '../../ui/settings';
import type { LLMWikiSettings } from '../../types';

const { buttonClicks, fetchModelsMock, settingNames, notices, requestUrlMock, textChangeHandlers, createdEls } =
  vi.hoisted(() => ({
    buttonClicks: [] as Array<() => unknown>,
    fetchModelsMock: vi.fn(),
    settingNames: [] as string[],
    notices: [] as string[],
    requestUrlMock: vi.fn(),
    textChangeHandlers: [] as Array<{ placeholder: string; onChange: (value: string) => void }>,
    createdEls: [] as Array<{ tag: string; text: string; cls: string }>,
  }));

vi.mock('../../core/url-fallback', () => ({ fetchModelsWithFallback: fetchModelsMock }));

vi.mock('obsidian', () => {
  class ControlMock {
    inputEl = { type: '' };
    private placeholder = '';
    addOption(): this { return this; }
    setValue(): this { return this; }
    onChange(handler: (value: string) => void): this {
      textChangeHandlers.push({ placeholder: this.placeholder, onChange: handler });
      return this;
    }
    setPlaceholder(value: string): this { this.placeholder = value; return this; }
    setLimits(): this { return this; }
    setDynamicTooltip(): this { return this; }
    setButtonText(): this { return this; }
    setDisabled(): this { return this; }
    setWarning(): this { return this; }
    setTooltip(): this { return this; }
    onClick(callback: () => unknown): this { buttonClicks.push(callback); return this; }
  }
  class SettingMock {
    settingEl = { style: { display: '' } };
    constructor(_containerEl: HTMLElement) {}
    setName(value: string): this { settingNames.push(value); return this; }
    setDesc(): this { return this; }
    setHeading(): this { return this; }
    addDropdown(callback: (control: ControlMock) => void): this { callback(new ControlMock()); return this; }
    addText(callback: (control: ControlMock) => void): this { callback(new ControlMock()); return this; }
    addToggle(callback: (control: ControlMock) => void): this { callback(new ControlMock()); return this; }
    addSlider(callback: (control: ControlMock) => void): this { callback(new ControlMock()); return this; }
    addButton(callback: (control: ControlMock) => void): this { callback(new ControlMock()); return this; }
    then(callback: (setting: SettingMock) => void): this { callback(this); return this; }
  }
  class NoticeMock {
    constructor(message: string) { notices.push(message); }
  }
  return {
    Setting: SettingMock,
    Notice: NoticeMock,
    Platform: { isMobile: false },
    requestUrl: requestUrlMock,
  };
});

/** Minimal container that records `createEl` calls (inline warnings). */
function makeContainer(): HTMLElement {
  const el = {
    createEl: (tag: string, opts?: { text?: string; cls?: string }) => {
      const child = { tag, text: opts?.text ?? '', cls: opts?.cls ?? '' };
      createdEls.push(child);
      return { ...child, remove: () => undefined } as unknown as HTMLElement;
    },
  };
  return el as unknown as HTMLElement;
}

function createTab(overrides: Partial<LLMWikiSettings>): LLMWikiSettingTab {
  return {
    tempSettings: { ...DEFAULT_SETTINGS, ...overrides },
    plugin: { app: { secretStorage: null }, codexAuthManager: null, bedrockAuthManager: null },
    codexAuthBusy: false,
    codexDevicePrompt: null,
    getText: (key: string) => key,
    getTextDynamic: (key: string) => key,
    display: vi.fn(),
    renderModelField: vi.fn(),
    setFieldValue: vi.fn(),
    cascadeUnifiedModelChange: vi.fn(),
    prefillPerTaskFromUnified: vi.fn(),
    markLLMConfigStale: vi.fn(),
    queueStaleCodexModelRefresh: vi.fn(),
  } as unknown as LLMWikiSettingTab;
}

beforeEach(() => {
  buttonClicks.length = 0;
  settingNames.length = 0;
  notices.length = 0;
  textChangeHandlers.length = 0;
  createdEls.length = 0;
  fetchModelsMock.mockReset();
  requestUrlMock.mockReset();
  registerEgressSettings(null);
});

describe('model-section Fetch Models egress gate', () => {
  it('refuses a cleartext remote base URL without issuing a request', async () => {
    const tab = createTab({ provider: 'custom', baseUrl: 'http://evil.example.net/v1', strictEgress: true });
    renderModelSection(tab, makeContainer());
    expect(buttonClicks.length).toBeGreaterThan(0);
    await buttonClicks[0]();
    expect(requestUrlMock).not.toHaveBeenCalled();
    expect(fetchModelsMock).not.toHaveBeenCalled();
    expect(notices.some((n) => n.includes('egressDeniedNotice'))).toBe(true);
  });

  it('trusts the host of the user-configured base URL (self-hosted endpoints keep working)', async () => {
    const tab = createTab({ provider: 'custom', baseUrl: 'https://llm.corp.internal/v1', strictEgress: true });
    renderModelSection(tab, makeContainer());
    requestUrlMock.mockResolvedValue({ status: 200, json: { data: [{ id: 'local-model' }] }, text: '', headers: {} });
    fetchModelsMock.mockImplementation(async (opts: { fetchFn: (u: string) => Promise<string[]> }) =>
      opts.fetchFn('https://llm.corp.internal/v1/models'));
    await buttonClicks[0]();
    expect(requestUrlMock).toHaveBeenCalledTimes(1);
    expect(notices.some((n) => n.includes('egressDeniedNotice'))).toBe(false);
  });

  it('refuses a private-range base URL under strict egress', async () => {
    const tab = createTab({ provider: 'custom', baseUrl: 'https://169.254.169.254/v1', strictEgress: true });
    renderModelSection(tab, makeContainer());
    await buttonClicks[0]();
    expect(requestUrlMock).not.toHaveBeenCalled();
    expect(fetchModelsMock).not.toHaveBeenCalled();
    expect(notices.some((n) => n.includes('egressDeniedNotice'))).toBe(true);
  });

  it('gates each candidate URL the fallback orchestrator probes', async () => {
    const tab = createTab({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', strictEgress: true });
    renderModelSection(tab, makeContainer());
    // Drive the probe callback with a URL that is NOT the configured host.
    fetchModelsMock.mockImplementation(async (opts: { fetchFn: (u: string) => Promise<string[]> }) =>
      opts.fetchFn('https://evil.example.net/v1/models'));
    await buttonClicks[0]();
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it('lets an allowlisted host through to requestUrl', async () => {
    const tab = createTab({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', strictEgress: true });
    renderModelSection(tab, makeContainer());
    requestUrlMock.mockResolvedValue({ status: 200, json: { data: [{ id: 'gpt-5' }] }, text: '', headers: {} });
    fetchModelsMock.mockImplementation(async (opts: { fetchFn: (u: string) => Promise<string[]> }) =>
      opts.fetchFn('https://api.openai.com/v1/models'));
    await buttonClicks[0]();
    expect(requestUrlMock).toHaveBeenCalledTimes(1);
  });
});

describe('provider-section base URL validation', () => {
  function baseUrlHandler() {
    // The Base URL field is the only text control whose placeholder is a URL.
    return textChangeHandlers.find((h) => h.placeholder.startsWith('http'));
  }

  it('refuses to store a cleartext remote base URL and keeps the previous value', () => {
    const tab = createTab({ provider: 'custom', baseUrl: 'https://api.openai.com/v1', strictEgress: true });
    renderProviderSection(tab, makeContainer());
    const handler = baseUrlHandler();
    expect(handler).toBeDefined();
    handler?.onChange('http://evil.example.net/v1');
    expect(tab.tempSettings.baseUrl).toBe('https://api.openai.com/v1');
    expect(createdEls.some((el) => el.cls.includes('llm-wiki-egress-warning'))).toBe(true);
  });

  it('refuses a base URL with embedded credentials', () => {
    const tab = createTab({ provider: 'custom', baseUrl: 'https://api.openai.com/v1', strictEgress: true });
    renderProviderSection(tab, makeContainer());
    baseUrlHandler()?.onChange('https://user:pass@api.openai.com/v1');
    expect(tab.tempSettings.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('refuses a base URL pointing at a private range', () => {
    const tab = createTab({ provider: 'custom', baseUrl: 'https://api.openai.com/v1', strictEgress: true });
    renderProviderSection(tab, makeContainer());
    baseUrlHandler()?.onChange('https://169.254.169.254/v1');
    expect(tab.tempSettings.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('accepts a self-hosted https base URL (the user configures it, so it is trusted)', () => {
    const tab = createTab({ provider: 'custom', baseUrl: 'https://api.openai.com/v1', strictEgress: true });
    renderProviderSection(tab, makeContainer());
    baseUrlHandler()?.onChange('https://llm.corp.internal/v1');
    expect(tab.tempSettings.baseUrl).toBe('https://llm.corp.internal/v1');
  });

  it('accepts a loopback base URL over http', () => {
    const tab = createTab({ provider: 'custom', baseUrl: 'https://api.openai.com/v1', strictEgress: true });
    renderProviderSection(tab, makeContainer());
    baseUrlHandler()?.onChange('http://localhost:11434/v1');
    expect(tab.tempSettings.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('accepts an empty base URL (clearing the override)', () => {
    const tab = createTab({ provider: 'custom', baseUrl: 'https://api.openai.com/v1', strictEgress: true });
    renderProviderSection(tab, makeContainer());
    baseUrlHandler()?.onChange('');
    expect(tab.tempSettings.baseUrl).toBe('');
  });

  it('still refuses cleartext when strict egress is off', () => {
    const tab = createTab({ provider: 'custom', baseUrl: 'https://api.openai.com/v1', strictEgress: false });
    renderProviderSection(tab, makeContainer());
    baseUrlHandler()?.onChange('http://evil.example.net/v1');
    expect(tab.tempSettings.baseUrl).toBe('https://api.openai.com/v1');
  });
});

describe('strict egress toggle', () => {
  it('renders the toggle and warns when it is off', () => {
    const tab = createTab({ provider: 'custom', strictEgress: false });
    renderProviderSection(tab, makeContainer());
    expect(settingNames).toContain('strictEgressName');
    expect(createdEls.some((el) => el.cls.includes('llm-wiki-strict-egress-warning'))).toBe(true);
  });

  it('renders no warning when strict egress is on', () => {
    const tab = createTab({ provider: 'custom', strictEgress: true });
    renderProviderSection(tab, makeContainer());
    expect(settingNames).toContain('strictEgressName');
    expect(createdEls.some((el) => el.cls.includes('llm-wiki-strict-egress-warning'))).toBe(false);
  });

  it('defaults to strict in DEFAULT_SETTINGS', () => {
    expect(DEFAULT_SETTINGS.strictEgress).toBe(true);
  });
});
