/**
 * v1.25.8 HOTFIX regression test — Settings commit paths MUST flush
 * the typed apiKey into Obsidian SecretStorage as part of the commit,
 * not only on hide().
 *
 * Bug (root-cause analysis 2026-07-25): Test Connection success path
 * ran commitTempSettings() which wiped the in-memory apiKey buffer
 * but did NOT flush it into SecretStorage (only hide() did). The next
 * initializeLLMClient() read SecretStorage and got the PREVIOUS
 * provider's key, so Lint/Query/Ingest sent requests with the wrong
 * Authorization header → 401.
 *
 * Fix: commitTempSettings() now flushes SecretStorage first via
 * flushApiKey(), then wipes + spreads. Returns false on IO failure so
 * callers skip saveSettings() (preserves typed key for retry,
 * matching v1.25.4 #339).
 *
 * Tests below exercise the REAL production methods (not a mirror) per
 * project TDD standard — shell tests via local re-implementation are
 * explicitly banned because they pass even when production regresses.
 */

import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../types';
import { LLMWikiSettingTab } from '../../ui/settings';

interface FakeStorage {
  values: Map<string, string>;
  getSecret: (id: string) => string | null;
  setSecret: (id: string, value: string) => void;
}

function backend(initial?: string): FakeStorage {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set('karpathywiki-provider-api-key', initial);
  return {
    values,
    getSecret: (id) => values.get(id) ?? null,
    setSecret: (id, value) => { values.set(id, value); },
  };
}

function backendThrows(): FakeStorage {
  return {
    values: new Map(),
    getSecret: () => null,
    setSecret: () => { throw new Error('keychain locked'); },
  };
}

const SECRET_ID = 'karpathywiki-provider-api-key';

// Minimal Obsidian App stub (only secretStorage is touched by the
// code under test). PluginSettingTab's constructor signature requires
// (app, plugin); we pass throwaway objects that only expose what
// commitTempSettings / flushApiKey actually read.
//
// Hardening Phase 3 (F-03): the typed key moved off the settings object to
// `tab.pendingApiKey`, so `typedKey` seeds that buffer instead of a
// `tempSettings.apiKey` field — and the assertions that used to prove the
// key was wiped OUT of the settings object are now stronger by
// construction: there is no field for it to be in.
function makeTab(
  secretStorage: FakeStorage,
  typedKey: string,
): {
  tab: LLMWikiSettingTab;
  secretStorage: FakeStorage;
  pluginSettings: Record<string, unknown>;
} {
  const tab = Object.create(LLMWikiSettingTab.prototype) as LLMWikiSettingTab;
  const tempSettings = { ...DEFAULT_SETTINGS, providerApiKeySecretId: SECRET_ID };
  const pluginSettings = { ...DEFAULT_SETTINGS, providerApiKeySecretId: SECRET_ID };
  // App stub — only .secretStorage is read by commitTempSettings/flushApiKey.
  (tab as unknown as { app: unknown }).app = { secretStorage };
  (tab as unknown as { plugin: unknown }).plugin = {
    settings: pluginSettings,
    initializeLLMClient: vi.fn(),
  };
  (tab as unknown as { tempSettings: unknown }).tempSettings = tempSettings;
  tab.pendingApiKey = typedKey;
  (tab as unknown as { cascadeUnifiedModelChange: unknown }).cascadeUnifiedModelChange = vi.fn();
  return { tab, secretStorage, pluginSettings: pluginSettings as unknown as Record<string, unknown> };
}

describe('v1.25.8 HOTFIX: commitTempSettings must flush before spread', () => {
  it('writes typed key to SecretStorage when flush succeeds (the missing step)', () => {
    const secretStorage = backend();
    const { tab, pluginSettings } = makeTab(secretStorage, 'sk-minimax-new');
    const ok = tab.commitTempSettings();
    expect(ok).toBe(true);
    expect(secretStorage.values.get(SECRET_ID)).toBe('sk-minimax-new');
    // The committed settings object carries no key at all — not even an
    // empty one — so nothing downstream can serialize it.
    expect('apiKey' in pluginSettings).toBe(false);
    expect(tab.pendingApiKey).toBe('');
  });

  it('returns false and preserves the typed key when flush throws (so caller skips saveSettings)', () => {
    const secretStorage = backendThrows();
    const { tab } = makeTab(secretStorage, 'sk-user-typed');
    const ok = tab.commitTempSettings();
    expect(ok).toBe(false);
    // Key preserved in memory for retry — and only in memory.
    expect(tab.pendingApiKey).toBe('sk-user-typed');
  });

  it('returns true and does no SecretStorage IO when the typed buffer is empty', () => {
    const secretStorage = backend('sk-existing-stays');
    const { tab } = makeTab(secretStorage, '');
    let ioCount = 0;
    const originalSet = secretStorage.setSecret;
    secretStorage.setSecret = (id, value) => { ioCount++; originalSet(id, value); };
    const ok = tab.commitTempSettings();
    expect(ok).toBe(true);
    expect(ioCount).toBe(0);  // no needless SecretStorage write
    expect(secretStorage.values.get(SECRET_ID)).toBe('sk-existing-stays');  // preserved
  });

  it('skips SecretStorage write for a whitespace-only typed buffer', () => {
    const secretStorage = backend('sk-existing-stays');
    const { tab } = makeTab(secretStorage, '   ');
    let ioCount = 0;
    const originalSet = secretStorage.setSecret;
    secretStorage.setSecret = (id, value) => { ioCount++; originalSet(id, value); };
    const ok = tab.commitTempSettings();
    expect(ok).toBe(true);
    expect(ioCount).toBe(0);  // don't overwrite SecretStorage with empty
    expect(secretStorage.values.get(SECRET_ID)).toBe('sk-existing-stays');
  });

  it('end-to-end: provider switch + Test Connection → SecretStorage updated', () => {
    // The exact bug shape:
    // - Pre-existing SecretStorage = sk-deepseek-OLD
    // - User typed sk-minimax-NEW in Settings tab
    // - User clicked Test Connection → commitTempSettings runs
    // - Pre-fix: SecretStorage still sk-deepseek-OLD (BUG)
    // - Post-fix: SecretStorage = sk-minimax-NEW
    const secretStorage = backend('sk-deepseek-OLD');
    const { tab } = makeTab(secretStorage, 'sk-minimax-NEW');
    tab.commitTempSettings();
    expect(secretStorage.values.get(SECRET_ID)).toBe('sk-minimax-NEW');
  });

  it('end-to-end: failure path → caller skips saveSettings → SecretStorage unchanged', () => {
    const secretStorage = backendThrows();
    const { tab } = makeTab(secretStorage, 'sk-minimax-NEW');
    const ok = tab.commitTempSettings();
    expect(ok).toBe(false);
    expect(tab.pendingApiKey).toBe('sk-minimax-NEW');  // preserved for retry
  });
});