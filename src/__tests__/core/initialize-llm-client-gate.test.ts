// initializeLLMClient must allow lmstudio (and ollama) with an empty
// apiKey — same gate as testLLMConnection (#223). Without this, ingest
// commands see llmClient === null and show errorNoApiKey.
//
// Hardening Phase 3 (F-03): "empty apiKey" now means an empty OS-keychain
// slot, not an empty `settings.apiKey` field — that field no longer exists.
// The fixtures below therefore seed a stub keychain instead.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import LLMWikiPlugin from '../../main';

vi.mock('../../llm-sdk/create-llm-client', () => ({
  createLLMClientFromSettingsSync: vi.fn(() => ({
    createMessage: vi.fn().mockResolvedValue('ok'),
    createMessageStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
  })),
  preloadLLMClientModules: vi.fn().mockResolvedValue(undefined),
  _resetPreloadedModulesForTests: vi.fn(),
}));

const SECRET_ID = 'karpathywiki-provider-api-key';

describe('initializeLLMClient — local provider API key gate', () => {
  /** The key the stub keychain answers with; reset per test. */
  let storedKey = '';
  const mockApp = {
    vault: {
      getAbstractFileByPath: vi.fn().mockReturnValue(null),
      getMarkdownFiles: vi.fn().mockReturnValue([]),
      read: vi.fn().mockResolvedValue(''),
    },
    secretStorage: {
      getSecret: (id: string) => (id === SECRET_ID ? storedKey : null),
      setSecret: (id: string, value: string) => { if (id === SECRET_ID) storedKey = value; },
    },
  };
  const mockManifest = {
    id: 'test-plugin',
    name: 'Test',
    version: '1.0.0',
    minAppVersion: '0.15.0',
  };
  let plugin: LLMWikiPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    storedKey = '';
    plugin = new LLMWikiPlugin(mockApp as never, mockManifest as never);
    (plugin as unknown as Record<string, unknown>).settings = {
      provider: 'openai',
      providerApiKeySecretId: SECRET_ID,
      baseUrl: 'http://localhost:1234/v1',
      model: 'qwen2.5-7b',
      language: 'en',
      wikiFolder: 'wiki',
      llmReady: true,
      maxTokensPerCall: 0,
      autoIngestNotificationLevel: 'notice',
      autoWatchSources: false,
      startupCheck: false,
      slugCase: 'preserve',
    };
  });

  it('initializes llmClient for lmstudio with empty apiKey (ingest gate)', () => {
    (plugin as unknown as Record<string, unknown>).settings = {
      ...(plugin as unknown as Record<string, unknown>).settings as Record<string, unknown>,
      provider: 'lmstudio',
    };

    plugin.initializeLLMClient();

    expect(plugin.llmClient).not.toBeNull();
  });

  it('initializes llmClient for ollama with empty apiKey (existing behavior)', () => {
    (plugin as unknown as Record<string, unknown>).settings = {
      ...(plugin as unknown as Record<string, unknown>).settings as Record<string, unknown>,
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
    };

    plugin.initializeLLMClient();

    expect(plugin.llmClient).not.toBeNull();
  });

  it('leaves llmClient null for openai with empty apiKey', () => {
    (plugin as unknown as Record<string, unknown>).settings = {
      ...(plugin as unknown as Record<string, unknown>).settings as Record<string, unknown>,
      provider: 'openai',
    };

    plugin.initializeLLMClient();

    expect(plugin.llmClient).toBeNull();
  });

  it('initializes llmClient for lmstudio when the stored key is whitespace-only', () => {
    storedKey = '   ';
    (plugin as unknown as Record<string, unknown>).settings = {
      ...(plugin as unknown as Record<string, unknown>).settings as Record<string, unknown>,
      provider: 'lmstudio',
    };

    plugin.initializeLLMClient();

    expect(plugin.llmClient).not.toBeNull();
  });

  // Hardening Phase 3 (F-03): a keychain that cannot be read is NOT the
  // same as an empty slot. The gate must refuse to build a client rather
  // than reach for anything on disk — there is nothing on disk to reach for.
  it('leaves llmClient null when the keychain read throws (fail closed)', () => {
    const brokenApp = {
      ...mockApp,
      secretStorage: {
        getSecret: () => { throw new Error('Secret Service is not running'); },
        setSecret: () => {},
      },
    };
    const broken = new LLMWikiPlugin(brokenApp as never, mockManifest as never);
    (broken as unknown as Record<string, unknown>).settings = {
      ...(plugin as unknown as Record<string, unknown>).settings as Record<string, unknown>,
      provider: 'openai',
    };

    broken.initializeLLMClient();

    expect(broken.llmClient).toBeNull();
  });
});
