// Reference-image resolver shared by the two RAYU-HOSTED media gateway paths
// (ImageGenTool edits on dashscope_multimodal/openai_images models, VideoGenTool
// image2video on dashscope_video models). Both gateway endpoints accept the same
// image reference contract: an https URL verbatim, or a
// `data:image/{png|jpeg|webp};base64,<...>` URL for a local file.
//
// SECURITY: this only reads a user-named local file and encodes it; no network
// access happens here (an https reference is fetched by the GATEWAY, which is
// what holds the provider key).
import { readFileSync } from 'fs'

/**
 * Maximum decoded size of a local reference image, in bytes — mirrors the
 * gateway's MAX_REFERENCE_IMAGE_BYTES. The gateway accepts either an https URL
 * or a `data:image/{png|jpeg|webp};base64,<...>` URL.
 */
export const REFERENCE_IMAGE_MAX_DECODED_BYTES = 12 * 1024 * 1024

/**
 * Maximum request body the gateway will accept on its media generation
 * endpoints — mirrors rayu-gateway MAX_VIDEO_BODY_BYTES (DefaultBodyLimit). The
 * decoded cap alone is NOT sufficient: base64 inflates ~4/3, so a file at
 * exactly the 12 MiB decoded cap encodes to exactly 16 MiB, and the data-URI
 * prefix + JSON + prompt push the body over the limit — the extractor then 413s
 * before the handler can answer with a tagged error. Enforce the ENCODED size
 * against the same ceiling (minus headroom for the prompt and JSON envelope) so
 * what the CLI accepts is what the server actually accepts.
 */
export const GATEWAY_MAX_BODY_BYTES = 16 * 1024 * 1024
/** Headroom for the prompt (gateway caps it at 8k chars), JSON, and defaults. */
export const REFERENCE_IMAGE_HEADROOM_BYTES = 64 * 1024

/** PNG / JPEG / WebP magic bytes, extension fallback, else a clear refusal. */
function inferReferenceMime(
  buf: Buffer,
  pathHint: string,
): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (
    buf.length >= 4 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return 'image/png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  const lower = pathHint.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  throw new Error(
    'Reference image must be a PNG, JPEG or WebP image (the gateway only ' +
      'accepts those types).',
  )
}

/**
 * Resolve the caller's raw `input_image` into the gateway's `image` wire
 * value: an https URL passes through unchanged (the gateway accepts ONLY
 * https and data: — an http:// URL would be refused with a 400 the CLI can
 * prevent); anything else is a local path — read, size-capped, mime-sniffed
 * and base64-encoded into a data URL. Both the decoded AND the encoded size
 * are checked so an accepted file is one the gateway's body limit also
 * accepts.
 *
 * `gatewayLabel` names the endpoint in the https-only refusal message (the
 * video and image gateways refuse for the same reason but are distinct
 * services), so both callers share one implementation without misleading copy.
 */
export function resolveReferenceImage(
  raw: string,
  opts?: { gatewayLabel?: string },
): string {
  if (/^https:\/\//i.test(raw)) return raw
  if (/^http:\/\//i.test(raw)) {
    throw new Error(
      `Reference image URLs must use https:// — the ` +
        `${opts?.gatewayLabel ?? 'Rayu media gateway'} rejects plain http image references.`,
    )
  }
  let buf: Buffer
  try {
    buf = readFileSync(raw)
  } catch {
    throw new Error(`input_image not found or unreadable: ${raw}`)
  }
  if (buf.length > REFERENCE_IMAGE_MAX_DECODED_BYTES) {
    throw new Error(
      `Reference image is too large (${buf.length} bytes; max ` +
        `${REFERENCE_IMAGE_MAX_DECODED_BYTES}). Use a smaller PNG/JPEG/WebP, or ` +
        `an https:// URL instead of a local file.`,
    )
  }
  const dataUrl = `data:${inferReferenceMime(buf, raw)};base64,${buf.toString('base64')}`
  if (
    Buffer.byteLength(dataUrl) >
    GATEWAY_MAX_BODY_BYTES - REFERENCE_IMAGE_HEADROOM_BYTES
  ) {
    throw new Error(
      `Reference image is too large to fit the gateway request body ` +
        `(encoded payload ${Buffer.byteLength(dataUrl)} bytes; the whole body ` +
        `must stay under ${GATEWAY_MAX_BODY_BYTES}). Use a smaller ` +
        `PNG/JPEG/WebP, or an https:// URL instead of a local file.`,
    )
  }
  return dataUrl
}
