// Rayu hosted-model credit status for the CLI. Reads the authoritative live
// usage from the gateway (GET /v1/credits) using the user's Rayu JWT, and
// formats it for display. The gateway is the billing source of truth; the CLI
// only displays. Never throws.
import {
  getRayuGatewayBaseUrl,
  getValidRayuAccessToken,
} from './rayuSession.js'

export interface RayuCreditStatus {
  plan: string
  creditsPerWeek: number | null
  creditsPer5h: number | null
  used5h: number
  usedWeek: number
  remaining5h: number | null
  remainingWeek: number | null
  reset5hSeconds: number
  resetWeekSeconds: number
  topupBalance: number
  topUpEnabled: boolean
}

/** Fetch live credit usage from the gateway. Returns null when signed out,
 *  the gateway is unreachable, or the response is not OK. */
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
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** Multi-line summary for the /credits command. */
export function formatRayuCreditsSummary(c: RayuCreditStatus): string {
  const lines: string[] = [`Plan: ${c.plan}`]
  if (c.creditsPerWeek == null && c.creditsPer5h == null) {
    lines.push('No hosted credit allowance on this plan. Upgrade at /billing.')
  } else {
    const wk =
      c.remainingWeek == null
        ? 'unlimited'
        : `${c.remainingWeek.toLocaleString()} / ${(c.creditsPerWeek ?? 0).toLocaleString()}`
    lines.push(`This week: ${wk} credits left (resets in ${fmtReset(c.resetWeekSeconds)})`)
    const h5 =
      c.remaining5h == null
        ? 'unlimited'
        : `${c.remaining5h.toLocaleString()} / ${(c.creditsPer5h ?? 0).toLocaleString()}`
    lines.push(`This 5h: ${h5} credits left (resets in ${fmtReset(c.reset5hSeconds)})`)
  }
  if (c.topUpEnabled) {
    lines.push(`Top-up balance: ${c.topupBalance.toLocaleString()} credits`)
  }
  return lines.join('\n')
}

/** Compact one-line summary (e.g. for a status segment). */
export function formatRayuCreditsLine(c: RayuCreditStatus): string {
  if (c.remainingWeek == null) return `Rayu: unlimited credits`
  return `Rayu: ${c.remainingWeek.toLocaleString()} credits left this week`
}
