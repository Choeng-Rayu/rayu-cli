// Shared enum-like string unions used across entities and DTOs.
// We use plain string unions + const arrays so the same code works on MySQL
// (production) and SQLite (tests) without DB-specific enum handling.

export const USER_ROLES = ['user', 'admin', 'superadmin'] as const
export type UserRole = (typeof USER_ROLES)[number]

export const USER_STATUSES = ['active', 'suspended', 'banned'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

export const PLAN_CODES = [
  'free',
  'basic',
  'pro',
  'pro_plus',
  'max',
  'enterprise',
] as const
export type PlanCode = (typeof PLAN_CODES)[number]

export const PLAN_AVAILABILITY = ['active', 'coming_soon'] as const
export type PlanAvailability = (typeof PLAN_AVAILABILITY)[number]

export const SUBSCRIPTION_STATUSES = ['active', 'canceled'] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

export const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'expired', 'canceled'] as const
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]

export const FEEDBACK_TYPES = ['bug', 'idea', 'other'] as const
export type FeedbackType = (typeof FEEDBACK_TYPES)[number]

export const USAGE_SOURCES = ['cli', 'web', 'studio'] as const
export type UsageSource = (typeof USAGE_SOURCES)[number]

// --- Teams (organizations) ----------------------------------------------------
// A team has exactly one owner (Organization.adminId) plus any number of
// members. The role here is the ORG role carried in the Rayu JWT as `orgRole`;
// it is orthogonal to UserRole (a platform 'user' can be an org 'admin').
export const ORG_ROLES = ['admin', 'member'] as const
export type OrgRole = (typeof ORG_ROLES)[number]

// Membership is REMOVED rather than deleted so the record of who spent the
// team's credits survives the person leaving.
export const ORG_MEMBER_STATUSES = ['active', 'removed'] as const
export type OrgMemberStatus = (typeof ORG_MEMBER_STATUSES)[number]

// 'suspended' is the super-admin oversight action: the org's members lose
// gateway access without any data being destroyed.
export const ORG_STATUSES = ['active', 'suspended'] as const
export type OrgStatus = (typeof ORG_STATUSES)[number]

export const ORG_INVITE_STATUSES = ['pending', 'accepted', 'revoked'] as const
export type OrgInviteStatus = (typeof ORG_INVITE_STATUSES)[number]

// A shareable join link is either live or dead. There is no "expired" status:
// expiry is a timestamp compared at use time, so a link never needs a background
// job to age it out (and an admin can extend one by regenerating it).
export const ORG_JOIN_LINK_STATUSES = ['active', 'revoked'] as const
export type OrgJoinLinkStatus = (typeof ORG_JOIN_LINK_STATUSES)[number]

// Lifecycle of a request filed by someone who opened a join link. Holding the
// link is NOT membership — 'pending' is where every request starts, and only an
// admin moves it to 'approved'. 'canceled' is the requester withdrawing.
export const ORG_JOIN_REQUEST_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'canceled',
] as const
export type OrgJoinRequestStatus = (typeof ORG_JOIN_REQUEST_STATUSES)[number]

export const ORG_SUBSCRIPTION_STATUSES = [
  'active',
  'past_due',
  'canceled',
] as const
export type OrgSubscriptionStatus = (typeof ORG_SUBSCRIPTION_STATUSES)[number]

// Lifecycle of one pay-as-you-go credit purchase made FOR a team. Mirrors
// credit_topups' individual statuses, because it is the same money moving
// through the same rails: 'paid' is the grant (it raises
// credit_pools.extra_credits), 'refunded' is the clawback, and 'expired' is a QR
// that was never paid — NOT credits that ran out of time. Purchased credits stop
// being spendable when the pool's period ends, which is enforced by the period
// gate plus the reset in activateSubscription, so no status change is involved
// and there is no sweep job that could drift from the truth.
export const ORG_CREDIT_TOPUP_STATUSES = [
  'pending',
  'paid',
  'refunded',
  // A QR the admin abandoned (or that timed out) — NOT credits that ran out of
  // time. See the note above.
  'canceled',
  'expired',
] as const
export type OrgCreditTopupStatus = (typeof ORG_CREDIT_TOPUP_STATUSES)[number]

// --- Rayu Studio --------------------------------------------------------------
// Third-party services the studio can hold a per-user credential for. Each value
// is a `kind` in studio_connections and a path segment under /api/studio.
// Adding one here is not enough — it also needs an upstream host in
// studio-urls.ts, or requests to it are refused by the SSRF guard.
export const STUDIO_CONNECTION_KINDS = [
  'github',
  'gitlab',
  'netlify',
  'vercel',
  'supabase',
] as const
export type StudioConnectionKind = (typeof STUDIO_CONNECTION_KINDS)[number]

// --- Media (image / video) generation catalog ---------------------------------
// The image- and video-generation models the CLI offers. This catalog is pure
// METADATA: unlike hosted chat models, media models are NOT proxied by the
// gateway — the CLI calls the upstream (NVIDIA / Vertex / fal) directly with the
// user's own key — so no routing config and no credential belongs on these rows.
export const MEDIA_TYPES = ['image', 'video'] as const
export type MediaType = (typeof MEDIA_TYPES)[number]

// What a media model can do. Image models generate from text or edit an existing
// image; video models animate text or an input image.
export const MEDIA_CAPABILITIES = [
  'generate',
  'edit',
  'text2video',
  'image2video',
] as const
export type MediaCapability = (typeof MEDIA_CAPABILITIES)[number]

// Which upstream serves the model. The CLI picks its HTTP client from this.
export const MEDIA_BACKENDS = [
  'nvidia', // ai.api.nvidia.com/v1/genai (image)
  'vertex', // Vertex AI publisher :predict (Imagen / Veo)
  'nvcf', // api.nvcf.nvidia.com/v2/nvcf/pexec (video)
  'nvidia-svd', // ai.api.nvidia.com/v1/genai (Stable Video Diffusion)
  'fal', // queue.fal.run
] as const
export type MediaBackend = (typeof MEDIA_BACKENDS)[number]

// Request-SHAPE family. The CLI keys its per-family request-body builder off
// this string, so a new model that reuses an existing body shape needs only a
// catalog row — no CLI release. Adding a genuinely NEW shape is the one case
// that still requires a CLI change (and the CLI fails with a clear error naming
// the unknown family rather than crashing).
export const MEDIA_FAMILIES = [
  // image
  'flux',
  'sd3',
  'kontext',
  'imagen',
  // video
  'cosmos-predict1',
  'cosmos-transfer1',
  'cosmos3-nano',
  'cosmos-legacy',
  'svd',
  'fal-kling',
  'veo',
] as const
export type MediaFamily = (typeof MEDIA_FAMILIES)[number]

// --- Hosted provider registry -------------------------------------------------
// Wire format an upstream provider speaks. The gateway's canonical internal
// format is Anthropic Messages (what the CLI speaks natively); every other
// format is translated by a gateway adapter.
export const PROVIDER_FORMATS = [
  'anthropic_messages',
  'openai_chat',
  'openai_responses',
  'genai',
  // AWS Bedrock's Anthropic surface: same message format, but the model id is in
  // the URL path (/model/{model}/invoke), the body needs anthropic_version and
  // must omit model/stream, and streaming is AWS event-stream. See the gateway's
  // internal/translate/bedrock.go.
  'bedrock_anthropic',
] as const
export type ProviderFormat = (typeof PROVIDER_FORMATS)[number]

// How the upstream API key is presented on the wire.
export const PROVIDER_AUTH_SCHEMES = [
  'bearer', // Authorization: Bearer <key>
  'x_api_key', // x-api-key: <key>  (Anthropic standard)
  'x_goog_api_key', // x-goog-api-key: <key>  (Google GenAI)
] as const
export type ProviderAuthScheme = (typeof PROVIDER_AUTH_SCHEMES)[number]

// Health of a single provider API key. The gateway writes these back as it
// observes upstream responses, so the dashboard reflects reality:
//   active       — usable now
//   rate_limited — a 429 was seen; unusable until cooldownUntil passes
//   invalid      — a 401/403 was seen (or it failed to decrypt); needs replacing
//   disabled     — an admin switched it off
export const PROVIDER_KEY_STATUSES = [
  'active',
  'rate_limited',
  'invalid',
  'disabled',
] as const
export type ProviderKeyStatus = (typeof PROVIDER_KEY_STATUSES)[number]
