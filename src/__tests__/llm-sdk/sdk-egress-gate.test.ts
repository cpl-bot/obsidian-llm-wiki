// AI SDK 7 / @ai-sdk/* 4 upgrade guard (Phase 1.3 follow-up).
//
// `src/__tests__/core/egress-bridge-gate.test.ts` proves the gate is the
// first statement of each chokepoint by calling the bridge directly. That
// test cannot see the one thing a provider-SDK major can silently break:
// whether the SDK still routes its HTTP through the `fetch` we hand
// `createOpenAICompatible` / `createOpenAI` / `createAnthropic` at all.
// If a future major stopped honouring the custom `fetch` option (or
// started using an internal transport for some request class), every
// direct-bridge test would stay green while credentialed traffic left the
// plugin unpoliced.
//
// So these tests drive the REAL provider adapters through the REAL
// `generateText` with the clients' PRODUCTION fetch defaults (no `fetch`
// override in the constructor — that is the point) and assert both
// directions:
//   - denied host  → `EgressDeniedError`, and `requestUrl` is never reached
//   - allowed host → `requestUrl` IS reached, i.e. the SDK really did call
//                    our bridge rather than some transport of its own
//
// A loopback baseURL is used for the allowed arm because `streamWithFallback`
// routes local URLs straight to `obsidianFetchBridge` (no `window.fetch`
// gamble), which keeps the assertion deterministic under the node test
// environment.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestUrl } from 'obsidian';
import { OpenAICompatSdkClient } from '../../llm-sdk/openai-compat-sdk-client';
import { OpenAISdkClient } from '../../llm-sdk/openai-sdk-client';
import { AnthropicSdkClient } from '../../llm-sdk/anthropic-sdk-client';
import { createLLMClientFromSettings } from '../../llm-sdk/create-llm-client';
import {
  EgressDeniedError,
  registerEgressSettings,
  type EgressSettings,
} from '../../core/egress-policy';

const mockRequestUrl = vi.mocked(requestUrl);

const DENIED_BASE_URL = 'https://evil.example.net/v1';
const LOOPBACK_BASE_URL = 'http://127.0.0.1:11434/v1';

function useSettings(settings: EgressSettings): void {
  registerEgressSettings(() => settings);
}

/** Shape `obsidianFetchBridge` expects back from `requestUrl`. */
function jsonResult(payload: unknown): Awaited<ReturnType<typeof requestUrl>> {
  const text = JSON.stringify(payload);
  return {
    status: 200,
    text,
    json: payload,
    headers: { 'content-type': 'application/json' },
    arrayBuffer: new TextEncoder().encode(text).buffer,
  } as unknown as Awaited<ReturnType<typeof requestUrl>>;
}

const CHAT_COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 0,
  model: 'm',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

// The official-OpenAI client builds `createOpenAI()(modelId)`, which is the
// Responses model — its reply shape is `output[]`, not `choices[]`.
const OPENAI_RESPONSE = {
  id: 'resp_1',
  object: 'response',
  created_at: 0,
  model: 'gpt-4o-mini',
  status: 'completed',
  output: [
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};

const ANTHROPIC_MESSAGE = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-4-5',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

describe('egress gate under the AI SDK (provider adapters, production fetch defaults)', () => {
  beforeEach(() => {
    mockRequestUrl.mockReset();
    registerEgressSettings(null);
  });

  afterEach(() => registerEgressSettings(null));

  describe('denied destination never reaches the transport', () => {
    it('OpenAICompatSdkClient.createMessage', async () => {
      useSettings({ strictEgress: true });
      const client = new OpenAICompatSdkClient({
        apiKey: 'sk-secret',
        baseURL: DENIED_BASE_URL,
        provider: 'custom',
      });
      await expect(
        client.createMessage({
          model: 'm',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).rejects.toBeInstanceOf(EgressDeniedError);
      expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('OpenAISdkClient.createMessage', async () => {
      useSettings({ strictEgress: true });
      const client = new OpenAISdkClient({
        apiKey: 'sk-secret',
        baseURL: DENIED_BASE_URL,
      });
      await expect(
        client.createMessage({
          model: 'gpt-4o-mini',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).rejects.toBeInstanceOf(EgressDeniedError);
      expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('AnthropicSdkClient.createMessage', async () => {
      useSettings({ strictEgress: true });
      const client = new AnthropicSdkClient({
        apiKey: 'sk-secret',
        baseURL: DENIED_BASE_URL,
      });
      await expect(
        client.createMessage({
          model: 'claude-haiku-4-5',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).rejects.toBeInstanceOf(EgressDeniedError);
      expect(mockRequestUrl).not.toHaveBeenCalled();
    });
  });

  describe('allowed destination still travels through obsidianFetchBridge', () => {
    it('OpenAICompatSdkClient.createMessage reaches requestUrl', async () => {
      useSettings({ strictEgress: true });
      mockRequestUrl.mockResolvedValue(jsonResult(CHAT_COMPLETION));
      const client = new OpenAICompatSdkClient({
        apiKey: 'sk-secret',
        baseURL: LOOPBACK_BASE_URL,
        provider: 'custom',
      });
      const text = await client.createMessage({
        model: 'm',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(text).toBe('ok');
      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
      const params = mockRequestUrl.mock.calls[0][0] as { url: string; body?: string };
      expect(params.url).toContain('127.0.0.1:11434');
      // The gate saw the same URL the transport did — no second,
      // ungated URL construction between the check and the send.
      expect(JSON.parse(String(params.body))).toMatchObject({ model: 'm' });
    });

    it('AnthropicSdkClient.createMessage reaches requestUrl', async () => {
      useSettings({ strictEgress: true });
      mockRequestUrl.mockResolvedValue(jsonResult(ANTHROPIC_MESSAGE));
      const client = new AnthropicSdkClient({
        apiKey: 'sk-secret',
        baseURL: LOOPBACK_BASE_URL,
      });
      const text = await client.createMessage({
        model: 'claude-haiku-4-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(text).toBe('ok');
      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
      const params = mockRequestUrl.mock.calls[0][0] as { url: string };
      expect(params.url).toContain('127.0.0.1:11434');
    });
  });

  // The blocks above construct the clients the way production's factory
  // does — no `fetch` / `streamFetch` override, so the constructor defaults
  // (`obsidianFetchBridge` / `streamWithFallback`) are what the SDK gets.
  // That still leaves one seam untested: the factory itself. `main.ts` never
  // calls `new OpenAICompatSdkClient(...)`; it goes through
  // `createLLMClientFromSettings` / `...Sync`, and that factory is free to
  // hand a client an explicit `fetch` / `streamFetch` (a removed provider
  // surface used to do exactly that). A future edit that passed some
  // provider an unbridged fetch there would leave every assertion above
  // green. So drive the real factory too, for both the denied and the
  // allowed direction.
  describe('clients built by the production factory are bridged the same way', () => {
    /** `createLLMClientFromSettings` shape used by `main.ts`, key passed as pending. */
    function factorySettings(provider: string, baseUrl: string) {
      return {
        provider,
        providerApiKeySecretId: 'karpathywiki:provider-key',
        baseUrl,
      };
    }

    it.each([
      ['custom', 'm'],
      ['openai', 'gpt-4o-mini'],
      ['anthropic-compatible', 'claude-haiku-4-5'],
    ] as const)('provider:%s — denied destination never reaches the transport', async (provider, model) => {
      useSettings({ strictEgress: true });
      const client = await createLLMClientFromSettings(
        factorySettings(provider, DENIED_BASE_URL),
        'sk-secret',
      );
      await expect(
        client.createMessage({
          model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).rejects.toBeInstanceOf(EgressDeniedError);
      expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it.each([
      ['custom', 'm', CHAT_COMPLETION],
      ['openai', 'gpt-4o-mini', OPENAI_RESPONSE],
      ['anthropic-compatible', 'claude-haiku-4-5', ANTHROPIC_MESSAGE],
    ] as const)('provider:%s — allowed destination reaches requestUrl', async (provider, model, payload) => {
      useSettings({ strictEgress: true });
      mockRequestUrl.mockResolvedValue(jsonResult(payload));
      const client = await createLLMClientFromSettings(
        factorySettings(provider, LOOPBACK_BASE_URL),
        'sk-secret',
      );
      const text = await client.createMessage({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(text).toBe('ok');
      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
      const params = mockRequestUrl.mock.calls[0][0] as { url: string };
      expect(params.url).toContain('127.0.0.1:11434');
    });
  });
});
