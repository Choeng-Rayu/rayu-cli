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
