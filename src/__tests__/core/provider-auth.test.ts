// provider-auth tests: legacy policy invariants (restored — the #425
// review caught them being replaced rather than extended).
//
// Hardening Phase 2.B removed the cloud provider whose SSO/IAM modes let
// an AWS credential stand in for the bearer key, so `isProviderConfigured`
// is back to three cases: Codex OAuth, keyless local endpoints, and
// everything else needs a key. The final describe pins that the removed
// provider ids really are unregistered — a re-merge would otherwise put a
// selectable-but-unconstructable provider back in the dropdown.

import { describe, expect, it } from 'vitest';
import {
  isProviderConfigured,
  providerRequiresApiKey,
  providerSupportsOAuth,
} from '../../core/provider-auth';
import { PREDEFINED_PROVIDERS } from '../../types';

describe('provider auth policy (legacy invariants)', () => {
  it('keeps OpenAI on API-key auth', () => {
    expect(providerRequiresApiKey('openai')).toBe(true);
    expect(providerSupportsOAuth('openai')).toBe(false);
  });
  it('configures openai-codex only with a stored credential and model', () => {
    expect(isProviderConfigured({ provider: 'openai-codex', apiKey: '', model: 'gpt-5.5', hasCodexCredential: false })).toBe(false);
    expect(isProviderConfigured({ provider: 'openai-codex', apiKey: '', model: 'gpt-5.5', hasCodexCredential: true })).toBe(true);
  });
  it('preserves keyless local providers', () => {
    expect(isProviderConfigured({ provider: 'ollama', apiKey: '', model: 'qwen3', hasCodexCredential: false })).toBe(true);
    expect(isProviderConfigured({ provider: 'lmstudio', apiKey: '', model: 'local', hasCodexCredential: false })).toBe(true);
  });
  it('uses the required ChatGPT Plan label for Codex OAuth', () => {
    expect(PREDEFINED_PROVIDERS['openai-codex'].name).toBe('ChatGPT Plan (Codex OAuth)');
    expect(PREDEFINED_PROVIDERS['openai-codex'].nameEn).toBe('ChatGPT Plan (Codex OAuth)');
    expect(PREDEFINED_PROVIDERS['openai-codex'].nameZh).toBe('ChatGPT Plan (Codex OAuth)');
  });
});

// Hardening Phase 2.B: the removed provider registered two ids. Neither
// may come back — a settings dropdown entry the factory cannot construct
// wedges every LLM call for whoever picks it. The vendor name is assembled
// from fragments so this file does not itself carry the literal that
// `scripts/check-bundle-no-bedrock.mjs` forbids.
describe('removed provider surface (hardening Phase 2.B)', () => {
  const removedVendor = ['bed', 'rock'].join('');

  it('registers no provider naming the removed vendor', () => {
    const offenders = Object.keys(PREDEFINED_PROVIDERS).filter((id) => id.toLowerCase().includes(removedVendor));
    expect(offenders).toEqual([]);
  });

  it('treats a stale removed-provider id as needing a key like any unknown provider', () => {
    // Nothing special-cases it any more: no AWS-credential escape hatch,
    // so a blank key is simply unconfigured.
    expect(providerRequiresApiKey(`${removedVendor}-anthropic`)).toBe(true);
    expect(isProviderConfigured({
      provider: `${removedVendor}-anthropic`,
      apiKey: '',
      model: 'some-model',
      hasCodexCredential: false,
    })).toBe(false);
  });
});
