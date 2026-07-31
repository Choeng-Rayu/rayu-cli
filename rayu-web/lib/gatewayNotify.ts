import { gatewayUrl } from './config'

/**
 * Tell the gateway that admin configuration changed, so it re-reads it NOW.
 *
 * WHY THE DASHBOARD HAS TO ASK
 *
 * The gateway serves provider routes, models, keys and plan membership from an
 * in-memory snapshot refreshed on a timer (CONFIG_REFRESH_SECONDS, 30s by
 * default). That is what keeps a hosted request from touching MySQL, but it also
 * means a save is invisible to real traffic until the next tick: a model enabled
 * in the dashboard is still "not available on your plan" for up to half a minute,
 * and an edited model id is still the old one — which is indistinguishable from a
 * broken save.
 *
 * The backend cannot send this (it has no Redis client and no gateway
 * credentials), but the dashboard already talks to the gateway with the admin's
 * own token, so it asks directly. The gateway then fans the notice out to its
 * other replicas over Redis.
 *
 * BEST EFFORT BY DESIGN. The call carries no data and the gateway's periodic
 * refresh is still the safety net, so a failure here delays a change by seconds —
 * it never loses it. Nothing in the UI should block or fail on it.
 */
export type ConfigChangeReason = 'providers' | 'keys' | 'models' | 'plans' | 'manual'

export async function notifyGatewayConfigChanged(
  token: string | undefined | null,
  reason: ConfigChangeReason = 'manual',
  userId?: number,
): Promise<boolean> {
  if (!token) return false
  try {
    const res = await fetch(gatewayUrl('/v1/_reload'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(userId ? { reason, userId } : { reason }),
    })
    if (!res.ok) return false
    const body = (await res.json().catch(() => ({}))) as { reloaded?: boolean }
    return body.reloaded === true
  } catch {
    // Gateway unreachable from the browser (different host, blocked, offline).
    // The timer still picks the change up.
    return false
  }
}
