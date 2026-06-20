// Soft paid-feature gating for the CLI.
//
// Some capabilities (image/video generation, …) are only included in Rayu's
// PAID plans. Historically the CLI HID the matching tools from the model when
// the signed-in user was on the Free plan (isEnabled() === false), so the model
// literally could not see or call them.
//
// We now SOFT-gate instead: the tool stays VISIBLE to the model, but
//   1. its prompt/description carries an "upgrade required" note, and
//   2. its call() refuses to run for a Free user and returns an upgrade ask.
// This lets the assistant respond helpfully ("image generation is a paid
// feature — please upgrade…") instead of silently lacking the capability.
//
// ADMIN-DRIVEN, NOT HARDCODED: whether a feature is gated comes from per-user
// entitlements (rayuFeatureAllowed), and the upgrade target's plan NAME + PRICE
// come from the admin-configured plan catalog (getEntryPaidPlan). Nothing about
// the plan ("Basic", "$3", …) is hardcoded here — the super-admin owns all of
// it in the dashboard/DB. When that data isn't available the copy degrades to a
// generic "a paid plan".
//
// Paid users are unaffected: rayuFeatureAllowed() returns true for them, so
// isPaidFeatureLocked() is false and none of the gating below kicks in. When
// Rayu OAuth is OFF (the BYOK / open-source path) rayuFeatureAllowed() also
// returns true, so behaviour there is unchanged as well.

import { rayuFeatureAllowed } from './rayuEntitlements.js'
import { getEntryPaidPlan } from './rayuPlansCatalog.js'

/**
 * Whether a gated feature is currently LOCKED for the signed-in user, i.e. the
 * tool should stay visible but show the upgrade note and refuse to execute.
 *
 * This is the inverse of `rayuFeatureAllowed`, so it inherits its fail-open
 * semantics: locked is only ever true for a signed-in Free user with Rayu OAuth
 * enabled. Paid users and the OAuth-off (BYOK) path are never locked.
 */
export function isPaidFeatureLocked(featureKey: string): boolean {
  return !rayuFeatureAllowed(featureKey)
}

/** Capitalize the first letter (for sentence-leading feature labels). */
function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s
}

/** Format cents as `$3` (whole) or `$2.50`. */
function usd(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`
}

/**
 * The admin-configured upgrade-target phrase, e.g. "the Basic plan ($3/mo)".
 *
 * Sourced LIVE from the plan catalog the super-admin manages — the name and
 * price are never hardcoded. Degrades to a generic "a paid plan" when the
 * catalog isn't known yet (offline, pre-fetch, or OAuth off).
 */
export function upgradeTargetLabel(): string {
  const plan = getEntryPaidPlan()
  if (plan) {
    const price = plan.priceCents > 0 ? ` (${usd(plan.priceCents)}/mo)` : ''
    return `the ${plan.name} plan${price}`
  }
  return 'a paid plan'
}

/**
 * The short, friendly line the assistant should say to a Free user when they
 * ask for a locked feature. Kept in one place so the tool prompt and the
 * blocked-call message stay consistent.
 *
 * @param featureLabel noun phrase, e.g. "image generation".
 */
export function upgradePromptForUser(featureLabel: string): string {
  return `${capitalize(featureLabel)} is a paid feature. Please upgrade to ${upgradeTargetLabel()} to unlock it and all other premium features.`
}

/**
 * Markdown note appended to a gated tool's prompt() — the description the model
 * sees — when the feature is locked. Tells the model NOT to run the tool and to
 * ask the user to upgrade instead.
 *
 * @param featureLabel noun phrase, e.g. "image generation".
 */
export function paidFeatureUpgradeNote(featureLabel: string): string {
  return `

---
> 🔒 **Paid feature — requires ${upgradeTargetLabel()}.**
>
> The signed-in user is on the **Free** plan, which does not include ${featureLabel}. This tool will refuse to run for them and return an error.
>
> If the user asks for ${featureLabel}, do **not** call this tool — it will fail. Instead, tell the user: "${upgradePromptForUser(featureLabel)}"
>
> Users on a paid plan get unlimited access to this tool.`
}

/**
 * Short suffix appended to a gated tool's one-line description() when locked, so
 * even the condensed listing signals the paid requirement.
 */
export function paidFeatureDescriptionSuffix(): string {
  return ` (Requires ${upgradeTargetLabel()}.)`
}

/**
 * The error message a gated tool throws from call() when a Free user invokes it.
 * Surfaced to the model as the tool result, so it doubles as an instruction to
 * relay the upgrade ask to the user.
 *
 * @param featureLabel noun phrase, e.g. "image generation".
 */
export function paidFeatureBlockedMessage(featureLabel: string): string {
  return `🔒 ${capitalize(featureLabel)} requires ${upgradeTargetLabel()}. The signed-in user is on the Free plan, so this tool is locked. Tell the user: "${upgradePromptForUser(featureLabel)}" Do not retry this tool until they upgrade.`
}
