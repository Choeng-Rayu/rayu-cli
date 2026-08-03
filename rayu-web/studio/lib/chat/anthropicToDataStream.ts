import { formatDataStreamPart } from '@ai-sdk/ui-utils';

/**
 * Translates rayu-gateway's Anthropic Messages SSE into the Vercel AI SDK data
 * stream protocol, in the browser.
 *
 * WHY THIS EXISTS
 *
 * bolt.diy POSTed to its own Remix route `/api/chat`, which ran `streamText()`
 * server-side and returned an AI SDK data stream — the format `useChat` consumes.
 *
 * Rayu Studio has no server route of its own (rayu-web is a pure frontend), and
 * the gateway speaks ONE wire format: Anthropic Messages. Its OpenAI-compatible
 * `/v1/chat/completions` is retired and answers 410. So the translation has to
 * happen somewhere on the client, and `useChat`'s custom `fetch` option is the
 * documented seam for it.
 *
 * THE TWO PROTOCOLS
 *
 * In (Anthropic SSE, one JSON object per `data:` line):
 *   message_start        {message:{id,usage:{input_tokens}}}
 *   content_block_start  {index,content_block:{type:'text'|'thinking'|...}}
 *   content_block_delta  {index,delta:{type:'text_delta',text}|{type:'thinking_delta',thinking}}
 *   content_block_stop   {index}
 *   message_delta        {delta:{stop_reason},usage:{output_tokens}}
 *   message_stop
 *   error                {error:{type,message}}
 *   ping                 (keep-alive, ignored)
 *
 * Out (AI SDK data stream, newline-delimited `code:json`):
 *   f:{messageId}   start step
 *   0:"text"        text delta
 *   g:"reasoning"   reasoning delta
 *   e:{...}         finish step
 *   d:{...}         finish message
 *   3:"error"       error
 *
 * The out-format codes are produced by `formatDataStreamPart` rather than written
 * by hand, so a protocol change in the SDK surfaces as a type error here instead
 * of as silently malformed output.
 */

/**
 * The AI SDK's finish-reason vocabulary. Typed as the SDK's own union so an
 * unmapped Anthropic stop reason is a compile error rather than a malformed part.
 */
type FinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'other' | 'unknown';

/** Anthropic stop reasons mapped onto the AI SDK's finishReason vocabulary. */
function mapFinishReason(stopReason: string | null | undefined): FinishReason {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool-calls';
    case null:
    case undefined:
      return 'unknown';
    default:
      return 'other';
  }
}

interface AnthropicEvent {
  type: string;
  index?: number;
  message?: { id?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  content_block?: { type?: string };
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string | null };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

/**
 * Wrap an Anthropic SSE body in a ReadableStream of AI SDK data-stream chunks.
 *
 * Exported separately from the fetch wrapper so it can be tested against recorded
 * gateway output without a network call.
 */
export function anthropicSseToDataStream(
  body: ReadableStream<Uint8Array>,
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffered = '';
  let messageId = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let finishReason: FinishReason = 'unknown';
  /** Content block index -> kind, so a delta is routed to text vs reasoning. */
  const blockKinds = new Map<number, string>();
  let sawFinish = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      const reader = body.getReader();

      const handleEvent = (event: AnthropicEvent) => {
        switch (event.type) {
          case 'message_start': {
            messageId = event.message?.id ?? '';
            // Anthropic reports input tokens up front and output tokens at the end.
            promptTokens = event.message?.usage?.input_tokens ?? 0;
            write(formatDataStreamPart('start_step', { messageId }));
            break;
          }

          case 'content_block_start': {
            if (event.index !== undefined) {
              blockKinds.set(event.index, event.content_block?.type ?? 'text');
            }

            break;
          }

          case 'content_block_delta': {
            const kind = event.index !== undefined ? blockKinds.get(event.index) : 'text';

            if (event.delta?.type === 'thinking_delta' || kind === 'thinking') {
              const reasoning = event.delta?.thinking ?? '';

              if (reasoning) {
                write(formatDataStreamPart('reasoning', reasoning));
              }

              break;
            }

            const text = event.delta?.text ?? '';

            if (text) {
              write(formatDataStreamPart('text', text));
            }

            break;
          }

          case 'content_block_stop': {
            if (event.index !== undefined) {
              blockKinds.delete(event.index);
            }

            break;
          }

          case 'message_delta': {
            finishReason = mapFinishReason(event.delta?.stop_reason);
            completionTokens = event.usage?.output_tokens ?? completionTokens;
            break;
          }

          case 'message_stop': {
            const usage = { promptTokens, completionTokens };
            onUsage?.(usage);
            /*
             * Both parts are required: `useChat` uses finish_step to close the
             * assistant turn and finish_message to resolve onFinish (which is
             * where bolt logs token usage).
             */
            write(formatDataStreamPart('finish_step', { finishReason, usage, isContinued: false }));
            write(formatDataStreamPart('finish_message', { finishReason, usage }));
            sawFinish = true;
            break;
          }

          case 'error': {
            const message = event.error?.message ?? 'Upstream model error';
            write(formatDataStreamPart('error', message));
            break;
          }

          // 'ping' and any future event type are ignored rather than fatal.
          default:
            break;
        }
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          buffered += decoder.decode(value, { stream: true });

          // SSE events are separated by a blank line; a chunk boundary can fall
          // anywhere, so only complete events are consumed.
          let sep = buffered.indexOf('\n\n');

          while (sep !== -1) {
            const raw = buffered.slice(0, sep);
            buffered = buffered.slice(sep + 2);

            for (const line of raw.split('\n')) {
              if (!line.startsWith('data:')) {
                continue;
              }

              const payload = line.slice(5).trim();

              if (!payload || payload === '[DONE]') {
                continue;
              }

              try {
                handleEvent(JSON.parse(payload) as AnthropicEvent);
              } catch {
                // A single unparseable event must not kill the stream; the UI is
                // better off with a partial answer than a hard failure.
              }
            }

            sep = buffered.indexOf('\n\n');
          }
        }

        /*
         * An upstream that dies mid-stream never sends message_stop. Without a
         * finish part `useChat` leaves the message pending forever, so one is
         * synthesised and reported as an error finish.
         */
        if (!sawFinish) {
          const usage = { promptTokens, completionTokens };
          write(
            formatDataStreamPart('finish_step', {
              finishReason: 'error',
              usage,
              isContinued: false,
            }),
          );
          write(formatDataStreamPart('finish_message', { finishReason: 'error', usage }));
        }
      } catch (e) {
        write(formatDataStreamPart('error', (e as Error).message || 'Stream failed'));
      } finally {
        controller.close();
        reader.releaseLock();
      }
    },
  });
}
