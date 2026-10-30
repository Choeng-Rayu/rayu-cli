// Image/video generation model catalog for the CLI — fetched from the Rayu
// provider, never hardcoded.
//
// The catalog is admin-owned data in the backend (`media_models`) and reaches the
// CLI through the gateway:
//
//     GET {gateway}/v1/models?media=all      (Authorization: Bearer <Rayu JWT>)
//
// Adding an image or video model is therefore a backend row and nothing else — no
// CLI release. See docs/media-models-contract.md for the response schema.
//
// Caching mirrors the entitlements pattern in rayuEntitlements.ts, for the same
// reason: the model PICKER renders synchronously, so the catalog has to be
// readable without awaiting a network round-trip. It is held in memory, persisted
// in the active authentication profile, and refreshed in the background with a
// cooldown so a down gateway cannot cause a request storm.
//
// OFFLINE / DIRECT-KEY MODE: when USE_RAYU_OAUTH is off or the user is not signed
// in there is no gateway to ask, and a tiny fallback catalog is used instead (see
// mediaModelsFallback.ts for why, and why it is not the source of truth).
//
// SECURITY: this is metadata only. No provider key is fetched, stored, or sent.
// Hosted generation goes through the gateway on the Rayu session; bring-your-own
// generation runs against the user's own fal.ai / Google Cloud credentials.
//
// NVIDIA image and video generation (genai, NVCF, SVD) was removed from the CLI.
// The backend can still publish rows for those backends — older CLIs read them —
// so this parser skips them quietly (see RETIRED_MEDIA_BACKENDS).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getRayuAuthConfigDir } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { fallbackMediaCatalog } from './mediaModelsFallback.js'
import {
  getSecureRayuGatewayBaseUrl,
  getValidRayuAccessToken,
  hasRayuSession,
  isUseRayuOAuthEnabled,
  readRayuSession,
} from './rayuSession.js'

export type MediaType = 'image' | 'video'
export type ImageCapability = 'generate' | 'edit'
export type VideoCapability = 'text2video' | 'image2video'
export type MediaCapability = ImageCapability | VideoCapability

/**
 * Upstream that serves a media model. The CLI picks its HTTP client from this.
 *
 * `rayu` means RAYU-HOSTED: the request goes to the Rayu gateway (Bearer Rayu
 * JWT) and the gateway holds the upstream provider key, exactly like a
 * rayu-hosted chat model. It is therefore the only backend the user needs no
 * key for. `vertex` (Imagen / Veo on the user's Google credentials) and `fal`
 * (fal.ai Kling on the user's FAL_KEY) are the bring-your-own backends.
 */
export type MediaBackend = 'vertex' | 'fal' | 'rayu'

/**
 * Request-SHAPE family. The CLI maps this to a body builder (see the
 * IMAGE_BODY_BUILDERS / VIDEO_BODY_BUILDERS maps in the two tools), which is the
 * one piece that legitimately stays client-side: it describes how a third-party
 * API wants its request, not which models exist.
 *
 * The union is deliberately NOT closed here — the gateway is free to return a
 * family a given CLI build has no builder for, and the tool then fails with a
 * clear error naming it rather than crashing.
 */
export type MediaFamily = string

/** One catalog entry, exactly as the gateway describes it. */
export interface MediaModelEntry {
  id: string
  label: string
  mediaType: MediaType
  capabilities: MediaCapability[]
  backend: MediaBackend
  family: MediaFamily
  /** Rough generation seconds, for the user-facing wait message. */
  estimatedSeconds?: number
  /**
   * Per-model upstream request defaults (e.g. `{ cfg_scale: 0, steps: 4 }`).
   * This is what lets two models share one request-shape family.
   */
  defaultParams?: Record<string, unknown>
  /** Preferred pick for its (mediaType, backend) pair. */
  isDefault?: boolean
}

export interface MediaCatalog {
  image: MediaModelEntry[]
  video: MediaModelEntry[]
  /**
   * `gateway` — the authoritative, admin-owned catalog.
   * `fallback` — no gateway available (OAuth off / signed out); minimal built-in
   *              defaults, see mediaModelsFallback.ts.
   */
  source: 'gateway' | 'fallback'
  /** Epoch ms of the successful fetch (0 for the fallback). */
  fetchedAt: number
}

interface PersistedCatalog extends MediaCatalog {
  /** Bound to the session user this cache belongs to (anti cross-user reuse). */
  userId?: number | null
}

const FILE = 'rayu-media-models.json'

/**
 * How long a fetched catalog is considered fresh. Short, because the whole point
 * of a server-owned catalog is that a model added in the dashboard shows up
 * without a release; opening `/model_image_generation` or
 * `/model_video_generation` forces an immediate refresh.
 */
const TTL_MS = 5 * 60 * 1000

/** Floor between fetch ATTEMPTS, so an unreachable gateway can't be hammered. */
const REFRESH_COOLDOWN_MS = 30_000

const MEDIA_TYPES: readonly MediaType[] = ['image', 'video']
const IMAGE_CAPABILITIES: readonly string[] = ['generate', 'edit']
const VIDEO_CAPABILITIES: readonly string[] = ['text2video', 'image2video']
const MEDIA_BACKENDS: readonly string[] = [
  'vertex',
  'fal',
  // Hosted entries synthesized by the gateway from the admin's hosted catalog:
  // `image_models` for images (family openai_images / dashscope_multimodal) AND
  // hosted video models (family dashscope_video). mediaModelsFallback.ts stays
  // BYO-only — hosted models are server-owned and must never be invented offline.
  'rayu',
]

/**
 * Backends this CLI no longer serves: NVIDIA genai (FLUX / Stable Diffusion /
 * Kontext), NVCF (Cosmos) and NVIDIA SVD.
 *
 * Rows for them are skipped QUIETLY. They are not schema drift — the backend
 * still publishes them for older CLIs — so counting them as unreadable would log
 * a "your CLI is older than the gateway" warning that is the opposite of true.
 */
const RETIRED_MEDIA_BACKENDS: ReadonlySet<string> = new Set([
  'nvidia',
  'nvcf',
  'nvidia-svd',
])

function isRetiredBackendItem(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const backend = (raw as { backend?: unknown }).backend
  return typeof backend === 'string' && RETIRED_MEDIA_BACKENDS.has(backend)
}

/**
 * Error text for a signed-in hosted user with NO usable media catalog: the
 * gateway fetch failed (so only the BYO-only built-in fallback is known) or the
 * catalog carries no hosted entry for the operation, and no BYO backend is
 * configured either. Naming the real cause beats a misleading "API key not
 * configured" from a BYO client the user never chose.
 */
export const MEDIA_CATALOG_UNAVAILABLE_MESSAGE =
  'Rayu model catalog unavailable — check your connection, then open /model_image_generation or /model_video_generation to retry'

let cache: PersistedCatalog | null = null
let loadedFromDisk = false
let fetching: Promise<MediaCatalog | null> | null = null
let lastAttempt = 0

function catalogPath(): string {
  return join(getRayuAuthConfigDir(), FILE)
}

function currentUserId(): number | null {
  return readRayuSession()?.user?.id ?? null
}

function loadFromDiskOnce(): void {
  if (loadedFromDisk) return
  loadedFromDisk = true
  try {
    const p = catalogPath()
    if (!existsSync(p)) return
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown
    cache = parseCatalogFile(parsed)
  } catch {
    cache = null
  }
}

/** Re-validate a persisted file: a hand-edited or stale-shaped cache is dropped. */
function parseCatalogFile(raw: unknown): PersistedCatalog | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Partial<PersistedCatalog>
  if (!Array.isArray(o.image) || !Array.isArray(o.video)) return null
  return {
    image: o.image.map(coerceEntry).filter((m): m is MediaModelEntry => m !== null),
    video: o.video.map(coerceEntry).filter((m): m is MediaModelEntry => m !== null),
    source: o.source === 'fallback' ? 'fallback' : 'gateway',
    fetchedAt: typeof o.fetchedAt === 'number' ? o.fetchedAt : 0,
    userId: typeof o.userId === 'number' ? o.userId : null,
  }
}

function persist(catalog: PersistedCatalog | null): void {
  try {
    const dir = getRayuAuthConfigDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const p = catalogPath()
    if (catalog) {
      writeFileSync(p, JSON.stringify(catalog, null, 2), { mode: 0o600 })
    } else {
      rmSync(p, { force: true })
    }
  } catch {
    // best-effort: a read-only home must not break media generation
  }
}

/**
 * Validate one wire item into a catalog entry, or null when it is unusable.
 *
 * The parser is PINNED to the documented shape: an item missing any field the
 * CLI needs to build a request (id, mediaType, a capability, backend, family) is
 * dropped rather than half-used, because a half-used entry fails later as an
 * opaque upstream 400. Unknown EXTRA fields are ignored, which is what makes the
 * contract forward-compatible; dropped items are reported by parseMediaModels.
 */
function coerceEntry(raw: unknown): MediaModelEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id : ''
  const mediaType = o.mediaType
  if (!id || typeof mediaType !== 'string') return null
  if (!MEDIA_TYPES.includes(mediaType as MediaType)) return null
  const valid = mediaType === 'image' ? IMAGE_CAPABILITIES : VIDEO_CAPABILITIES
  const capabilities = Array.isArray(o.capabilities)
    ? o.capabilities.filter(
        (c): c is MediaCapability => typeof c === 'string' && valid.includes(c),
      )
    : []
  if (capabilities.length === 0) return null
  const backend = typeof o.backend === 'string' ? o.backend : ''
  if (!MEDIA_BACKENDS.includes(backend)) return null
  const family = typeof o.family === 'string' ? o.family : ''
  if (!family) return null
  const entry: MediaModelEntry = {
    id,
    label: typeof o.label === 'string' && o.label ? o.label : id,
    mediaType: mediaType as MediaType,
    capabilities: [...new Set(capabilities)],
    backend: backend as MediaBackend,
    family,
    isDefault: o.default === true || o.isDefault === true,
  }
  if (typeof o.estimatedSeconds === 'number' && o.estimatedSeconds > 0) {
    entry.estimatedSeconds = Math.floor(o.estimatedSeconds)
  }
  if (o.defaultParams && typeof o.defaultParams === 'object' && !Array.isArray(o.defaultParams)) {
    entry.defaultParams = o.defaultParams as Record<string, unknown>
  }
  return entry
}

/**
 * Split a `{ object: "list", data: [...] }` gateway response into the two model
 * lists. Exported for tests and for any other consumer of the same endpoint.
 *
 * Returns the number of items that failed validation so the caller can report
 * schema drift LOUDLY (an error log) instead of the user silently seeing a
 * shorter model list than the dashboard shows, plus `chatShaped` — see below.
 */
export function parseMediaModels(payload: unknown): {
  image: MediaModelEntry[]
  video: MediaModelEntry[]
  dropped: number
  /**
   * True when the response is a CHAT model list, i.e. every item is a model but
   * none carries a `mediaType`. That is exactly what a gateway too old to know
   * the `?media=` filter returns: it ignores the unknown query parameter and
   * answers 200 with the chat catalog. Distinguishing it matters because those
   * items are not corrupt — the CLI asked the wrong server — so the fix is
   * "upgrade the gateway", not "update the CLI", and the response must NOT be
   * cached as an authoritative empty media catalog.
   */
  chatShaped: boolean
} {
  const data =
    payload && typeof payload === 'object'
      ? (payload as { data?: unknown }).data
      : undefined
  if (!Array.isArray(data)) {
    return { image: [], video: [], dropped: 0, chatShaped: false }
  }
  const image: MediaModelEntry[] = []
  const video: MediaModelEntry[] = []
  let dropped = 0
  let withMediaType = 0
  for (const raw of data) {
    if (
      raw &&
      typeof raw === 'object' &&
      typeof (raw as { mediaType?: unknown }).mediaType === 'string'
    ) {
      withMediaType++
    }
    // A retired backend is a known, deliberate omission — not an unreadable item.
    if (isRetiredBackendItem(raw)) continue
    const entry = coerceEntry(raw)
    if (!entry) {
      dropped++
      continue
    }
    if (entry.mediaType === 'image') image.push(entry)
    else video.push(entry)
  }
  return {
    image,
    video,
    dropped,
    chatShaped: data.length > 0 && withMediaType === 0,
  }
}

/** True when the cached catalog is missing, not from the gateway, or past TTL. */
function isStale(c: PersistedCatalog | null): boolean {
  if (!c || c.source !== 'gateway') return true
  return Date.now() - c.fetchedAt > TTL_MS
}

/**
 * The cache, if it belongs to the CURRENT user.
 *
 * A catalog minted for a signed-in user is discarded once that user is no longer
 * the session user — including when there is no session at all (token expired, or
 * a different account signed in). Plan-filtered model lists must not outlive the
 * session they were fetched for.
 *
 * An EMPTY gateway catalog is returned as-is, not treated as "no cache": an admin
 * who disabled every media model has genuinely disabled the feature, and falling
 * back to the CLI's built-ins would silently override that decision.
 */
function readUsableCache(): PersistedCatalog | null {
  loadFromDiskOnce()
  if (cache && cache.userId != null && currentUserId() !== cache.userId) {
    cache = null
  }
  return cache
}

/**
 * The catalog as currently known — SYNCHRONOUS, for the model pickers and other
 * render paths. Kicks a rate-limited background refresh when the cache is stale,
 * and falls back to the built-in list only when NOTHING has been fetched and
 * there is no gateway to ask (OAuth off / signed out).
 *
 * A previously fetched catalog is preferred over the fallback even when it is
 * stale: the last thing the server said is closer to the truth than the CLI's
 * built-in defaults.
 */
export function getCachedMediaModels(): MediaCatalog {
  const known = readUsableCache()
  if (
    isUseRayuOAuthEnabled() &&
    hasRayuSession() &&
    isStale(known) &&
    Date.now() - lastAttempt > REFRESH_COOLDOWN_MS
  ) {
    void refreshMediaModels()
  }
  return known ? stripUserId(known) : fallbackMediaCatalog()
}

/**
 * The catalog, awaiting a fetch when needed — for the TOOLS, which run in async
 * context and must not offer a model the server no longer has.
 *
 * A fetch failure is not fatal: the last good cache is kept, and the built-in
 * fallback is used only when nothing has ever been fetched.
 */
export async function ensureMediaModels(): Promise<MediaCatalog> {
  const known = readUsableCache()
  if (isUseRayuOAuthEnabled() && hasRayuSession() && isStale(known)) {
    const fetched = await refreshMediaModels()
    if (fetched) return fetched
  }
  const after = readUsableCache()
  return after ? stripUserId(after) : fallbackMediaCatalog()
}

/**
 * A copy without the internal user binding, safe to hand to callers. The arrays
 * are copied too: the cache is process-wide and long-lived, so a consumer that
 * sorts or splices its "own" list must not corrupt what everyone else reads.
 */
function stripUserId(c: PersistedCatalog): MediaCatalog {
  return {
    image: c.image.slice(),
    video: c.video.slice(),
    source: c.source,
    fetchedAt: c.fetchedAt,
  }
}

/**
 * Fetch the catalog from the gateway and update the cache. Never throws.
 *
 * Concurrent callers share ONE request (the tool and the picker can both ask at
 * once), and `force` bypasses the attempt cooldown for an explicit user refresh.
 */
export async function refreshMediaModels(
  force = false,
): Promise<MediaCatalog | null> {
  if (!isUseRayuOAuthEnabled() || !hasRayuSession()) return null
  if (fetching) return fetching
  if (!force && Date.now() - lastAttempt < REFRESH_COOLDOWN_MS) {
    const known = readUsableCache()
    return known ? stripUserId(known) : null
  }
  lastAttempt = Date.now()
  fetching = fetchCatalog()
  try {
    return await fetching
  } finally {
    fetching = null
  }
}

/**
 * Report a catalog problem ONCE per distinct message. Without the guard the
 * 5-minute refresh would append the same line to the error log forever, which
 * buries whatever the user is actually debugging.
 */
let lastReported = ''
function reportOnce(message: string): void {
  if (lastReported === message) return
  lastReported = message
  logError(new Error(message))
}

async function fetchCatalog(): Promise<MediaCatalog | null> {
  try {
    const token = await getValidRayuAccessToken()
    if (!token) return null
    const res = await (globalThis.fetch as typeof fetch)(
      `${getSecureRayuGatewayBaseUrl()}/v1/models?media=all`,
      { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
    )
    if (!res.ok) {
      if (res.status === 400) {
        // A gateway that KNOWS the filter but rejected this value. Should be
        // unreachable (media=all is valid), so it means the contract moved.
        reportOnce(
          'Rayu gateway rejected GET /v1/models?media=all (400). The media model ' +
            'catalog contract has changed — update the CLI (npm i -g @rayu-dev/rayu-cli).',
        )
      }
      return null
    }
    const payload: unknown = await res.json()
    const { image, video, dropped, chatShaped } = parseMediaModels(payload)

    // A gateway too old to know `?media=` ignores it and returns the CHAT
    // catalog. Those items are not corrupt, so this is NOT schema drift and must
    // NOT be cached as "the admin configured no media models" — report the real
    // cause and leave the CLI on its built-in defaults.
    if (chatShaped) {
      reportOnce(
        'Rayu gateway does not support the media model catalog (GET /v1/models?media=all ' +
          'returned the chat model list). Upgrade rayu-gateway; image/video generation is ' +
          'using the CLI built-in defaults meanwhile.',
      )
      return null
    }
    if (dropped > 0) {
      // Loud, not silent: a shape the CLI cannot read means the user sees fewer
      // models than the dashboard shows, which is otherwise unexplainable.
      reportOnce(
        `Rayu media model catalog: ${dropped} entr${dropped === 1 ? 'y' : 'ies'} ` +
          `could not be read (unexpected shape) and were skipped. The CLI may be ` +
          `older than the gateway — update it to see every model.`,
      )
    }
    // An EMPTY list here is a real answer — the admin has no media models enabled
    // (or the caller's plan allows none) — so it IS cached. Falling back to the
    // built-ins would silently re-enable models an admin deliberately removed.
    const next: PersistedCatalog = {
      image,
      video,
      source: 'gateway',
      fetchedAt: Date.now(),
      userId: currentUserId(),
    }
    cache = next
    loadedFromDisk = true
    persist(next)
    // Clear the report guard only on a CLEAN fetch. Clearing it after a fetch that
    // just reported dropped entries would let that same warning re-log on every
    // 5-minute refresh — the spam reportOnce exists to prevent. A later clean
    // fetch re-arms it, so a problem that comes back is reported again.
    if (dropped === 0) lastReported = ''
    return stripUserId(next)
  } catch (e) {
    // A gateway URL that would ship the JWT in the clear (remote plaintext
    // http, embedded credentials, non-http scheme) throws HERE, before the
    // request. That is a configuration fault the user can fix, not transient
    // noise — report it once so it does not vanish into the offline fallback.
    if (e instanceof Error && e.message.includes('RAYU_GATEWAY_URL')) {
      reportOnce(e.message)
    }
    // Offline / DNS / TLS — keep the last good cache.
    return null
  }
}

/** Forget the cached catalog (call on logout: plan-restricted models must go). */
export function clearMediaModels(): void {
  cache = null
  loadedFromDisk = true
  lastAttempt = 0
  lastReported = ''
  persist(null)
}

/**
 * True when a video catalog entry accepts a reference image, i.e. its
 * capabilities include `image2video`. The hosted gateway maps that capability
 * to an `input.media:[{type:"reference_image"}]` upstream request, so this is
 * the gate for sending `input_image` to a hosted model.
 */
export function isReferenceCapable(entry: MediaModelEntry): boolean {
  return entry.capabilities.includes('image2video')
}

/**
 * True when an image catalog entry accepts an input image for editing, i.e.
 * its capabilities include `edit`. The hosted gateway maps that capability to
 * an image-to-image upstream request (families like `dashscope_multimodal`
 * advertise it; `openai_images` entries stay generate-only), so this is the
 * gate for sending `input_image` to a hosted image model.
 */
export function isEditCapable(entry: MediaModelEntry): boolean {
  return entry.capabilities.includes('edit')
}

/** All models for a media type, in server-defined order (picker display). */
export function mediaModelsFor(
  catalog: MediaCatalog,
  mediaType: MediaType,
): MediaModelEntry[] {
  return mediaType === 'image' ? catalog.image : catalog.video
}

// --- Test hooks -------------------------------------------------------------

export function _setMediaModelsForTesting(catalog: MediaCatalog | null): void {
  cache = catalog ? { ...catalog, userId: currentUserId() } : null
  loadedFromDisk = true
  // Suppress the background refresh so a test never reaches the network.
  lastAttempt = Date.now()
}

export function _resetMediaModelsForTesting(): void {
  cache = null
  loadedFromDisk = false
  fetching = null
  lastAttempt = 0
  lastReported = ''
}
