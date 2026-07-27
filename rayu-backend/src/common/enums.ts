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

export const USAGE_SOURCES = ['cli', 'web'] as const
export type UsageSource = (typeof USAGE_SOURCES)[number]

// --- Hosted provider registry -------------------------------------------------
// Wire format an upstream provider speaks. The gateway's canonical internal
// format is Anthropic Messages (what the CLI speaks natively); every other
// format is translated by a gateway adapter.
export const PROVIDER_FORMATS = [
  'anthropic_messages',
  'openai_chat',
  'openai_responses',
  'genai',
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
