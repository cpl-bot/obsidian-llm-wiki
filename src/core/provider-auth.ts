import { isLocalNoKeyProvider } from './local-no-key-provider';

// Hardening Phase 2.B removed both credential-orchestrated provider
// surfaces that used to widen this module:
//   - `BedrockAuthMethod` / `usesBedrockAwsCredentials()` — the single
//     predicate for "this provider signs with AWS credentials instead of a
//     bearer key", plus the `bedrockAuthMethod` / `hasBedrockCredential`
//     fields on `ProviderCredentialState`.
//   - `OPENAI_CODEX_PROVIDER_ID` / `providerSupportsOAuth()` and the
//     `hasCodexCredential` field — the OAuth readiness branch.
// With both gone every remaining provider authenticates with either an API
// key or nothing at all (local endpoints), so readiness is a single
// question again.

export interface ProviderCredentialState {
  provider: string;
  apiKey: string;
  model: string;
}

export function providerRequiresApiKey(provider: string): boolean {
  return !isLocalNoKeyProvider(provider);
}

export function isProviderConfigured(input: ProviderCredentialState): boolean {
  if (!input.model.trim()) return false;
  if (!providerRequiresApiKey(input.provider)) return true;
  return input.apiKey.trim().length > 0;
}
