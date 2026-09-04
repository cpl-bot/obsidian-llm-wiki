// Hardening Phase 3 (F-03), task 3.5: mask credentials in anything the
// plugin prints.
//
// Why this exists. Provider error bodies echo the request that produced
// them, and a 4xx from a misconfigured gateway routinely quotes the
// `Authorization` header back at you. Those bodies reach `console.error`
// and Notices verbatim through half a dozen catch blocks. Obsidian's
// developer console is copied into bug reports, and a Notice is screen-
// shotted — so an unredacted log line is a slower version of the leak
// this phase just closed in `data.json`.
//
// Scope. This masks credential SHAPES, not "anything secret-looking". It
// is applied at the log/Notice boundary only, never to values on their
// way to a provider, and never to ordinary UI strings — a user whose
// wiki folder is named `api_key` should still be able to read their own
// error messages.

/** What every match collapses to. Short, obvious, and not itself a shape. */
const MASK = '***';

/**
 * Ordered because the patterns overlap: a labelled form
 * (`x-api-key: sk-...`) must win over the bare `sk-...` rule so the label
 * survives and only the value is masked.
 *
 * Each entry keeps whatever identifies the finding (the scheme, the header
 * name, the parameter name) and replaces only the credential, so a redacted
 * log still says WHICH credential the request carried.
 */
const PATTERNS: Array<{ readonly pattern: RegExp; readonly replacement: string }> = [
  // `Authorization: Bearer <token>` / a bare `Bearer <token>` in a body.
  // The token runs to whitespace or a quote — provider bodies quote it.
  { pattern: /\bBearer\s+[^\s"'`,;)\]}]+/gi, replacement: `Bearer ${MASK}` },

  // Header-style credentials: `x-api-key: <value>`, `api-key: <value>`,
  // `anthropic-api-key: <value>`. Also matches the JSON rendering
  // (`"x-api-key": "<value>"`) because the separator class allows quotes.
  {
    pattern: /((?:x-)?(?:[a-z0-9-]+-)?api[_-]?key"?\s*[:=]\s*"?)[^\s"'`,;)\]}]+/gi,
    replacement: `$1${MASK}`,
  },

  // Query-string / form / JSON parameters: `?api_key=<value>`,
  // `access_token=<value>`, `"secret": "<value>"`. Same separator class.
  {
    pattern: /((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|token|password)"?\s*[:=]\s*"?)[^\s"'`,;)\]}&]{6,}/gi,
    replacement: `$1${MASK}`,
  },

  // OpenAI-style keys, and every vendor that copied the convention
  // (`sk-`, `sk-ant-`, `sk-or-v1-`). >= 10 chars after the prefix so the
  // literal string "sk-" in prose is left alone.
  { pattern: /\bsk-[A-Za-z0-9_-]{10,}/g, replacement: MASK },

  // AWS access key ids. Fixed shape, no length ambiguity.
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: MASK },

  // Long opaque blobs sitting next to a credential label — the shape a
  // hand-rolled `Failed to sign: <signature>` message takes. Bounded to
  // 24+ chars so ordinary hex (a sha256 prefix, a colour) is untouched.
  {
    pattern: /\b((?:token|secret|key|signature|credential)s?\b[^\S\n]*[:=]?[^\S\n]*)([A-Za-z0-9+/=]{24,}|[0-9a-f]{32,})/gi,
    replacement: `$1${MASK}`,
  },
];

/**
 * Mask credential-shaped substrings in `text`.
 *
 * Pure and total: never throws, never returns undefined, and returns the
 * input unchanged when nothing matches (the overwhelmingly common case —
 * this runs on every routed log line). Cost is O(text) per pattern, on
 * strings that are about to be handed to `console` or a Notice anyway.
 *
 * Non-string input is coerced rather than rejected: call sites pass
 * `unknown` catch values, and a redaction helper that throws inside a
 * catch block would be worse than the leak.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const { pattern, replacement } of PATTERNS) {
    // Fresh lastIndex per call: the /g regexes are module-level constants.
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Render an unknown thrown value as a redacted, log-safe string.
 *
 * The idiom this replaces —
 * `error instanceof Error ? error.message : String(error)` — appears at
 * ~30 catch sites. Routing them through one helper means a new provider
 * whose errors carry a credential is covered everywhere at once.
 */
export function redactError(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  return redactSecrets(String(error));
}
