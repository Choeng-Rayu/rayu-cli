// Rayu-HOSTED video client. POSTs to the gateway's video-generation endpoint with
// the user's Rayu JWT; the gateway holds the upstream provider key (Qwen
// DashScope video and any other provider the admin configured), bills the
// request, and returns one or more generated video URLs.
//
//     POST {gateway}/v1/videos/generations
//     Authorization: Bearer <Rayu JWT>
//     {model, prompt, duration?, resolution?, ratio?, negative_prompt?, seed?,
//      prompt_extend?, watermark?, image?}
//
// Response: {created, data:[{url, duration, resolution, ratio}],
//            rayu:{videos, seconds, billingUnit:"video_second",
//                  billableTokens, tokensPerCredit}}
// Headers: x-rayu-billable-tokens, x-rayu-video-seconds
//
// This is the only video path that needs no BYO provider key. A reference image
// (`image`: an https URL or a data:image base64 URL) is accepted only for
// catalog entries whose capabilities include `image2video`; the tool refuses it
// for text-to-video-only models before reaching here (see VideoGenTool.call).
// The gateway bills ACTUAL seconds — the returned duration can differ from the
// requested one, so it is surfaced to the caller.
//
// SECURITY: the Rayu JWT is sent only to the configured Rayu gateway; never
// logged. The gateway base URL itself is validated first (https, or http to
// loopback only) and the generation POST uses `redirect:'error'`, so a
// redirect — same-host or off-host — can never carry the bearer token to a
// target the operator did not configure. A provider-returned URL is likewise
// downloaded with `redirect:'error'` (no off-host hops), https-only, a
// timeout, and a size cap.
import { hasHostedModelAccess, hostedModelUpgradeMessage } from '../../services/rayuAuth/rayuEntitlements.js'
import {
  getSecureRayuGatewayBaseUrl,
  getValidRayuAccessToken,
} from '../../services/rayuAuth/rayuSession.js'
import { recordRayuCharge } from '../../services/rayuAuth/rayuTurnCredits.js'
import { creditsFromRayuBody } from '../../utils/rayuRequestCharge.js'
import { type VideoModel, type VideoParams } from './models.js'

/**
 * How long the client waits for the gateway before aborting.
 *
 * The gateway's video path may hold the request for up to ~900s (provider
 * generation plus failover) and bills once the upstream returns — even if this
 * client has already hung up. Wait past the gateway's whole budget (960s = 900s
 * + margin) so the client only gives up after the gateway itself has, while
 * still composing the caller's cancel signal.
 *
 * Exported for the timeout assertion in the tests.
 */
export const RAYU_VIDEO_TIMEOUT_MS = 960_000
/** URL download: 300 MiB ceiling and a 120s total timeout. */
const RAYU_VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000
const RAYU_VIDEO_MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024

/** A generated video plus the model id that actually produced it. */
export type GeneratedVideo = {
  buffer: Buffer
  mediaType: string
  modelId: string
  /**
   * ACTUAL seconds billed: `data[0].duration`, falling back to `rayu.seconds`,
   * then to the requested duration. The gateway can return a different length
   * than was asked for, so callers report this, not the request.
   */
  durationSeconds?: number
  /** Actual resolution tier the gateway served (e.g. "480P"), when returned. */
  resolution?: string
  /** Actual ratio the gateway served (e.g. "16:9"), when returned. */
  ratio?: string
}

type VideosItem = {
  url?: string | null
  duration?: number
  resolution?: string
  ratio?: string
}

type VideosResponse = {
  created?: number
  data?: VideosItem[]
  rayu?: {
    videos?: number
    seconds?: number
    billingUnit?: string
    billableTokens?: number
    tokensPerCredit?: number
  }
  error?: { message?: string; type?: string; code?: string | null }
}

/**
 * Compose the caller's abort signal with the fixed request timeout. The fixed
 * timeout signal is also returned so the catch site can tell a GATEWAY timeout
 * apart from a user cancel — the raw TimeoutError ("The operation was aborted
 * due to timeout") names neither, and a timeout here has a billing consequence
 * the user must be told about.
 */
function withTimeout(signal?: AbortSignal): { composed: AbortSignal; timeout: AbortSignal } {
  const timeout = AbortSignal.timeout(RAYU_VIDEO_TIMEOUT_MS)
  if (!signal) return { composed: timeout, timeout }
  // AbortSignal.any keeps a user cancel (Esc) working without clobbering it.
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  return { composed: AbortSignal.any([timeout, signal]), timeout }
}

/** Compose the caller's abort signal with the download timeout. */
function withDownloadTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(RAYU_VIDEO_DOWNLOAD_TIMEOUT_MS)
  if (!signal) return timeout
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  return AbortSignal.any([timeout, signal])
}

/** Read an error body as `{error:{message}}`, plain text, or nothing. */
async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return ''
  try {
    const parsed = JSON.parse(text) as VideosResponse
    const message = parsed?.error?.message
    if (typeof message === 'string' && message) return message
  } catch {
    // not JSON — fall through to the raw text
  }
  return text.slice(0, 300)
}

/** MP4 sniff: the `ftyp` box type sits at byte offset 4 of a valid file. */
function looksLikeMp4(buf: Buffer): boolean {
  return buf.length >= 8 && buf.toString('latin1', 4, 8) === 'ftyp'
}

/**
 * Download a provider-returned video URL. The gateway returns a URL rather than
 * inline bytes, so this is the normal path for hosted video.
 */
async function downloadVideo(
  url: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Rayu video API returned an invalid video URL.')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Refusing to download a generated video over ${parsed.protocol} (https required).`,
    )
  }

  const res = await fetch(url, {
    // A redirect could land on a host this URL was never vetted for. The
    // gateway's own downloader refuses redirects; mirror that here.
    redirect: 'error',
    signal: withDownloadTimeout(signal),
  })
  if (!res.ok) {
    throw new Error(`Generated video download failed (${res.status}).`)
  }
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > RAYU_VIDEO_MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `Generated video is too large (${declared} bytes; max ${RAYU_VIDEO_MAX_DOWNLOAD_BYTES}).`,
    )
  }
  const contentType = (res.headers.get('content-type') ?? '')
    .toLowerCase()
    .split(';')[0]!
    .trim()
  if (
    contentType &&
    contentType !== 'video/mp4' &&
    contentType !== 'application/octet-stream'
  ) {
    throw new Error(
      `Generated video URL returned ${contentType}, not an MP4 video.`,
    )
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) {
    throw new Error('Generated video download returned an empty body.')
  }
  if (buf.length > RAYU_VIDEO_MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `Generated video is too large (${buf.length} bytes; max ${RAYU_VIDEO_MAX_DOWNLOAD_BYTES}).`,
    )
  }
  if (!looksLikeMp4(buf)) {
    throw new Error('Generated video download is not an MP4 (no ftyp box).')
  }
  return buf
}

/**
 * Generate one video with a Rayu-hosted model.
 *
 * Throws:
 * - `hostedModelUpgradeMessage()` when the plan grants no hosted access;
 * - a sign-in prompt when there is no usable Rayu token;
 * - the gateway's `{error:{message}}` (or plain text) on a non-2xx response;
 * - a clear error when the response carries no usable video URL.
 */
export async function generateRayuVideo(opts: {
  /** The resolved catalog entry (with its family body builder attached). */
  model: VideoModel
  params: VideoParams
  signal?: AbortSignal
}): Promise<GeneratedVideo> {
  // Same client-side courtesy gate as the chat path: a user with no hosted
  // access gets the upgrade message instead of a raw gateway 403. The gateway
  // remains the authoritative gate.
  if (!hasHostedModelAccess()) {
    throw new Error(hostedModelUpgradeMessage())
  }

  // Validate the gateway target BEFORE the token is read or sent: a
  // misconfigured RAYU_GATEWAY_URL must fail here, not on the wire.
  const gateway = getSecureRayuGatewayBaseUrl()

  const token = await getValidRayuAccessToken()
  if (!token) {
    throw new Error(
      'Not signed in to Rayu. Run /login to use Rayu-hosted video models.',
    )
  }

  const body = {
    ...opts.model.buildBody(opts.params),
    // Set AFTER the spread: catalog `defaultParams` must never be able to swap
    // the model the caller selected (the dashscope builder strips `model` too;
    // this is the authoritative guard for any family).
    model: opts.model.id,
  }

  const { composed, timeout } = withTimeout(opts.signal)
  let res: Response
  try {
    res = await fetch(`${gateway}/v1/videos/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // The JWT must reach exactly the configured gateway, once. A redirect —
      // even a same-host 308 — would move the request to a URL the operator
      // never vetted, so refuse all of them.
      redirect: 'error',
      signal: composed,
    })
  } catch (err) {
    // A gateway timeout is NOT a plain network error: the gateway settles the
    // render (and the charge) even after this client hangs up, so the message
    // must say so instead of leaking the raw TimeoutError.
    if (timeout.aborted && !opts.signal?.aborted) {
      throw new Error(
        `Rayu video generation timed out after ${Math.round(RAYU_VIDEO_TIMEOUT_MS / 1000)}s. ` +
          'The render may still complete and be billed server-side — check /billing ' +
          'before retrying so you do not pay for it twice.',
      )
    }
    if (opts.signal?.aborted) throw err
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not reach the Rayu video gateway: ${detail}`)
  }

  if (!res.ok) {
    const detail = await readErrorMessage(res)
    throw new Error(
      `Rayu video API error ${res.status}${detail ? `: ${detail}` : ''}`,
    )
  }

  let payload: VideosResponse
  try {
    payload = (await res.json()) as VideosResponse
  } catch {
    throw new Error('Rayu video API returned an unreadable (non-JSON) response.')
  }
  // The render was settled before the gateway answered, so count it now: a
  // download that fails below does not undo the charge.
  recordRayuCharge(creditsFromRayuBody(payload))
  if (payload?.error?.message) {
    throw new Error(`Rayu video API error: ${payload.error.message}`)
  }

  const item = payload?.data?.[0]
  if (!item) {
    throw new Error(
      'Rayu video API returned no video (the model may have declined the prompt).',
    )
  }
  if (typeof item.url !== 'string' || !item.url) {
    throw new Error('Rayu video API returned no video URL.')
  }

  const buffer = await downloadVideo(item.url, opts.signal)

  // The gateway bills and returns ACTUAL seconds, which can differ from the
  // requested duration — prefer the per-item duration, then the billing
  // aggregate, then (only if the response carried neither) the request.
  // The request body is a per-family builder output (Record<string, unknown>);
  // `duration` is set by families that map frame counts to seconds.
  const requested = (body as Record<string, unknown>).duration
  const durationSeconds =
    typeof item.duration === 'number' && Number.isFinite(item.duration)
      ? item.duration
      : typeof payload?.rayu?.seconds === 'number' &&
        Number.isFinite(payload.rayu.seconds)
        ? payload.rayu.seconds
        : typeof requested === 'number' && Number.isFinite(requested)
          ? requested
          : undefined

  return {
    buffer,
    // The gateway only serves MP4 today, and the download was sniffed for an
    // `ftyp` box, so this is not a guess.
    mediaType: 'video/mp4',
    modelId: opts.model.id,
    durationSeconds,
    resolution:
      typeof item.resolution === 'string' && item.resolution
        ? item.resolution
        : undefined,
    ratio:
      typeof item.ratio === 'string' && item.ratio ? item.ratio : undefined,
  }
}
