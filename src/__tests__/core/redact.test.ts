/**
 * Hardening Phase 3 (F-03), task 3.5.
 *
 * The redactor's job is narrow and its failure modes are opposite: mask
 * too little and a credential lands in a bug report; mask too much and the
 * error message the user needs becomes unreadable. Both directions are
 * pinned here — every pattern has a positive case AND a near-miss that
 * must survive untouched.
 */

import { describe, it, expect } from 'vitest';
import { redactSecrets, redactError } from '../../core/redact';

describe('redactSecrets — credential shapes', () => {
  it('masks a Bearer token but keeps the scheme', () => {
    const out = redactSecrets('Authorization: Bearer sk-proj-abc123DEF456ghi789');
    expect(out).toBe('Authorization: Bearer ***');
    expect(out).not.toContain('abc123DEF456ghi789');
  });

  it('masks a Bearer token quoted inside a provider error body', () => {
    const out = redactSecrets('{"error":{"message":"Incorrect API key provided: Bearer abcdefghijklmnop"}}');
    expect(out).not.toContain('abcdefghijklmnop');
    expect(out).toContain('Incorrect API key provided');
  });

  it('masks an OpenAI-style sk- key', () => {
    expect(redactSecrets('key=sk-abcdefghij1234567890')).not.toContain('abcdefghij1234567890');
  });

  it('masks vendor variants of the sk- convention', () => {
    expect(redactSecrets('sk-ant-api03-Zm9vYmFyYmF6cXV4')).toBe('***');
    expect(redactSecrets('sk-or-v1-0123456789abcdef')).toBe('***');
  });

  it('leaves a short sk- fragment alone (>= 10 chars is the rule)', () => {
    expect(redactSecrets('the sk- prefix is conventional')).toBe('the sk- prefix is conventional');
    expect(redactSecrets('sk-short')).toBe('sk-short');
  });

  it('masks an AWS access key id', () => {
    expect(redactSecrets('accessKeyId AKIAIOSFODNN7EXAMPLE failed')).toBe('accessKeyId *** failed');
  });

  it('leaves an AKIA-lookalike of the wrong shape alone', () => {
    expect(redactSecrets('AKIASHORT')).toBe('AKIASHORT');
  });

  it('masks an x-api-key header value and keeps the header name', () => {
    const out = redactSecrets('x-api-key: sk-ant-0123456789abcdef');
    expect(out).toBe('x-api-key: ***');
  });

  it('masks an x-api-key rendered as JSON', () => {
    const out = redactSecrets('{"headers":{"x-api-key":"abc123def456ghi"}}');
    expect(out).not.toContain('abc123def456ghi');
    expect(out).toContain('x-api-key');
  });

  it('masks an api_key query parameter and keeps the parameter name', () => {
    const out = redactSecrets('GET https://example.com/v1/models?api_key=abcdef123456 failed');
    expect(out).toContain('api_key=***');
    expect(out).not.toContain('abcdef123456');
    expect(out).toContain('https://example.com/v1/models');
  });

  it('masks api-key and apiKey spellings of the same parameter', () => {
    expect(redactSecrets('api-key=abcdef123456')).toContain('***');
    expect(redactSecrets('"apiKey": "abcdef123456"')).not.toContain('abcdef123456');
  });

  it('masks a long base64 blob adjacent to a credential label', () => {
    const out = redactSecrets('token: YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0');
    expect(out).not.toContain('YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0');
  });

  it('masks a long hex blob adjacent to a credential label', () => {
    const out = redactSecrets('signature=0123456789abcdef0123456789abcdef0123');
    expect(out).not.toContain('0123456789abcdef0123456789abcdef0123');
  });

  // Review follow-up. Gemini authenticates by query parameter, so the key
  // rides in the request URL that `core/obsidian-fetch-bridge.ts` logs on
  // every streaming fallback. The pre-existing rules missed it: the
  // `api_key` rule needs the `api` prefix, and the base64 rule's character
  // class stops at the `-` / `_` that Google keys contain.
  it('masks a Google API key in a query string and keeps the URL readable', () => {
    const key = 'AIzaSyD-1234567890abcdefghijklmnopqrstu';
    const out = redactSecrets(`GET https://generativelanguage.googleapis.com/v1/models?key=${key} failed`);
    expect(out).not.toContain(key);
    expect(out).toContain('https://generativelanguage.googleapis.com/v1/models');
    expect(out).toContain('key=');
  });

  it('masks a Google API key with no surrounding label at all', () => {
    const key = 'AIzaSyD_abcdefghijklmnopqrstuvwxyz012345';
    expect(redactSecrets(`stored ${key} ok`)).toBe('stored *** ok');
  });

  it('masks a long dashed/underscored value behind a bare key/token/secret label', () => {
    const value = 'abcd-efgh_1234-5678_ijkl-mnop_9012-3456';
    expect(redactSecrets(`key=${value}`)).toBe('key=***');
    expect(redactSecrets(`secret: ${value}`)).toBe('secret: ***');
  });

  it('leaves a long hex string with no credential label alone', () => {
    const sha = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';
    expect(redactSecrets(`content hash ${sha}`)).toContain(sha);
  });
});

describe('redactSecrets — must not eat ordinary text', () => {
  it('returns a plain UI string unchanged (the no-op case)', () => {
    const msg = 'Ingestion failed: the file is empty. Open Settings → LLM Provider to pick a model.';
    expect(redactSecrets(msg)).toBe(msg);
  });

  it('leaves an empty string and a whitespace string alone', () => {
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets('   ')).toBe('   ');
  });

  it('leaves prose that merely mentions keys alone', () => {
    const msg = 'API Key is not configured';
    expect(redactSecrets(msg)).toBe(msg);
  });

  it('leaves model ids and URLs alone', () => {
    const msg = 'model=claude-sonnet-4-6 baseURL=https://api.anthropic.com/v1 status=404';
    expect(redactSecrets(msg)).toBe(msg);
  });

  // The bare-label rule is the one most likely to over-reach, so pin the
  // near misses: a path, a model id, and a number are all things a user
  // needs to read out of an error message.
  it('leaves a file path after a credential-shaped word alone', () => {
    const msg = 'Failed to read /Users/alice/Documents/vault/notes/key-management.md';
    expect(redactSecrets(msg)).toBe(msg);
    const win = 'wrote file at C:/Users/bob/Documents/my-wiki-folder/index.md';
    expect(redactSecrets(win)).toBe(win);
  });

  it('leaves a short value behind a bare key/token label alone', () => {
    expect(redactSecrets('key: some-model-name-v2')).toBe('key: some-model-name-v2');
    expect(redactSecrets('token budget exceeded: 128000')).toBe('token budget exceeded: 128000');
    expect(redactSecrets('wikiFolder key=my-wiki')).toBe('wikiFolder key=my-wiki');
  });

  it('is idempotent — redacting a redacted line changes nothing further', () => {
    const once = redactSecrets('Authorization: Bearer sk-abcdefghij1234567890');
    expect(redactSecrets(once)).toBe(once);
  });

  it('masks every occurrence, not just the first', () => {
    const out = redactSecrets('first sk-abcdefghij1234567890 then sk-zyxwvutsrq0987654321');
    expect(out).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
  });
});

describe('redactError', () => {
  it('redacts an Error message', () => {
    expect(redactError(new Error('401 from Bearer sk-abcdefghij1234567890'))).not.toContain('abcdefghij1234567890');
  });

  // Review follow-up: the sites that adopted this helper used to log the
  // error OBJECT, whose console rendering leads with the class name. A
  // plain `Error` stays bare so no Notice text changes; a named one keeps
  // the name, which is the whole diagnostic for e.g. a keychain failure.
  it('keeps a non-generic error name, the way String(error) renders it', () => {
    expect(redactError(new TypeError('network down'))).toBe('TypeError: network down');
    class ProviderSecretStorageError extends Error {
      constructor(message: string) { super(message); this.name = 'ProviderSecretStorageError'; }
    }
    expect(redactError(new ProviderSecretStorageError('Secret Service is not running')))
      .toBe('ProviderSecretStorageError: Secret Service is not running');
  });

  it('renders a plain Error bare, so user-facing messages are unchanged', () => {
    expect(redactError(new Error('status 401: incorrect api key'))).toBe('status 401: incorrect api key');
  });

  it('reads the message off a non-Error throwable instead of collapsing to [object Object]', () => {
    const out = redactError({ message: 'gateway said Bearer sk-abcdefghij1234567890' });
    expect(out).not.toContain('abcdefghij1234567890');
    expect(out).toContain('gateway said');
    expect(out).not.toContain('[object Object]');
  });

  it('survives a throwable that cannot be stringified', () => {
    expect(redactError(Object.create(null))).toBe('[unrenderable thrown value]');
  });

  it('redacts a non-Error thrown value', () => {
    expect(redactError('raw string with sk-abcdefghij1234567890')).not.toContain('abcdefghij1234567890');
  });

  it('never throws on odd input', () => {
    expect(() => redactError(undefined)).not.toThrow();
    expect(() => redactError(null)).not.toThrow();
    expect(() => redactError({ nested: 1 })).not.toThrow();
  });
});
