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
    // The scanner can only ever see the literal prefix when a label is
    // concatenated at runtime — hence the `knownRuntimePrefixes` category.
    expect(extractBundleHosts('const u = `https://api.${region}.example.com`;')).toEqual(['api.']);
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

  // Hardening Phase 2.B removed the only feature that built a hostname at
  // runtime, so the live data has no prefixes and no patterns left. The
  // matcher itself still has to work — a future regional provider would
  // depend on it — so it is exercised against a synthetic host set rather
  // than deleted along with the rows.
  const SYNTHETIC = {
    allowlist: [],
    hostPatterns: [{ id: 'demo', prefix: 'api.', suffix: '.example.com' }],
    loopbackHosts: [],
    knownDocHosts: [],
    knownRuntimePrefixes: ['api.'],
  };

  it('accepts a declared runtime prefix verbatim', () => {
    expect(isAcceptedBundleHost('api.', SYNTHETIC)).toBe(true);
  });

  it('accepts a fully expanded regional host through its pattern', () => {
    expect(isAcceptedBundleHost('api.us-east-1.example.com', SYNTHETIC)).toBe(true);
  });

  it('rejects an extra label in the region slot of a pattern', () => {
    expect(isAcceptedBundleHost('api.evil.example.example.com', SYNTHETIC)).toBe(false);
  });

  it('accepts nothing regional against the live host set — no pattern is declared', () => {
    expect(isAcceptedBundleHost('oidc.', EGRESS_HOSTS)).toBe(false);
    expect(isAcceptedBundleHost('oidc.us-east-1.amazonaws.com', EGRESS_HOSTS)).toBe(false);
    expect(isAcceptedBundleHost('bedrock-mantle.', EGRESS_HOSTS)).toBe(false);
  });

  it('accepts the settings-string placeholder but no other awsapps tenant', () => {
    // The placeholder is a doc host and nothing more; *.awsapps.com is NOT
    // pattern-accepted, so a real tenant domain still trips the wire.
    expect(isAcceptedBundleHost('d-xxxxxxxxx.awsapps.com', EGRESS_HOSTS)).toBe(true);
    expect(isAcceptedBundleHost('d-9067abcdef.awsapps.com', EGRESS_HOSTS)).toBe(false);
    expect(isAcceptedBundleHost('attacker.awsapps.com', EGRESS_HOSTS)).toBe(false);
  });

  it('rejects an unknown host', () => {
    expect(isAcceptedBundleHost('mineru.net', EGRESS_HOSTS)).toBe(false);
    expect(isAcceptedBundleHost('evil.example.net', EGRESS_HOSTS)).toBe(false);
  });

  it('rejects a look-alike of an allowlisted host', () => {
    expect(isAcceptedBundleHost('api.openai.com.evil.net', EGRESS_HOSTS)).toBe(false);
    expect(isAcceptedBundleHost('notapi.openai.com', EGRESS_HOSTS)).toBe(false);
  });
});

describe('findOffendingHosts', () => {
  it('reports nothing for a bundle that only touches known hosts', () => {
    const source = [
      'https://api.openai.com/v1',
      'https://api.anthropic.com/v1',
      'https://ai-gateway.vercel.sh/v1',
      'http://localhost:11434',
      'https://docs.anthropic.com/en/api',
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
    // Vacuously true while both lists are empty (hardening Phase 2.B), and
    // the check that matters the moment either grows again.
    const patterns: ReadonlyArray<{ prefix: string }> = EGRESS_HOSTS.hostPatterns;
    for (const prefix of EGRESS_HOSTS.knownRuntimePrefixes as readonly string[]) {
      expect(
        patterns.some((p) => p.prefix === prefix),
        `runtime prefix ${prefix} has no matching hostPattern`,
      ).toBe(true);
    }
  });

  // Hardening Phase 2.B: the removed provider owned every pattern row and
  // every runtime prefix. Neither list may name it again.
  it('leaves no removed-provider host pattern or runtime prefix behind', () => {
    const needles = [['bed', 'rock'].join(''), 'amazonaws.com'];
    const serialized = JSON.stringify([
      EGRESS_HOSTS.allowlist,
      EGRESS_HOSTS.hostPatterns,
      EGRESS_HOSTS.knownRuntimePrefixes,
    ]).toLowerCase();
    for (const needle of needles) expect(serialized).not.toContain(needle);
  });
});
