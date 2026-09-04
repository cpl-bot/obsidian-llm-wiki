// Phase 4.5 (F-04) — bundle hostname tripwire.
//
// This is the control that catches a hostile (or merely careless) upstream
// merge: if `main.js` acquires a hostname that is neither egress-allowed nor
// on the explicit "documented but never fetched" list, the check fails.
// The scanner core is a pure function so it can be exercised against fixture
// strings without depending on the state of the real bundle.

import { describe, it, expect } from 'vitest';
import {
  extractBundleHosts,
  isAcceptedBundleHost,
  findOffendingHosts,
} from '../../../scripts/check-bundle-hosts.mjs';
import EGRESS_HOSTS from '../../core/egress-hosts.json';

describe('extractBundleHosts', () => {
  it('pulls every http(s) host out of a bundle, deduped and lower-cased', () => {
    const source = `
      const A = "https://api.openai.com/v1";
      const B = 'https://API.OpenAI.com/v1/models';
      const C = \`http://localhost:11434/v1\`;
      // https://docs.anthropic.com/en/api
    `;
    expect(extractBundleHosts(source)).toEqual(['api.openai.com', 'docs.anthropic.com', 'localhost']);
  });

  it('returns the truncated prefix for a runtime-concatenated host', () => {
    expect(extractBundleHosts('const u = `https://oidc.${region}.amazonaws.com`;')).toEqual(['oidc.']);
  });

  it('returns nothing for a bundle with no URLs', () => {
    expect(extractBundleHosts('const x = 1;')).toEqual([]);
  });
});

describe('isAcceptedBundleHost', () => {
  it('accepts an exact allowlist entry', () => {
    expect(isAcceptedBundleHost('api.anthropic.com', EGRESS_HOSTS)).toBe(true);
  });

  it('accepts a documented-but-never-fetched host', () => {
    expect(isAcceptedBundleHost('docs.anthropic.com', EGRESS_HOSTS)).toBe(true);
    expect(isAcceptedBundleHost('ai-gateway.vercel.sh', EGRESS_HOSTS)).toBe(true);
  });

  it('accepts a loopback host', () => {
    expect(isAcceptedBundleHost('localhost', EGRESS_HOSTS)).toBe(true);
  });

  it('accepts the truncated runtime prefixes the bundle really contains', () => {
    expect(isAcceptedBundleHost('oidc.', EGRESS_HOSTS)).toBe(true);
    expect(isAcceptedBundleHost('portal.sso.', EGRESS_HOSTS)).toBe(true);
    expect(isAcceptedBundleHost('bedrock-mantle.', EGRESS_HOSTS)).toBe(true);
  });

  it('accepts a fully expanded regional AWS host', () => {
    expect(isAcceptedBundleHost('oidc.us-east-1.amazonaws.com', EGRESS_HOSTS)).toBe(true);
    expect(isAcceptedBundleHost('d-9067abcdef.awsapps.com', EGRESS_HOSTS)).toBe(true);
  });

  it('rejects an unknown host', () => {
    expect(isAcceptedBundleHost('mineru.net', EGRESS_HOSTS)).toBe(false);
    expect(isAcceptedBundleHost('evil.example.net', EGRESS_HOSTS)).toBe(false);
  });

  it('rejects a look-alike of an allowlisted host', () => {
    expect(isAcceptedBundleHost('api.openai.com.evil.net', EGRESS_HOSTS)).toBe(false);
    expect(isAcceptedBundleHost('oidc.evil.example.amazonaws.com', EGRESS_HOSTS)).toBe(false);
  });
});

describe('findOffendingHosts', () => {
  it('reports nothing for a bundle that only touches known hosts', () => {
    const source = [
      'https://api.openai.com/v1',
      'https://api.anthropic.com/v1',
      'https://ai-gateway.vercel.sh/v1',
      'http://localhost:11434',
      'https://oidc.',
      'https://portal.sso.',
      'https://bedrock-mantle.',
      'https://d-xxxxxxxxx.awsapps.com/start',
    ].map((u) => `"${u}"`).join(';\n');
    expect(findOffendingHosts(source, EGRESS_HOSTS)).toEqual([]);
  });

  it('reports every unknown host, sorted', () => {
    const source = '"https://zeta.example.org/x";"https://api.openai.com/v1";"https://alpha.example.org/y"';
    expect(findOffendingHosts(source, EGRESS_HOSTS)).toEqual(['alpha.example.org', 'zeta.example.org']);
  });

  it('would catch a silently added exfiltration host next to a legitimate one', () => {
    const source = '"https://api.anthropic.com/v1/messages";"https://collector.attacker.example/beacon"';
    expect(findOffendingHosts(source, EGRESS_HOSTS)).toEqual(['collector.attacker.example']);
  });
});

describe('egress-hosts.json contract', () => {
  it('never lists a host as both fetch-allowed and documentation-only', () => {
    const overlap = EGRESS_HOSTS.allowlist.filter((h) => EGRESS_HOSTS.knownDocHosts.includes(h));
    expect(overlap).toEqual([]);
  });

  it('keeps every runtime prefix consistent with a declared host pattern', () => {
    for (const prefix of EGRESS_HOSTS.knownRuntimePrefixes) {
      expect(
        EGRESS_HOSTS.hostPatterns.some((p) => p.prefix === prefix),
        `runtime prefix ${prefix} has no matching hostPattern`,
      ).toBe(true);
    }
  });
});
