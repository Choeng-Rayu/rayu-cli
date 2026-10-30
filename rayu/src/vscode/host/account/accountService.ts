/**
 * The Account section's view of the signed-in Rayu account, built in the extension host.
 *
 * ── TOKEN-FREE BY CONSTRUCTION ─────────────────────────────────────────────────
 *
 * The sources below call rayu-backend and rayu-gateway with the account's bearer token,
 * HERE. What leaves this module for the (untrusted) webview is `AccountView`: names,
 * numbers and dates, mapped field by field, so nothing secret can ride along by accident.
 *
 * ── THREE INDEPENDENT PARTS ────────────────────────────────────────────────────
 *
 * The profile (`GET /me`), the plan and credits (`GET /v1/credits` on the gateway),
 * this month's feature usage (`GET /usage/features`) and the device registry
 * (`GET /devices`) are separate services. Each part that fails is reported on its own,
 * so an unreachable gateway does not hide who is signed in. Entitlements are never
 * refreshed from here: that would change which models the running conversations offer.
 *
 * Free of `vscode` imports; every source is injected.
 */
import {
  isPacingEnforced,
  PACING_SWITCH_HINT,
  TEAM_PACING_HINT,
  type RayuCreditStatus,
} from '../../../services/rayuAuth/rayuCredits.js'
import type { RemoteDevice } from '../../../services/rayuAuth/rayuDevices.js'
import type { FeatureUsageRow } from '../../../services/rayuAuth/rayuFeatureUsage.js'
import type { RayuProfile } from '../../../services/rayuAuth/rayuProfile.js'
import type {
  AccountIdentityView,
  AccountUsageView,
  AccountView,
  CreditWindowView,
  DeviceView,
} from '../../shared/settingsProtocol.js'
import type { AuthSnapshot } from '../auth/rayuAuthBridge.js'

export interface AccountSources {
  auth(): AuthSnapshot
  /** An account session exists, as opposed to only a Rayu API key. */
  hasAccountSession(): boolean
  profile(): Promise<RayuProfile | null>
  credits(): Promise<RayuCreditStatus | null>
  features(): Promise<FeatureUsageRow[] | null>
  devices(): Promise<RemoteDevice[] | null>
  /** This machine's device id, when the CLI has given it one. */
  thisDeviceId(): string | null
  now(): number
}

export const USAGE_UNAVAILABLE =
  'Could not load your plan and credits from Rayu. Check your connection, or sign in again if this continues.'
export const FEATURES_UNAVAILABLE = "Could not load this month's feature usage."
export const DEVICES_UNAVAILABLE = 'Could not load your devices.'

export async function loadAccountView(sources: AccountSources): Promise<AccountView> {
  const auth = sources.auth()
  if (!auth.oauthEnabled) return { kind: 'disabled' }
  if (!sources.hasAccountSession()) return auth.signedIn ? { kind: 'apiKey' } : { kind: 'signedOut' }
  const [profile, credits, features, devices] = await Promise.all([
    sources.profile(),
    sources.credits(),
    sources.features(),
    sources.devices(),
  ])
  return {
    kind: 'signedIn',
    identity: identityView(auth, profile),
    usage: credits ? { ok: true, value: usageView(credits, sources.now()) } : { ok: false, error: USAGE_UNAVAILABLE },
    features: features
      ? { ok: true, value: features.map(({ key, label, used, limit }) => ({ key, label, used, limit })) }
      : { ok: false, error: FEATURES_UNAVAILABLE },
    devices: devices
      ? { ok: true, value: devicesView(devices, sources.thisDeviceId()) }
      : { ok: false, error: DEVICES_UNAVAILABLE },
  }
}

/** The devices, this machine first, then the most recently seen. Field by field, as everywhere here. */
export function devicesView(devices: readonly RemoteDevice[], thisDeviceId: string | null): DeviceView[] {
  return devices
    .map(device => ({
      deviceId: device.deviceId,
      name: device.deviceName,
      platform: device.platform,
      arch: device.arch,
      version: device.version,
      status: device.online ? 'online' : device.status,
      lastSeenAt: typeof device.lastSeenAt === 'string' ? device.lastSeenAt : '',
      thisMachine: device.deviceId === thisDeviceId,
    }))
    .sort((a, b) => Number(b.thisMachine) - Number(a.thisMachine) || b.lastSeenAt.localeCompare(a.lastSeenAt))
}

/** The live profile when it loaded, otherwise who signed in, as stored at sign-in. */
function identityView(auth: AuthSnapshot, profile: RayuProfile | null): AccountIdentityView {
  return {
    displayName: profile?.user.displayName ?? auth.identity?.displayName ?? null,
    email: profile?.user.email ?? auth.identity?.email ?? null,
    active: profile ? profile.status === 'active' : true,
  }
}

/** The plan, credits and limits, with every relative time made absolute at `now`. */
export function usageView(credits: RayuCreditStatus, now: number): AccountUsageView {
  const perPeriod = credits.creditsPerPeriod
  return {
    planName: credits.planName || credits.plan,
    priceCents: credits.priceCents,
    renewsAt: credits.periodEnd,
    credits: perPeriod == null
      ? null
      : {
          perPeriod,
          used: credits.usedCredits,
          remaining: credits.remainingCredits ?? Math.max(0, perPeriod - credits.usedCredits),
        },
    pacing: pacingView(credits, now),
    team: credits.scope === 'team',
    dailyTurns: dailyTurnsView(credits, now),
    topUpBalance: credits.topUpEnabled ? credits.topupBalance : null,
  }
}

function pacingView(credits: RayuCreditStatus, now: number): AccountUsageView['pacing'] {
  const windows: CreditWindowView[] = []
  const add = (id: CreditWindowView['id'], cap: number | null | undefined, used: number | undefined, resetSeconds: number | undefined): void => {
    // A missing or zero cap means the plan does not set the window: there is nothing to show.
    if (cap == null || cap <= 0) return
    windows.push({ id, cap, used: used ?? 0, resetsAt: resetsAt(now, resetSeconds) })
  }
  add('session', credits.creditsPer5h, credits.windowUsedCredits, credits.windowResetSeconds)
  add('weekly', credits.creditsPerWeek, credits.weekUsedCredits, credits.weekResetSeconds)
  const enforced = isPacingEnforced(credits)
  const full = enforced && windows.some(window => window.used >= window.cap)
  return {
    enforced,
    windows,
    advice: full ? (credits.scope === 'team' ? TEAM_PACING_HINT : PACING_SWITCH_HINT) : null,
  }
}

function dailyTurnsView(credits: RayuCreditStatus, now: number): AccountUsageView['dailyTurns'] {
  const max = credits.maxDailyTurns
  if (max == null || max <= 0) return null
  const used = credits.turnsUsedToday ?? 0
  return {
    max,
    used,
    remaining: credits.turnsRemaining ?? Math.max(0, max - used),
    resetsAt: resetsAt(now, credits.turnsResetSeconds),
  }
}

function resetsAt(now: number, seconds: number | undefined): number | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : null
}
