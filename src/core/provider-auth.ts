import { isLocalNoKeyProvider } from './local-no-key-provider';

/** #425 Bedrock Stage 2 — auth modes of the two bedrock-* providers. */
export type BedrockAuthMethod = 'api-key' | 'sso' | 'iam';

/**
 * #425 — single predicate for "this provider+mode signs requests with
 * AWS credentials instead of a bearer key". One home, four former
 * spellings (factory, connection gate ×2, provider-auth gate).
 */
export function usesBedrockAwsCredentials(provider: string, authMethod: BedrockAuthMethod | undefined): boolean {
  return provider.startsWith('bedrock-') && (authMethod ?? 'api-key') !== 'api-key';
}

export interface ProviderCredentialState {
  provider: string;
  apiKey: string;
  model: string;
  /** #425 Bedrock Stage 2 — auth mode of the active bedrock-* provider.
   * Absent for every other provider (and for api-key mode). */
  bedrockAuthMethod?: BedrockAuthMethod;
  /** #425 — true when an SSO token or IAM keys are actually present. */
  hasBedrockCredential?: boolean;
}

export function providerRequiresApiKey(provider: string): boolean {
  return !isLocalNoKeyProvider(provider);
}

export function isProviderConfigured(input: ProviderCredentialState): boolean {
  if (!input.model.trim()) return false;
  // #425: in sso/iam modes AWS credentials replace the bearer key —
  // presence of the credential, not a key string, decides readiness.
  if ((input.bedrockAuthMethod === 'sso' || input.bedrockAuthMethod === 'iam') && input.provider.startsWith('bedrock-')) {
    return input.hasBedrockCredential === true;
  }
  if (!providerRequiresApiKey(input.provider)) return true;
  return input.apiKey.trim().length > 0;
}
