/**
 * Minimal module for firing macOS keychain reads in parallel with main.tsx
 * module evaluation, same pattern as startMdmRawRead() in settings/mdm/rawRead.ts.
 *
 * isRemoteManagedSettingsEligible() reads two separate keychain entries
 * SEQUENTIALLY via sync execSync during applySafeConfigEnvironmentVariables():
 *   1. "Rayu-credentials" (OAuth tokens)  — ~32ms
 *   2. "Rayu" (legacy API key)            — ~33ms
 * Sequential cost: ~65ms on every macOS startup.
 *
 * Firing both here lets the subprocesses run in parallel with the ~65ms of
 * main.tsx imports. ensureKeychainPrefetchCompleted() is awaited alongside
 * ensureMdmSettingsLoaded() in main.tsx preAction — nearly free since the
 * subprocesses finish during import evaluation. Sync read() and
 * getApiKeyFromConfigOrMacOSKeychain() then hit their caches.
 *
 * Imports stay minimal: child_process + macOsKeychainHelpers.ts (NOT
 * macOsKeychainStorage.ts — that pulls in execa → human-signals →
 * cross-spawn, ~58ms of synchronous module init). The helpers file's own
 * import chain (envUtils, oauth constants, crypto) is already evaluated by
 * startupProfiler.ts at main.tsx:5, so no new module-init cost lands here.
 */

import { execFile } from 'child_process'
import { isBareMode } from '../envUtils.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getMacOsKeychainStorageServiceName,
  getUsername,
  KEYCHAIN_LOCK_CHECK_TIMEOUT_MS,
  KEYCHAIN_LOCKED_EXIT_CODE,
  primeKeychainCacheFromPrefetch,
} from './macOsKeychainHelpers.js'

// `security` on an unlocked, ACL-clear keychain answers in well under a
// second. A read still running after this bound is waiting on an interactive
// prompt (unlock/ACL consent) — there is no value in waiting longer, and the
// sync fallback path is bounded by the same duration.
const KEYCHAIN_PREFETCH_TIMEOUT_MS = 5_000

// Shared with auth.ts getApiKeyFromConfigOrMacOSKeychain() so it can skip its
// sync spawn when the prefetch already landed. Distinguishing "not started" (null)
// from "completed with no key" ({ stdout: null }) lets the sync reader only
// trust a completed prefetch.
let legacyApiKeyPrefetch: { stdout: string | null } | null = null

let prefetchPromise: Promise<void> | null = null

type SpawnResult = { stdout: string | null; timedOut: boolean }

function spawnSecurity(serviceName: string): Promise<SpawnResult> {
  return new Promise(resolve => {
    execFile(
      'security',
      ['find-generic-password', '-a', getUsername(), '-w', '-s', serviceName],
      { encoding: 'utf-8', timeout: KEYCHAIN_PREFETCH_TIMEOUT_MS },
      (err, stdout) => {
        // Exit 44 (entry not found) is a valid "no key" result and safe to
        // prime as null. But timeout (err.killed) means the keychain MAY have
        // a key we couldn't fetch — don't prime, let sync spawn retry.
        // biome-ignore lint/nursery/noFloatingPromises: resolve() is not a floating promise
        resolve({
          stdout: err ? null : stdout?.trim() || null,
          timedOut: Boolean(err && 'killed' in err && err.killed),
        })
      },
    )
  })
}

/**
 * Probe whether the login keychain is locked (`security show-keychain-info`
 * exit code 36). Cheap and non-interactive — it never triggers a prompt.
 * Fails OPEN (false) on any error/timeout: worst case the password reads
 * proceed and their own bounded timeout applies.
 */
function spawnShowKeychainInfo(): Promise<boolean> {
  return new Promise(resolve => {
    execFile(
      'security',
      ['show-keychain-info'],
      { encoding: 'utf-8', timeout: KEYCHAIN_LOCK_CHECK_TIMEOUT_MS },
      err => {
        // biome-ignore lint/nursery/noFloatingPromises: resolve() is not a floating promise
        resolve(
          err != null &&
            'code' in err &&
            err.code === KEYCHAIN_LOCKED_EXIT_CODE,
        )
      },
    )
  })
}

/**
 * Fire both keychain reads in parallel. Called at main.tsx top-level
 * immediately after startMdmRawRead(). Non-darwin is a no-op.
 */
export function startKeychainPrefetch(): void {
  if (process.platform !== 'darwin' || prefetchPromise || isBareMode()) return

  // Fire all three subprocesses immediately (non-blocking). They run in
  // parallel with each other AND with main.tsx imports. The await happens
  // later via ensureKeychainPrefetchCompleted().
  const oauthSpawn = spawnSecurity(
    getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX),
  )
  const legacySpawn = spawnSecurity(getMacOsKeychainStorageServiceName())
  const lockedSpawn = spawnShowKeychainInfo()

  prefetchPromise = (async (): Promise<void> => {
    // LOCKED login keychain (SSH sessions, lock-on-sleep): the password reads
    // above are blocking on an interactive unlock prompt the user may never
    // see. Waiting them out stalled `rayu` at launch on macOS. Resolve
    // immediately without priming — the sync read path performs the same lock
    // check and skips its own spawn, so startup proceeds on the plaintext
    // fallback instead of freezing.
    if (await lockedSpawn) return
    const [oauth, legacy] = await Promise.all([oauthSpawn, legacySpawn])
    // Timed-out prefetch: don't prime. Sync read/spawn will retry with its
    // own (same-length) timeout. Priming null here would shadow a key that
    // the sync path might successfully fetch.
    if (!oauth.timedOut) primeKeychainCacheFromPrefetch(oauth.stdout)
    if (!legacy.timedOut) legacyApiKeyPrefetch = { stdout: legacy.stdout }
  })()
}

/**
 * Await prefetch completion. Called in main.tsx preAction alongside
 * ensureMdmSettingsLoaded() — nearly free since subprocesses finish during
 * the ~65ms of main.tsx imports. Resolves immediately on non-darwin.
 */
export async function ensureKeychainPrefetchCompleted(): Promise<void> {
  if (prefetchPromise) await prefetchPromise
}

/**
 * Consumed by getApiKeyFromConfigOrMacOSKeychain() in auth.ts before it
 * falls through to sync execSync. Returns null if prefetch hasn't completed.
 */
export function getLegacyApiKeyPrefetchResult(): {
  stdout: string | null
} | null {
  return legacyApiKeyPrefetch
}

/**
 * Clear prefetch result. Called alongside getApiKeyFromConfigOrMacOSKeychain
 * cache invalidation so a stale prefetch doesn't shadow a fresh write.
 */
export function clearLegacyApiKeyPrefetch(): void {
  legacyApiKeyPrefetch = null
}
