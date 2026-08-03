// Anthropic OAuth types.
//
// These are the wire + storage shapes for the "Login with Claude (Pro / Max
// plan)" path: the OAuth 2.0 authorization-code + PKCE flow against the
// endpoints in src/constants/oauth.ts. They were reconstructed from the call
// sites in un-use-code/services/oauth/{index,auth-code-listener}.ts and from
// the responses services/oauth/client.ts already parses, so every field named
// here is one the code actually reads.
//
// SECURITY: OAuthTokens carries bearer credentials. It is persisted only via
// utils/auth.ts → secureStorage (0600) and must never be logged or echoed.

/**
 * A Claude.ai plan. Derived from `organization.organization_type` on
 * /api/oauth/profile (`claude_pro` → 'pro', `claude_max` → 'max', …) by
 * client.fetchProfileInfo. `null` elsewhere means "not a subscriber, or the
 * plan could not be determined".
 */
export type SubscriptionType = 'pro' | 'max' | 'team' | 'enterprise'

/**
 * Server-assigned rate-limit bucket (e.g. 'default_claude_max_5x',
 * 'default_claude_max_20x'). Deliberately a bare string: the set is defined by
 * the backend and new tiers must not crash an older CLI (see the plan's
 * "plan/tier mismatch" risk).
 */
export type RateLimitTier = string

/** How the subscription is billed. Read from the profile's organization. */
export type BillingType =
  | 'stripe_subscription'
  | 'stripe_subscription_contracted'
  | 'apple_subscription'
  | 'google_play_subscription'
  | (string & {})

/** `GET {BASE_API_URL}/api/oauth/profile` — only the fields we read are typed. */
export type OAuthProfileResponse = {
  account?: {
    uuid?: string
    email_address?: string
    display_name?: string
    created_at?: string
  }
  organization?: {
    uuid?: string
    name?: string
    organization_type?: string
    rate_limit_tier?: RateLimitTier
    has_extra_usage_enabled?: boolean
    billing_type?: BillingType
    subscription_created_at?: string
  }
}

/** `POST {TOKEN_URL}` response, for both the code and refresh_token grants. */
export type OAuthTokenExchangeResponse = {
  access_token: string
  refresh_token: string
  /** Lifetime in SECONDS (converted to an absolute `expiresAt` on storage). */
  expires_in: number
  /** Space-separated granted scopes; parsed with client.parseScopes. */
  scope?: string
  account?: {
    uuid: string
    email_address: string
  }
  organization?: {
    uuid: string
    name?: string
  }
}

/** `GET {ROLES_URL}` — the caller's role within the org. */
export type UserRolesResponse = {
  organization_role?: string | null
  workspace_role?: string | null
  organization_name?: string | null
}

/** The account the tokens were issued for, as returned by the token endpoint. */
export type OAuthTokenAccount = {
  uuid: string
  emailAddress: string
  organizationUuid?: string
}

/**
 * The persisted credential record for a Claude.ai subscription login. Stored
 * under the `claudeAiOauth` key of secureStorage — a slot entirely separate
 * from the Rayu account JWT (services/rayuAuth), so the two auth paths never
 * clobber one another.
 */
export type OAuthTokens = {
  accessToken: string
  refreshToken: string
  /** Absolute epoch ms. `null` means "no known expiry" (never auto-refreshed). */
  expiresAt: number | null
  scopes: string[]
  subscriptionType: SubscriptionType | null
  rateLimitTier: RateLimitTier | null
  profile?: OAuthProfileResponse
  tokenAccount?: OAuthTokenAccount
}

// --- Referral / guest-pass shapes (services/api/referral.ts) ----------------
// Not part of the subscription-login flow; declared here because that module
// and utils/config.ts import them from this file. Kept permissive (index
// signatures) since the CLI only reads a couple of fields and passes the rest
// through to the config cache.

export type ReferralCampaign = 'claude_code_guest_pass' | (string & {})

export type ReferrerRewardInfo = {
  currency: string
  amount_minor_units: number
  [key: string]: unknown
}

export type ReferralEligibilityResponse = {
  eligible: boolean
  remaining_passes?: number | null
  referrer_reward?: ReferrerRewardInfo | null
  [key: string]: unknown
}

export type ReferralRedemptionsResponse = {
  [key: string]: unknown
}
