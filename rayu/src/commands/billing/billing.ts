import type { LocalCommandResult } from '../../types/command.js'
import type { RayuEntitlements } from '../../services/rayuAuth/rayuEntitlements.js'
import {
  getCachedEntitlements,
  refreshRayuEntitlements,
} from '../../services/rayuAuth/rayuEntitlements.js'
import {
  getRayuWebBaseUrl,
  hasRayuSession,
} from '../../services/rayuAuth/rayuSession.js'

/** Format a plan price (in cents) as a short display string. */
function formatPlanPrice(cents: number): string {
  if (!cents || cents <= 0) return 'Free'
  return `$${(cents / 100).toFixed(2)}/mo`
}

/** Format an ISO date as a short local date, or null when absent/unparseable. */
function formatDate(iso?: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * Build the /billing summary: the current plan (name + price + renewal +
 * included credits) followed by the website link to upgrade. Pure + exported
 * for testing.
 *
 * Every plan value comes from the backend-provided entitlements (which reflect
 * whatever the super-admin configured); only the label copy and the upgrade
 * URL's path are in code. When entitlements can't be loaded we still hand the
 * user the website link so they can manage/upgrade from the browser.
 */
export function formatBillingSummary(
  ent: RayuEntitlements | null,
  billingUrl: string,
): string {
  if (!ent) {
    return (
      'Could not load your plan right now.\n\n' +
      `To view or upgrade your plan, open the website:\n${billingUrl}`
    )
  }

  const lines: string[] = [
    `Current plan: ${ent.plan.name} (${formatPlanPrice(ent.plan.priceCents)})`,
  ]

  const renewal = formatDate(ent.plan.currentPeriodEnd)
  if (renewal) lines.push(`Renews: ${renewal}`)

  if (ent.creditAllowance?.creditsPerPeriod != null) {
    lines.push(
      `Included credits per period: ${ent.creditAllowance.creditsPerPeriod}`,
    )
  }
  if (typeof ent.topupBalance === 'number' && ent.topupBalance > 0) {
    lines.push(`Top-up balance: ${ent.topupBalance} credits`)
  }

  lines.push('')
  lines.push('To upgrade your plan, open the website:')
  lines.push(billingUrl)

  return lines.join('\n')
}

export async function call(): Promise<LocalCommandResult> {
  if (!hasRayuSession()) {
    return {
      type: 'text',
      value: 'Not signed in. Run /login to view your plan and billing.',
    }
  }

  // Prefer a live fetch so a recent upgrade/downgrade shows immediately; fall
  // back to the cached entitlements when the backend is unreachable.
  const ent = (await refreshRayuEntitlements()) ?? getCachedEntitlements()
  const billingUrl = `${getRayuWebBaseUrl()}/billing`
  return { type: 'text', value: formatBillingSummary(ent, billingUrl) }
}
