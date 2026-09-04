// Phase 4.2 (F-04) — the fetch chokepoints must consult the egress
// policy BEFORE any transport call.
//
// The assertion that matters is negative: on a denial `requestUrl` /
// `window.fetch` must never be reached, because reaching them is exactly
// what leaks the `Authorization: Bearer …` header.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestUrl } from 'obsidian';
import {
  obsidianFetchBridge,
  streamingObsidianFetch,
  streamWithFallback,
} from '../../core/obsidian-fetch-bridge';
import {
  EgressDeniedError,
  registerEgressSettings,
  type EgressSettings,
} from '../../core/egress-policy';

const mockRequestUrl = vi.mocked(requestUrl);

function okResult(): Awaited<ReturnType<typeof requestUrl>> {
  return {
    status: 200,
    text: '{}',
    json: {},
    headers: {},
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Awaited<ReturnType<typeof requestUrl>>;
}

function useSettings(settings: EgressSettings): void {
  registerEgressSettings(() => settings);
}

describe('obsidianFetchBridge egress gate', () => {
  beforeEach(() => {
    mockRequestUrl.mockReset();
    mockRequestUrl.mockResolvedValue(okResult());
    registerEgressSettings(null);
  });

  afterEach(() => registerEgressSettings(null));

  it('reaches requestUrl for an allowlisted host', async () => {
    useSettings({ strictEgress: true });
    await obsidianFetchBridge('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it('throws EgressDeniedError and never calls requestUrl for an unlisted host', async () => {
    useSettings({ strictEgress: true });
    await expect(
      obsidianFetchBridge('https://evil.example.net/v1/chat', { method: 'POST', body: '{"key":"secret"}' })
    ).rejects.toBeInstanceOf(EgressDeniedError);
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('never calls requestUrl for a cleartext remote host', async () => {
    useSettings({ strictEgress: true });
    await expect(obsidianFetchBridge('http://api.openai.com/v1/models')).rejects.toBeInstanceOf(EgressDeniedError);
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('never calls requestUrl for a private-range host', async () => {
    useSettings({ strictEgress: true });
    await expect(obsidianFetchBridge('https://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(EgressDeniedError);
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('fails closed when no settings provider is registered', async () => {
    registerEgressSettings(null);
    await expect(obsidianFetchBridge('https://llm.corp.internal/v1/chat')).rejects.toBeInstanceOf(EgressDeniedError);
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('honors the user-configured base URL host', async () => {
    useSettings({ baseUrl: 'https://llm.corp.internal/v1', strictEgress: true });
    await obsidianFetchBridge('https://llm.corp.internal/v1/chat');
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it('lets an unlisted https host through when strict egress is off', async () => {
    useSettings({ strictEgress: false });
    await obsidianFetchBridge('https://gateway.corp.example/v1/chat');
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it('checks the policy before the abort short-circuit so a denied URL never races', async () => {
    useSettings({ strictEgress: true });
    const controller = new AbortController();
    controller.abort();
    await expect(
      obsidianFetchBridge('https://evil.example.net/v1', { signal: controller.signal })
    ).rejects.toBeInstanceOf(EgressDeniedError);
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });
});

describe('streamingObsidianFetch egress gate', () => {
  beforeEach(() => {
    registerEgressSettings(null);
    vi.restoreAllMocks();
  });

  afterEach(() => registerEgressSettings(null));

  it('never calls window.fetch for an unlisted host', async () => {
    useSettings({ strictEgress: true });
    const spy = vi.spyOn(window, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(streamingObsidianFetch('https://evil.example.net/v1/chat')).rejects.toBeInstanceOf(EgressDeniedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('calls window.fetch for an allowlisted host', async () => {
    useSettings({ strictEgress: true });
    const spy = vi.spyOn(window, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await streamingObsidianFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('streamWithFallback egress gate', () => {
  beforeEach(() => {
    // Drop any window.fetch spy an earlier describe installed before
    // re-arming the requestUrl module mock.
    vi.restoreAllMocks();
    mockRequestUrl.mockReset();
    mockRequestUrl.mockResolvedValue(okResult());
    registerEgressSettings(null);
  });

  afterEach(() => registerEgressSettings(null));

  it('does not fall back to requestUrl when the policy denies the URL', async () => {
    useSettings({ strictEgress: true });
    const spy = vi.spyOn(window, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(streamWithFallback('https://evil.example.net/v1/chat')).rejects.toBeInstanceOf(EgressDeniedError);
    expect(spy).not.toHaveBeenCalled();
    expect(mockRequestUrl).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('denies a private-range "local" URL before the isLocalBaseURL shortcut fires', async () => {
    useSettings({ strictEgress: true });
    await expect(streamWithFallback('http://192.168.1.50:11434/v1/chat')).rejects.toBeInstanceOf(EgressDeniedError);
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('still routes loopback URLs straight to requestUrl', async () => {
    useSettings({ strictEgress: true });
    await streamWithFallback('http://localhost:11434/v1/chat');
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });
});
