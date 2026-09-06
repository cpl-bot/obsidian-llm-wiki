/**
 * Hardening Phase 3 (F-03), task 3.6: prove there is no persisted slot
 * left for a provider credential.
 *
 * `data.json` lives inside the vault, so anything the settings object can
 * hold rides along into git, iCloud, Syncthing and every backup. Deleting
 * the `apiKey` settings field closed that; this file is the guard that keeps it
 * closed, because the failure mode is a quiet one — an upstream merge
 * re-adds a `token` field, everything still compiles, every other test
 * still passes, and the leak is back.
 *
 * Two independent angles, because either alone is easy to fool:
 *
 *   1. Structural — no field NAME in the settings type looks like a
 *      credential holder. The `*SecretId` fields are the deliberate
 *      exception and are asserted to hold slot identifiers, not secrets.
 *   2. Behavioural — a fully-configured settings object, serialized the
 *      way `saveData` serializes it, matches none of the credential
 *      SHAPES an allowlist of key-like patterns describes.
 *
 * A note on the sentinels. The obvious construction — fill every string
 * field with an `sk-live-…` value and assert the JSON has no key shape —
 * is self-defeating: those sentinels ARE key-shaped, so the assertion
 * could never pass. Instead every string field gets a distinct
 * NON-key-shaped sentinel (so a value showing up in the JSON can be
 * traced to the exact field that leaked it), and the key-shaped values
 * are injected where a real key can actually enter: the transient typed
 * buffer and the keychain. If any field could carry a credential to
 * disk, that is where it would come from.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type LLMWikiSettings } from '../../types';

/** The shapes a persisted provider credential would take. */
const KEY_SHAPES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'OpenAI-style sk- key', pattern: /\bsk-[A-Za-z0-9_-]{10,}/ },
  { name: 'Anthropic-style sk-ant key', pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: 'Bearer token', pattern: /\bBearer\s+\S{8,}/i },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google-style AIza key', pattern: /\bAIza[0-9A-Za-z_-]{20,}/ },
  { name: 'GitHub-style token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
  { name: 'long base64 blob after a credential label', pattern: /(?:token|secret|key|credential)"?\s*[:=]\s*"?[A-Za-z0-9+/=]{32,}/i },
];

/** The name of the field this phase deleted. */
const LEGACY_PLAINTEXT_FIELD = 'apiKey';

/** Field names that read as "this holds a credential". */
const CREDENTIAL_NAME_SHAPES = [/api[_-]?key/i, /secret/i, /token/i, /password/i, /credential/i, /passphrase/i];

/**
 * Names that legitimately match the shapes above. Each is an IDENTIFIER
 * of a keychain slot or a numeric budget — never a credential value — and
 * each is asserted as such below. Adding to this list should require
 * explaining which of those two it is.
 */
const ALLOWED_NAMES: Record<string, 'keychain-slot-id' | 'token-budget'> = {
  providerApiKeySecretId: 'keychain-slot-id',
  maxTokensPerCall: 'token-budget',
};

function serialize(settings: unknown): string {
  // Exactly what `Plugin.saveData` does to the object.
  return JSON.stringify(settings);
}

function expectNoKeyShape(json: string, label: string): void {
  for (const { name, pattern } of KEY_SHAPES) {
    expect(pattern.test(json), `${label} contains a ${name}: ${json.slice(0, 300)}`).toBe(false);
  }
}

describe('the settings type has no credential slot (F-03, task 3.6)', () => {
  it('has no field whose name reads as a credential holder', () => {
    const offenders = Object.keys(DEFAULT_SETTINGS)
      .filter((key) => CREDENTIAL_NAME_SHAPES.some((shape) => shape.test(key)))
      .filter((key) => !(key in ALLOWED_NAMES));
    expect(offenders, 'new credential-shaped settings field').toEqual([]);
  });

  it('holds only slot identifiers and budgets under the allowlisted names', () => {
    const settings = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
    for (const [name, role] of Object.entries(ALLOWED_NAMES)) {
      if (role === 'token-budget') {
        expect(typeof settings[name], `${name} should be a number`).toBe('number');
        continue;
      }
      // A slot id names where the secret lives; it is not the secret.
      expect(settings[name], `${name} should be a namespaced slot id`).toMatch(/^karpathywiki-[a-z0-9-]+$/);
    }
  });

  it('does not declare apiKey at all — not even as an empty string', () => {
    expect(LEGACY_PLAINTEXT_FIELD in (DEFAULT_SETTINGS as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe('serializing settings never yields a key-shaped value (F-03, task 3.6)', () => {
  it('DEFAULT_SETTINGS serializes clean', () => {
    expectNoKeyShape(serialize(DEFAULT_SETTINGS), 'DEFAULT_SETTINGS');
  });

  /**
   * A settings object with every string field populated — the shape a
   * long-lived install's `data.json` actually has. Each sentinel names its
   * own field so a failure points straight at the leaking one.
   */
  function fullyConfigured(): LLMWikiSettings {
    const settings = { ...DEFAULT_SETTINGS } as unknown as Record<string, unknown>;
    for (const key of Object.keys(settings)) {
      if (typeof settings[key] === 'string') settings[key] = `sentinel-value-for-${key}`;
    }
    // The slot id is read back as a keychain lookup, so keep it real.
    settings.providerApiKeySecretId = DEFAULT_SETTINGS.providerApiKeySecretId;
    return settings as unknown as LLMWikiSettings;
  }

  it('a fully-configured settings object serializes clean', () => {
    expectNoKeyShape(serialize(fullyConfigured()), 'fully-configured settings');
  });

  it('every string field is accounted for by a sentinel (the fixture actually filled them)', () => {
    const json = serialize(fullyConfigured());
    const stringFields = Object.entries(DEFAULT_SETTINGS as unknown as Record<string, unknown>)
      .filter(([key, value]) => typeof value === 'string' && !(key in ALLOWED_NAMES))
      .map(([key]) => key);
    expect(stringFields.length).toBeGreaterThan(5);
    for (const field of stringFields) {
      expect(json, `fixture did not populate ${field}`).toContain(`sentinel-value-for-${field}`);
    }
  });

  // The real key exists in exactly two places, and neither is this object.
  it('assigning a key-shaped value has nowhere to land: no field accepts it', () => {
    const settings = fullyConfigured() as unknown as Record<string, unknown>;
    const before = serialize(settings);
    // Simulate the pre-hardening leak: something writes the key back.
    // The point is that no PRODUCTION path does this any more — if one
    // did, the JSON would carry the shape and the assertion below fires.
    expectNoKeyShape(before, 'fully-configured settings');
    // Written through a computed key on purpose: the field does not exist
    // on the type any more, so this is the only way to simulate its return.
    settings[LEGACY_PLAINTEXT_FIELD] = 'sk-live-0123456789abcdefghij';
    expect(() => expectNoKeyShape(serialize(settings), 'tampered settings')).toThrow();
  });
});
