import { anthropicSseToDataStream } from './anthropicToDataStream';

/**
 * The translator is the load-bearing piece of the studio's chat path: rayu-gateway
 * speaks Anthropic Messages SSE, `useChat` consumes the AI SDK data-stream
 * protocol, and there is no server route in between to do the conversion. A bug
 * here shows up as a chat that renders nothing or never stops streaming, so the
 * event handling is pinned against recorded gateway output.
 */

/** Build an SSE body from Anthropic events, framed as the gateway frames them. */
function sseStream(events: unknown[], opts: { chunkSize?: number } = {}): ReadableStream<Uint8Array> {
  const text = events
    .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('');
  const bytes = new TextEncoder().encode(text);
  const size = opts.chunkSize ?? bytes.length;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) {
        controller.enqueue(bytes.slice(i, i + size));
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    out += decoder.decode(value, { stream: true });
  }

  return out;
}

/** A complete, successful two-block response. */
const HAPPY_PATH = [
  { type: 'message_start', message: { id: 'msg_123', usage: { input_tokens: 42 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'ping' },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
  { type: 'message_stop' },
];

describe('anthropicSseToDataStream', () => {
  it('emits text deltas as data-stream text parts', async () => {
    const out = await collect(anthropicSseToDataStream(sseStream(HAPPY_PATH)));

    expect(out).toContain('0:"Hello"');
    expect(out).toContain('0:" world"');
  });

  it('opens with a start_step carrying the upstream message id', async () => {
    const out = await collect(anthropicSseToDataStream(sseStream(HAPPY_PATH)));

    expect(out).toContain('f:{"messageId":"msg_123"}');
    // start_step must precede the first text part.
    expect(out.indexOf('f:{')).toBeLessThan(out.indexOf('0:"Hello"'));
  });

  it('closes with both finish parts and mapped usage', async () => {
    const out = await collect(anthropicSseToDataStream(sseStream(HAPPY_PATH)));

    /*
     * Both are required: useChat needs finish_step to close the assistant turn and
     * finish_message to resolve onFinish — which is where the studio logs usage.
     */
    expect(out).toContain('e:{"finishReason":"stop"');
    expect(out).toContain('d:{"finishReason":"stop"');
    // input_tokens arrives on message_start, output_tokens on message_delta.
    expect(out).toContain('"promptTokens":42');
    expect(out).toContain('"completionTokens":7');
  });

  it('reports usage through the callback', async () => {
    const seen: Array<{ promptTokens: number; completionTokens: number }> = [];
    await collect(anthropicSseToDataStream(sseStream(HAPPY_PATH), (u) => seen.push(u)));

    expect(seen).toEqual([{ promptTokens: 42, completionTokens: 7 }]);
  });

  it('ignores ping keep-alives', async () => {
    const out = await collect(anthropicSseToDataStream(sseStream(HAPPY_PATH)));

    expect(out).not.toContain('ping');
  });

  it('reassembles events split across chunk boundaries', async () => {
    /*
     * The real gateway flushes on token boundaries, so a `data:` line is routinely
     * split mid-JSON. Feeding one byte at a time proves the buffering is correct;
     * a naive per-chunk parse passes the happy path and fails here.
     */
    const out = await collect(anthropicSseToDataStream(sseStream(HAPPY_PATH, { chunkSize: 1 })));

    expect(out).toContain('0:"Hello"');
    expect(out).toContain('0:" world"');
    expect(out).toContain('d:{"finishReason":"stop"');
  });

  it('routes thinking deltas to reasoning parts, not text', async () => {
    const out = await collect(
      anthropicSseToDataStream(
        sseStream([
          { type: 'message_start', message: { id: 'm', usage: { input_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
          { type: 'message_stop' },
        ]),
      ),
    );

    // Reasoning uses the 'g:' code; rendering it as text would leak the model's
    // scratchpad into the answer.
    expect(out).toContain('g:"hmm"');
    expect(out).toContain('0:"answer"');
    expect(out).not.toContain('0:"hmm"');
  });

  it.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['max_tokens', 'length'],
    ['tool_use', 'tool-calls'],
  ])('maps stop_reason %s to finishReason %s', async (stopReason, expected) => {
    const out = await collect(
      anthropicSseToDataStream(
        sseStream([
          { type: 'message_start', message: { id: 'm', usage: { input_tokens: 1 } } },
          { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]),
      ),
    );

    expect(out).toContain(`d:{"finishReason":"${expected}"`);
  });

  it('forwards an upstream error as an error part', async () => {
    const out = await collect(
      anthropicSseToDataStream(
        sseStream([
          { type: 'message_start', message: { id: 'm', usage: { input_tokens: 1 } } },
          { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
        ]),
      ),
    );

    expect(out).toContain('3:"Overloaded"');
  });

  it('synthesises a finish when the stream dies mid-response', async () => {
    /*
     * Without this, useChat leaves the assistant message pending forever and the
     * UI spins with no way to retry — the worst failure mode of the three.
     */
    const out = await collect(
      anthropicSseToDataStream(
        sseStream([
          { type: 'message_start', message: { id: 'm', usage: { input_tokens: 5 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
          // No message_delta, no message_stop: upstream vanished.
        ]),
      ),
    );

    expect(out).toContain('0:"partial"');
    expect(out).toContain('e:{"finishReason":"error"');
    expect(out).toContain('d:{"finishReason":"error"');
  });

  it('survives an unparseable event without dropping the rest', async () => {
    const bad =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1}}}\n\n' +
      'event: content_block_delta\ndata: {not json\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';

    const bytes = new TextEncoder().encode(bad);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });

    const out = await collect(anthropicSseToDataStream(stream));

    expect(out).toContain('0:"ok"');
    expect(out).toContain('d:{');
  });

  it('emits nothing but a synthetic finish for an empty stream', async () => {
    const out = await collect(anthropicSseToDataStream(sseStream([])));

    expect(out).toContain('d:{"finishReason":"error"');
    expect(out).not.toContain('0:"');
  });
});
