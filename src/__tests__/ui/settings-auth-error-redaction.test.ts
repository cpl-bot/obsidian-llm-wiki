/**
 * Hardening Phase 3 (F-03), task 3.5 — review follow-up.
 *
 * The SSO controls in the settings tab are the flows that actually carry
 * bearer tokens: the Bedrock SSO device login exchanges and refreshes
 * tokens against AWS OIDC. Their failures are therefore the error bodies
 * most likely to quote an `Authorization` header back at us — and every
 * one of them lands in a Notice that a user screenshots into a bug report.
 *
 * These tests exercise the real public methods, so they fail if the
 * redaction is removed from the private formatter they share.
 *
 * Hardening Phase 2.B removed the second flow this file used to cover (the
 * ChatGPT-subscription OAuth login and its model refresh) along with the
 * provider itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Notice } from 'obsidian';
import { DEFAULT_SETTINGS } from '../../types';
import { LLMWikiSettingTab } from '../../ui/settings';

/** A provider error body of the shape a misconfigured gateway returns. */
const LEAKY_BODY = 'token exchange rejected: Authorization: Bearer sk-proj-abcdef1234567890xyz';
const LEAKED_SECRET = 'sk-proj-abcdef1234567890xyz';

function notices(): Array<{ message: string }> {
  return (Notice as unknown as { instances: Array<{ message: string }> }).instances;
}

/**
 * A settings tab wired to the smallest plugin/app surface these auth
 * methods actually read. `Object.create` skips PluginSettingTab's
 * constructor (which wants a live containerEl) — the same idiom
 * settings-commit-flush-api-key.test.ts uses.
 */
function makeTab(pluginOverrides: Record<string, unknown> = {}): LLMWikiSettingTab {
  const tab = Object.create(LLMWikiSettingTab.prototype) as LLMWikiSettingTab;
  const settings = { ...DEFAULT_SETTINGS };
  (tab as unknown as { app: unknown }).app = { secretStorage: { getSecret: () => null, setSecret: () => undefined } };
  (tab as unknown as { plugin: unknown }).plugin = {
    settings,
    openExternal: vi.fn(),
    bedrockAuthManager: null,
    ...pluginOverrides,
  };
  tab.tempSettings = settings;
  (tab as unknown as { display: () => void }).display = vi.fn();
  return tab;
}

beforeEach(() => {
  notices().length = 0;
});

describe('settings-tab auth failures are redacted before they reach a Notice', () => {
  it('redacts a Bedrock SSO device-login failure', async () => {
    const manager = {
      hasSsoToken: () => false,
      beginDeviceLogin: vi.fn().mockRejectedValue(new Error(LEAKY_BODY)),
    };
    const tab = makeTab({ bedrockAuthManager: manager });
    tab.tempSettings.bedrockSsoStartUrl = 'https://example.awsapps.com/start';

    await tab.loginBedrockSso();

    const messages = notices().map((n) => n.message);
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) expect(message).not.toContain(LEAKED_SECRET);
  });
});
