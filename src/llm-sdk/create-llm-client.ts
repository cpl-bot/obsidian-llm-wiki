// v1.23.0 P1-7: Provider-agnostic factory that maps settings.provider
// to the appropriate AI-SDK-backed client.
//
// Replaces the hand-rolled factory in main.ts that constructed
// OpenAICompatibleClient / AnthropicClient / AnthropicCompatibleClient
// based on `settings.provider`.
//
// Decision tree (matches PREDEFINED_PROVIDERS in types.ts):
//   - 'anthropic'              → AnthropicSdkClient  (api.anthropic.com)
//   - 'anthropic-compatible'   → AnthropicSdkClient with custom baseURL
//   - 'openai'                 → OpenAISdkClient (official)
//   - everything else          → OpenAICompatSdkClient (8 OpenAI-compatible baseURLs)
//
// B1 strategy: the three SDK modules are loaded via dynamic import.
// `createLLMClientFromSettings` is async; `createLLMClientFromSettingsSync`
// is a sync shim that uses pre-loaded modules (loaded eagerly by
// `preloadLLMClientModules` on plugin startup). This keeps the call
// sites in main.ts / wiki-engine.ts / query-engine.ts unchanged
// (they all expect a sync `LLMClient` instance).

import { LLMClient } from '../types';
import type { CodexAuthManager } from './openai-codex/auth-manager';
import { resolveProviderApiKey } from './provider-api-key-resolver';
import type { ProviderSecretStorage } from './provider-secret-store';

export interface ProviderSettings {
  provider: string;
  /**
   * v1.25.3 #182: stable ID for the provider API key in Obsidian
   * SecretStorage — the only place the key lives. Hardening Phase 3
   * (F-03) removed the `apiKey` plaintext mirror that used to sit
   * alongside this field as a fallback.
   */
  providerApiKeySecretId: string;
  /**
   * v1.25.3 #182: optional SecretStorage surface. When provided, the
   * factory reads the live key from it; when null there is no source,
   * so the resolved key is '' ("no key configured"). Callers that hold
   * a freshly-typed key pass it as `pendingApiKey` instead.
   */
  secretStorage?: ProviderSecretStorage | null;
  baseUrl?: string;
  useOfficialOpenAI?: boolean;
  codexAuth?: CodexAuthManager;
  codexVersion?: string;
  codexQuotaMessage?: string;
}

// Hardening Phase 2.B: `resolveBedrockRegion()` and `createBedrockClient()`
// used to sit here — the region-scoped mantle baseURL builder plus the SigV4
// signing wrappers that replaced bearer auth on both fetch seams. The whole
// AWS provider surface is gone, so every branch below authenticates with a
// bearer key, Codex OAuth, or nothing at all.

/**
 * Async factory used by callers that can await (Test Connection,
 * settings change handlers, ingestion init).
 */
export async function createLLMClientFromSettings(
  settings: ProviderSettings,
  pendingApiKey?: string,
): Promise<LLMClient> {
  const { OpenAISdkClient } = await import('./openai-sdk-client');
  const { AnthropicSdkClient } = await import('./anthropic-sdk-client');
  const { OpenAICompatSdkClient } = await import('./openai-compat-sdk-client');
  const { OpenAICodexSdkClient } = await import('./openai-codex-sdk-client');

  const provider = settings.provider;
  // v1.25.3 #182: read the key through the resolver — SecretStorage is
  // the only source. Hardening Phase 3 (F-03): a keychain that cannot be
  // read throws ProviderSecretStorageError out of this factory rather
  // than degrading to a plaintext value from disk; the callers that own a
  // UI surface (initializeLLMClient, testLLMConnection) turn it into the
  // "keychain unavailable" Notice.
  // v1.25.7 PATCH: forward the optional pendingApiKey (tab.pendingApiKey
  // in the Test Connection flow) so the freshly-typed key wins over the
  // stale SecretStorage value. Production callers pass undefined.
  const apiKey = resolveProviderApiKey(
    { providerApiKeySecretId: settings.providerApiKeySecretId },
    settings.secretStorage ?? null,
    pendingApiKey,
  );
  const baseUrl = settings.baseUrl?.trim() || undefined;

  if (provider === 'openai-codex') {
    if (!settings.codexAuth) throw new Error('Codex auth manager is required');
    return new OpenAICodexSdkClient({ auth: settings.codexAuth, sessionId: () => crypto.randomUUID(), version: settings.codexVersion ?? 'unknown', quotaMessage: settings.codexQuotaMessage });
  }
  if (provider === 'anthropic') {
    return new AnthropicSdkClient({ apiKey });
  }

  if (provider === 'anthropic-compatible') {
    return new AnthropicSdkClient({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
  }

  if (provider === 'openai' || settings.useOfficialOpenAI) {
    return new OpenAISdkClient({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
  }

  return new OpenAICompatSdkClient({
    apiKey,
    baseURL: baseUrl ?? 'http://localhost:11434/v1',
    provider,
  });
}

/**
 * Synchronous factory for callers that can't await (legacy main.ts
 * `createLLMClient`, page-factory, source-analyzer). Requires the
 * three SDK modules to be pre-loaded via `preloadLLMClientModules()`
 * at plugin startup, otherwise throws.
 */
export interface PreloadedSdkModules {
  OpenAISdkClient: typeof import('./openai-sdk-client').OpenAISdkClient;
  AnthropicSdkClient: typeof import('./anthropic-sdk-client').AnthropicSdkClient;
  OpenAICompatSdkClient: typeof import('./openai-compat-sdk-client').OpenAICompatSdkClient;
  OpenAICodexSdkClient: typeof import('./openai-codex-sdk-client').OpenAICodexSdkClient;
}

let preloadedModules: PreloadedSdkModules | null = null;

/**
 * Eagerly load all three SDK modules. Called once during plugin
 * `onload()` so subsequent sync `createLLMClientFromSettingsSync`
 * calls don't need to await dynamic imports (which would block the
 * sync API contract).
 */
export async function preloadLLMClientModules(): Promise<void> {
  const [openai, anthropic, compat, codex] = await Promise.all([
    import('./openai-sdk-client'),
    import('./anthropic-sdk-client'),
    import('./openai-compat-sdk-client'),
    import('./openai-codex-sdk-client'),
  ]);
  preloadedModules = {
    OpenAISdkClient: openai.OpenAISdkClient,
    AnthropicSdkClient: anthropic.AnthropicSdkClient,
    OpenAICompatSdkClient: compat.OpenAICompatSdkClient,
    OpenAICodexSdkClient: codex.OpenAICodexSdkClient,
  };
}

/**
 * Sync factory used by main.ts and legacy call sites. Requires
 * `preloadLLMClientModules()` to have been awaited at plugin startup.
 * If not preloaded, throws — this signals a bug in the plugin init
 * order, not a runtime config issue.
 */
export function createLLMClientFromSettingsSync(
  settings: ProviderSettings,
  pendingApiKey?: string,
): LLMClient {
  if (!preloadedModules) {
    throw new Error(
      '[v1.23.0 LLM migration] SDK modules not preloaded. ' +
      'Call `await preloadLLMClientModules()` during plugin onload() before any LLM call.'
    );
  }
  const { OpenAISdkClient, AnthropicSdkClient, OpenAICompatSdkClient, OpenAICodexSdkClient } = preloadedModules;

  const provider = settings.provider;
  // v1.25.3 #182: read the key through the resolver — SecretStorage is
  // the only source. Hardening Phase 3 (F-03): a keychain that cannot be
  // read throws ProviderSecretStorageError out of this factory rather
  // than degrading to a plaintext value from disk; the callers that own a
  // UI surface (initializeLLMClient, testLLMConnection) turn it into the
  // "keychain unavailable" Notice.
  // v1.25.7 PATCH: forward the optional pendingApiKey (tab.pendingApiKey
  // in the Test Connection flow) so the freshly-typed key wins over the
  // stale SecretStorage value. Production callers pass undefined.
  const apiKey = resolveProviderApiKey(
    { providerApiKeySecretId: settings.providerApiKeySecretId },
    settings.secretStorage ?? null,
    pendingApiKey,
  );
  const baseUrl = settings.baseUrl?.trim() || undefined;

  if (provider === 'openai-codex') {
    if (!settings.codexAuth) throw new Error('Codex auth manager is required');
    return new OpenAICodexSdkClient({ auth: settings.codexAuth, sessionId: () => crypto.randomUUID(), version: settings.codexVersion ?? 'unknown', quotaMessage: settings.codexQuotaMessage });
  }
  if (provider === 'anthropic') {
    return new AnthropicSdkClient({ apiKey });
  }

  if (provider === 'anthropic-compatible') {
    return new AnthropicSdkClient({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
  }

  if (provider === 'openai' || settings.useOfficialOpenAI) {
    return new OpenAISdkClient({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
  }

  return new OpenAICompatSdkClient({
    apiKey,
    baseURL: baseUrl ?? 'http://localhost:11434/v1',
    provider,
  });
}

/**
 * Test helper: reset preloaded module cache (used by unit tests that
 * want to exercise the lazy-path).
 */
export function _resetPreloadedModulesForTests(): void {
  preloadedModules = null;
}
