/**
 * Hardening Phase 3 (F-03), task 3.5 — review follow-up.
 *
 * The invariant: no error body reaches a settings-tab Notice unredacted.
 * These Notices are the ones users screenshot into bug reports, and the
 * errors that land in them are raised while the code is handling a
 * credential — so they are exactly the messages that can quote a bearer
 * token or an API key back on screen.
 *
 * Hardening Phase 2.B removed BOTH credential-orchestrated flows this file
 * used to exercise: the ChatGPT-subscription OAuth login and its model
 * refresh, and the AWS SSO device login. What remains on the settings tab
 * is the keychain write in `flushApiKey`, whose platform error is raised
 * while handling the key itself. The test exercises the real public method,
 * so it fails if the redaction is removed from that sink.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Notice } from 'obsidian';
import { DEFAULT_SETTINGS } from '../../types';
import { LLMWikiSettingTab } from '../../ui/settings';

/** A platform error body of the shape a failing credential manager returns. */
const LEAKY_BODY = 'keychain write rejected: Authorization: Bearer sk-proj-abcdef1234567890xyz';
const LEAKED_SECRET = 'sk-proj-abcdef1234567890xyz';

function notices(): Array<{ message: string }> {
  return (Notice as unknown as { instances: Array<{ message: string }> }).instances;
}

/**
 * A settings tab wired to the smallest plugin/app surface the flush path
 * actually reads. `Object.create` skips PluginSettingTab's constructor
 * (which wants a live containerEl) — the same idiom
 * settings-commit-flush-api-key.test.ts uses.
 */
function makeTab(secretStorage: Record<string, unknown>): LLMWikiSettingTab {
  const tab = Object.create(LLMWikiSettingTab.prototype) as LLMWikiSettingTab;
  const settings = { ...DEFAULT_SETTINGS };
  (tab as unknown as { app: unknown }).app = { secretStorage };
  (tab as unknown as { plugin: unknown }).plugin = { settings };
  tab.tempSettings = settings;
  (tab as unknown as { display: () => void }).display = vi.fn();
  return tab;
}

beforeEach(() => {
  notices().length = 0;
});

describe('settings-tab credential failures are redacted before they reach a Notice', () => {
  it('redacts a keychain write failure raised while flushing the typed API key', () => {
    const tab = makeTab({
      getSecret: () => null,
      setSecret: () => { throw new Error(LEAKY_BODY); },
    });
    tab.pendingApiKey = 'sk-proj-abcdef1234567890xyz';

    expect(tab.flushApiKey()).toBe(false);

    const messages = notices().map((n) => n.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain(LEAKED_SECRET);
    // The diagnostic must survive the masking — a Notice that says only
    // "***" is a worse bug report than one that leaks.
    expect(messages[0]).toContain('keychain write rejected');
  });

  it('keeps the typed key buffered so the user can retry the flush', () => {
    const tab = makeTab({
      getSecret: () => null,
      setSecret: () => { throw new Error(LEAKY_BODY); },
    });
    tab.pendingApiKey = 'sk-proj-abcdef1234567890xyz';

    tab.flushApiKey();

    expect(tab.pendingApiKey).toBe('sk-proj-abcdef1234567890xyz');
  });
});
