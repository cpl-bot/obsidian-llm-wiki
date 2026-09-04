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

  // Bare credential labels — `key`, `token`, `secret` — followed by a long
  // opaque value. Distinct from the rule above because that one requires
  // the `api` prefix (`api_key`), and Google, GitHub and most gateway
  // vendors spell it `?key=` / `token=`. The value class allows `-` and
  // `_` (both appear in real keys) but NOT `/` or `.`, so a path or a
  // filename after `key:` survives; 32+ chars keeps ordinary words,
  // model ids and UUID-ish fragments out.
  {
    pattern: /\b((?:key|token|secret)"?\s*[:=]\s*"?)[A-Za-z0-9_-]{32,}/gi,
    replacement: `$1${MASK}`,
  },

  // Google API keys. Fixed shape (`AIza` + 35), and the reason the rule
  // above cannot be the only cover: Gemini authenticates by query
  // parameter, so the key rides in every request URL — including the ones
  // `core/obsidian-fetch-bridge.ts` logs on the streaming fallback path.
  // `{35,}` rather than `{35}`: a longer lookalike must be swallowed
  // whole, not masked down to a readable tail.
  { pattern: /\bAIza[0-9A-Za-z_-]{35,}/g, replacement: MASK },

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
 *
 * Shape rules, because the call sites are diagnostics and an unreadable
 * diagnostic is its own kind of failure:
 *
 *   - An `Error` keeps its NAME when the name is informative. `String(err)`
 *     renders `TypeError: …` / `ProviderSecretStorageError: …`, and the
 *     sites that now log `redactError(e)` used to log the error object
 *     itself; dropping the class name would turn "the keychain refused"
 *     into an anonymous sentence. A plain `Error` (the shape
 *     `mapAiSdkError` builds, whose message already reads `status 401: …`)
 *     is rendered bare, so no user-facing Notice text changes.
 *   - A non-`Error` throwable that carries a string `message` is rendered
 *     from that message. `String({ message: '…' })` is `'[object Object]'`,
 *     which is what a rejected `requestUrl` / a thrown plain object from a
 *     provider SDK used to collapse to — the diagnostic was simply lost.
 *   - Everything else falls back to `String(error)`, itself guarded: a
 *     throwable with a hostile `toString` must not throw a second error
 *     out of a catch block.
 *
 * The `stack` is deliberately NOT included: it is unredactable free text
 * of unbounded length, and it is still available on the object itself for
 * anyone who wants to log that separately.
 */
export function redactError(error: unknown): string {
  if (error instanceof Error) {
    const name = typeof error.name === 'string' ? error.name : '';
    const message = redactSecrets(error.message ?? '');
    if (!name || name === 'Error') return message;
    return message.length === 0 ? name : `${name}: ${message}`;
  }
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return redactSecrets(message);
  }
  return redactSecrets(safeString(error));
}

/**
 * `String(value)` that cannot itself throw. A thrown value is arbitrary —
 * `Object.create(null)` has no `toString`, and a Proxy can throw from one.
 * Losing the detail is acceptable; throwing out of a catch block is not.
 */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[unrenderable thrown value]';
  }
}
