/**
 * Issue #456: commitTempSettings must preserve per-task model fields on commit.
 *
 * Root cause (v1.24.1 PATCH Phase 5.5.0): a defensive belt-and-suspenders
 * cascade was added inside commitTempSettings. The cascade belongs on the
 * live-edit path only — setFieldValue('model', ...) already fires it.
 * Commit must be a pure write-through.
 *
 * Tests below exercise the REAL production methods (not a mirror) per
 * project TDD standard — shell tests via local re-implementation are
 * explicitly banned because they pass even when production regresses.
 *
 * The setFieldValue → cascadeUnifiedModelChange live-edit path is pinned
 * separately by settings-cascade.test.ts; not duplicated here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../types';
import { LLMWikiSettingTab } from '../../ui/settings';

beforeEach(() => {
  // Stub global Notice so flushApiKey's catch branch can instantiate it
  // without pulling in the full Obsidian Notice surface in unit tests.
  vi.stubGlobal('Notice', class {
    constructor() {
      /* noop */
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeTab(
  overrides: Record<string, unknown>,
  options: { setSecretThrows?: boolean } = {},
): LLMWikiSettingTab {
  // App stub — commitTempSettings only reads app.secretStorage (via flushApiKey).
  const tab = Object.create(LLMWikiSettingTab.prototype) as LLMWikiSettingTab;
  (tab as unknown as { app: unknown }).app = {
    secretStorage: {
      getSecret: () => null,
      setSecret: options.setSecretThrows
        ? () => {
            throw new Error('SecretStorage locked');
          }
        : () => undefined,
    },
  };
  // plugin.settings is the LIVE reference that commitTempSettings writes to
  // (the spread creates a new object assigned back to plugin.settings).
  (tab as unknown as { plugin: unknown }).plugin = {
    settings: { ...DEFAULT_SETTINGS, ...overrides },
    initializeLLMClient: () => undefined,
    saveSettings: () => undefined,
  };
  // tempSettings: edited by setFieldValue (which fires cascadeUnifiedModelChange
  // on the live-edit path); commitTempSettings is a pure write-through spread
  // into plugin.settings.
  (tab as unknown as { tempSettings: unknown }).tempSettings = {
    ...DEFAULT_SETTINGS,
    ...overrides,
  };
  // Hardening Phase 3 (F-03): the typed key is a field of the tab, not of
  // the settings object. `Object.create(prototype)` skips class field
  // initializers, so seed it explicitly — empty by default, which exercises
  // the flushApiKey short-circuit; the commit-failure test sets it.
  tab.pendingApiKey = typeof overrides.pendingApiKey === 'string' ? overrides.pendingApiKey : '';
  delete (tab as unknown as { tempSettings: Record<string, unknown> }).tempSettings.pendingApiKey;
  // Stub getText so flushApiKey's catch branch can run without pulling in
  // the full TEXTS table (the test pins write-through semantics, not UX).
  (tab as unknown as { getText: unknown }).getText = () => 'stub';
  return tab;
}

describe('Issue #456: commitTempSettings preserves per-task fields', () => {
  it('preserves ingestModel / lintModel / queryModel when unified model is set', () => {
    const tab = makeTab({
      model: 'gpt-5-mini',
      ingestModel: 'gpt-5-mini',
      lintModel: 'gpt-5.5',
      queryModel: 'gpt-5.6-sol',
    });
    const ok = tab.commitTempSettings();
    expect(ok).toBe(true);
    const saved = (tab as unknown as { plugin: { settings: Record<string, string> } }).plugin.settings;
    expect(saved.lintModel).toBe('gpt-5.5');
    expect(saved.queryModel).toBe('gpt-5.6-sol');
    expect(saved.ingestModel).toBe('gpt-5-mini');
    expect(saved.model).toBe('gpt-5-mini');
  });

  it('preserves per-task fields when unified model is blank', () => {
    const tab = makeTab({ model: '', ingestModel: 'i', lintModel: 'l', queryModel: 'q' });
    expect(tab.commitTempSettings()).toBe(true);
    const saved = (tab as unknown as { plugin: { settings: Record<string, string> } }).plugin.settings;
    expect(saved.ingestModel).toBe('i');
    expect(saved.lintModel).toBe('l');
    expect(saved.queryModel).toBe('q');
  });

  it('preserves per-task fields when unified model is whitespace', () => {
    const tab = makeTab({ model: '   ', ingestModel: 'i', lintModel: 'l', queryModel: 'q' });
    expect(tab.commitTempSettings()).toBe(true);
    const saved = (tab as unknown as { plugin: { settings: Record<string, string> } }).plugin.settings;
    expect(saved.ingestModel).toBe('i');
    expect(saved.lintModel).toBe('l');
    expect(saved.queryModel).toBe('q');
  });

  it('leaves plugin.settings untouched when flushApiKey fails (per #339 invariant)', () => {
    // pre-fix snapshot of plugin.settings — represents on-disk persisted state
    const persistedSnapshot = {
      ...DEFAULT_SETTINGS,
      model: 'old-model',
      ingestModel: 'old-ingest',
      lintModel: 'old-lint',
      queryModel: 'old-query',
    };
    const tab = makeTab(
      {
        model: 'new-model',
        ingestModel: 'new-ingest',
        lintModel: 'new-lint',
        queryModel: 'new-query',
        pendingApiKey: 'sk-typed-pending',
      },
      { setSecretThrows: true },
    );
    // Override plugin.settings with the pre-fix snapshot (post-makeTab's default)
    (tab as unknown as { plugin: { settings: Record<string, unknown> } }).plugin.settings = { ...persistedSnapshot };
    expect(tab.commitTempSettings()).toBe(false);
    const saved = (tab as unknown as { plugin: { settings: Record<string, unknown> } }).plugin.settings;
    // Pre-fix snapshot preserved verbatim — no field was overwritten.
    expect(saved.model).toBe('old-model');
    expect(saved.ingestModel).toBe('old-ingest');
    expect(saved.lintModel).toBe('old-lint');
    expect(saved.queryModel).toBe('old-query');
    // The pending typed key MUST NOT have leaked into plugin.settings —
    // and since hardening Phase 3 (F-03) there is not even a field for it
    // to leak into. It stayed in the tab's in-memory buffer for a retry.
    expect('apiKey' in saved).toBe(false);
    expect(tab.pendingApiKey).toBe('sk-typed-pending');
  });
});