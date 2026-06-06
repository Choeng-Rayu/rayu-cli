import chalk from 'chalk'
import { exec } from 'child_process'
import { execa } from 'execa'
import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getModelStrings } from 'src/utils/model/modelStrings.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { getActiveProvider, getRayuApiKey } from 'src/utils/rayuConfig.js'
import {
  getIsNonInteractiveSession,
  preferThirdPartyAuthentication,
} from '../bootstrap/state.js'
import {
  getMockSubscriptionType,
  shouldUseMockSubscription,
} from '../services/mockRateLimits.js'
import type { OAuthTokens, SubscriptionType } from '../services/oauth/types.js'
import {
  getApiKeyFromFileDescriptor,
  getOAuthTokenFromFileDescriptor,
} from './authFileDescriptor.js'
import {
  maybeRemoveApiKeyFromMacOSKeychainThrows,
  normalizeApiKeyForConfig,
} from './authPortable.js'
import {
  checkStsCallerIdentity,
  clearAwsIniCache,
  isValidAwsStsOutput,
} from './aws.js'
import { AwsAuthStatusManager } from './awsAuthStatusManager.js'
import { clearBetasCaches } from './betas.js'
import {
  type AccountInfo,
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  saveGlobalConfig,
} from './config.js'
import { logAntError, logForDebugging } from './debug.js'
import {
  getRayuConfigHomeDir,
  isBareMode,
  isEnvTruthy,
  isRunningOnHomespace,
} from './envUtils.js'
import { errorMessage } from './errors.js'
import { execSyncWithDefaults_DEPRECATED } from './execFileNoThrow.js'
import { logError } from './log.js'
import { memoizeWithTTLAsync } from './memoize.js'
import { getSecureStorage } from './secureStorage/index.js'
import {
  clearLegacyApiKeyPrefetch,
  getLegacyApiKeyPrefetchResult,
} from './secureStorage/keychainPrefetch.js'
import {
  clearKeychainCache,
  getMacOsKeychainStorageServiceName,
  getUsername,
} from './secureStorage/macOsKeychainHelpers.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from './settings/settings.js'
import { sleep } from './sleep.js'
import { jsonParse } from './slowOperations.js'
import { clearToolSchemaCache } from './toolSchemaCache.js'

/** Default TTL for API key helper cache in milliseconds (5 minutes) */
const DEFAULT_API_KEY_HELPER_TTL = 5 * 60 * 1000

/**
 * Managed Rayu contexts should never fall back to the user's
 * ~/.rayu/settings.json API-key config (apiKeyHelper,
 * env.RAYU_ANTHROPIC_API_KEY, env.RAYU_ANTHROPIC_AUTH_TOKEN). Those settings exist for
 * the user's terminal CLI, not managed sessions. Without this guard, a user
 * who runs `rayu` in their terminal with an API key sees every managed session
 * also use that key.
 */
function isManagedOAuthContext(): boolean {
  return (
    isEnvTruthy(process.env.RAYU_REMOTE) ||
    process.env.RAYU_ENTRYPOINT === 'rayu-desktop'
  )
}

/** Whether we are supporting direct 1P auth. */
// this code is closely related to getAuthTokenSource
export function isAnthropicAuthEnabled(): boolean {
  // Rayu: if a non-anthropic provider is active, Anthropic auth is not needed.
  try {
    const kind = getActiveProvider()?.kind
    if (kind && kind !== 'anthropic') return false
  } catch {
    // fall through
  }

  return !!getRayuAnthropicApiKey() || !!process.env.RAYU_ANTHROPIC_API_KEY
}

/** Where the auth token is being sourced from, if any. */
// this code is closely related to isAnthropicAuthEnabled
export function getAuthTokenSource() {
  return { source: 'none' as const, hasToken: false }
}

export type ApiKeySource =
  | 'RAYU_ANTHROPIC_API_KEY'
  | 'rayuProvider'
  | 'none'

/**
 * Read a first-party Anthropic API key from the Rayu provider store.
 * Returns the key only when the active/anthropic provider is the anthropic kind.
 */
function getRayuAnthropicApiKey(): string | null {
  try {
    const active = getActiveProvider()
    if (active && active.kind === 'anthropic') {
      return active.apiKey ?? null
    }
    // Fall back to a provider explicitly registered under the 'anthropic' id.
    return getRayuApiKey('anthropic')
  } catch {
    return null
  }
}

export function getAnthropicApiKey(): null | string {
  const { key } = getAnthropicApiKeyWithSource()
  return key
}

export function hasAnthropicApiKeyAuth(): boolean {
  const { key, source } = getAnthropicApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  })
  return key !== null && source !== 'none'
}

export function getAnthropicApiKeyWithSource(
  _opts: { skipRetrievingKeyFromApiKeyHelper?: boolean } = {},
): {
  key: null | string
  source: ApiKeySource
} {
  if (process.env.RAYU_ANTHROPIC_API_KEY) {
    return {
      key: process.env.RAYU_ANTHROPIC_API_KEY,
      source: 'RAYU_ANTHROPIC_API_KEY',
    }
  }

  const rayuKey = getRayuAnthropicApiKey()
  if (rayuKey) {
    return { key: rayuKey, source: 'rayuProvider' }
  }

  return {
    key: null,
    source: 'none',
  }
}

/**
 * Get the configured apiKeyHelper from settings.
 * In bare mode, only the --settings flag source is consulted — apiKeyHelper
 * from ~/.rayu/settings.json or project settings is ignored.
 */
export function getConfiguredApiKeyHelper(): string | undefined {
  if (isBareMode()) {
    return getSettingsForSource('flagSettings')?.apiKeyHelper
  }
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.apiKeyHelper
}

/**
 * Check if the configured apiKeyHelper comes from project settings (projectSettings or localSettings)
 */
function isApiKeyHelperFromProjectOrLocalSettings(): boolean {
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (!apiKeyHelper) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.apiKeyHelper === apiKeyHelper ||
    localSettings?.apiKeyHelper === apiKeyHelper
  )
}

/**
 * Get the configured awsAuthRefresh from settings
 */
function getConfiguredAwsAuthRefresh(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.awsAuthRefresh
}

/**
 * Check if the configured awsAuthRefresh comes from project settings
 */
export function isAwsAuthRefreshFromProjectSettings(): boolean {
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()
  if (!awsAuthRefresh) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.awsAuthRefresh === awsAuthRefresh ||
    localSettings?.awsAuthRefresh === awsAuthRefresh
  )
}

/**
 * Get the configured awsCredentialExport from settings
 */
function getConfiguredAwsCredentialExport(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.awsCredentialExport
}

/**
 * Check if the configured awsCredentialExport comes from project settings
 */
export function isAwsCredentialExportFromProjectSettings(): boolean {
  const awsCredentialExport = getConfiguredAwsCredentialExport()
  if (!awsCredentialExport) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.awsCredentialExport === awsCredentialExport ||
    localSettings?.awsCredentialExport === awsCredentialExport
  )
}

/**
 * Calculate TTL in milliseconds for the API key helper cache
 * Uses RAYU_API_KEY_HELPER_TTL_MS env var if set and valid,
 * otherwise defaults to 5 minutes
 */
export function calculateApiKeyHelperTTL(): number {
  const envTtl = process.env.RAYU_API_KEY_HELPER_TTL_MS

  if (envTtl) {
    const parsed = parseInt(envTtl, 10)
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed
    }
    logForDebugging(
      `Found RAYU_API_KEY_HELPER_TTL_MS env var, but it was not a valid number. Got ${envTtl}`,
      { level: 'error' },
    )
  }

  return DEFAULT_API_KEY_HELPER_TTL
}

// Async API key helper with sync cache for non-blocking reads.
// Epoch bumps on clearApiKeyHelperCache() — orphaned executions check their
// captured epoch before touching module state so a settings-change or 401-retry
// mid-flight can't clobber the newer cache/inflight.
let _apiKeyHelperCache: { value: string; timestamp: number } | null = null
let _apiKeyHelperInflight: {
  promise: Promise<string | null>
  // Only set on cold launches (user is waiting); null for SWR background refreshes.
  startedAt: number | null
} | null = null
let _apiKeyHelperEpoch = 0

export function getApiKeyHelperElapsedMs(): number {
  const startedAt = _apiKeyHelperInflight?.startedAt
  return startedAt ? Date.now() - startedAt : 0
}

export async function getApiKeyFromApiKeyHelper(
  isNonInteractiveSession: boolean,
): Promise<string | null> {
  if (!getConfiguredApiKeyHelper()) return null
  const ttl = calculateApiKeyHelperTTL()
  if (_apiKeyHelperCache) {
    if (Date.now() - _apiKeyHelperCache.timestamp < ttl) {
      return _apiKeyHelperCache.value
    }
    // Stale — return stale value now, refresh in the background.
    // `??=` banned here by eslint no-nullish-assign-object-call (bun bug).
    if (!_apiKeyHelperInflight) {
      _apiKeyHelperInflight = {
        promise: _runAndCache(
          isNonInteractiveSession,
          false,
          _apiKeyHelperEpoch,
        ),
        startedAt: null,
      }
    }
    return _apiKeyHelperCache.value
  }
  // Cold cache — deduplicate concurrent calls
  if (_apiKeyHelperInflight) return _apiKeyHelperInflight.promise
  _apiKeyHelperInflight = {
    promise: _runAndCache(isNonInteractiveSession, true, _apiKeyHelperEpoch),
    startedAt: Date.now(),
  }
  return _apiKeyHelperInflight.promise
}

async function _runAndCache(
  isNonInteractiveSession: boolean,
  isCold: boolean,
  epoch: number,
): Promise<string | null> {
  try {
    const value = await _executeApiKeyHelper(isNonInteractiveSession)
    if (epoch !== _apiKeyHelperEpoch) return value
    if (value !== null) {
      _apiKeyHelperCache = { value, timestamp: Date.now() }
    }
    return value
  } catch (e) {
    if (epoch !== _apiKeyHelperEpoch) return ' '
    const detail = e instanceof Error ? e.message : String(e)
    // biome-ignore lint/suspicious/noConsole: user-configured script failed; must be visible without --debug
    console.error(chalk.red(`apiKeyHelper failed: ${detail}`))
    logForDebugging(`Error getting API key from apiKeyHelper: ${detail}`, {
      level: 'error',
    })
    // SWR path: a transient failure shouldn't replace a working key with
    // the ' ' sentinel — keep serving the stale value and bump timestamp
    // so we don't hammer-retry every call.
    if (!isCold && _apiKeyHelperCache && _apiKeyHelperCache.value !== ' ') {
      _apiKeyHelperCache = { ..._apiKeyHelperCache, timestamp: Date.now() }
      return _apiKeyHelperCache.value
    }
    // Cold cache or prior error — cache ' ' so callers don't fall back to OAuth
    _apiKeyHelperCache = { value: ' ', timestamp: Date.now() }
    return ' '
  } finally {
    if (epoch === _apiKeyHelperEpoch) {
      _apiKeyHelperInflight = null
    }
  }
}

async function _executeApiKeyHelper(
  isNonInteractiveSession: boolean,
): Promise<string | null> {
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (!apiKeyHelper) {
    return null
  }

  if (isApiKeyHelperFromProjectOrLocalSettings()) {
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !isNonInteractiveSession) {
      const error = new Error(
        `Security: apiKeyHelper executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('apiKeyHelper invoked before trust check', error)
      logEvent('tengu_apiKeyHelper_missing_trust11', {})
      return null
    }
  }

  const result = await execa(apiKeyHelper, {
    shell: true,
    timeout: 10 * 60 * 1000,
    reject: false,
  })
  if (result.failed) {
    // reject:false — execa resolves on exit≠0/timeout, stderr is on result
    const why = result.timedOut ? 'timed out' : `exited ${result.exitCode}`
    const stderr = result.stderr?.trim()
    throw new Error(stderr ? `${why}: ${stderr}` : why)
  }
  const stdout = result.stdout?.trim()
  if (!stdout) {
    throw new Error('did not return a value')
  }
  return stdout
}

/**
 * Sync cache reader — returns the last fetched apiKeyHelper value without executing.
 * Returns stale values to match SWR semantics of the async reader.
 * Returns null only if the async fetch hasn't completed yet.
 */
export function getApiKeyFromApiKeyHelperCached(): string | null {
  return _apiKeyHelperCache?.value ?? null
}

export function clearApiKeyHelperCache(): void {
  _apiKeyHelperEpoch++
  _apiKeyHelperCache = null
  _apiKeyHelperInflight = null
}

export function prefetchApiKeyFromApiKeyHelperIfSafe(
  isNonInteractiveSession: boolean,
): void {
  // Skip if trust not yet accepted — the inner _executeApiKeyHelper check
  // would catch this too, but would fire a false-positive analytics event.
  if (
    isApiKeyHelperFromProjectOrLocalSettings() &&
    !checkHasTrustDialogAccepted()
  ) {
    return
  }
  void getApiKeyFromApiKeyHelper(isNonInteractiveSession)
}

/** Default STS credentials are one hour. We manually manage invalidation, so not too worried about this being accurate. */
const DEFAULT_AWS_STS_TTL = 60 * 60 * 1000

/**
 * Run awsAuthRefresh to perform interactive authentication (e.g., aws sso login)
 * Streams output in real-time for user visibility
 */
async function runAwsAuthRefresh(): Promise<boolean> {
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()

  if (!awsAuthRefresh) {
    return false // Not configured, treat as success
  }

  // SECURITY: Check if awsAuthRefresh is from project settings
  if (isAwsAuthRefreshFromProjectSettings()) {
    // Check if trust has been established for this project
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        `Security: awsAuthRefresh executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('awsAuthRefresh invoked before trust check', error)
      logEvent('tengu_awsAuthRefresh_missing_trust', {})
      return false
    }
  }

  try {
    logForDebugging('Fetching AWS caller identity for AWS auth refresh command')
    await checkStsCallerIdentity()
    logForDebugging(
      'Fetched AWS caller identity, skipping AWS auth refresh command',
    )
    return false
  } catch {
    // only actually do the refresh if caller-identity calls
    return refreshAwsAuth(awsAuthRefresh)
  }
}

// Timeout for AWS auth refresh command (3 minutes).
// Long enough for browser-based SSO flows, short enough to prevent indefinite hangs.
const AWS_AUTH_REFRESH_TIMEOUT_MS = 3 * 60 * 1000

export function refreshAwsAuth(awsAuthRefresh: string): Promise<boolean> {
  logForDebugging('Running AWS auth refresh command')
  // Start tracking authentication status
  const authStatusManager = AwsAuthStatusManager.getInstance()
  authStatusManager.startAuthentication()

  return new Promise(resolve => {
    const refreshProc = exec(awsAuthRefresh, {
      timeout: AWS_AUTH_REFRESH_TIMEOUT_MS,
    })
    refreshProc.stdout!.on('data', data => {
      const output = data.toString().trim()
      if (output) {
        // Add output to status manager for UI display
        authStatusManager.addOutput(output)
        // Also log for debugging
        logForDebugging(output, { level: 'debug' })
      }
    })

    refreshProc.stderr!.on('data', data => {
      const error = data.toString().trim()
      if (error) {
        authStatusManager.setError(error)
        logForDebugging(error, { level: 'error' })
      }
    })

    refreshProc.on('close', (code, signal) => {
      if (code === 0) {
        logForDebugging('AWS auth refresh completed successfully')
        authStatusManager.endAuthentication(true)
        void resolve(true)
      } else {
        const timedOut = signal === 'SIGTERM'
        const message = timedOut
          ? chalk.red(
              'AWS auth refresh timed out after 3 minutes. Run your auth command manually in a separate terminal.',
            )
          : chalk.red(
              'Error running awsAuthRefresh (in settings or ~/.rayu/settings.json):',
            )
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message)
        authStatusManager.endAuthentication(false)
        void resolve(false)
      }
    })
  })
}

/**
 * Run awsCredentialExport to get credentials and set environment variables
 * Expects JSON output containing AWS credentials
 */
async function getAwsCredsFromCredentialExport(): Promise<{
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
} | null> {
  const awsCredentialExport = getConfiguredAwsCredentialExport()

  if (!awsCredentialExport) {
    return null
  }

  // SECURITY: Check if awsCredentialExport is from project settings
  if (isAwsCredentialExportFromProjectSettings()) {
    // Check if trust has been established for this project
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        `Security: awsCredentialExport executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('awsCredentialExport invoked before trust check', error)
      logEvent('tengu_awsCredentialExport_missing_trust', {})
      return null
    }
  }

  try {
    logForDebugging(
      'Fetching AWS caller identity for credential export command',
    )
    await checkStsCallerIdentity()
    logForDebugging(
      'Fetched AWS caller identity, skipping AWS credential export command',
    )
    return null
  } catch {
    // only actually do the export if caller-identity calls
    try {
      logForDebugging('Running AWS credential export command')
      const result = await execa(awsCredentialExport, {
        shell: true,
        reject: false,
      })
      if (result.exitCode !== 0 || !result.stdout) {
        throw new Error('awsCredentialExport did not return a valid value')
      }

      // Parse the JSON output from aws sts commands
      const awsOutput = jsonParse(result.stdout.trim())

      if (!isValidAwsStsOutput(awsOutput)) {
        throw new Error(
          'awsCredentialExport did not return valid AWS STS output structure',
        )
      }

      logForDebugging('AWS credentials retrieved from awsCredentialExport')
      return {
        accessKeyId: awsOutput.Credentials.AccessKeyId,
        secretAccessKey: awsOutput.Credentials.SecretAccessKey,
        sessionToken: awsOutput.Credentials.SessionToken,
      }
    } catch (e) {
      const message = chalk.red(
        'Error getting AWS credentials from awsCredentialExport (in settings or ~/.rayu/settings.json):',
      )
      if (e instanceof Error) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message, e.message)
      } else {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message, e)
      }
      return null
    }
  }
}

/**
 * Refresh AWS authentication and get credentials with cache clearing
 * This combines runAwsAuthRefresh, getAwsCredsFromCredentialExport, and clearAwsIniCache
 * to ensure fresh credentials are always used
 */
export const refreshAndGetAwsCredentials = memoizeWithTTLAsync(
  async (): Promise<{
    accessKeyId: string
    secretAccessKey: string
    sessionToken: string
  } | null> => {
    // First run auth refresh if needed
    const refreshed = await runAwsAuthRefresh()

    // Get credentials from export
    const credentials = await getAwsCredsFromCredentialExport()

    // Clear AWS INI cache to ensure fresh credentials are used
    if (refreshed || credentials) {
      await clearAwsIniCache()
    }

    return credentials
  },
  DEFAULT_AWS_STS_TTL,
)

export function clearAwsCredentialsCache(): void {
  refreshAndGetAwsCredentials.cache.clear()
}

/**
 * Get the configured gcpAuthRefresh from settings
 */
function getConfiguredGcpAuthRefresh(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.gcpAuthRefresh
}

/**
 * Check if the configured gcpAuthRefresh comes from project settings
 */
export function isGcpAuthRefreshFromProjectSettings(): boolean {
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()
  if (!gcpAuthRefresh) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.gcpAuthRefresh === gcpAuthRefresh ||
    localSettings?.gcpAuthRefresh === gcpAuthRefresh
  )
}

/** Short timeout for the GCP credentials probe. Without this, when no local
 *  credential source exists (no ADC file, no env var), google-auth-library falls
 *  through to the GCE metadata server which hangs ~12s outside GCP. */
const GCP_CREDENTIALS_CHECK_TIMEOUT_MS = 5_000

/**
 * Check if GCP credentials are currently valid by attempting to get an access token.
 * This uses the same authentication chain that the Vertex SDK uses.
 */
export async function checkGcpCredentialsValid(): Promise<boolean> {
  try {
    // Dynamically import to avoid loading google-auth-library unnecessarily
    const { GoogleAuth } = await import('google-auth-library')
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    const probe = (async () => {
      const client = await auth.getClient()
      await client.getAccessToken()
    })()
    const timeout = sleep(GCP_CREDENTIALS_CHECK_TIMEOUT_MS).then(() => {
      throw new GcpCredentialsTimeoutError('GCP credentials check timed out')
    })
    await Promise.race([probe, timeout])
    return true
  } catch {
    return false
  }
}

/** Default GCP credential TTL - 1 hour to match typical ADC token lifetime */
const DEFAULT_GCP_CREDENTIAL_TTL = 60 * 60 * 1000

/**
 * Run gcpAuthRefresh to perform interactive authentication (e.g., gcloud auth application-default login)
 * Streams output in real-time for user visibility
 */
async function runGcpAuthRefresh(): Promise<boolean> {
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()

  if (!gcpAuthRefresh) {
    return false // Not configured, treat as success
  }

  // SECURITY: Check if gcpAuthRefresh is from project settings
  if (isGcpAuthRefreshFromProjectSettings()) {
    // Check if trust has been established for this project
    // Pass true to indicate this is a dangerous feature that requires trust
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        `Security: gcpAuthRefresh executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('gcpAuthRefresh invoked before trust check', error)
      logEvent('tengu_gcpAuthRefresh_missing_trust', {})
      return false
    }
  }

  try {
    logForDebugging('Checking GCP credentials validity for auth refresh')
    const isValid = await checkGcpCredentialsValid()
    if (isValid) {
      logForDebugging(
        'GCP credentials are valid, skipping auth refresh command',
      )
      return false
    }
  } catch {
    // Credentials check failed, proceed with refresh
  }

  return refreshGcpAuth(gcpAuthRefresh)
}

// Timeout for GCP auth refresh command (3 minutes).
// Long enough for browser-based auth flows, short enough to prevent indefinite hangs.
const GCP_AUTH_REFRESH_TIMEOUT_MS = 3 * 60 * 1000

export function refreshGcpAuth(gcpAuthRefresh: string): Promise<boolean> {
  logForDebugging('Running GCP auth refresh command')
  // Start tracking authentication status. AwsAuthStatusManager is cloud-provider-agnostic
  // despite the name — print.ts emits its updates as generic SDK 'auth_status' messages.
  const authStatusManager = AwsAuthStatusManager.getInstance()
  authStatusManager.startAuthentication()

  return new Promise(resolve => {
    const refreshProc = exec(gcpAuthRefresh, {
      timeout: GCP_AUTH_REFRESH_TIMEOUT_MS,
    })
    refreshProc.stdout!.on('data', data => {
      const output = data.toString().trim()
      if (output) {
        // Add output to status manager for UI display
        authStatusManager.addOutput(output)
        // Also log for debugging
        logForDebugging(output, { level: 'debug' })
      }
    })

    refreshProc.stderr!.on('data', data => {
      const error = data.toString().trim()
      if (error) {
        authStatusManager.setError(error)
        logForDebugging(error, { level: 'error' })
      }
    })

    refreshProc.on('close', (code, signal) => {
      if (code === 0) {
        logForDebugging('GCP auth refresh completed successfully')
        authStatusManager.endAuthentication(true)
        void resolve(true)
      } else {
        const timedOut = signal === 'SIGTERM'
        const message = timedOut
          ? chalk.red(
              'GCP auth refresh timed out after 3 minutes. Run your auth command manually in a separate terminal.',
            )
          : chalk.red(
              'Error running gcpAuthRefresh (in settings or ~/.rayu/settings.json):',
            )
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message)
        authStatusManager.endAuthentication(false)
        void resolve(false)
      }
    })
  })
}

/**
 * Refresh GCP authentication if needed.
 * This function checks if credentials are valid and runs the refresh command if not.
 * Memoized with TTL to avoid excessive refresh attempts.
 */
export const refreshGcpCredentialsIfNeeded = memoizeWithTTLAsync(
  async (): Promise<boolean> => {
    // Run auth refresh if needed
    const refreshed = await runGcpAuthRefresh()
    return refreshed
  },
  DEFAULT_GCP_CREDENTIAL_TTL,
)

export function clearGcpCredentialsCache(): void {
  refreshGcpCredentialsIfNeeded.cache.clear()
}

/**
 * Prefetches GCP credentials only if workspace trust has already been established.
 * This allows us to start the potentially slow GCP commands early for trusted workspaces
 * while maintaining security for untrusted ones.
 *
 * Returns void to prevent misuse - use refreshGcpCredentialsIfNeeded() to actually refresh.
 */
export function prefetchGcpCredentialsIfSafe(): void {
  // Check if gcpAuthRefresh is configured
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()

  if (!gcpAuthRefresh) {
    return
  }

  // Check if gcpAuthRefresh is from project settings
  if (isGcpAuthRefreshFromProjectSettings()) {
    // Only prefetch if trust has already been established
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      // Don't prefetch - wait for trust to be established first
      return
    }
  }

  // Safe to prefetch - either not from project settings or trust already established
  void refreshGcpCredentialsIfNeeded()
}

/**
 * Prefetches AWS credentials only if workspace trust has already been established.
 * This allows us to start the potentially slow AWS commands early for trusted workspaces
 * while maintaining security for untrusted ones.
 *
 * Returns void to prevent misuse - use refreshAndGetAwsCredentials() to actually retrieve credentials.
 */
export function prefetchAwsCredentialsAndBedRockInfoIfSafe(): void {
  // Check if either AWS command is configured
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()
  const awsCredentialExport = getConfiguredAwsCredentialExport()

  if (!awsAuthRefresh && !awsCredentialExport) {
    return
  }

  // Check if either command is from project settings
  if (
    isAwsAuthRefreshFromProjectSettings() ||
    isAwsCredentialExportFromProjectSettings()
  ) {
    // Only prefetch if trust has already been established
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      // Don't prefetch - wait for trust to be established first
      return
    }
  }

  // Safe to prefetch - either not from project settings or trust already established
  void refreshAndGetAwsCredentials()
  getModelStrings()
}

/** @private Use {@link getAnthropicApiKey} or {@link getAnthropicApiKeyWithSource} */
export const getApiKeyFromConfigOrMacOSKeychain = memoize(
  (): { key: string; source: ApiKeySource } | null => {
    return null
  },
)

function isValidApiKey(apiKey: string): boolean {
  // Only allow alphanumeric characters, dashes, and underscores
  return /^[a-zA-Z0-9-_]+$/.test(apiKey)
}

export async function saveApiKey(apiKey: string): Promise<void> {
  if (!isValidApiKey(apiKey)) {
    throw new Error(
      'Invalid API key format. API key must contain only alphanumeric characters, dashes, and underscores.',
    )
  }

  // Store as primary API key
  await maybeRemoveApiKeyFromMacOSKeychain()
  let savedToKeychain = false
  if (process.platform === 'darwin') {
    try {
      // TODO: migrate to SecureStorage
      const storageServiceName = getMacOsKeychainStorageServiceName()
      const username = getUsername()

      // Convert to hexadecimal to avoid any escaping issues
      const hexValue = Buffer.from(apiKey, 'utf-8').toString('hex')

      // Use security's interactive mode (-i) with -X (hexadecimal) option
      // This ensures credentials never appear in process command-line arguments
      // Process monitors only see "security -i", not the password
      const command = `add-generic-password -U -a "${username}" -s "${storageServiceName}" -X "${hexValue}"\n`

      await execa('security', ['-i'], {
        input: command,
        reject: false,
      })

      logEvent('tengu_api_key_saved_to_keychain', {})
      savedToKeychain = true
    } catch (e) {
      logError(e)
      logEvent('tengu_api_key_keychain_error', {
        error: errorMessage(
          e,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logEvent('tengu_api_key_saved_to_config', {})
    }
  } else {
    logEvent('tengu_api_key_saved_to_config', {})
  }

  const normalizedKey = normalizeApiKeyForConfig(apiKey)

  // Save config with all updates
  saveGlobalConfig(current => {
    const approved = current.customApiKeyResponses?.approved ?? []
    return {
      ...current,
      // Only save to config if keychain save failed or not on darwin
      primaryApiKey: savedToKeychain ? current.primaryApiKey : apiKey,
      customApiKeyResponses: {
        ...current.customApiKeyResponses,
        approved: approved.includes(normalizedKey)
          ? approved
          : [...approved, normalizedKey],
        rejected: current.customApiKeyResponses?.rejected ?? [],
      },
    }
  })

  // Clear memo cache
  getApiKeyFromConfigOrMacOSKeychain.cache.clear?.()
  clearLegacyApiKeyPrefetch()
}

export function isCustomApiKeyApproved(apiKey: string): boolean {
  const config = getGlobalConfig()
  const normalizedKey = normalizeApiKeyForConfig(apiKey)
  return (
    config.customApiKeyResponses?.approved?.includes(normalizedKey) ?? false
  )
}

export async function removeApiKey(): Promise<void> {
  await maybeRemoveApiKeyFromMacOSKeychain()

  // Also remove from config instead of returning early, for older clients
  // that set keys before we supported keychain.
  saveGlobalConfig(current => ({
    ...current,
    primaryApiKey: undefined,
  }))

  // Clear memo cache
  getApiKeyFromConfigOrMacOSKeychain.cache.clear?.()
  clearLegacyApiKeyPrefetch()
}

async function maybeRemoveApiKeyFromMacOSKeychain(): Promise<void> {
  try {
    await maybeRemoveApiKeyFromMacOSKeychainThrows()
  } catch (e) {
    logError(e)
  }
}

// Rayu does not persist Claude account OAuth tokens.
export function saveOAuthTokensIfNeeded(_tokens: OAuthTokens): {
  success: boolean
  warning?: string
} {
  return { success: true }
}

export const getClaudeAIOAuthTokens = memoize((): OAuthTokens | null => {
  return null
})

/**
 * Clears all OAuth token caches. Call this on 401 errors to ensure
 * the next token read comes from secure storage, not stale in-memory caches.
 * This handles the case where the local expiration check disagrees with the
 * server (e.g., due to clock corrections after token was issued).
 */
export function clearOAuthTokenCache(): void {
  getClaudeAIOAuthTokens.cache?.clear?.()
  clearKeychainCache()
}

export function handleOAuth401Error(
  _failedAccessToken: string,
): Promise<boolean> {
  return Promise.resolve(false)
}

/**
 * Reads OAuth tokens asynchronously, avoiding blocking keychain reads.
 * Delegates to the sync memoized version for env var / file descriptor tokens
 * (which don't hit the keychain), and only uses async for storage reads.
 */
export async function getClaudeAIOAuthTokensAsync(): Promise<OAuthTokens | null> {
  return null
}

export function checkAndRefreshOAuthTokenIfNeeded(
  retryCount = 0,
  force = false,
): Promise<boolean> {
  void retryCount
  void force
  return Promise.resolve(false)
}

export function isClaudeAISubscriber(): boolean {
  return false
}

/**
 * Check if the current OAuth token has the user:profile scope.
 *
 * Rayu does not use Claude account profile scopes.
 */
export function hasProfileScope(): boolean {
  return false
}

export function is1PApiCustomer(): boolean {
  // 1P API customers are users who are NOT:
  // 1. Rayu provider-configured users
  // 2. Vertex AI users
  // 3. AWS Bedrock users
  // 4. Foundry users

  // Exclude Vertex, Bedrock, and Foundry customers
  if (
    isEnvTruthy(process.env.RAYU_USE_BEDROCK) ||
    isEnvTruthy(process.env.RAYU_USE_VERTEX) ||
    isEnvTruthy(process.env.RAYU_USE_FOUNDRY)
  ) {
    return false
  }

  // Exclude subscription-account auth (unsupported in Rayu)
  if (isClaudeAISubscriber()) {
    return false
  }

  // Everyone else is an API customer (OAuth API customers, direct API key users, etc.)
  return true
}

/**
 * Gets OAuth account information when Anthropic auth is enabled.
 * Returns undefined when using external API keys or third-party services.
 */
export function getOauthAccountInfo(): AccountInfo | undefined {
  return isAnthropicAuthEnabled() ? getGlobalConfig().oauthAccount : undefined
}

/**
 * Checks if overage/extra usage provisioning is allowed for this organization.
 * Subscription account overage provisioning is not supported in Rayu.
 */
export function isOverageProvisioningAllowed(): boolean {
  const accountInfo = getOauthAccountInfo()
  const billingType = accountInfo?.billingType

  // Must be a Claude subscriber with a supported subscription type
  if (!isClaudeAISubscriber() || !billingType) {
    return false
  }

  // only allow Stripe and mobile billing types to purchase extra usage
  if (
    billingType !== 'stripe_subscription' &&
    billingType !== 'stripe_subscription_contracted' &&
    billingType !== 'apple_subscription' &&
    billingType !== 'google_play_subscription'
  ) {
    return false
  }

  return true
}

// Returns whether the user has Opus access at all, regardless of whether they
// are a subscriber or PayG.
export function hasOpusAccess(): boolean {
  const subscriptionType = getSubscriptionType()

  return (
    subscriptionType === 'max' ||
    subscriptionType === 'enterprise' ||
    subscriptionType === 'team' ||
    subscriptionType === 'pro' ||
    // subscriptionType === null covers both API users and the case where
    // subscribers do not have subscription type populated. For those
    // subscribers, when in doubt, we should not limit their access to Opus.
    subscriptionType === null
  )
}

export function getSubscriptionType(): SubscriptionType | null {
  // Check for mock subscription type first (ANT-only testing)
  if (shouldUseMockSubscription()) {
    return getMockSubscriptionType()
  }

  if (!isAnthropicAuthEnabled()) {
    return null
  }
  const oauthTokens = getClaudeAIOAuthTokens()
  if (!oauthTokens) {
    return null
  }

  return oauthTokens.subscriptionType ?? null
}

export function isMaxSubscriber(): boolean {
  return getSubscriptionType() === 'max'
}

export function isTeamSubscriber(): boolean {
  return getSubscriptionType() === 'team'
}

export function isTeamPremiumSubscriber(): boolean {
  return (
    getSubscriptionType() === 'team' &&
    getRateLimitTier() === 'default_claude_max_5x'
  )
}

export function isEnterpriseSubscriber(): boolean {
  return getSubscriptionType() === 'enterprise'
}

export function isProSubscriber(): boolean {
  return getSubscriptionType() === 'pro'
}

export function getRateLimitTier(): string | null {
  if (!isAnthropicAuthEnabled()) {
    return null
  }
  const oauthTokens = getClaudeAIOAuthTokens()
  if (!oauthTokens) {
    return null
  }

  return oauthTokens.rateLimitTier ?? null
}

export function getSubscriptionName(): string {
  const subscriptionType = getSubscriptionType()

  switch (subscriptionType) {
    case 'enterprise':
      return 'Claude Enterprise'
    case 'team':
      return 'Claude Team'
    case 'max':
      return 'Claude Max'
    case 'pro':
      return 'Claude Pro'
    default:
      return 'Claude API'
  }
}

/** Check if using third-party services (Bedrock or Vertex or Foundry) */
export function isUsing3PServices(): boolean {
  if (
    isEnvTruthy(process.env.RAYU_USE_BEDROCK) ||
    isEnvTruthy(process.env.RAYU_USE_VERTEX) ||
    isEnvTruthy(process.env.RAYU_USE_FOUNDRY)
  ) {
    return true
  }
  // Rayu: any non-anthropic provider routes through its own adapter —
  // no Anthropic key is needed, so bypass Anthropic auth entirely.
  try {
    const kind = getActiveProvider()?.kind
    return !!kind && kind !== 'anthropic'
  } catch {
    return false
  }
}

/**
 * Get the configured otelHeadersHelper from settings
 */
function getConfiguredOtelHeadersHelper(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.otelHeadersHelper
}

/**
 * Check if the configured otelHeadersHelper comes from project settings (projectSettings or localSettings)
 */
export function isOtelHeadersHelperFromProjectOrLocalSettings(): boolean {
  const otelHeadersHelper = getConfiguredOtelHeadersHelper()
  if (!otelHeadersHelper) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.otelHeadersHelper === otelHeadersHelper ||
    localSettings?.otelHeadersHelper === otelHeadersHelper
  )
}

// Cache for debouncing otelHeadersHelper calls
let cachedOtelHeaders: Record<string, string> | null = null
let cachedOtelHeadersTimestamp = 0
const DEFAULT_OTEL_HEADERS_DEBOUNCE_MS = 29 * 60 * 1000 // 29 minutes

export function getOtelHeadersFromHelper(): Record<string, string> {
  const otelHeadersHelper = getConfiguredOtelHeadersHelper()

  if (!otelHeadersHelper) {
    return {}
  }

  // Return cached headers if still valid (debounce)
  const debounceMs = parseInt(
    process.env.RAYU_OTEL_HEADERS_HELPER_DEBOUNCE_MS ||
      DEFAULT_OTEL_HEADERS_DEBOUNCE_MS.toString(),
  )
  if (
    cachedOtelHeaders &&
    Date.now() - cachedOtelHeadersTimestamp < debounceMs
  ) {
    return cachedOtelHeaders
  }

  if (isOtelHeadersHelperFromProjectOrLocalSettings()) {
    // Check if trust has been established for this project
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust) {
      return {}
    }
  }

  try {
    const result = execSyncWithDefaults_DEPRECATED(otelHeadersHelper, {
      timeout: 30000, // 30 seconds - allows for auth service latency
    })
      ?.toString()
      .trim()
    if (!result) {
      throw new Error('otelHeadersHelper did not return a valid value')
    }

    const headers = jsonParse(result)
    if (
      typeof headers !== 'object' ||
      headers === null ||
      Array.isArray(headers)
    ) {
      throw new Error(
        'otelHeadersHelper must return a JSON object with string key-value pairs',
      )
    }

    // Validate all values are strings
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') {
        throw new Error(
          `otelHeadersHelper returned non-string value for key "${key}": ${typeof value}`,
        )
      }
    }

    // Cache the result
    cachedOtelHeaders = headers as Record<string, string>
    cachedOtelHeadersTimestamp = Date.now()

    return cachedOtelHeaders
  } catch (error) {
    logError(
      new Error(
        `Error getting OpenTelemetry headers from otelHeadersHelper (in settings): ${errorMessage(error)}`,
      ),
    )
    throw error
  }
}

function isConsumerPlan(plan: SubscriptionType): plan is 'max' | 'pro' {
  return plan === 'max' || plan === 'pro'
}

export function isConsumerSubscriber(): boolean {
  const subscriptionType = getSubscriptionType()
  return (
    isClaudeAISubscriber() &&
    subscriptionType !== null &&
    isConsumerPlan(subscriptionType)
  )
}

export type UserAccountInfo = {
  subscription?: string
  tokenSource?: string
  apiKeySource?: ApiKeySource
  organization?: string
  email?: string
}

export function getAccountInformation() {
  const apiProvider = getAPIProvider()
  // Only provide account info for first-party Anthropic API
  if (apiProvider !== 'anthropic') {
    return undefined
  }
  const accountInfo: UserAccountInfo = {}
  const { key: apiKey, source: apiKeySource } = getAnthropicApiKeyWithSource()
  if (apiKey) {
    accountInfo.apiKeySource = apiKeySource
  }
  return accountInfo
}

/**
 * Result of org validation — either success or a descriptive error.
 */
export type OrgValidationResult =
  | { valid: true }
  | { valid: false; message: string }

export async function validateForceLoginOrg(): Promise<OrgValidationResult> {
  return { valid: true }
}

class GcpCredentialsTimeoutError extends Error {}
