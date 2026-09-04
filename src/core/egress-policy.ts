/**
 * Phase 4 (finding F-04) — network egress policy.
 *
 * Single structural control over every outbound HTTP request the plugin
 * makes. It exists because the plugin legitimately holds provider API
 * keys and reads the whole vault: without a destination check, a
 * mis-typed `baseUrl` (or a hostile future update) can point the
 * `Authorization: Bearer …` header at an arbitrary host, or send it over
 * cleartext `http:` where any on-path device can read it.
 *
 * Policy (in evaluation order):
 *   (a) scheme MUST be `https:`, except `http:` is permitted when the
 *       hostname is one of LOOPBACK_HOSTS (Ollama / LM Studio / the
 *       OAuth loopback listener all serve plain HTTP on 127.0.0.1);
 *   (c) URLs carrying userinfo (`user:pass@host`) are refused outright —
 *       `requestUrl` would forward those credentials, and userinfo is a
 *       classic way to disguise the real host in a UI;
 *   (d) RFC1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16,
 *       fe80::/10), CGNAT (100.64/10), unique-local (fc00::/7),
 *       0.0.0.0 / `::` and IPv4-mapped IPv6 forms of any of those are
 *       refused — this is the SSRF / cloud-metadata guard — unless the
 *       loopback exception in (a) applies;
 *   (b) the hostname must match EGRESS_ALLOWLIST exactly, match one of
 *       EGRESS_HOST_PATTERNS (regional AWS hosts whose middle label is
 *       concatenated at runtime), be a loopback host, or equal the
 *       hostname of a URL the user themselves configured in settings;
 *   (e) when `settings.strictEgress === false` the user has explicitly
 *       opted into an unlisted destination (corporate proxy / gateway):
 *       (b) and (d) are skipped, (a) and (c) still apply, so the key can
 *       never go out over cleartext regardless of the toggle.
 *
 * Parsing is done with the WHATWG `URL` class only. That matters: it
 * normalises the numeric IPv4 escapes (`http://2130706433`,
 * `http://0x0a000001`) that a hand-rolled string check would miss, and
 * anything it cannot parse is denied rather than guessed at.
 *
 * REDIRECTS ARE NOT RE-VALIDATED. Obsidian's `requestUrl` follows
 * redirects internally and exposes no hook to intercept or disable that
 * (`RequestUrlParam` in obsidian 1.12.3 has only url/method/contentType/
 * body/headers/throw — no `redirect` option), and `window.fetch` in the
 * streaming path is likewise not configured with `redirect: 'manual'`
 * because AI-SDK needs the followed response. So an allowlisted host
 * that answers 302 can still steer the *response* fetch elsewhere. What
 * the policy does guarantee is that no request carrying plugin
 * credentials is *initiated* against a denied host: the credential
 * headers are attached to the first hop only. Revisit if a future
 * Obsidian API exposes redirect control.
 *
 * The host lists live in `egress-hosts.json` so that this module and the
 * post-build tripwire (`scripts/check-bundle-hosts.mjs`) read one source
 * of truth. esbuild inlines the JSON into the bundle.
 */

import EGRESS_HOSTS from './egress-hosts.json';

/** Machine-readable cause, so the UI can localize without string matching. */
export type EgressDenialReason =
  /** `new URL(...)` refused the input. */
  | 'invalid-url'
  /** Scheme is neither http: nor https:. */
  | 'unsupported-scheme'
  /** http: towards something that is not a loopback host. */
  | 'cleartext-scheme'
  /** URL embeds `user:pass@`. */
  | 'userinfo'
  /** RFC1918 / link-local / CGNAT / unique-local / unspecified target. */
  | 'private-address'
  /** Not on the allowlist and not a user-configured destination. */
  | 'host-not-allowed';

/** Thrown before any byte leaves the process. */
export class EgressDeniedError extends Error {
  readonly reason: EgressDenialReason;
  /** The URL as given to the policy (never mutated, never redacted). */
  readonly url: string;
  /** Parsed hostname, or '' when the URL could not be parsed. */
  readonly hostname: string;

  constructor(reason: EgressDenialReason, url: string, hostname: string, detail: string) {
    super(`Egress denied (${reason}): ${detail}`);
    this.name = 'EgressDeniedError';
    this.reason = reason;
    this.url = url;
    this.hostname = hostname;
  }
}

/**
 * Minimal structural view of `LLMWikiSettings` — only the fields the
 * policy reads. Structural typing keeps this module free of the heavy
 * `types.ts` import graph so the bridge can depend on it cheaply.
 */
export interface EgressSettings {
  /** User-configured provider base URL (`LLMWikiSettings.baseUrl`). */
  baseUrl?: string;
  /** Bedrock IAM Identity Center portal URL (`LLMWikiSettings.bedrockSsoStartUrl`). */
  bedrockSsoStartUrl?: string;
  /** Phase 4.4 toggle. Absent / undefined means strict (fail closed). */
  strictEgress?: boolean;
}

/** One regional/tenant host shape: prefix + a single label + suffix. */
export interface EgressHostPattern {
  readonly id: string;
  readonly prefix: string;
  readonly suffix: string;
}

/** Hosts the shipped code actually fetches. */
export const EGRESS_ALLOWLIST: ReadonlySet<string> = new Set(EGRESS_HOSTS.allowlist);

/** Regional AWS hosts (`oidc.<region>.amazonaws.com`, …). */
export const EGRESS_HOST_PATTERNS: readonly EgressHostPattern[] = EGRESS_HOSTS.hostPatterns;

/** The only hostnames for which `http:` is tolerated. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(EGRESS_HOSTS.loopbackHosts);

/**
 * Hosts that appear as literals in the bundle but are never fetched
 * (documentation links, links opened in the user's browser, placeholder
 * examples). Deliberately NOT egress-allowed — `ai-gateway.vercel.sh`,
 * the `ai` SDK's built-in default gateway, lives here precisely so the
 * bundle tripwire stays quiet while the policy keeps blocking it.
 */
export const KNOWN_DOC_HOSTS: ReadonlySet<string> = new Set(EGRESS_HOSTS.knownDocHosts);

/** A single DNS label as it may appear in the region/tenant slot. */
const HOST_LABEL = /^[a-z0-9-]+$/;

/** Dotted-quad IPv4, already normalised by the WHATWG URL parser. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** `[::1]` → `::1`; lower-cases everything else. */
function normalizeHostname(hostname: string): string {
  const lowered = hostname.toLowerCase();
  return lowered.startsWith('[') && lowered.endsWith(']') ? lowered.slice(1, -1) : lowered;
}

/** Returns the four octets, or null when `hostname` is not an IPv4 literal. */
function parseIpv4(hostname: string): number[] | null {
  const m = IPV4.exec(hostname);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

/** RFC1918 + link-local + CGNAT + "this network" + unspecified. */
function isBlockedIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return true;                       // 0.0.0.0/8 — "this network" / unspecified
  if (a === 10) return true;                      // RFC1918
  if (a === 127) return true;                     // loopback beyond the three allowed literals
  if (a === 169 && b === 254) return true;        // link-local (cloud metadata lives at 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true;        // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  return false;
}

/**
 * Expand an IPv6 literal into eight 16-bit groups. Returns null when the
 * text is not an IPv6 address (the WHATWG parser already guarantees
 * well-formedness for anything that reached us in brackets).
 */
function parseIpv6(hostname: string): number[] | null {
  if (!hostname.includes(':')) return null;
  const [head, tail] = hostname.split('::', 2);
  const toGroups = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((g) => Number.parseInt(g, 16));
  let groups: number[];
  if (hostname.includes('::')) {
    const left = toGroups(head);
    const right = toGroups(tail ?? '');
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  } else {
    groups = toGroups(hostname);
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function isBlockedIpv6(groups: number[]): boolean {
  const allZeroLeading = groups.slice(0, 5).every((g) => g === 0);
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms
  // re-enter the IPv4 rules — otherwise `::ffff:10.0.0.1` would sneak past.
  if (allZeroLeading && (groups[5] === 0xffff || groups[5] === 0)) {
    const octets = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
    if (octets.some((o) => o !== 0)) return isBlockedIpv4(octets);
  }
  if (groups.every((g) => g === 0)) return true;              // :: unspecified
  if ((groups[0] & 0xffc0) === 0xfe80) return true;           // fe80::/10 link-local
  if ((groups[0] & 0xfe00) === 0xfc00) return true;           // fc00::/7 unique-local
  return false;
}

/**
 * True when the hostname points at a non-routable / infrastructure
 * address. Loopback is handled by the caller (it has its own exception).
 */
function isBlockedAddressLiteral(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  const ipv4 = parseIpv4(host);
  if (ipv4) return isBlockedIpv4(ipv4);
  const ipv6 = parseIpv6(host);
  if (ipv6) return isBlockedIpv6(ipv6);
  return false;
}

function matchesHostPattern(hostname: string): boolean {
  return EGRESS_HOST_PATTERNS.some(({ prefix, suffix }) => {
    if (!hostname.startsWith(prefix) || !hostname.endsWith(suffix)) return false;
    const middle = hostname.slice(prefix.length, hostname.length - suffix.length);
    return HOST_LABEL.test(middle);
  });
}

/** Hostname of `raw`, or null when it is absent / unparsable. */
function hostnameOf(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  try {
    return normalizeHostname(new URL(raw.trim()).hostname);
  } catch {
    return null;
  }
}

/**
 * The user's own configured destinations. A base URL the user typed is
 * trusted for the requests derived from it — that is what makes
 * self-hosted / gateway deployments keep working under strict egress.
 */
function configuredHostnames(settings: EgressSettings): string[] {
  return [hostnameOf(settings.baseUrl), hostnameOf(settings.bedrockSsoStartUrl)]
    .filter((h): h is string => h !== null);
}

/**
 * Pure allowlist predicate — clause (b) only. Exported so the settings
 * UI and the tests can ask the question without constructing a URL.
 */
export function isAllowedHost(hostname: string, settings: EgressSettings): boolean {
  const host = normalizeHostname(hostname);
  if (!host) return false;
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (EGRESS_ALLOWLIST.has(host)) return true;
  if (matchesHostPattern(host)) return true;
  return configuredHostnames(settings).includes(host);
}

/**
 * Enforce the egress policy. Returns normally when the request may
 * proceed; otherwise throws `EgressDeniedError` BEFORE any I/O.
 *
 * @throws EgressDeniedError
 */
export function assertAllowedEgress(url: string, settings: EgressSettings): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EgressDeniedError('invalid-url', url, '', 'the URL could not be parsed');
  }

  const hostname = normalizeHostname(parsed.hostname);
  const loopback = LOOPBACK_HOSTS.has(hostname);

  // (a) scheme
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new EgressDeniedError('unsupported-scheme', url, hostname, `scheme "${parsed.protocol}" is not http(s)`);
  }
  if (parsed.protocol === 'http:' && !loopback) {
    throw new EgressDeniedError('cleartext-scheme', url, hostname, `http:// is only allowed for ${[...LOOPBACK_HOSTS].join(', ')}`);
  }

  // (c) userinfo
  if (parsed.username !== '' || parsed.password !== '') {
    throw new EgressDeniedError('userinfo', url, hostname, 'the URL embeds credentials (user:pass@host)');
  }

  // (e) explicit opt-out stops here: cleartext and userinfo stay blocked.
  if (settings.strictEgress === false) return;

  // (d) address ranges
  if (!loopback && isBlockedAddressLiteral(hostname)) {
    throw new EgressDeniedError('private-address', url, hostname, `${hostname} is a private, link-local or unspecified address`);
  }

  // (b) allowlist
  if (!isAllowedHost(hostname, settings)) {
    throw new EgressDeniedError('host-not-allowed', url, hostname, `${hostname} is not on the egress allowlist`);
  }
}

// ---------------------------------------------------------------------------
// Live-settings registry.
//
// `obsidianFetchBridge` / `streamingObsidianFetch` are free functions
// shared by every SDK client, so there is no constructor to thread
// settings through. The plugin registers a getter once in `onload`; until
// it does (tests, early module init) the policy sees `{}` — which is
// strict, i.e. fail closed.
// ---------------------------------------------------------------------------

let egressSettingsProvider: (() => EgressSettings) | null = null;

/** Install (or, with `null`, remove) the live settings getter. */
export function registerEgressSettings(provider: (() => EgressSettings) | null): void {
  egressSettingsProvider = provider;
}

/** Current settings for policy purposes; `{}` (strict) when unavailable. */
export function currentEgressSettings(): EgressSettings {
  if (!egressSettingsProvider) return {};
  try {
    return egressSettingsProvider() ?? {};
  } catch {
    return {};
  }
}
