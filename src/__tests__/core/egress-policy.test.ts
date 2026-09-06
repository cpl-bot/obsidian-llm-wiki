// Phase 4 (F-04) — network egress policy unit tests.
//
// The policy is the single structural control that keeps provider
// credentials from leaving over cleartext or towards a host the shipped
// code has no business talking to. Every branch below maps to one clause
// of the policy documented in src/core/egress-policy.ts.

import { describe, it, expect, afterEach } from 'vitest';
import {
  assertAllowedEgress,
  isAllowedHost,
  EgressDeniedError,
  EGRESS_ALLOWLIST,
  EGRESS_HOST_PATTERNS,
  LOOPBACK_HOSTS,
  KNOWN_DOC_HOSTS,
  registerEgressSettings,
  currentEgressSettings,
  type EgressSettings,
} from '../../core/egress-policy';

const STRICT: EgressSettings = { strictEgress: true };

function denialReason(url: string, settings: EgressSettings = STRICT): string {
  try {
    assertAllowedEgress(url, settings);
  } catch (err) {
    if (err instanceof EgressDeniedError) return err.reason;
    return `unexpected:${String(err)}`;
  }
  return 'allowed';
}

describe('egress host lists', () => {
  it('allowlists every provider host the shipped code fetches', () => {
    for (const host of [
      'api.anthropic.com',
      'api.openai.com',
      'generativelanguage.googleapis.com',
      'openrouter.ai',
      'api.deepseek.com',
      'api.minimaxi.com',
      'api.moonshot.cn',
      'open.bigmodel.cn',
    ]) {
      expect(EGRESS_ALLOWLIST.has(host), `${host} must be fetch-allowlisted`).toBe(true);
    }
  });

  // Hardening Phase 2.B: the two hosts the removed ChatGPT-subscription OAuth
  // provider talked to are gone from the allowlist. Nothing in the shipped
  // code fetches them any more, so a request to either must be denied even
  // though they sit under a domain whose API host is still allowlisted.
  it('denies the removed OAuth provider hosts', () => {
    for (const host of ['auth.openai.com', 'chatgpt.com']) {
      expect(EGRESS_ALLOWLIST.has(host), `${host} must not be fetch-allowlisted`).toBe(false);
      expect(isAllowedHost(host, STRICT), `${host} must be denied`).toBe(false);
    }
  });

  it('never fetch-allowlists the ai SDK default gateway (documented but blocked)', () => {
    expect(EGRESS_ALLOWLIST.has('ai-gateway.vercel.sh')).toBe(false);
    expect(KNOWN_DOC_HOSTS.has('ai-gateway.vercel.sh')).toBe(true);
    expect(isAllowedHost('ai-gateway.vercel.sh', STRICT)).toBe(false);
  });

  it('keeps documentation hosts out of the fetch allowlist', () => {
    for (const host of KNOWN_DOC_HOSTS) {
      expect(EGRESS_ALLOWLIST.has(host), `${host} is a doc host, not a fetch target`).toBe(false);
    }
  });

  it('exposes the three loopback hostnames the local providers use', () => {
    expect([...LOOPBACK_HOSTS].sort()).toEqual(['127.0.0.1', '::1', 'localhost']);
  });

  it('exposes the AWS regional host patterns', () => {
    expect(EGRESS_HOST_PATTERNS.map((p) => p.id)).toContain('aws-sso-oidc');
    expect(EGRESS_HOST_PATTERNS.map((p) => p.id)).toContain('aws-bedrock-mantle');
  });
});

describe('isAllowedHost', () => {
  it('accepts an exact allowlist entry', () => {
    expect(isAllowedHost('api.openai.com', STRICT)).toBe(true);
  });

  it('rejects an unknown host', () => {
    expect(isAllowedHost('evil.example.net', STRICT)).toBe(false);
  });

  it('rejects a host that merely ends with an allowlisted host', () => {
    expect(isAllowedHost('api.openai.com.evil.net', STRICT)).toBe(false);
    expect(isAllowedHost('notapi.openai.com', STRICT)).toBe(false);
  });

  it('accepts AWS regional hosts through the suffix patterns', () => {
    expect(isAllowedHost('oidc.us-east-1.amazonaws.com', STRICT)).toBe(true);
    expect(isAllowedHost('portal.sso.eu-central-1.amazonaws.com', STRICT)).toBe(true);
    expect(isAllowedHost('bedrock-runtime.ap-northeast-1.amazonaws.com', STRICT)).toBe(true);
    expect(isAllowedHost('bedrock-mantle.eu-central-1.api.aws', STRICT)).toBe(true);
  });

  it('never blanket-allows *.awsapps.com — anyone can self-register a tenant there', () => {
    // The SSO start URL is only ever a body field on a request to
    // oidc.<region>.amazonaws.com; no awsapps.com host is ever fetched, so
    // none may be reachable by default.
    expect(isAllowedHost('d-9067abcdef.awsapps.com', STRICT)).toBe(false);
    expect(isAllowedHost('attacker.awsapps.com', STRICT)).toBe(false);
    expect(EGRESS_HOST_PATTERNS.some((p) => p.suffix.endsWith('.awsapps.com'))).toBe(false);
  });

  it('rejects AWS look-alikes with an extra label in the region slot', () => {
    expect(isAllowedHost('oidc.evil.example.amazonaws.com', STRICT)).toBe(false);
    expect(isAllowedHost('bedrock-mantle.a.b.api.aws', STRICT)).toBe(false);
    expect(isAllowedHost('oidc.us-east-1.amazonaws.com.evil.net', STRICT)).toBe(false);
  });

  it('requires a dot boundary before a pattern suffix', () => {
    expect(isAllowedHost('evil-amazonaws.com', STRICT)).toBe(false);
    expect(isAllowedHost('oidcevil-amazonaws.com', STRICT)).toBe(false);
  });

  it('accepts the hostname of a user-configured provider base URL', () => {
    expect(isAllowedHost('llm.corp.internal', { baseUrl: 'https://llm.corp.internal/v1' })).toBe(true);
  });

  it('does not trust the Bedrock SSO start URL host — it is never a fetch target', () => {
    // startDeviceAuthorization sends the start URL as a body field to
    // oidc.<region>.amazonaws.com; admitting its host would widen the
    // allowlist for a destination the plugin never contacts.
    const settings = { baseUrl: '' } as EgressSettings & { bedrockSsoStartUrl: string };
    settings.bedrockSsoStartUrl = 'https://sso.corp.example/start';
    expect(isAllowedHost('sso.corp.example', settings)).toBe(false);
  });

  it('ignores an unparsable configured base URL instead of throwing', () => {
    expect(isAllowedHost('evil.example.net', { baseUrl: 'not a url' })).toBe(false);
  });

  it('treats loopback hostnames as allowed', () => {
    expect(isAllowedHost('localhost', STRICT)).toBe(true);
    expect(isAllowedHost('127.0.0.1', STRICT)).toBe(true);
    expect(isAllowedHost('::1', STRICT)).toBe(true);
  });
});

describe('assertAllowedEgress — scheme policy', () => {
  it('allows https to an allowlisted host', () => {
    expect(() => assertAllowedEgress('https://api.openai.com/v1/chat/completions', STRICT)).not.toThrow();
  });

  it('denies http to a remote host', () => {
    expect(denialReason('http://api.openai.com/v1/models')).toBe('cleartext-scheme');
  });

  it('allows http://localhost:11434 (Ollama)', () => {
    expect(() => assertAllowedEgress('http://localhost:11434/v1/chat', STRICT)).not.toThrow();
  });

  it('allows http://127.0.0.1:1234 (LM Studio)', () => {
    expect(() => assertAllowedEgress('http://127.0.0.1:1234/v1/models', STRICT)).not.toThrow();
  });

  it('allows http://[::1] (IPv6 loopback)', () => {
    expect(() => assertAllowedEgress('http://[::1]:11434/v1/models', STRICT)).not.toThrow();
  });

  it('denies non-http(s) schemes', () => {
    expect(denialReason('file:///etc/passwd')).toBe('unsupported-scheme');
    expect(denialReason('ftp://api.openai.com/x')).toBe('unsupported-scheme');
    expect(denialReason('data:text/plain,hi')).toBe('unsupported-scheme');
  });

  it('denies an unparsable URL', () => {
    expect(denialReason('not a url at all')).toBe('invalid-url');
    expect(denialReason('')).toBe('invalid-url');
  });
});

describe('assertAllowedEgress — credentials and address ranges', () => {
  it('denies embedded userinfo even for an allowlisted host', () => {
    expect(denialReason('https://user:pass@api.openai.com/v1/models')).toBe('userinfo');
    expect(denialReason('https://user@api.openai.com/v1/models')).toBe('userinfo');
  });

  it.each([
    ['https://10.1.2.3/v1'],
    ['https://192.168.1.100/v1'],
    ['https://172.16.0.1/v1'],
    ['https://172.31.255.254/v1'],
    ['https://169.254.169.254/latest/meta-data'],
    ['https://100.64.0.1/v1'],
    ['https://0.0.0.0/v1'],
    ['https://[fe80::1]/v1'],
    ['https://[::]/v1'],
    ['https://[::ffff:10.0.0.1]/v1'],
    // IPv4-translated (RFC 2765) and NAT64 (RFC 6052) reach the very same
    // v4 address as ::ffff:a.b.c.d and must not be a way around clause (d).
    ['https://[::ffff:0:169.254.169.254]/latest/meta-data'],
    ['https://[64:ff9b::169.254.169.254]/latest/meta-data'],
    ['https://[::ffff:0:10.0.0.1]/v1'],
    ['https://[64:ff9b::192.168.1.1]/v1'],
  ])('denies the private / link-local / unspecified address %s', (url) => {
    expect(denialReason(url)).toBe('private-address');
  });

  it('allows a public IP only when it is otherwise allowlisted', () => {
    expect(denialReason('https://8.8.8.8/v1')).toBe('host-not-allowed');
  });

  it('denies a decimal-encoded loopback that is not the literal 127.0.0.1', () => {
    // WHATWG URL normalises 2130706433 → 127.0.0.1, which IS a loopback host.
    expect(() => assertAllowedEgress('http://2130706433/v1', STRICT)).not.toThrow();
    // 0x0a000001 → 10.0.0.1 is private and must still be rejected.
    expect(denialReason('https://0x0a000001/v1')).toBe('private-address');
  });

  it('denies a host outside the allowlist', () => {
    expect(denialReason('https://evil.example.net/v1/chat')).toBe('host-not-allowed');
  });

  it('carries the offending url, hostname and reason on the error', () => {
    try {
      assertAllowedEgress('https://evil.example.net/v1/chat', STRICT);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EgressDeniedError);
      const denied = err as EgressDeniedError;
      expect(denied.name).toBe('EgressDeniedError');
      expect(denied.reason).toBe('host-not-allowed');
      expect(denied.hostname).toBe('evil.example.net');
      expect(denied.url).toContain('evil.example.net');
    }
  });
});

describe('assertAllowedEgress — configured base URL and strict toggle', () => {
  it('allows the configured provider base URL host', () => {
    const settings: EgressSettings = { baseUrl: 'https://llm.corp.internal/v1', strictEgress: true };
    expect(() => assertAllowedEgress('https://llm.corp.internal/v1/chat', settings)).not.toThrow();
  });

  it('defaults to strict when strictEgress is undefined', () => {
    expect(denialReason('https://evil.example.net/v1', {})).toBe('host-not-allowed');
  });

  it('skips the allowlist check when strictEgress is false', () => {
    expect(() => assertAllowedEgress('https://evil.example.net/v1', { strictEgress: false })).not.toThrow();
  });

  it('still denies cleartext to a remote host when strictEgress is false', () => {
    expect(denialReason('http://evil.example.net/v1', { strictEgress: false })).toBe('cleartext-scheme');
  });

  it('still denies userinfo when strictEgress is false', () => {
    expect(denialReason('https://user:pass@evil.example.net/v1', { strictEgress: false })).toBe('userinfo');
  });

  it('still denies an unparsable URL when strictEgress is false', () => {
    expect(denialReason('¯\\_(ツ)_/¯', { strictEgress: false })).toBe('invalid-url');
  });
});

describe('egress settings registry', () => {
  afterEach(() => registerEgressSettings(null));

  it('returns an empty (fail-closed, strict) object when nothing is registered', () => {
    registerEgressSettings(null);
    expect(currentEgressSettings()).toEqual({});
    expect(denialReason('https://evil.example.net/v1', currentEgressSettings())).toBe('host-not-allowed');
  });

  it('returns the live settings once registered', () => {
    const settings: EgressSettings = { baseUrl: 'https://llm.corp.internal/v1' };
    registerEgressSettings(() => settings);
    expect(currentEgressSettings()).toBe(settings);
  });

  it('falls back to fail-closed defaults when the provider throws', () => {
    registerEgressSettings(() => { throw new Error('settings not loaded yet'); });
    expect(currentEgressSettings()).toEqual({});
  });
});
