// Rayu hosted-model usage/credit status for the CLI. Reads the authoritative
// live usage from the gateway (GET /v1/credits) using the user's Rayu JWT, and
// formats it for the /usage command. The gateway is the billing source of
// truth; the CLI only displays. Never throws.
import {
  getRayuGatewayBaseUrl,
  getValidRayuAccessToken,
} from './rayuSession.js'

export interface RayuCreditStatus {
  plan: string
  planName: string
  priceCents: number
  creditsPerPeriod: number | null
  usedCredits: number
  remainingCredits: number | null
  tokensPerCredit: number
  allowanceTokens: number | null
  usedTokens: number | null
  remainingTokens: number | null
  resetSeconds: number
  periodEnd: string | null
  topupBalance: number
  topUpEnabled: boolean
}

/** Fetch live usage from the gateway. Returns null when signed out, the gateway
 *  is unreachable, or the response is not OK. */
export async function fetchRayuCredits(): Promise<RayuCreditStatus | null> {
  const token = await getValidRayuAccessToken()
  if (!token) return null
  try {
    const res = await (globalThis.fetch as typeof fetch)(
      `${getRayuGatewayBaseUrl()}/v1/credits`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) return null
    return (await res.json()) as RayuCreditStatus
  } catch {
    return null
  }
}

function fmtReset(seconds: number): string {
  if (!seconds || seconds <= 0) return 'soon'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`
}

/** Multi-line summary for the /usage command. */
export function formatRayuUsageSummary(c: RayuCreditStatus): string {
  const lines: string[] = []
  const price = c.priceCents > 0 ? ` (${usd(c.priceCents)}/mo)` : ''
  lines.push(`Plan: ${c.planName || c.plan}${price}`)
  if (c.periodEnd) {
    lines.push(`Renews: ${new Date(c.periodEnd).toLocaleDateString()}`)
  }
  if (c.creditsPerPeriod == null) {
    lines.push('No hosted credit allowance on this plan — upgrade at /billing.')
  } else {
    const remC = c.remainingCredits ?? 0
    lines.push(
      `Credits: ${c.usedCredits.toLocaleString()} / ${c.creditsPerPeriod.toLocaleString()} used · ${remC.toLocaleString()} left (resets in ${fmtReset(c.resetSeconds)})`,
    )
    if (c.allowanceTokens != null) {
      lines.push(
        `Tokens:  ${(c.usedTokens ?? 0).toLocaleString()} / ${c.allowanceTokens.toLocaleString()}`,
      )
    }
  }
  if (c.topUpEnabled) {
    lines.push(`Top-up balance: ${c.topupBalance.toLocaleString()} credits`)
  }
  return lines.join('\n')
}

/** Compact one-line summary (e.g. for a status segment). */
export function formatRayuUsageLine(c: RayuCreditStatus): string {
  if (c.creditsPerPeriod == null) return `Rayu: ${c.planName || c.plan}`
  return `Rayu: ${(c.remainingCredits ?? 0).toLocaleString()} / ${c.creditsPerPeriod.toLocaleString()} credits left`
}
