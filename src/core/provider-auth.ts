import { isLocalNoKeyProvider } from './local-no-key-provider';

export const OPENAI_CODEX_PROVIDER_ID = 'openai-codex';

// Hardening Phase 2.B: `BedrockAuthMethod` / `usesBedrockAwsCredentials()`
// used to live here — the single predicate for "this provider signs with
// AWS credentials instead of a bearer key". Both are gone with the AWS
// provider surface itself, so every remaining provider authenticates with
// either an API key, Codex OAuth, or nothing (local endpoints).

export interface ProviderCredentialState {
  provider: string;
  apiKey: string;
  model: string;
  hasCodexCredential: boolean;
}

export function providerRequiresApiKey(provider: string): boolean {
  return provider !== OPENAI_CODEX_PROVIDER_ID && !isLocalNoKeyProvider(provider);
}

export function providerSupportsOAuth(provider: string): boolean {
  return provider === OPENAI_CODEX_PROVIDER_ID;
}

export function isProviderConfigured(input: ProviderCredentialState): boolean {
  if (!input.model.trim()) return false;
  if (input.provider === OPENAI_CODEX_PROVIDER_ID) return input.hasCodexCredential;
  if (!providerRequiresApiKey(input.provider)) return true;
  return input.apiKey.trim().length > 0;
}
