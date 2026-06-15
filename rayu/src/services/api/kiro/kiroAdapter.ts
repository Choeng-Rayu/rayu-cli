// Rayu Kiro adapter. Presents the slice of the Anthropic SDK surface that
// src/services/api/claude.ts uses — `client.beta.messages.create(params, opts)`
// for both non-streaming (await → BetaMessage) and streaming (stream:true →
// .withResponse() → { data, request_id, response }) — and bridges to the AWS
// CodeWhisperer "GenerateAssistantResponse" endpoint that Kiro uses.
//
// Flow: buildKiroPayload (Anthropic → Kiro payload) → POST q.<region>.amazonaws
// .com with the bearer from kiroAuth → parseKiroEventStream (binary event-stream)
// → translateKiroStream / toBetaMessageFromKiro (Kiro events → Anthropic).
//
// EVERYTHING is lazy: client.ts only imports this when the active provider is
// kind:'kiro'. SECURITY: bearer tokens are never logged.
import {
  APIError as AnthropicAPIError,
  APIConnectionError as AnthropicAPIConnectionError,
} from '@anthropic-ai/sdk/index.js'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RayuProvider } from '../../../utils/rayuConfig.js'
import { getRayuConfigHomeDir } from '../../../utils/envUtils.js'
import { reportIssue } from '../../../utils/rayuDiagnostics.js'
import { buildKiroPayload, type KiroBetaParams, type ToolNameMap } from './buildPayload.js'
import { KiroEventType, parseKiroEventStream, type KiroEvent } from './eventStream.js'
import { getKiroBearer, invalidateKiroAuthCache } from './kiroAuth.js'
import { toBetaMessageFromKiro, translateKiroStream } from './translateStream.js'

type AnyObj = Record<string, unknown>
type StreamEvent = { type: string } & AnyObj

const AMZ_TARGET = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse'
// AWS SDK Rust UA strings copied verbatim from kirocc-fork (mimics AmazonQ-For-CLI).
const USER_AGENT =
  'aws-sdk-rust/1.3.14 ua/2.1 api/codewhispererstreaming/0.1.14474 os/macos lang/rust/1.92.0 md/appVersion-2.0.0 app/AmazonQ-For-CLI'
const AMZ_USER_AGENT =
  'aws-sdk-rust/1.3.14 ua/2.1 api/codewhispererstreaming/0.1.14474 os/macos lang/rust/1.92.0 m/F app/AmazonQ-For-CLI'

const REQUEST_TIMEOUT_MS = 120_000

// --- Env-gated debug capture (RAYU_DEBUG_KIRO) ------------------------------
// Inert unless RAYU_DEBUG_KIRO is set. Appends one JSON line per request + per
// response to ~/.rayu/debug-kiro.jsonl so we can see whether thinking was
// requested (the <thinking_mode> prefix) and whether Kiro returned reasoning
// events. NEVER logs tokens or message content.
function kiroDebugEnabled(): boolean {
  return !!process.env.RAYU_DEBUG_KIRO
}
function kiroDebugLog(obj: AnyObj): void {
  if (!kiroDebugEnabled()) return
  try {
    appendFileSync(
      join(getRayuConfigHomeDir(), 'debug-kiro.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), ...obj })}\n`,
    )
  } catch {
    // best-effort
  }
}
/** Per-request debug collector: records RAW frame types (incl. unknown ones),
 *  a sample of any unknown event's payload, and whether reasoning is embedded
 *  inline in assistant text — so we can see how the CURRENT Kiro emits thinking. */
type KiroDebugCollector = {
  onRawFrame: (eventType: string, payload: Uint8Array) => void
  flush: (decoded: { counts: Record<string, number>; reasoningChars: number; textChars: number }) => void
}
function makeKiroDebugCollector(model: string): KiroDebugCollector {
  const rawCounts: Record<string, number> = {}
  const unknownSamples: Record<string, string> = {}
  let inlineThinking = false
  let textSample = ''
  const known = new Set<string>(Object.values(KiroEventType))
  const dec = new TextDecoder()
  return {
    onRawFrame(eventType, payload) {
      rawCounts[eventType] = (rawCounts[eventType] ?? 0) + 1
      if (!known.has(eventType) && unknownSamples[eventType] === undefined) {
        unknownSamples[eventType] = dec.decode(payload).slice(0, 240)
      }
      if (eventType === KiroEventType.AssistantResponse) {
        try {
          const c = (JSON.parse(dec.decode(payload)) as { content?: string }).content ?? ''
          if (textSample.length < 280) textSample = (textSample + c).slice(0, 280)
          if (!inlineThinking && /<think|◁think|<reason|<analysis/i.test(c)) inlineThinking = true
        } catch {
          // ignore
        }
      }
    },
    flush(decoded) {
      kiroDebugLog({
        phase: 'response',
        model,
        ...decoded,
        rawCounts,
        unknownSamples,
        inlineThinking,
        textSample,
      })
    },
  }
}
/** Count decoded event types as they flow through (debug only). */
async function* teeKiroEvents(
  events: AsyncGenerator<KiroEvent>,
  model: string,
  collector?: KiroDebugCollector,
): AsyncGenerator<KiroEvent> {
  const counts: Record<string, number> = {}
  let reasoningChars = 0
  let textChars = 0
  for await (const ev of events) {
    counts[ev.type] = (counts[ev.type] ?? 0) + 1
    if (ev.type === KiroEventType.ReasoningContent) reasoningChars += (ev.thinkingText ?? '').length
    else if (ev.type === KiroEventType.AssistantResponse) textChars += (ev.content ?? '').length
    yield ev
  }
  if (collector) collector.flush({ counts, reasoningChars, textChars })
  else kiroDebugLog({ phase: 'response', model, counts, reasoningChars, textChars })
}

export type KiroConfig = { provider: RayuProvider; maxRetries?: number }

function isEventStreamContentType(ct: string): boolean {
  return ct.toLowerCase().includes('vnd.amazon.eventstream')
}

function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt + Math.floor(Math.random() * 250), 8000)
}
function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Extract a human-readable message from an AWS JSON exception envelope. */
function awsErrorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { message?: string; Message?: string; __type?: string }
    return j.message || j.Message || j.__type || body.slice(0, 300)
  } catch {
    return body.slice(0, 300)
  }
}
function isRetryableAWSException(body: string): boolean {
  return /Throttling|TooManyRequests|InternalServer|ServiceUnavailable/i.test(body)
}

function kiroApiError(status: number, body: string): unknown {
  const message = awsErrorMessage(body)
  return AnthropicAPIError.generate(status, { error: { message } }, `Kiro: ${message}`, undefined)
}

/**
 * Turn the "profileArn is required" failure (OAuth on an AWS Builder ID account,
 * which can't list profiles) into a CLEAR, NON-retryable 400 with guidance —
 * instead of the confusing "Retrying… attempt 5/10" loop.
 */
function clarifyKiroError(e: unknown): unknown {
  const msg = e instanceof Error ? e.message : String(e)
  if (/profile\s*arn is required/i.test(msg)) {
    return AnthropicAPIError.generate(
      400,
      { error: { message: msg } },
      'Kiro: a profile ARN is required, but your kiro-cli login (AWS Builder ID) cannot provide one. ' +
        'Use a Kiro API key (/connect → Kiro → API key), sign in to kiro-cli with an IAM Identity Center / Pro account, ' +
        'or set RAYU_KIRO_PROFILE_ARN to your profile ARN.',
      undefined,
    )
  }
  return e
}

/** Wrap a stream generator so its errors get clarified (e.g. profileArn). */
async function* mapStreamErrors(gen: AsyncGenerator<StreamEvent>): AsyncGenerator<StreamEvent> {
  try {
    yield* gen
  } catch (e) {
    throw clarifyKiroError(e)
  }
}

export function createKiroClient(provider: RayuProvider, maxRetries = 2) {
  /**
   * Build the payload once, then POST with retry. On 403 we drop the cached
   * bearer (forcing a re-read/refresh from the kiro-cli token DB) and retry.
   * Returns the raw event-stream body + the resolved model + tool-name map.
   */
  async function sendRequest(
    params: KiroBetaParams,
    signal?: AbortSignal,
  ): Promise<{
    stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>
    toolNames: ToolNameMap
    responseModel: string
  }> {
    const { payload, toolNames } = buildKiroPayload(params)
    const invocationId = crypto.randomUUID()
    if (kiroDebugEnabled()) {
      const c = payload.conversationState.currentMessage.userInputMessage.content
      kiroDebugLog({
        phase: 'request',
        model: params.model,
        thinkingParam: (params.thinking as AnyObj | undefined)?.type ?? null,
        thinkingRequested: c.includes('<thinking_mode>enabled</thinking_mode>'),
      })
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const bearer = await getKiroBearer(provider)
      if (bearer.profileArn) payload.profileArn = bearer.profileArn
      const endpoint = `https://q.${bearer.region}.amazonaws.com/`
      const headers: Record<string, string> = {
        Authorization: `Bearer ${bearer.token}`,
        'Content-Type': 'application/x-amz-json-1.0',
        Accept: '*/*',
        'X-Amz-Target': AMZ_TARGET,
        'User-Agent': USER_AGENT,
        'x-amz-user-agent': AMZ_USER_AGENT,
        'x-amzn-codewhisperer-optout': 'false',
        'amz-sdk-invocation-id': invocationId,
        'amz-sdk-request': `attempt=${attempt + 1}; max=${maxRetries + 1}`,
      }
      if (bearer.tokenType) headers.TokenType = bearer.tokenType

      // Per-request timeout, composed with the caller's abort signal.
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const composite =
        signal && 'any' in AbortSignal
          ? (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([signal, timeout])
          : (signal ?? timeout)

      let res: Response
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: composite,
        })
      } catch (e) {
        if (attempt < maxRetries) {
          await delay(backoffDelay(attempt))
          continue
        }
        reportIssue('kiro.request_failed', 'Kiro request failed', {
          model: params.model,
          error: e instanceof Error ? e.message : String(e),
        })
        throw new AnthropicAPIConnectionError({
          message: e instanceof Error ? e.message : String(e),
          cause: e as Error,
        })
      }

      if (res.status === 200) {
        const ct = res.headers.get('content-type') ?? ''
        if (!isEventStreamContentType(ct)) {
          // 200 + JSON = AWS exception envelope (throttling/internal/etc.).
          const body = await res.text()
          if (attempt < maxRetries && isRetryableAWSException(body)) {
            await delay(backoffDelay(attempt))
            continue
          }
          reportIssue('kiro.request_failed', 'Kiro 200 non-eventstream exception', {
            model: params.model,
            body: body.slice(0, 200),
          })
          throw kiroApiError(200, body)
        }
        if (!res.body) throw kiroApiError(200, 'empty response body')
        return { stream: res.body, toolNames, responseModel: params.model }
      }

      if (res.status === 403 && attempt < maxRetries) {
        // Token rejected — drop cache, re-read/refresh, retry.
        invalidateKiroAuthCache(provider.id)
        continue
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await delay(backoffDelay(attempt))
        continue
      }

      const body = await res.text().catch(() => '')
      reportIssue('kiro.request_failed', 'Kiro request failed', {
        model: params.model,
        status: res.status,
        body: body.slice(0, 200),
      })
      throw kiroApiError(res.status, body)
    }
    throw kiroApiError(500, 'Kiro: max retries exceeded')
  }

  async function runNonStreaming(params: KiroBetaParams, signal?: AbortSignal): Promise<unknown> {
    const { stream, toolNames, responseModel } = await sendRequest(params, signal)
    const events: KiroEvent[] = []
    const collector = kiroDebugEnabled() ? makeKiroDebugCollector(responseModel) : undefined
    const parsed = parseKiroEventStream(stream, collector?.onRawFrame)
    const src = collector ? teeKiroEvents(parsed, responseModel, collector) : parsed
    try {
      for await (const ev of src) events.push(ev)
      return toBetaMessageFromKiro(events, responseModel, toolNames)
    } catch (e) {
      throw clarifyKiroError(e)
    }
  }

  async function runStreamingWithResponse(
    params: KiroBetaParams,
    signal?: AbortSignal,
  ): Promise<{ data: AsyncGenerator<StreamEvent>; request_id: null; response: Response }> {
    const { stream, toolNames, responseModel } = await sendRequest(params, signal)
    const collector = kiroDebugEnabled() ? makeKiroDebugCollector(responseModel) : undefined
    const parsed = parseKiroEventStream(stream, collector?.onRawFrame)
    const events = collector ? teeKiroEvents(parsed, responseModel, collector) : parsed
    return {
      data: mapStreamErrors(translateKiroStream(events, responseModel, toolNames)),
      request_id: null,
      response: new Response(null, { status: 200 }),
    }
  }

  function create(params: KiroBetaParams, opts?: AnyObj): unknown {
    const signal = opts?.signal as AbortSignal | undefined
    return {
      then(onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return runNonStreaming(params, signal).then(onFulfilled, onRejected)
      },
      catch(onRejected?: (e: unknown) => unknown) {
        return runNonStreaming(params, signal).catch(onRejected)
      },
      withResponse: () => runStreamingWithResponse(params, signal),
    }
  }

  return {
    beta: { messages: { create } },
    messages: { create },
  }
}
