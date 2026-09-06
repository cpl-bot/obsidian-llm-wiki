/**
 * v1.25.1 Phase C-PR3: Plugin-level LLM client factory.
 *
 * Extracted from main.ts to break the circular dependency between
 * main.ts and main-commands/connection-commands.ts: the connection
 * test commands need to call createLLMClient without main.ts
 * importing from them in return.
 *
 * Pure function — no class or plugin state. Exists solely to inject
 * user-configured advanced settings (temperature, repetitionPenalty)
 * into the AI-SDK-backed client.
 */

import { wrapWithAdvancedSettings } from '../llm-client-wrapper';
import { createLLMClientFromSettingsSync } from '../llm-sdk/create-llm-client';
import type { ProviderSecretStorage } from '../llm-sdk/provider-secret-store';
import type { LLMWikiSettings, LLMClient } from '../types';

export function createLLMClient(
  settings: LLMWikiSettings,
  // v1.25.3 #182: the SDK factory reads the live key from Obsidian
  // SecretStorage. Pass `plugin.app.secretStorage` — hardening Phase 3
  // (F-03) removed the on-disk fallback AND made an absent store fail
  // closed (minAppVersion 1.11.4 guarantees `app.secretStorage` exists),
  // so omitting it now throws `ProviderSecretStorageError` for every
  // provider that needs a bearer key.
  secretStorage?: ProviderSecretStorage | null,
  // v1.25.7 PATCH: forward the in-memory typed key (tab.pendingApiKey
  // in the Test Connection flow) so the freshly-typed key wins over the
  // stale SecretStorage value. Production callers pass undefined.
  pendingApiKey?: string,
): LLMClient {
  // Hardening Phase 2.B: both removed provider surfaces (the
  // ChatGPT-subscription OAuth provider and the AWS Bedrock SSO/IAM
  // provider) used to thread a plugin-owned credential orchestrator
  // through here. Neither exists any more, so the factory takes nothing
  // beyond the settings, the keychain and the in-flight typed key.
  const client: LLMClient = createLLMClientFromSettingsSync({
    provider: settings.provider,
    providerApiKeySecretId: settings.providerApiKeySecretId,
    secretStorage: secretStorage ?? null,
    baseUrl: settings.baseUrl,
  }, pendingApiKey);

  return wrapWithAdvancedSettings(client, {
    maxTokensPerCall: settings.maxTokensPerCall,
    extractionTemperature: settings.extractionTemperature,
    extractionTopP: settings.extractionTopP,
    samplingSeed: settings.samplingSeed,
    chatTemperature: settings.chatTemperature,
    repetitionPenalty: settings.repetitionPenalty,
    taskPolicies: settings.taskPolicies,
  });
}
