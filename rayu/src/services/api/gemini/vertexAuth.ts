// Google Vertex AI authentication for Rayu's Gemini/Vertex provider.
//
// Provides a freshly-minted Google Cloud OAuth bearer token (cloud-platform
// scope) for the OpenAI-compatible Vertex chat endpoint, plus project/region
// detection. Tokens live ~1h and are cached until shortly before expiry.
//
// Credential resolution order:
//   1. Application Default Credentials (ADC) via google-auth-library
//      (gcloud auth application-default login, GOOGLE_APPLICATION_CREDENTIALS,
//       workload identity, GCE metadata, …).
//   2. The interactive loopback OAuth fallback registered by googleOAuth.ts
//      (set lazily to avoid an import cycle).
//
// SECURITY: tokens are never logged. They are sent only to the Google Vertex
// host by the adapter's fetch wrapper.

/** A minted access token with its absolute expiry (epoch ms). */
export type VertexTokenResult = { token: string; expiresAtMs: number }

/** Resolves an access token, or null when this source has no credentials. */
export type VertexTokenSource = () => Promise<VertexTokenResult | null>

/** Refresh a cached token this many ms before its real expiry. */
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000

/** Default ADC token lifetime when the auth client doesn't report an expiry. */
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000

/** Short timeout for credential probes so we don't hang on the GCE metadata
 *  server (~12s) when no local credential source exists. */
const GCP_PROBE_TIMEOUT_MS = 5_000

let cachedToken: VertexTokenResult | null = null

/**
 * Interactive OAuth fallback, registered by googleOAuth.ts. Kept as a setter
 * (rather than a static import) to avoid an import cycle and to keep this
 * module usable in tests without the loopback server.
 */
let oauthFallback: VertexTokenSource | null = null

/** Register the interactive OAuth token source (called by googleOAuth.ts). */
export function registerVertexOAuthFallback(source: VertexTokenSource): void {
  oauthFallback = source
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('gcp probe timed out')), ms),
    ),
  ])
}

/** ADC token source via google-auth-library (cloud-platform scope). */
const adcTokenSource: VertexTokenSource = async () => {
  try {
    const { GoogleAuth } = await import('google-auth-library')
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    const result = await withTimeout(
      (async () => {
        const client = await auth.getClient()
        const { token } = await client.getAccessToken()
        // OAuth2/JWT clients expose the real expiry on credentials.expiry_date.
        const expiry =
          (client.credentials as { expiry_date?: number } | undefined)
            ?.expiry_date ?? Date.now() + DEFAULT_TOKEN_TTL_MS
        return token ? { token, expiresAtMs: expiry } : null
      })(),
      GCP_PROBE_TIMEOUT_MS,
    )
    return result
  } catch {
    return null
  }
}

/**
 * The ordered list of token sources to try. Overridable in tests via
 * _setVertexTokenSourcesForTesting. The OAuth fallback is consulted lazily so
 * it can be registered after this module loads.
 */
let tokenSourcesOverride: VertexTokenSource[] | null = null

function tokenSources(): VertexTokenSource[] {
  if (tokenSourcesOverride) return tokenSourcesOverride
  // Prefer the interactive "Sign in with Google" token when present: the user
  // explicitly logged in for this provider, and that identity has the access /
  // model catalog they expect. Ambient gcloud ADC (which may be a different,
  // more limited identity) is only used when no interactive login exists.
  const sources: VertexTokenSource[] = []
  if (oauthFallback) sources.push(oauthFallback)
  sources.push(adcTokenSource)
  return sources
}

/**
 * Return a valid Vertex access token, minting/refreshing as needed. Prefers the
 * interactive "Sign in with Google" login when present, then falls back to
 * Application Default Credentials. Throws when no source can provide credentials.
 */
export async function getVertexAccessToken(): Promise<string> {
  const now = Date.now()
  if (cachedToken && now < cachedToken.expiresAtMs - TOKEN_REFRESH_SKEW_MS) {
    return cachedToken.token
  }
  for (const source of tokenSources()) {
    const result = await source()
    if (result?.token) {
      cachedToken = result
      return result.token
    }
  }
  throw new Error(
    'No Google Cloud credentials available for Vertex AI. Run /connect to ' +
      'sign in, or configure Application Default Credentials ' +
      '(gcloud auth application-default login).',
  )
}

/** True when Application Default Credentials are currently usable. */
export async function hasAdcCredentials(): Promise<boolean> {
  const result = await adcTokenSource()
  return result?.token != null
}

export type GcpProjectRegion = { project?: string; region: string }

// `global` serves the newest Gemini models for chat; image/video clients
// coerce it back to a real region since Imagen/Veo are regional.
const DEFAULT_REGION = 'global'

/**
 * Detect the GCP project id and region for Vertex AI.
 * Project precedence: GOOGLE_CLOUD_PROJECT → ANTHROPIC_VERTEX_PROJECT_ID →
 *   GCLOUD_PROJECT/GCP_PROJECT → ADC quota/default project.
 * Region precedence:  GOOGLE_CLOUD_LOCATION → CLOUD_ML_REGION →
 *   VERTEX_REGION → default (us-central1).
 */
export async function detectGcpProjectAndRegion(): Promise<GcpProjectRegion> {
  const region =
    process.env.GOOGLE_CLOUD_LOCATION ||
    process.env.CLOUD_ML_REGION ||
    process.env.VERTEX_REGION ||
    DEFAULT_REGION

  const envProject =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.ANTHROPIC_VERTEX_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT

  if (envProject) return { project: envProject, region }

  // Fall back to whatever ADC reports as the active/quota project.
  const adcProject = await detectAdcProject()
  return { project: adcProject, region }
}

let adcProjectResolverOverride: (() => Promise<string | undefined>) | null = null

async function detectAdcProject(): Promise<string | undefined> {
  if (adcProjectResolverOverride) return adcProjectResolverOverride()
  try {
    const { GoogleAuth } = await import('google-auth-library')
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    const project = await withTimeout(auth.getProjectId(), GCP_PROBE_TIMEOUT_MS)
    return project || undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the project + region to use for Vertex AI image/video requests.
 * Prefers a configured kind:'vertex' provider's stored gcpProject/gcpRegion,
 * then falls back to env/ADC detection.
 */
export async function resolveVertexProjectRegion(): Promise<GcpProjectRegion> {
  try {
    const { loadRayuConfig } = await import('../../../utils/rayuConfig.js')
    const vertex = loadRayuConfig().providers.find(p => p.kind === 'vertex')
    if (vertex?.gcpProject) {
      return {
        project: vertex.gcpProject,
        region: vertex.gcpRegion || 'global',
      }
    }
  } catch {
    // fall through to detection
  }
  return detectGcpProjectAndRegion()
}

// --- Test hooks -------------------------------------------------------------

export function _setVertexTokenSourcesForTesting(
  sources: VertexTokenSource[] | null,
): void {
  tokenSourcesOverride = sources
}

export function _setAdcProjectResolverForTesting(
  fn: (() => Promise<string | undefined>) | null,
): void {
  adcProjectResolverOverride = fn
}

export function _resetVertexAuthCacheForTesting(): void {
  cachedToken = null
  oauthFallback = null
  tokenSourcesOverride = null
  adcProjectResolverOverride = null
}
