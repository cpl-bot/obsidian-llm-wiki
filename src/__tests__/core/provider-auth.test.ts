// provider-auth tests: legacy policy invariants (restored — the #425
// review caught them being replaced rather than extended).
//
// Hardening Phase 2.B removed BOTH credential-orchestrated providers: the
// cloud provider whose SSO/IAM modes let an AWS credential stand in for the
// bearer key, and the ChatGPT-subscription OAuth provider that was
// configured without a key at all. `isProviderConfigured` is therefore back
// to two cases — keyless local endpoints, and everything else needs a key.
// The final describes pin that neither removed provider's ids are
// registered any more: a re-merge would otherwise put a
// selectable-but-unconstructable provider back in the dropdown.

import { describe, expect, it } from 'vitest';
import {
  isProviderConfigured,
  providerRequiresApiKey,
} from '../../core/provider-auth';
import { PREDEFINED_PROVIDERS } from '../../types';

describe('provider auth policy (legacy invariants)', () => {
  it('keeps OpenAI on API-key auth', () => {
    expect(providerRequiresApiKey('openai')).toBe(true);
  });
  // Hardening Phase 2.B: the OAuth-only provider that used to be exercised
  // here is gone, and with it the "configured without an API key" branch.
  // Every remaining provider is either API-key-authenticated or keyless-local.
  it('preserves keyless local providers', () => {
    expect(isProviderConfigured({ provider: 'ollama', apiKey: '', model: 'qwen3' })).toBe(true);
    expect(isProviderConfigured({ provider: 'lmstudio', apiKey: '', model: 'local' })).toBe(true);
  });
  it('requires an API key for every non-local provider', () => {
    expect(isProviderConfigured({ provider: 'openai', apiKey: '', model: 'gpt-4.1' })).toBe(false);
    expect(isProviderConfigured({ provider: 'openai', apiKey: 'sk-x', model: 'gpt-4.1' })).toBe(true);
  });
});

// Hardening Phase 2.B: the removed AWS provider registered two ids. Neither
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
    })).toBe(false);
  });
});

// The same guarantee for the removed OAuth provider: its single id must not
// be selectable, and a `data.json` that still names it gets no special
// treatment — it needs a key like any other unknown provider.
describe('removed OAuth provider surface (hardening Phase 2.B)', () => {
  const removedOAuthId = `openai-${['cod', 'ex'].join('')}`;

  it('registers no provider under the removed OAuth id', () => {
    expect(Object.keys(PREDEFINED_PROVIDERS)).not.toContain(removedOAuthId);
  });

  it('leaves no authMode that authenticates without a key', () => {
    const modes = new Set(Object.values(PREDEFINED_PROVIDERS).map((config) => config.authMode));
    expect([...modes].sort()).toEqual(['api-key', 'none']);
  });

  it('treats a stale removed OAuth id as needing a key', () => {
    expect(providerRequiresApiKey(removedOAuthId)).toBe(true);
    expect(isProviderConfigured({ provider: removedOAuthId, apiKey: '', model: 'gpt-5.5' })).toBe(false);
  });
});
