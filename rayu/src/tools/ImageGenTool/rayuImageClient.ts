// Rayu-HOSTED image client. POSTs to the gateway's OpenAI-Images-compatible
// endpoint with the user's Rayu JWT; the gateway holds the upstream provider
// key (Qwen and any other OpenAI-Images host the admin configured), bills the
// request, and returns the image inline as base64 or as a URL.
//
//     POST {gateway}/v1/images/generations
//     Authorization: Bearer <Rayu JWT>
//     {model, prompt, n:1, size?, negative_prompt?, seed?, response_format:"b64_json"}
//
// Response: {created, data:[{b64_json|url, revised_prompt}], usage?,
//            rayu:{images,billableTokens,tokensPerCredit}}
//
// This is the only image path that needs no BYO provider key. Edits are
// capability-gated: an `image` (an https URL or a `data:image/...;base64,...`
// URL, built by the family body builder) is sent only for catalog entries that
// advertise `edit`; the tool refuses input_image for generate-only hosted
// models before reaching here (see ImageGenTool.call).
//
// SECURITY: the Rayu JWT is sent only to the configured Rayu gateway; never
// logged. The gateway base URL itself is validated first (https, or http to
// loopback only) and the generation POST uses `redirect:'error'`, so a
// redirect — same-host or off-host — can never carry the bearer token to a
// target the operator did not configure. A provider-returned URL is likewise
// downloaded with `redirect:'error'` (no off-host hops), a timeout, and a
// size cap.
import { detectImageFormatFromBuffer } from '../../utils/imageResizer.js'
import { creditsFromRayuBody } from '../../utils/rayuRequestCharge.js'
import { hasHostedModelAccess, hostedModelUpgradeMessage } from '../../services/rayuAuth/rayuEntitlements.js'
import {
  getSecureRayuGatewayBaseUrl,
  getValidRayuAccessToken,
} from '../../services/rayuAuth/rayuSession.js'
import { recordRayuCharge } from '../../services/rayuAuth/rayuTurnCredits.js'
import { type ImageModel, type ImageParams } from './models.js'

/**
 * How long the client waits for the gateway before aborting.
 *
 * The gateway's image path has a 240s FAILOVER budget: when the first upstream
 * provider hits its own 180s ceiling it may try a second one, and the request is
 * BILLED once any upstream returns — even if this client has already hung up.
 * Aborting at 180s therefore risked charging the user for an image they never
 * saw. Wait past the gateway's whole budget (300s) so the client only gives up
 * after the gateway itself has, and still compose the caller's cancel signal.
 *
 * Exported for the timeout assertion in the tests.
 */
export const RAYU_IMAGE_TIMEOUT_MS = 300_000
/** URL fallback download: total time and size ceilings. */
const RAYU_IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000
const RAYU_IMAGE_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024

/** A generated image plus the model id that actually produced it. */
export type GeneratedImage = {
  buffer: Buffer
  mediaType: string
  modelId: string
}

type ImagesItem = {
  b64_json?: string | null
  url?: string | null
  revised_prompt?: string | null
}

type ImagesResponse = {
  created?: number
  data?: ImagesItem[]
  /** What the gateway charged; read by `creditsFromRayuBody`. */
  rayu?: {
    images?: number
    billingUnit?: string
    billableTokens?: number
    tokensPerCredit?: number
  }
  error?: { message?: string; type?: string; code?: string | null }
}

/**
 * Compose the caller's abort signal with the fixed request timeout. The fixed
 * timeout signal is also returned so the catch site can tell a GATEWAY timeout
 * apart from a user cancel — the gateway bills a completed image even after
 * this client hangs up, and the raw TimeoutError says neither.
 */
function withTimeout(signal?: AbortSignal): { composed: AbortSignal; timeout: AbortSignal } {
  const timeout = AbortSignal.timeout(RAYU_IMAGE_TIMEOUT_MS)
  if (!signal) return { composed: timeout, timeout }
  // AbortSignal.any keeps a user cancel (Esc) working without clobbering it.
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  return { composed: AbortSignal.any([timeout, signal]), timeout }
}

/** Read an error body as `{error:{message}}`, plain text, or nothing. */
async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return ''
  try {
    const parsed = JSON.parse(text) as ImagesResponse
    const message = parsed?.error?.message
    if (typeof message === 'string' && message) return message
  } catch {
    // not JSON — fall through to the raw text
  }
  return text.slice(0, 300)
}

/**
 * Download a provider-returned image URL. The gateway normally inlines base64;
 * this path exists for a gateway that could not fetch the URL itself (it
 * returns the URL and still bills).
 */
async function downloadImage(
  url: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Rayu image API returned an invalid image URL.')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Refusing to download a generated image over ${parsed.protocol} (https required).`,
    )
  }

  const timeout = AbortSignal.timeout(RAYU_IMAGE_DOWNLOAD_TIMEOUT_MS)
  const combined = signal
    ? // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      AbortSignal.any([timeout, signal])
    : timeout

  const res = await fetch(url, {
    // A redirect could land on a host this URL was never vetted for. The
    // gateway's own downloader refuses redirects; mirror that here.
    redirect: 'error',
    signal: combined,
  })
  if (!res.ok) {
    throw new Error(`Generated image download failed (${res.status}).`)
  }
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > RAYU_IMAGE_MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `Generated image is too large (${declared} bytes; max ${RAYU_IMAGE_MAX_DOWNLOAD_BYTES}).`,
    )
  }
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  if (contentType && !contentType.startsWith('image/')) {
    throw new Error(
      `Generated image URL returned ${contentType}, not an image.`,
    )
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) {
    throw new Error('Generated image download returned an empty body.')
  }
  if (buf.length > RAYU_IMAGE_MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `Generated image is too large (${buf.length} bytes; max ${RAYU_IMAGE_MAX_DOWNLOAD_BYTES}).`,
    )
  }
  return buf
}

/**
 * Generate one image with a Rayu-hosted model.
 *
 * Throws:
 * - `hostedModelUpgradeMessage()` when the plan grants no hosted access;
 * - a sign-in prompt when there is no usable Rayu token;
 * - the gateway's `{error:{message}}` (or plain text) on a non-2xx response;
 * - a clear error when the response carries no usable image.
 */
export async function generateRayuImage(opts: {
  /** The resolved catalog entry (with its family body builder attached). */
  model: ImageModel
  params: ImageParams
  signal?: AbortSignal
}): Promise<GeneratedImage> {
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
      'Not signed in to Rayu. Run /login to use Rayu-hosted image models.',
    )
  }

  const body = {
    ...opts.model.buildBody(opts.params),
    // Set AFTER the spread: catalog `defaultParams` must never be able to swap
    // the model the caller selected (openaiImagesBody strips these too; this is
    // the authoritative guard for any family).
    model: opts.model.id,
    // Ask the gateway to inline the bytes: one round-trip, no extra host to
    // trust. The gateway still bills for the upstream call even if it has to
    // fall back to a URL.
    response_format: 'b64_json',
  }

  const { composed, timeout } = withTimeout(opts.signal)
  let res: Response
  try {
    res = await fetch(`${gateway}/v1/images/generations`, {
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
    // The gateway bills a completed image even after this client hangs up, so
    // a timeout must say that instead of leaking the raw TimeoutError.
    if (timeout.aborted && !opts.signal?.aborted) {
      throw new Error(
        `Rayu image generation timed out after ${Math.round(RAYU_IMAGE_TIMEOUT_MS / 1000)}s. ` +
          'The image may still complete and be billed server-side — check /billing ' +
          'before retrying so you do not pay for it twice.',
      )
    }
    if (opts.signal?.aborted) throw err
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not reach the Rayu image gateway: ${detail}`)
  }

  if (!res.ok) {
    const detail = await readErrorMessage(res)
    throw new Error(
      `Rayu image API error ${res.status}${detail ? `: ${detail}` : ''}`,
    )
  }

  let payload: ImagesResponse
  try {
    payload = (await res.json()) as ImagesResponse
  } catch {
    throw new Error('Rayu image API returned an unreadable (non-JSON) response.')
  }
  // The gateway settled the charge before answering, so count it now: a URL
  // download that fails below does not undo it.
  recordRayuCharge(creditsFromRayuBody(payload))
  if (payload?.error?.message) {
    throw new Error(`Rayu image API error: ${payload.error.message}`)
  }

  const item = payload?.data?.[0]
  if (!item) {
    throw new Error(
      'Rayu image API returned no image (the model may have declined the prompt).',
    )
  }

  let buffer: Buffer
  if (typeof item.b64_json === 'string' && item.b64_json) {
    buffer = Buffer.from(item.b64_json, 'base64')
  } else if (typeof item.url === 'string' && item.url) {
    buffer = await downloadImage(item.url, opts.signal)
  } else {
    throw new Error('Rayu image API returned no image data (b64_json or url).')
  }

  if (buffer.length === 0) {
    throw new Error('Rayu image API returned an empty image.')
  }

  return {
    buffer,
    // Sniff the magic bytes rather than trusting a header: the gateway may
    // forward whatever the upstream produced (PNG from Qwen, JPEG elsewhere).
    mediaType: detectImageFormatFromBuffer(buffer),
    modelId: opts.model.id,
  }
}
