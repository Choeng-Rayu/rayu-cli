// "Login with Claude (Pro plan / Max plan)" — the orchestration layer between
// the /connect UI and the OAuth machinery.
//
// Everything here is reached ONLY from the /connect Claude-login path and is
// therefore lazy-imported by its callers, so the OAuth modules (localhost
// listener, axios profile fetch) never load at CLI startup.
//
// The provider entry this installs is a normal RayuProvider of kind 'anthropic'
// with `anthropicAuthType:'oauth'` and NO apiKey — see rayuConfig.RayuProvider.
// It is a SEPARATE id from the 'anthropic' Console-API-key preset, so connecting
// one never overwrites the other's credential, and it is separate again from the
// Rayu account JWT used by /login.
//
// SECURITY: tokens are persisted only via saveOAuthTokensIfNeeded →
// secureStorage (0600 / keychain), never into providers.json and never logged.
import { getOauthConfig, OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import {
  getClaudeAIOAuthTokens,
  hasClaudeAISubscriptionLogin,
  logoutClaudeAISubscription,
  saveOAuthTokensIfNeeded,
} from '../../utils/auth.js'
import { getGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  loadRayuConfig,
  removeProvider,
  type RayuProvider,
  upsertProvider,
} from '../../utils/rayuConfig.js'
import {
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  PROVIDER_PRESETS,
} from '../../utils/rayuProviders.js'
import { storeOAuthAccountInfo } from './client.js'
import { refreshClaudeAIOAuthTokensIfNeeded } from './claudeAiTokens.js'
import type { OAuthTokens, RateLimitTier, SubscriptionType } from './types.js'

export { CLAUDE_SUBSCRIPTION_PROVIDER_ID }

/**
 * `anthropic-version` for the raw (non-SDK) calls in this module. The Anthropic
 * SDK sets this itself on the request path; the model-catalog fetch below is a
 * plain fetch, so it must send it explicitly. Same value the other raw callers in
 * the tree use (bridge/codeSessionApi.ts, services/api/filesApi.ts).
 */
const ANTHROPIC_VERSION = '2023-06-01'

/** The preset backing the subscription provider (label, default models). */
function subscriptionPreset() {
  return PROVIDER_PRESETS.find(p => p.id === CLAUDE_SUBSCRIPTION_PROVIDER_ID)
}

/**
 * Models to offer when the live catalog can't be listed (offline, or a plan
 * whose token cannot read /v1/models). Derived from the preset rather than
 * hardcoded here, so the ids stay in one place and follow the catalog.
 */
function fallbackSubscriptionModels(): string[] {
  const preset = subscriptionPreset()
  return [preset?.defaultModel, preset?.smallFastModel].filter(
    (m): m is string => !!m,
  )
}

type AnthropicModelsPage = {
  data?: Array<{ id?: string; display_name?: string }>
  has_more?: boolean
  last_id?: string | null
}

/**
 * List the Claude models the signed-in subscription can use.
 *
 * `GET {BASE_API_URL}/v1/models` with the OAuth access token as a bearer plus the
 * OAuth beta header. Returns the preset fallback (never an empty list) when the
 * account has no login or the call fails, so the /connect model picker is always
 * usable.
 */
export async function fetchClaudeSubscriptionModels(): Promise<string[]> {
  const ok = await refreshClaudeAIOAuthTokensIfNeeded()
  const token = getClaudeAIOAuthTokens()?.accessToken
  if (!ok || !token) return fallbackSubscriptionModels()

  const ids: string[] = []
  let afterId: string | undefined
  try {
    // Paginate defensively; the catalog is small, so 5 pages is plenty.
    for (let page = 0; page < 5; page++) {
      const url = new URL(`${getOauthConfig().BASE_API_URL}/v1/models`)
      url.searchParams.set('limit', '100')
      if (afterId) url.searchParams.set('after_id', afterId)
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-beta': OAUTH_BETA_HEADER,
        },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        logForDebugging(
          `[oauth] /v1/models returned ${res.status}; using fallback catalog`,
        )
        break
      }
      const json = (await res.json()) as AnthropicModelsPage
      for (const m of json.data ?? []) {
        if (typeof m.id === 'string' && m.id) ids.push(m.id)
      }
      if (!json.has_more || !json.last_id) break
      afterId = json.last_id
    }
  } catch (e) {
    logForDebugging(
      `[oauth] model catalog fetch failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  }

  if (ids.length === 0) return fallbackSubscriptionModels()
  // Newest first: the API returns the catalog in creation order.
  return [...new Set(ids)].reverse()
}

/**
 * Pick the default model for a freshly connected subscription: the preset default
 * when the account can use it, else the newest Sonnet, else anything listed.
 * Opus is deliberately NOT chosen automatically — it is Max-only on some plans
 * (see subscriptionAllowsOpus) and a first turn that 403s is a bad first run.
 */
export function pickSubscriptionDefaultModel(models: string[]): string {
  const preset = subscriptionPreset()
  if (preset?.defaultModel && models.includes(preset.defaultModel)) {
    return preset.defaultModel
  }
  return (
    models.find(m => /claude.*sonnet/i.test(m)) ??
    models.find(m => /claude/i.test(m)) ??
    models[0] ??
    preset?.defaultModel ??
    ''
  )
}

/**
 * Whether a plan can run Opus models.
 *
 * Pro is Sonnet/Haiku-only in practice; Max/Team/Enterprise include Opus. An
 * UNKNOWN plan (null — a new plan name the CLI has not seen) is allowed through
 * rather than blocked, matching hasOpusAccess() in utils/auth.ts: when in doubt,
 * do not restrict a paying user.
 */
export function subscriptionAllowsOpus(
  subscriptionType: SubscriptionType | null,
): boolean {
  return subscriptionType !== 'pro'
}

/** Drop Opus models for plans that cannot run them. */
export function filterModelsForSubscription(
  models: string[],
  subscriptionType: SubscriptionType | null,
): string[] {
  if (subscriptionAllowsOpus(subscriptionType)) return models
  const filtered = models.filter(m => !/opus/i.test(m))
  // Never return an empty catalog because of the filter.
  return filtered.length ? filtered : models
}

/**
 * Persist a completed OAuth login and make it the active provider.
 *
 * Order matters: tokens FIRST (so the catalog fetch can authenticate), then the
 * account info, then the provider entry, then the live model catalog.
 */
export async function installClaudeSubscription(
  tokens: OAuthTokens,
): Promise<{ success: boolean; warning?: string; models: string[] }> {
  const { success, warning } = saveOAuthTokensIfNeeded(tokens)
  if (!success) {
    return {
      success: false,
      warning:
        warning ??
        'Could not save the Claude credentials to secure storage. Check the permissions on ~/.rayu.',
      models: [],
    }
  }

  // Cache the account so /connect can show who is signed in after a restart.
  const account = tokens.tokenAccount
  const profileAccount = tokens.profile?.account
  const accountUuid = account?.uuid ?? profileAccount?.uuid
  const emailAddress = account?.emailAddress ?? profileAccount?.email_address
  if (accountUuid && emailAddress) {
    storeOAuthAccountInfo({
      accountUuid,
      emailAddress,
      organizationUuid:
        account?.organizationUuid ?? tokens.profile?.organization?.uuid,
      ...(profileAccount?.display_name
        ? { displayName: profileAccount.display_name }
        : {}),
      ...(typeof tokens.profile?.organization?.has_extra_usage_enabled ===
      'boolean'
        ? {
            hasExtraUsageEnabled:
              tokens.profile.organization.has_extra_usage_enabled,
          }
        : {}),
      ...(tokens.profile?.organization?.billing_type
        ? { billingType: tokens.profile.organization.billing_type }
        : {}),
      ...(profileAccount?.created_at
        ? { accountCreatedAt: profileAccount.created_at }
        : {}),
      ...(tokens.profile?.organization?.subscription_created_at
        ? {
            subscriptionCreatedAt:
              tokens.profile.organization.subscription_created_at,
          }
        : {}),
    })
  }

  const preset = subscriptionPreset()
  const base: RayuProvider = {
    id: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    kind: 'anthropic',
    label: preset?.label ?? 'Claude subscription (Pro / Max plan)',
    anthropicAuthType: 'oauth',
    // No apiKey: the bearer token lives in secureStorage, never in providers.json.
    apiKey: undefined,
    ...(preset?.smallFastModel ? { smallFastModel: preset.smallFastModel } : {}),
  }
  upsertProvider(base, true)

  const models = filterModelsForSubscription(
    await fetchClaudeSubscriptionModels(),
    tokens.subscriptionType,
  )
  upsertProvider(
    {
      ...base,
      ...(models.length ? { fetchedModels: models } : {}),
      defaultModel: pickSubscriptionDefaultModel(models),
    },
    true,
  )

  return { success: true, warning, models }
}

export type ClaudeSubscriptionStatus = {
  signedIn: boolean
  /** True when this login is the ACTIVE provider for Claude requests. */
  active: boolean
  subscriptionType: SubscriptionType | null
  rateLimitTier: RateLimitTier | null
  emailAddress?: string
  organizationName?: string
  /** Absolute epoch ms of access-token expiry, when known. */
  expiresAt: number | null
  scopes: string[]
}

/** Human label for a plan, for the /connect status view. */
export function subscriptionPlanLabel(
  subscriptionType: SubscriptionType | null,
): string {
  switch (subscriptionType) {
    case 'max':
      return 'Claude Max'
    case 'pro':
      return 'Claude Pro'
    case 'team':
      return 'Claude Team'
    case 'enterprise':
      return 'Claude Enterprise'
    default:
      // A plan name the CLI does not know must not read as "no subscription".
      return 'Claude subscription'
  }
}

/** Current subscription-login state, for the /connect status view. */
export function getClaudeSubscriptionStatus(): ClaudeSubscriptionStatus {
  const tokens = getClaudeAIOAuthTokens()
  const cfg = loadRayuConfig()
  const provider = cfg.providers.find(
    p => p.id === CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  )
  const account = getGlobalConfig().oauthAccount
  return {
    signedIn: hasClaudeAISubscriptionLogin(),
    active: !!provider && cfg.activeProvider === provider.id,
    subscriptionType: tokens?.subscriptionType ?? null,
    rateLimitTier: tokens?.rateLimitTier ?? null,
    ...(account?.emailAddress ? { emailAddress: account.emailAddress } : {}),
    ...(account?.organizationName
      ? { organizationName: account.organizationName }
      : {}),
    expiresAt: tokens?.expiresAt ?? null,
    scopes: tokens?.scopes ?? [],
  }
}

/**
 * Forget the Claude.ai subscription login: clear the credential slot + cached
 * account info, and drop the provider entry so the session falls back to the
 * next configured provider. The Rayu account JWT is untouched.
 */
export function logoutClaudeSubscription(): boolean {
  const cleared = logoutClaudeAISubscription()
  removeProvider(CLAUDE_SUBSCRIPTION_PROVIDER_ID)
  return cleared
}
