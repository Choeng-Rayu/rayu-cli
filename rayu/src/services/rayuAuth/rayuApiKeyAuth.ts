// Credential state for the Rayu API-KEY provider ('rayu').
//
// Two jobs:
//
//  1. `hasRayuCredential()` — the SYNCHRONOUS answer to "can this user talk to
//     Rayu at all?", true for either an account JWT session or a Rayu API key
//     that last checked out OK. It is called on the prompt hot path (the login
//     gate) and on the first-run gate, so it must never touch the network.
//
//  2. A small validation cache so (1) has something to answer from. The launch
//     path validates ONCE per process against the gateway and records the
//     outcome here; every later synchronous caller reads the record.
//
// WHY A CACHE AT ALL: the user requirement is that a relaunch re-checks the key,
// so validity is inherently async — but the prompt gate is sync and runs on every
// message. Without a recorded verdict the gate would either block on I/O or have
// to assume an answer.
//
// FAIL OPEN is the rule throughout. A gateway outage, an offline laptop or a
// timeout must never look like a bad key: the gateway returns 503
// "authentication temporarily unavailable" when its own database is down, and a
// CLI that treated that as "invalid" would send users off rotating credentials
// that were never the problem. An 'unavailable' result therefore LEAVES THE
// PREVIOUS VERDICT ALONE rather than overwriting it.
//
// SECURITY: the API key itself is never written here. The cache stores a
// truncated SHA-256 fingerprint, which is enough to notice the key changed and
// useless as a credential.
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getRayuConfigHomeDir } from '../../utils/envUtils.js'
import { loadRayuConfig, type RayuProvider } from '../../utils/rayuConfig.js'
import { RAYU_API_PROVIDER_ID } from '../../utils/rayuProviders.js'
import { hasRayuSession } from './rayuSession.js'
import {
  validateRayuApiKey,
  type RayuApiKeyValidation,
  type RayuCreditStatus,
} from './rayuCredits.js'

const FILE = 'rayu-apikey-state.json'

/** The verdicts worth remembering across launches. */
type CachedVerdict = 'valid' | 'invalid' | 'no-credit'

type ApiKeyState = {
  /** Truncated SHA-256 of the key the verdict belongs to. Never the key. */
  fingerprint: string
  verdict: CachedVerdict
  /** Epoch ms of the check, for staleness reporting. */
  checkedAt: number
  /** Plan name at the time of the check, for display only. */
  planName?: string
}

let cache: ApiKeyState | null = null
let loadedFromDisk = false
/** Set once the launch path has validated in THIS process. */
let validatedThisProcess = false

function statePath(): string {
  return join(getRayuConfigHomeDir(), FILE)
}

/**
 * A non-reversible, change-detecting fingerprint of a key.
 *
 * Truncated deliberately: the full digest is what the gateway stores to look keys
 * up, so keeping a full one on disk would add a lookup primitive for no benefit.
 * 16 hex chars is far more than enough to notice "the user pasted a different
 * key".
 */
function fingerprint(key: string): string {
  return createHash('sha256').update(key.trim()).digest('hex').slice(0, 16)
}

function loadFromDiskOnce(): void {
  if (loadedFromDisk) return
  loadedFromDisk = true
  try {
    const p = statePath()
    if (!existsSync(p)) return
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'))
    cache = isApiKeyState(parsed) ? parsed : null
  } catch {
    cache = null
  }
}

/**
 * Structural check on the persisted record.
 *
 * A hand-edited or half-written file must not become the authority for the
 * prompt gate: a malformed record is discarded so the next launch re-validates,
 * rather than being read as some accidental verdict.
 */
function isApiKeyState(v: unknown): v is ApiKeyState {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const s = v as Partial<ApiKeyState>
  return (
    typeof s.fingerprint === 'string' &&
    s.fingerprint.length > 0 &&
    (s.verdict === 'valid' || s.verdict === 'invalid' || s.verdict === 'no-credit') &&
    typeof s.checkedAt === 'number'
  )
}

function persist(state: ApiKeyState | null): void {
  cache = state
  loadedFromDisk = true
  try {
    const dir = getRayuConfigHomeDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const p = statePath()
    if (state) {
      writeFileSync(p, JSON.stringify(state, null, 2), { mode: 0o600 })
    } else {
      rmSync(p, { force: true })
    }
  } catch {
    // Best-effort: an unwritable config dir must not break the session. The
    // in-memory value still serves this process.
  }
}

/** The configured Rayu API-key provider, or undefined when not connected. */
export function getRayuApiKeyProvider(): RayuProvider | undefined {
  try {
    return loadRayuConfig().providers.find(p => p.id === RAYU_API_PROVIDER_ID)
  } catch {
    return undefined
  }
}

/** True when a Rayu API key is stored (says nothing about whether it works). */
export function hasRayuApiKeyConfigured(): boolean {
  return !!getRayuApiKeyProvider()?.apiKey?.trim()
}

/**
 * True when a stored Rayu API key last checked out as usable.
 *
 * A verdict recorded for a DIFFERENT key is ignored — pasting a new key
 * invalidates the old verdict rather than inheriting it.
 *
 * Unverified (no record yet) counts as usable so the very first launch after a
 * successful /connect is not blocked by a race with its own validation; the
 * launch path records a real verdict moments later, and an actually-bad key is
 * caught then.
 */
export function hasValidatedRayuApiKey(): boolean {
  const key = getRayuApiKeyProvider()?.apiKey?.trim()
  if (!key) return false
  loadFromDiskOnce()
  if (!cache || cache.fingerprint !== fingerprint(key)) return true
  return cache.verdict === 'valid'
}

/**
 * True when the user has ANY usable Rayu credential: an account session, or an
 * API key that last checked out.
 *
 * This is the first-run gate and the login gate's escape hatch. Deliberately NOT
 * `hasConfiguredProvider()`, which returns true for any openai-compatible
 * provider even with no key at all and would silently skip the Rayu first-run
 * flow for a user who has none.
 */
export function hasRayuCredential(): boolean {
  return hasRayuSession() || hasValidatedRayuApiKey()
}

/** Record a validation outcome for a key. `unavailable` is not a verdict. */
export function recordRayuApiKeyValidation(
  key: string,
  result: RayuApiKeyValidation,
): void {
  if (result.status === 'unavailable') return
  persist({
    fingerprint: fingerprint(key),
    verdict: result.status,
    checkedAt: Date.now(),
    ...(result.status !== 'invalid' && result.credits.planName
      ? { planName: result.credits.planName }
      : {}),
  })
}

/** Forget any recorded verdict (used when the provider is disconnected). */
export function clearRayuApiKeyValidation(): void {
  persist(null)
}

/**
 * The result of a (possibly cached) key check.
 *
 * `credits` is present only when this process actually talked to the gateway —
 * the disk cache stores a verdict, not a balance, so a cached answer carries no
 * live figures. Callers that want numbers should fetch them explicitly.
 */
export type RayuApiKeyCheck = {
  status: RayuApiKeyValidation['status']
  credits?: RayuCreditStatus
  /** True when the verdict came from the cache rather than a live request. */
  cached?: boolean
}

/**
 * Validate the configured Rayu API key against the gateway and record the
 * verdict. Runs at most ONCE per process — the launch path calls it, so a
 * relaunch is what re-checks a revoked or expired key, exactly as required.
 *
 * Returns null when there is no key to check. Callers should treat
 * 'unavailable' as "carry on": the previous verdict is left intact.
 */
export async function ensureRayuApiKeyValidated(
  opts: { force?: boolean } = {},
): Promise<RayuApiKeyCheck | null> {
  const key = getRayuApiKeyProvider()?.apiKey?.trim()
  if (!key) return null
  if (validatedThisProcess && !opts.force) {
    loadFromDiskOnce()
    if (cache?.fingerprint === fingerprint(key)) {
      return { status: cache.verdict, cached: true }
    }
  }
  const result = await validateRayuApiKey(key)
  validatedThisProcess = true
  recordRayuApiKeyValidation(key, result)
  return result.status === 'valid' || result.status === 'no-credit'
    ? { status: result.status, credits: result.credits }
    : { status: result.status }
}

/** Test seam: drop in-memory state so a test starts from a known baseline. */
export function _resetRayuApiKeyStateForTesting(): void {
  cache = null
  loadedFromDisk = false
  validatedThisProcess = false
}
