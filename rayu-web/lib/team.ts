// Shared types + pure helpers for the Team (organization) dashboard.
//
// The types mirror the backend's /organizations responses. The helpers are pure
// so the numbers the UI shows (pool usage, a member's remaining quota, whether
// the admin has over-allocated) are unit-testable without rendering anything —
// billing figures are the last place you want to discover a display bug from a
// user's screenshot.

export type OrgRole = 'admin' | 'member'
export type OrgStatus = 'active' | 'suspended'

export interface TeamPlan {
  code: string
  name: string
  priceCents: number
  isTeamPlan: boolean
  seatCredits: number
}

export interface TeamCreditPool {
  totalCredits: number
  usedCredits: number
  remainingCredits: number
  /**
   * Credits the admin BOUGHT for the current period, on top of the plan's
   * allowance. Optional because an older backend (or an admin page built before
   * this shipped) may not send it; absent means the team bought nothing.
   */
  extraCredits?: number
  /** What is left of the plan's own allowance. Spent before purchased credits. */
  planRemaining?: number
  /** What is left of the purchased credits. */
  extraRemaining?: number
  periodEnd: string | null
}

export interface TeamSubscription {
  status: string
  currentPeriodEnd: string | null
}

export interface Team {
  id: number
  name: string
  slug: string
  ssoDomain: string | null
  status: OrgStatus
  adminId: number
  createdAt: string
  plan: TeamPlan | null
  subscription: TeamSubscription | null
  creditPool: TeamCreditPool | null
}

export interface TeamMember {
  userId: number
  email: string | null
  displayName: string | null
  avatarUrl: string | null
  role: OrgRole
  status: string
  bucketQuota: number
  bucketCredits: number
  joinedAt: string
}

export interface TeamInvite {
  id: number
  email: string
  role: OrgRole
  status?: string
  expiresAt: string
  createdAt: string
}

/** Live state of a shareable join link, as the backend computes it. */
export type JoinLinkState = 'active' | 'revoked' | 'expired'

export type JoinRequestStatus = 'pending' | 'approved' | 'rejected' | 'canceled'

/**
 * The team's ONE shareable join link. Only an admin ever receives this — `url`
 * contains the token — and holding it grants nothing but the right to file a
 * TeamJoinRequest, which an admin still has to approve.
 */
export interface TeamJoinLink {
  id: number
  url: string
  role: OrgRole
  status: string
  state: JoinLinkState
  expiresAt: string | null
  useCount: number
  createdAt: string
}

/** Someone who opened the link and is waiting to be let in. Admin view. */
export interface TeamJoinRequest {
  id: number
  userId: number
  email: string | null
  displayName: string | null
  avatarUrl: string | null
  status: JoinRequestStatus
  message: string | null
  createdAt: string
  decidedAt: string | null
}

/** One pay-as-you-go credit purchase, as the team admin's receipt list shows it. */
export interface TeamCreditPurchase {
  id: number
  credits: number
  amountCents: number
  status: string
  purchasedBy: string | null
  targetUserId: number | null
  /** Display name of the member it was earmarked for; null = the shared pool. */
  targetName: string | null
  expiresAt: string | null
  createdAt: string
}

export interface TeamDetail extends Team {
  viewer: { userId: number; role: OrgRole; bucketCredits: number; bucketQuota: number }
  members: TeamMember[]
  invites: TeamInvite[]
  /** null for a plain member, and for an admin who has not created one yet. */
  joinLink: TeamJoinLink | null
  joinRequests: TeamJoinRequest[]
  /** Admin-only receipt trail. Empty for a plain member. */
  creditPurchases: TeamCreditPurchase[]
}

/** What the /join/<token> landing page gets for a signed-in visitor. */
export interface JoinLinkPreview {
  team: {
    name: string
    slug: string
    ssoDomain: string | null
    status: OrgStatus
    memberCount: number
  }
  linkStatus: JoinLinkState
  membership: 'member' | 'other_team' | 'none'
  otherTeamSlug: string | null
  request: {
    id: number
    status: JoinRequestStatus
    createdAt: string
    decidedAt: string | null
  } | null
}

export interface TeamMembership {
  role: OrgRole
  bucketCredits: number
  bucketQuota: number
  organization: Team
}

/**
 * A live price for buying team credits (GET /payments/team/<slug>/topup/quote).
 *
 * Mirrors the backend field for field. A client must NEVER compute a price from a
 * rate of its own: `amountCents` is what the purchase costs at the admin's
 * current rate, and `expiresAt`/`daysLeft` are what the buyer has to see before
 * paying, because purchased credits die with the period they land in.
 */
export interface TeamTopupQuote {
  enabled: boolean
  credits: number
  amountCents: number
  currency: string
  minCredits: number
  maxCredits: number
  rateCreditsPerDollar: number
  minTopupCents: number
  meetsMinimum: boolean
  /** Machine reason the purchase is blocked; null when it is allowed. */
  reason: string | null
  /** Human, actionable version of `reason`. */
  message: string | null
  slug: string
  planCode: string | null
  planName: string | null
  expiresAt: string | null
  daysLeft: number | null
  expiresSoon: boolean
  pool: { totalCredits: number; usedCredits: number; extraCredits: number }
}

/** A team credit purchase awaiting payment (POST /payments/team/<slug>/topup). */
export interface TeamTopupCheckout {
  paymentId: number
  topupId: number
  credits: number
  targetUserId: number | null
  amountCents: number
  currency: string
  qr: string
  md5: string
  expiresAt: string
  creditsExpireAt: string | null
  reused: boolean
}

/**
 * When purchased credits stop being spendable, phrased for the person about to
 * pay. Empty when there is no period to expire into — nothing to promise.
 */
export function creditExpiryLabel(
  expiresAt: string | null,
  daysLeft: number | null,
): string {
  if (!expiresAt) return ''
  const when = new Date(expiresAt).toLocaleDateString()
  if (daysLeft == null) return `expires ${when}`
  if (daysLeft <= 0) return 'expires today'
  return `expires ${when} (${daysLeft} day${daysLeft === 1 ? '' : 's'})`
}

/**
 * The warning to show BEFORE the pay button, or null when there is nothing to
 * warn about.
 *
 * Purchased credits are zeroed when the period renews, so buying two days out is
 * buying two days. Allowing that is the product decision; saying so at the moment
 * of payment rather than at renewal is the honest way to ship it.
 */
export function purchaseWarning(quote: TeamTopupQuote | null): string | null {
  if (!quote || !quote.enabled) return null
  if (!quote.expiresSoon || quote.daysLeft == null) return null
  if (quote.daysLeft <= 0) {
    return 'These credits expire today, when the team period ends. Renew the team plan instead — credits bought now would be gone almost immediately.'
  }
  return `These credits expire in ${quote.daysLeft} day${quote.daysLeft === 1 ? '' : 's'}, when the team period ends. If you need a lasting increase, renew or upgrade the team plan instead.`
}

/** Percentage of the shared pool already spent, clamped to 0-100. */
export function poolUsedPct(pool: TeamCreditPool | null): number {
  const allowance = teamAllowance(pool)
  if (allowance <= 0) return 0
  const p = ((pool?.usedCredits ?? 0) / allowance) * 100
  return Math.max(0, Math.min(100, p))
}

/**
 * Everything the team may spend this period: the plan's allowance plus whatever
 * was bought. This is the denominator for every usage figure — showing usage
 * against the plan alone would put a topped-up team at "150% used".
 */
export function teamAllowance(pool: TeamCreditPool | null): number {
  if (!pool) return 0
  return pool.totalCredits + (pool.extraCredits ?? 0)
}

/**
 * What is left of each tier. Spending fills the plan's allowance first (one
 * counter covers both), so purchased credits are only touched once the plan's
 * are gone. Derived here as well as server-side so a page can render the split
 * from a payload that predates those fields.
 */
export function allowanceSplit(pool: TeamCreditPool | null): {
  plan: number
  purchased: number
  total: number
} {
  if (!pool) return { plan: 0, purchased: 0, total: 0 }
  const extra = pool.extraCredits ?? 0
  const plan = Math.max(0, pool.totalCredits - pool.usedCredits)
  const intoExtra = Math.max(0, pool.usedCredits - pool.totalCredits)
  const purchased = Math.max(0, extra - intoExtra)
  return { plan, purchased, total: plan + purchased }
}

/**
 * Sum of the quotas handed out to active members. Shown next to the pool so an
 * admin can see when they have promised more than the team bought — which is
 * allowed (the pool is the real cap) but worth knowing about.
 */
export function allocatedCredits(members: TeamMember[]): number {
  return members
    .filter((m) => m.status === 'active')
    .reduce((sum, m) => sum + m.bucketQuota, 0)
}

/** True when member quotas add up to more than the pool holds. */
export function isOverAllocated(
  members: TeamMember[],
  pool: TeamCreditPool | null,
): boolean {
  if (!pool || pool.totalCredits <= 0) return false
  return allocatedCredits(members) > pool.totalCredits
}

/** The equal-split quota the backend would default to for N active members. */
export function equalSplit(pool: TeamCreditPool | null, memberCount: number): number {
  if (!pool || pool.totalCredits <= 0 || memberCount <= 0) return 0
  return Math.floor(pool.totalCredits / memberCount)
}

/**
 * Turn a team name into a candidate slug matching the backend's rule: lowercase
 * letters/digits/single dashes, no leading or trailing dash, 3-64 chars. Returns
 * '' when nothing usable is left, so the form asks for one instead of posting
 * something the API will reject.
 */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return s.length >= 3 ? s : ''
}

/** Mirrors the backend's slug validation so the form can flag it before posting. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/.test(slug)
}

/**
 * Normalize an SSO domain for display: lowercase with a single leading '@'.
 * Empty input yields '' (an invite-only team).
 */
export function normalizeDomainInput(input: string): string {
  const bare = input.trim().toLowerCase().replace(/^@+/, '')
  return bare ? `@${bare}` : ''
}

/** How much of a member's own quota they have spent, as a percentage. */
export function bucketUsedPct(member: {
  bucketQuota: number
  bucketCredits: number
}): number {
  if (member.bucketQuota <= 0) return 0
  const used = member.bucketQuota - member.bucketCredits
  return Math.max(0, Math.min(100, (used / member.bucketQuota) * 100))
}

/**
 * One-line status for the team's billing state, written for the person reading
 * it: what is wrong and who can fix it.
 */
export function billingStatusLabel(team: Team): string {
  if (team.status === 'suspended') return 'Team suspended — contact support'
  if (!team.subscription || !team.plan) {
    return 'No team plan yet — buy one to give members credits'
  }
  if (team.subscription.status === 'past_due') {
    return 'Payment past due — members cannot spend team credits'
  }
  if (team.subscription.status === 'canceled') return 'Team plan canceled'
  const end = team.subscription.currentPeriodEnd
  if (end && new Date(end).getTime() <= Date.now()) {
    return 'Team period ended — renew to restore access'
  }
  return 'Active'
}

/** True when members can currently spend the team's credits. */
export function isTeamBillable(team: Team): boolean {
  return billingStatusLabel(team) === 'Active'
}

/**
 * One line describing the join link for the admin who is looking at it: whether
 * it works, and until when. Written as advice rather than as a status word,
 * because "revoked" and "expired" need different next actions.
 */
export function joinLinkLabel(link: TeamJoinLink | null): string {
  if (!link) return 'No join link yet — create one to share'
  if (link.state === 'revoked') return 'Turned off — create a new link to share again'
  if (link.state === 'expired') return 'Expired — create a new link to share again'
  const expiry = link.expiresAt
    ? `expires ${new Date(link.expiresAt).toLocaleDateString()}`
    : 'never expires'
  const used =
    link.useCount === 0
      ? 'not used yet'
      : `${link.useCount} request${link.useCount === 1 ? '' : 's'} so far`
  return `Live · ${expiry} · ${used}`
}

/**
 * Why this visitor cannot ask to join right now, in their own terms — or null
 * when the "Ask to join" button should be enabled. The backend enforces every
 * one of these; this exists so the page explains the outcome BEFORE the click
 * instead of after a rejected request.
 */
export function joinBlockedReason(preview: JoinLinkPreview): string | null {
  if (preview.team.status !== 'active') {
    return 'This team is suspended, so it cannot take new members right now.'
  }
  if (preview.linkStatus === 'revoked') {
    return 'This join link has been turned off. Ask the team admin for a new one.'
  }
  if (preview.linkStatus === 'expired') {
    return 'This join link has expired. Ask the team admin for a new one.'
  }
  if (preview.membership === 'member') return "You're already a member of this team."
  if (preview.membership === 'other_team') {
    return `You're already on the team "${preview.otherTeamSlug ?? 'another team'}". Leave it first — one team per account in this version.`
  }
  if (preview.request?.status === 'pending') {
    return 'Your request is waiting for a team admin to approve it.'
  }
  return null
}
