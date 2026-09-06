// Plugin-level factory seam contract.
//
// History: this file was added for a Bedrock region-forwarding regression
// (#425 prerequisite) — the literal `createLLMClient` builds for the sync
// SDK factory had silently omitted a field, so production sync-path calls
// ran against a default the user had not chosen, while the async factory
// honored the setting. Hardening Phase 2.B removed the AWS provider
// surface, but the *shape* of that bug is provider-independent: the literal
// is the contract between the plugin and the SDK factory, and a dropped
// field there is invisible to every provider-specific test. So the file
// stays, pinning the seams that remain.
//
// Strategy: mock the sync factory (same pattern as
// test-connection-gate.test.ts so no AI-SDK dynamic imports run) and
// assert on the literal it receives — the literal IS the contract
// under test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLLMClient } from '../../core/create-plugin-llm-client';
import { createLLMClientFromSettingsSync } from '../../llm-sdk/create-llm-client';
import type { LLMWikiSettings } from '../../types';

vi.mock('../../llm-sdk/create-llm-client', () => ({
  createLLMClientFromSettingsSync: vi.fn(() => ({
    createMessage: vi.fn().mockResolvedValue('ok'),
    createMessageStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
  })),
  preloadLLMClientModules: vi.fn().mockResolvedValue(undefined),
}));

describe('createLLMClient — sync factory literal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards the credential seams into the sync factory literal', () => {
    const secretStorage = { getSecret: vi.fn(), setSecret: vi.fn() };
    const settings = {
      provider: 'anthropic',
      providerApiKeySecretId: 'karpathywiki-provider-api-key',
      language: 'de',
      baseUrl: 'https://example.invalid',
    } as unknown as LLMWikiSettings;

    createLLMClient(settings, secretStorage, 'pending-key');

    expect(createLLMClientFromSettingsSync).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic',
        providerApiKeySecretId: 'karpathywiki-provider-api-key',
        baseUrl: 'https://example.invalid',
        secretStorage,
      }),
      'pending-key',
    );
  });

  it('passes a null secret storage through rather than dropping the key', () => {
    const settings = {
      provider: 'openai',
      providerApiKeySecretId: 'karpathywiki-provider-api-key',
      language: 'en',
    } as unknown as LLMWikiSettings;

    createLLMClient(settings);

    expect(createLLMClientFromSettingsSync).toHaveBeenCalledWith(
      expect.objectContaining({ secretStorage: null }),
      undefined,
    );
  });

  // Hardening Phase 2.B: the factory used to take two plugin-owned
  // credential orchestrators — the AWS one (plus four `bedrock*` settings
  // fields copied into the literal) and the OAuth one (plus `codexAuth` /
  // `codexVersion` / `codexQuotaMessage`). All of it is gone; nothing in the
  // literal may name either removed vendor again.
  it('puts no trace of the removed provider surfaces into the literal', () => {
    const removedVendors = [['bed', 'rock'].join(''), ['cod', 'ex'].join('')];
    const settings = {
      provider: 'anthropic',
      providerApiKeySecretId: 'karpathywiki-provider-api-key',
      language: 'en',
    } as unknown as LLMWikiSettings;

    createLLMClient(settings);

    const literal = vi.mocked(createLLMClientFromSettingsSync).mock.calls[0][0];
    const offenders = Object.keys(literal).filter((key) => removedVendors.some((vendor) => key.toLowerCase().includes(vendor)));
    expect(offenders).toEqual([]);
  });
});
