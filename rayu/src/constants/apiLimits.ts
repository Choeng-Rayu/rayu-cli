/**
 * Anthropic API Limits
 *
 * These constants define server-side limits enforced by the Anthropic API.
 * Keep this file dependency-free to prevent circular imports.
 *
 * Last verified: 2025-12-22
 * Source: api/api/schemas/messages/blocks/ and api/api/config.py
 *
 * Future: See issue #13240 for dynamic limits fetching from server.
 */

// =============================================================================
// IMAGE LIMITS
// =============================================================================

/**
 * Maximum base64-encoded image size (API enforced).
 * The API rejects images where the base64 string length exceeds this value.
 * Note: This is the base64 length, NOT raw bytes. Base64 increases size by ~33%.
 */
export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024 // 5 MB

/**
 * Target raw image size to stay under base64 limit after encoding.
 * Base64 encoding increases size by 4/3, so we derive the max raw size:
 * raw_size * 4/3 = base64_size → raw_size = base64_size * 3/4
 */
export const IMAGE_TARGET_RAW_SIZE = (API_IMAGE_MAX_BASE64_SIZE * 3) / 4 // 3.75 MB

/**
 * Client-side maximum dimensions for image resizing.
 *
 * Note: The API internally resizes images larger than 1568px (source:
 * encoding/full_encoding.py), but this is handled server-side and doesn't
 * cause errors. These client-side limits (2000px) are slightly larger to
 * preserve quality when beneficial.
 *
 * The API_IMAGE_MAX_BASE64_SIZE (5MB) is the actual hard limit that causes
 * API errors if exceeded.
 */
export const IMAGE_MAX_WIDTH = 2000
export const IMAGE_MAX_HEIGHT = 2000

// =============================================================================
// PDF LIMITS
// =============================================================================

/**
 * Maximum raw PDF file size that fits within the API request limit after encoding.
 * The API has a 32MB total request size limit. Base64 encoding increases size by
 * ~33% (4/3), so 20MB raw → ~27MB base64, leaving room for conversation context.
 */
export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024 // 20 MB

/**
 * Maximum number of pages in a PDF accepted by the API.
 */
export const API_PDF_MAX_PAGES = 100

/**
 * Size threshold above which PDFs are extracted into page images
 * instead of being sent as base64 document blocks. This applies to
 * first-party API only; non-first-party always uses extraction.
 */
export const PDF_EXTRACT_SIZE_THRESHOLD = 3 * 1024 * 1024 // 3 MB

/**
 * Maximum PDF file size for the page extraction path. PDFs larger than
 * this are rejected to avoid processing extremely large files.
 */
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024 // 100 MB

/**
 * Max pages the Read tool will extract in a single call with the pages parameter.
 */
export const PDF_MAX_PAGES_PER_READ = 20

/**
 * PDFs with more pages than this get the reference treatment on @ mention
 * instead of being inlined into context.
 */
export const PDF_AT_MENTION_INLINE_THRESHOLD = 10

// =============================================================================
// MEDIA LIMITS
// =============================================================================

/**
 * Maximum number of media items (images + PDFs) allowed per API request.
 * The API rejects requests exceeding this limit with a confusing error.
 * We validate client-side to provide a clear error message.
 */
export const API_MAX_MEDIA_PER_REQUEST = 100

/**
 * Byte budget for base64 media (images + documents) carried in one API request.
 *
 * The token estimator scores each image/document as a flat 2000 tokens
 * (tokenEstimation.ts roughTokenCountEstimationForBlock) — correct for the
 * context WINDOW, but blind to the request BODY: a base64 image is ~1-1.5MB of
 * wire bytes. So a long session heavy in pasted images can sit far under the
 * token-based auto-compact threshold while its serialized body crosses the
 * server's size cap (32MB total on the first-party API; gateways/proxies may
 * enforce less) and is rejected with HTTP 413.
 *
 * Auto-compact consults this to shed that media proactively. Compaction's
 * summary request strips images (compact.ts), so a byte-triggered compaction
 * cannot itself 413.
 *
 * THE BINDING CONSTANT IS THE GATEWAY, NOT THE 32MB FIRST-PARTY CAP. The known
 * rayu-hosted gateway request-body ceiling is 16MB (GATEWAY_MAX_BODY_BYTES in
 * utils/hostedReferenceImage.ts, mirroring the gateway's DefaultBodyLimit) — a
 * budget ABOVE that would trigger only after the gateway already 413'd. 12MB
 * leaves ~4MB headroom for text context + JSON under the 16MB ceiling while
 * staying far below the 32MB first-party cap. Override with
 * RAYU_MEDIA_COMPACT_BUDGET_BYTES when a deployment's real cap is known.
 */
export const MEDIA_COMPACT_BUDGET_BYTES = 12 * 1024 * 1024 // 12 MB (under the 16MB gateway body cap)
