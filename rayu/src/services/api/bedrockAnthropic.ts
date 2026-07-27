// Claude on AWS Bedrock, over the NATIVE Anthropic Messages wire format.
//
// Bedrock serves Claude through its own invoke endpoints rather than
// /v1/messages, so this module supplies a fetch wrapper that translates between
// the two. The Anthropic SDK client itself is the shared one
// (createAnthropicMessagesClient) — Bedrock is just a different endpoint + auth,
// which is the whole point of the unified builder.
//
// VERIFIED LIVE against bedrock-runtime.us-east-1.amazonaws.com with a Bedrock
// API key (bearer token), model global.anthropic.claude-haiku-4-5-20251001-v1:0:
//
//   POST /model/{modelId}/invoke
//     request : {"anthropic_version":"bedrock-2023-05-31","max_tokens":…,"messages":[…]}
//               (NO "model" field — the model is in the URL)
//     response: 200, native Anthropic Messages JSON
//               {"id":"msg_bdrk_…","type":"message","content":[…],"usage":{…}}
//
//   POST /model/{modelId}/invoke-with-response-stream
//     response: 200, `content-type: application/vnd.amazon.eventstream`
//               — AWS binary event-stream framing, each frame payload being
//               {"bytes":"<base64>"} whose decoded content is ONE native
//               Anthropic SSE event object ({"type":"message_start",…},
//               {"type":"content_block_delta",…}, …).
//
// The Anthropic SDK's streaming parser expects `text/event-stream`, so the
// streaming response is transcoded here: AWS frames → SSE lines. The frame
// decoding itself is the shared awsEventStream module (also used by Kiro).
//
// SECURITY:
//   • The Bedrock API key is sent ONLY to the bedrock-runtime host for the
//     configured region; the rewritten URL's host is validated before the
//     request goes out, and a cross-host rewrite throws instead of leaking.
//   • The key is read from the 0600 provider config and never logged.
import { parseEventStreamFrames } from './awsEventStream.js'

/** Anthropic API version Bedrock requires in the request body. */
export const BEDROCK_ANTHROPIC_VERSION = 'bedrock-2023-05-31'

/** Default region, matching the AWS SDK's own fallback. */
const DEFAULT_REGION = 'us-east-1'

/** Base URL for the Bedrock runtime in a region (the SDK appends paths). */
export function bedrockRuntimeBaseURL(region: string): string {
  return `https://bedrock-runtime.${region || DEFAULT_REGION}.amazonaws.com`
}

/** Hosts the Bedrock bearer token may be sent to. */
function isAllowedBedrockHost(host: string, region: string): boolean {
  // Region-scoped runtime host, plus the ANTHROPIC_BEDROCK_BASE_URL override the
  // AWS clients already honor (utils/model/bedrock.ts uses it as `endpoint`).
  if (host === `bedrock-runtime.${region || DEFAULT_REGION}.amazonaws.com`) {
    return true
  }
  const override = process.env.ANTHROPIC_BEDROCK_BASE_URL
  if (override) {
    try {
      return new URL(override).host === host
    } catch {
      return false
    }
  }
  return false
}

/**
 * Rewrite `<base>/v1/messages` into the Bedrock invoke path for `modelId`.
 * Streaming and non-streaming use different endpoints.
 */
export function bedrockInvokeURL(
  base: string,
  modelId: string,
  stream: boolean,
): string {
  const suffix = stream ? 'invoke-with-response-stream' : 'invoke'
  // Bedrock model ids contain '.' and ':' (e.g.
  // global.anthropic.claude-haiku-4-5-20251001-v1:0). Verified live that the id
  // is accepted unencoded in the path; encodeURIComponent would escape the colon
  // and 404. Only the path separator is disallowed.
  return `${base.replace(/\/+$/, '')}/model/${modelId}/${suffix}`
}

/**
 * Translate an Anthropic Messages request body into Bedrock's invoke body:
 * drop `model` (it lives in the URL) and add `anthropic_version`.
 */
export function toBedrockRequestBody(body: string): {
  body: string
  model: string
  stream: boolean
} {
  const parsed = JSON.parse(body) as Record<string, unknown>
  const model = typeof parsed.model === 'string' ? parsed.model : ''
  const stream = parsed.stream === true
  delete parsed.model
  // `stream` is expressed by the endpoint choice, not the body.
  delete parsed.stream
  parsed.anthropic_version = BEDROCK_ANTHROPIC_VERSION
  return { body: JSON.stringify(parsed), model, stream }
}

/**
 * Transcode an AWS event-stream body into Anthropic SSE text.
 *
 * Each frame payload is `{"bytes":"<base64 of one Anthropic SSE event JSON>"}`.
 * The Anthropic SDK reads `event:`/`data:` pairs, so each decoded event is
 * re-emitted with its own `type` as the SSE event name.
 */
export function eventStreamToSSE(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of parseEventStreamFrames(
          body,
          'bedrock eventstream',
        )) {
          let inner: unknown
          try {
            const outer = JSON.parse(decoder.decode(frame.payload)) as {
              bytes?: string
            }
            if (typeof outer.bytes !== 'string') continue
            inner = JSON.parse(atob(outer.bytes))
          } catch {
            // A frame we can't decode is skipped rather than killing the stream;
            // the SDK surfaces a missing-terminal-event error if it mattered.
            continue
          }
          const type =
            (inner as { type?: unknown }).type ??
            (frame.eventType || 'message')
          controller.enqueue(
            encoder.encode(
              `event: ${String(type)}\ndata: ${JSON.stringify(inner)}\n\n`,
            ),
          )
        }
        controller.close()
      } catch (e) {
        controller.error(e)
      }
    },
  })
}

/**
 * Build the fetch that turns an Anthropic-SDK request into a Bedrock invoke
 * request (and a Bedrock event-stream response back into Anthropic SSE).
 */
export function makeBedrockAnthropicFetch(opts: {
  apiKey: string
  region: string
  /** Inner fetch (the shared transport's logging/proxy fetch). */
  inner?: typeof fetch
}): typeof fetch {
  const region = opts.region || DEFAULT_REGION
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1] = {},
  ): Promise<Response> => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const inner = opts.inner ?? globalThis.fetch
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const originalUrl = input instanceof Request ? input.url : String(input)
    const rawBody = init?.body
    if (typeof rawBody !== 'string' || !/\/v1\/messages\b/.test(originalUrl)) {
      // Not a Messages call (e.g. a token-count probe) — pass through untouched.
      return inner(input, init)
    }

    const { body, model, stream } = toBedrockRequestBody(rawBody)
    if (!model) {
      throw new Error(
        'Bedrock request is missing a model id; cannot build the invoke URL.',
      )
    }
    const origin = new URL(originalUrl).origin
    const url = bedrockInvokeURL(origin, model, stream)
    const host = new URL(url).host
    if (!isAllowedBedrockHost(host, region)) {
      // SECURITY: never send the Bedrock bearer token to an unexpected host.
      throw new Error(
        `Refusing to send Bedrock credentials to unexpected host ${host}`,
      )
    }

    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${opts.apiKey}`)
    headers.set('content-type', 'application/json')
    // Anthropic-specific headers Bedrock does not accept.
    headers.delete('x-api-key')
    headers.delete('anthropic-version')
    headers.delete('anthropic-beta')

    const res = await inner(url, {
      ...init,
      method: 'POST',
      body,
      headers,
      // The rewritten URL is absolute; never follow a redirect to another host.
      redirect: 'error',
    })

    const contentType = res.headers.get('content-type') ?? ''
    if (!res.ok || !contentType.includes('vnd.amazon.eventstream') || !res.body) {
      // Errors and non-streaming responses are already Anthropic-shaped JSON.
      return res
    }
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const sseHeaders = new Headers(res.headers)
    sseHeaders.set('content-type', 'text/event-stream')
    return new Response(eventStreamToSSE(res.body), {
      status: res.status,
      statusText: res.statusText,
      headers: sseHeaders,
    })
  }
  return wrapped as typeof fetch
}
