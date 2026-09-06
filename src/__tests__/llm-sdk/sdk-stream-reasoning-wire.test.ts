// AI SDK 7 upgrade guard — streamed reasoning survives the `finalStep`
// migration (Phase 1.3 follow-up).
//
// v7 deprecated the flat `result.reasoning` accessor and moved the per-step
// outputs onto `finalStep`, so every streaming client now reads
// `(await result.finalStep).reasoning` once the `textStream` loop has
// drained. Nothing covered that against a real streamed response: the
// existing stream tests (`openai-sdk-client.test.ts` →
// `makeStreamTextResult`) mock `streamText` wholesale and assert against a
// hand-written object that carries whatever fields the test author typed.
// That mock would stay green if a real v7 `StreamTextResult` had no
// `finalStep` at all, or if `finalStep` stopped carrying `reasoning` — the
// two things the migration actually bet on.
//
// So this file mocks nothing from the SDK. It drives the real
// `@ai-sdk/openai-compatible` adapter through the real `streamText` over a
// stub transport that emits a genuine chat-completions SSE body with
// `reasoning_content` deltas, and pins the end-to-end outcome: the text
// deltas reach `onChunk` one call per delta, and the reasoning collected
// after the drain comes back wrapped in <think>…</think>.
//
// Note on ordering: `await result.finalStep` consumes the stream itself, so
// hoisting it above the drain loop would NOT lose the reasoning or the text
// — it would only defer the `onChunk` calls. That is a UX regression
// (the "一次性" batch render the v1.23.0 P2 fix exists to prevent), not a
// correctness one, and it is not observable through a stub transport whose
// whole body fits in the SDK's read-ahead buffer. This test therefore pins
// the data, not the interleaving.

import { describe, it, expect } from 'vitest';
import { OpenAICompatSdkClient } from '../../llm-sdk/openai-compat-sdk-client';

const REASONING_DELTAS = ['weighing ', 'the options'];
const TEXT_DELTAS = ['Hello', ', ', 'world'];

function sseFrame(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-stream',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'deepseek-reasoner',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/** A real SSE `Response` carrying reasoning deltas ahead of the text deltas. */
function reasoningStreamResponse(): Response {
  const frames = [
    sseFrame({ role: 'assistant', content: '' }, null),
    ...REASONING_DELTAS.map((r) => sseFrame({ reasoning_content: r }, null)),
    ...TEXT_DELTAS.map((t) => sseFrame({ content: t }, null)),
    sseFrame({}, 'stop'),
    'data: [DONE]\n\n',
  ];
  let i = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= frames.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(frames[i++]));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('AI SDK 7 finalStep migration: reasoning on a real streamed response', () => {
  it('forwards every text delta and wraps the post-stream reasoning in <think>', async () => {
    let sentBody: Record<string, unknown> = {};
    const streamFetch = (async (_url: string, init?: { body?: unknown }) => {
      sentBody = JSON.parse(String(init?.body));
      return reasoningStreamResponse();
    }) as never;

    const client = new OpenAICompatSdkClient({
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com/v1',
      provider: 'deepseek',
      streamFetch,
    });

    const chunks: string[] = [];
    const text = await client.createMessageStream!({
      model: 'deepseek-reasoner',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hi' }],
      onChunk: (c: string) => chunks.push(c),
    });

    // One `onChunk` per text delta — the reasoning deltas are NOT forwarded
    // to the UI stream (they would double-render against the <think> block).
    expect(chunks).toEqual(TEXT_DELTAS);

    // …and the reasoning read from `finalStep` after the drain is still
    // there, in front of the answer. This is the assertion that fails if a
    // future SDK release drops `reasoning` from `StepResult`, or renames
    // `finalStep`.
    expect(text).toBe(`<think>${REASONING_DELTAS.join('')}</think>\n\n${TEXT_DELTAS.join('')}`);

    // The request itself is unchanged by the migration: same model id, same
    // token cap, same single user message, and `stream: true`.
    expect(sentBody).toMatchObject({
      model: 'deepseek-reasoner',
      max_tokens: 128,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });
});
