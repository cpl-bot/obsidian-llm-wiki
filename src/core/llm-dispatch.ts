// core/llm-dispatch.ts
//
// v1.26.3 PATCH expanded-scope follow-up: centralize the typed-output /
// legacy dispatch guard that was duplicated at every migrated call site.
//
// Before this helper, each caller had:
//   const response = client.createMessageWithOutput
//     ? (await client.createMessageWithOutput(args)).text
//     : await client.createMessage(args);
//
// ...with subtle variations on the `.text` fallback path (some callers did
// `result.text`, others wrapped `createMessage` directly). This helper
// collapses the dispatch into one place so future LLMClient shape changes
// (e.g. a streaming-typed variant) only need to update one function.
//
// The legacy `createMessage` path returns `Promise<string>` directly — same
// shape we return. The typed path returns `{text, output?, outputMode,
// finishReason, usage?}`; we extract `.text` so callers can continue to
// treat the result as a string and route it through `parseJsonResponse`.
// Callers that want the typed `output` should call `client.createMessageWithOutput`
// directly and inspect `result.output` themselves.

import type { LLMClient } from '../types';

/**
 * Variant of `Parameters<NonNullable<LLMClient['createMessageWithOutput']>>[0]`
 * that does not require the optional method. We accept the same argument
 * shape the wrapped client expects so the typed and legacy calls match.
 */
export type LlmCallArgs = Parameters<
  NonNullable<LLMClient['createMessageWithOutput']>
>[0];

/**
 * Minimal client shape `callLlm` requires. Some callers pass a narrowed
 * context type (e.g. `PathResolutionContext.getClient()` returns a
 * `{createMessage, createMessageWithOutput?}`-shaped object, not the full
 * `LLMClient`). The method signatures are widened to accept any
 * implementation (the full `LLMClient` satisfies this structurally via
 * method bivariance).
 */
export interface LlmDispatchClient {
  createMessage: (...args: unknown[]) => Promise<string>;
  createMessageWithOutput?: (...args: unknown[]) => Promise<{ text: string }>;
}

/**
 * Dispatch an LLM call. Prefers the typed `createMessageWithOutput` method
 * when the client implements it; falls back to plain `createMessage` on
 * legacy clients (Anthropic / OpenAI / mock clients without the
 * typed method). Returns the wire text — callers that need the typed
 * `output` field should call `createMessageWithOutput` directly and
 * inspect `result.output`.
 */
export async function callLlm(
  client: LlmDispatchClient,
  args: LlmCallArgs
): Promise<string> {
  if (client.createMessageWithOutput) {
    const result = await client.createMessageWithOutput(args);
    return result.text;
  }
  return client.createMessage(args);
}