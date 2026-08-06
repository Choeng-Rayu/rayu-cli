import { randomBytes } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type {
  CreditPool,
  Organization,
  OrganizationMember,
  Plan,
  Prisma,
} from '@prisma/client'
import type { OrgRole } from '../common/enums'
import { PlansService } from '../plans/plans.service'
import { PrismaService } from '../prisma/prisma.service'
import type { CreateOrganizationDto } from './dto'

/** Invite links are valid for a week — long enough to survive a weekend. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Default lifetime of a shareable join link. Longer than an email invite because
 * it is an onboarding channel rather than a one-off ("new hires, use this link"),
 * and it is safe to leave lying around: it only produces requests an admin still
 * has to approve. Still finite, so a link forgotten in an old chat dies on its own.
 */
const JOIN_LINK_TTL_DAYS = 30

/** One billing period, matching the individual plan period in PaymentsService. */
const PERIOD_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Consumer email domains can never be an org's `ssoDomain`.
 *
 * Google only sends the `hd` claim for Workspace accounts, so a personal
 * @gmail.com sign-in would not match anyway — but a team that claimed
 * "@gmail.com" would be a standing trap (any future provider that did report a
 * consumer domain would silently hand it every one of those users), and the
 * unique constraint means the claim could not be taken back by anyone else.
 * Refusing it up front is cheaper than auditing it later.
 */
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'gmx.com',
  'mail.com',
  'yandex.com',
  'zoho.com',
  'qq.com',
  '163.com',
])

/** The org context carried in the Rayu JWT (absent for individual users). */
export interface OrgContext {
  orgId: number
  orgRole: OrgRole
  slug: string
}

/**
 * Raised when a team has no credits left to serve a request — the member's
 * bucket AND the shared pool are both exhausted.
 */
export class InsufficientCreditsError extends Error {
  constructor(message = 'Team credit pool exhausted') {
    super(message)
    this.name = 'InsufficientCreditsError'
  }
}

/** Result of debiting a member's bucket (which tier actually paid). */
export interface ChargeResult {
  /** 'bucket' = fully covered by the member's own quota; 'pool' = overflowed. */
  source: 'bucket' | 'pool'
  fromBucket: number
  fromPool: number
  bucketRemaining: number
  poolRemaining: number
}

type MemberWithUser = OrganizationMember & {
  user: { id: number; email: string | null; displayName: string | null; avatarUrl: string | null }
}

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
    private readonly config: ConfigService,
  ) {}

  // --- Domain helpers --------------------------------------------------------

  /**
   * Normalize a hosted domain to the stored form: lowercase, exactly one
   * leading '@' ("Company.COM" and "@company.com" both become "@company.com").
   * Storing one canonical form is what lets the SSO lookup be a single indexed
   * equality check instead of a scan with per-row normalization.
   */
  normalizeSsoDomain(input: string): string {
    const bare = input.trim().toLowerCase().replace(/^@+/, '')
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(bare)) {
      throw new BadRequestException(`Not a valid domain: ${input}`)
    }
    if (PUBLIC_EMAIL_DOMAINS.has(bare)) {
      throw new BadRequestException(
        `${bare} is a consumer email domain and cannot be used for team SSO. Use your company's Google Workspace domain, or invite members by email instead.`,
      )
    }
    return `@${bare}`
  }

  // --- Membership resolution (used by the auth layer) ------------------------

  /**
   * The user's ACTIVE team seat, or null for an individual user. This is what
   * becomes the JWT's `orgId`/`orgRole`, so it deliberately ignores memberships
   * in a suspended org and removed seats: no claim ⇒ the gateway bills the user
   * individually, which is exactly the right fallback.
   */
  async findActiveMembership(userId: number): Promise<OrgContext | null> {
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        userId,
        status: 'active',
        organization: { status: 'active' },
      },
      include: { organization: { select: { id: true, slug: true } } },
      orderBy: { joinedAt: 'asc' },
    })
    if (!member) return null
    return {
      orgId: member.organizationId,
      orgRole: member.role as OrgRole,
      slug: member.organization.slug,
    }
  }

  /**
   * SSO auto-join: adopt a Google Workspace signer into the org that owns their
   * hosted domain.
   *
   * `hostedDomain` is the `hd` claim from the Google-signed ID token (verified
   * server-side in OAuthService), which is why this is safe to trust and why no
   * SAML/IdP integration is needed. Returns null — leaving the user a plain
   * individual account — when: there is no `hd` (personal Google account), no
   * org claims that domain, the org is suspended, or the user already holds a
   * seat somewhere else (v1 is one team per user; we never silently move
   * someone between teams).
   */
  async autoJoinFromHostedDomain(
    userId: number,
    hostedDomain: string | null | undefined,
  ): Promise<OrgContext | null> {
    if (!hostedDomain) return null
    let ssoDomain: string
    try {
      ssoDomain = this.normalizeSsoDomain(hostedDomain)
    } catch {
      // A malformed/consumer hd is simply not an org domain — not an auth error.
      return null
    }
    const org = await this.prisma.organization.findUnique({ where: { ssoDomain } })
    if (!org || org.status !== 'active') return null

    const existing = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId } },
    })
    if (!existing) {
      // Already on another team? Leave them there rather than reassigning.
      const elsewhere = await this.findActiveMembership(userId)
      if (elsewhere) return elsewhere
      const quota = await this.defaultSeatQuota(org.id)
      await this.prisma.organizationMember.create({
        data: {
          organizationId: org.id,
          userId,
          role: 'member',
          bucketQuota: quota,
          bucketCredits: quota,
          status: 'active',
        },
      })
      this.logger.log(
        `SSO auto-join: user=${userId} joined org=${org.slug} via hd=${ssoDomain}`,
      )
    } else if (existing.status !== 'active') {
      // Re-activate a previously removed seat (they still work there).
      await this.prisma.organizationMember.update({
        where: { id: existing.id },
        data: { status: 'active' },
      })
    }
    // A pending email invite for this person is now redundant.
    await this.markInvitesAccepted(org.id, userId)

    const member = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId } },
    })
    return member
      ? { orgId: org.id, orgRole: member.role as OrgRole, slug: org.slug }
      : null
  }

  private async markInvitesAccepted(orgId: number, userId: number): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user?.email) return
    await this.prisma.organizationInvite.updateMany({
      where: { organizationId: orgId, email: user.email, status: 'pending' },
      data: { status: 'accepted' },
    })
  }

  // --- Team CRUD -------------------------------------------------------------

  /**
   * Create a team. The creator becomes its admin and its first member, and an
   * empty credit pool is created immediately so every later code path can assume
   * `org.creditPool` exists (it is seeded with credits when a Team plan is paid).
   */
  async createOrganization(userId: number, dto: CreateOrganizationDto) {
    const existing = await this.findActiveMembership(userId)
    if (existing) {
      throw new ConflictException(
        `You are already on the team "${existing.slug}". Leave it before creating another — one team per account in this version.`,
      )
    }
    const ssoDomain = dto.ssoDomain?.trim()
      ? this.normalizeSsoDomain(dto.ssoDomain)
      : null

    const slugTaken = await this.prisma.organization.findUnique({
      where: { slug: dto.slug },
    })
    if (slugTaken) {
      throw new ConflictException(`Team address "${dto.slug}" is taken`)
    }
    if (ssoDomain) {
      const domainTaken = await this.prisma.organization.findUnique({
        where: { ssoDomain },
      })
      if (domainTaken) {
        throw new ConflictException(
          `${ssoDomain} is already claimed by another team. Contact support if this is your company's domain.`,
        )
      }
    }

    const org = await this.prisma.organization.create({
      data: {
        name: dto.name.trim(),
        slug: dto.slug,
        ssoDomain,
        adminId: userId,
        status: 'active',
        members: {
          create: { userId, role: 'admin', status: 'active' },
        },
        creditPool: { create: {} },
      },
      include: { creditPool: true },
    })
    this.logger.log(`team created: org=${org.slug} admin=${userId} sso=${ssoDomain ?? 'none'}`)
    return this.publicOrg(org)
  }

  /** Load a team by slug, asserting the caller is a member. */
  async getForMember(slug: string, userId: number) {
    const org = await this.loadOrg(slug)
    const me = await this.membershipOf(org.id, userId)
    if (!me) throw new ForbiddenException('You are not a member of this team')
    const isAdmin = me.role === 'admin'
    const [members, invites, joinLink, joinRequests, creditPurchases] = await Promise.all([
      this.prisma.organizationMember.findMany({
        where: { organizationId: org.id, status: 'active' },
        include: {
          user: {
            select: { id: true, email: true, displayName: true, avatarUrl: true },
          },
        },
        orderBy: { joinedAt: 'asc' },
      }),
      isAdmin
        ? this.prisma.organizationInvite.findMany({
            where: { organizationId: org.id, status: 'pending' },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
      // The link CONTAINS a secret, so it never leaves the admin branch.
      isAdmin
        ? this.prisma.organizationJoinLink.findUnique({
            where: { organizationId: org.id },
          })
        : Promise.resolve(null),
      isAdmin
        ? this.prisma.organizationJoinRequest.findMany({
            where: { organizationId: org.id, status: 'pending' },
            include: {
              user: { select: { email: true, displayName: true, avatarUrl: true } },
            },
            orderBy: { createdAt: 'asc' },
          })
        : Promise.resolve([]),
      // Credit purchases are the admin's receipt trail: what was bought, for
      // whom, and whether the money actually landed. Pending rows are included
      // deliberately — an admin who closed the QR tab needs to see that the
      // purchase is still waiting rather than assume it failed.
      isAdmin
        ? this.prisma.organizationCreditTopup.findMany({
            where: { organizationId: org.id },
            include: {
              purchasedBy: { select: { email: true, displayName: true } },
              targetUser: { select: { email: true, displayName: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 20,
          })
        : Promise.resolve([]),
    ])
    return {
      ...this.publicOrg(org),
      viewer: { userId, role: me.role, bucketCredits: me.bucketCredits, bucketQuota: me.bucketQuota },
      // Every member sees the roster (that is the point of a team); only the
      // admin sees pending invites, the join link, and who is asking to join.
      members: members.map((m) => this.publicMember(m as MemberWithUser)),
      invites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
      })),
      joinLink: joinLink ? this.publicJoinLink(joinLink, org.slug) : null,
      joinRequests: joinRequests.map((r) => this.adminJoinRequest(r)),
      creditPurchases: creditPurchases.map((p) => ({
        id: p.id,
        credits: p.credits,
        amountCents: p.amountCents,
        status: p.status,
        // Who paid, and who it was earmarked for (null = the shared pool).
        purchasedBy: p.purchasedBy?.displayName ?? p.purchasedBy?.email ?? null,
        targetUserId: p.targetUserId,
        targetName: p.targetUser?.displayName ?? p.targetUser?.email ?? null,
        expiresAt: p.expiresAt,
        createdAt: p.createdAt,
      })),
    }
  }

  /** Teams the user belongs to (0 or 1 in v1, shaped as a list for the UI). */
  async listMine(userId: number) {
    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId, status: 'active' },
      include: {
        organization: {
          include: { creditPool: true, subscription: { include: { plan: true } } },
        },
      },
      orderBy: { joinedAt: 'asc' },
    })
    return memberships.map((m) => ({
      role: m.role,
      bucketCredits: m.bucketCredits,
      bucketQuota: m.bucketQuota,
      organization: this.publicOrg(m.organization),
    }))
  }

  /**
   * Assert the caller administers this team. Used by OrgAdminGuard and by every
   * admin-only service method (the guard keeps the HTTP layer honest; the
   * in-service check keeps a future internal caller honest too).
   */
  async requireAdmin(slug: string, userId: number): Promise<Organization> {
    const org = await this.loadOrg(slug)
    const me = await this.membershipOf(org.id, userId)
    if (!me || me.role !== 'admin') {
      throw new ForbiddenException('Team admin access required')
    }
    return org
  }

  // --- Invites ---------------------------------------------------------------

  /**
   * Invite someone by email. There is no email provider wired into this backend
   * yet, so the accept URL is RETURNED to the admin (and logged) to copy — the
   * flow is complete and testable today, and swapping in a mailer later changes
   * only this method.
   */
  async invite(slug: string, adminUserId: number, email: string, role: OrgRole = 'member') {
    const org = await this.requireAdmin(slug, adminUserId)
    const normalized = email.trim().toLowerCase()

    const alreadyMember = await this.prisma.organizationMember.findFirst({
      where: {
        organizationId: org.id,
        status: 'active',
        user: { email: normalized },
      },
    })
    if (alreadyMember) {
      throw new ConflictException(`${normalized} is already on this team`)
    }

    const token = randomBytes(24).toString('hex') // 48 chars, fits VarChar(64)
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
    // Re-inviting the same address REPLACES the previous invite (new token, new
    // expiry) instead of failing on the unique constraint — the admin's intent
    // is "send it again", and the old link must stop working.
    const invite = await this.prisma.organizationInvite.upsert({
      where: { organizationId_email: { organizationId: org.id, email: normalized } },
      create: {
        organizationId: org.id,
        email: normalized,
        role,
        status: 'pending',
        token,
        expiresAt,
      },
      update: { role, status: 'pending', token, expiresAt },
    })
    const acceptUrl = this.inviteUrl(org.slug, invite.token)
    this.logger.log(`team invite: org=${org.slug} email=${normalized} url=${acceptUrl}`)
    return {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt,
      acceptUrl,
    }
  }

  /** Revoke a pending invite (its link stops working immediately). */
  async revokeInvite(slug: string, adminUserId: number, inviteId: number) {
    const org = await this.requireAdmin(slug, adminUserId)
    const invite = await this.prisma.organizationInvite.findUnique({
      where: { id: inviteId },
    })
    if (!invite || invite.organizationId !== org.id) {
      throw new NotFoundException('Invite not found')
    }
    await this.prisma.organizationInvite.update({
      where: { id: invite.id },
      data: { status: 'revoked' },
    })
    return { id: invite.id, status: 'revoked' as const }
  }

  /**
   * Accept an invite. The signed-in account's email must match the invited
   * address — otherwise a leaked link would be a free seat on someone else's
   * paid team.
   */
  async acceptInvite(token: string, userId: number): Promise<OrgContext> {
    const invite = await this.prisma.organizationInvite.findUnique({
      where: { token },
      include: { organization: true },
    })
    if (!invite || invite.status !== 'pending') {
      throw new NotFoundException('Invite is invalid or has already been used')
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Invite has expired — ask the team admin to send a new one')
    }
    if (invite.organization.status !== 'active') {
      throw new ForbiddenException('This team is suspended')
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new NotFoundException('User not found')
    if (!user.email || user.email.toLowerCase() !== invite.email.toLowerCase()) {
      throw new ForbiddenException(
        `This invite is for ${invite.email}. Sign in with that account to accept it.`,
      )
    }
    const elsewhere = await this.prisma.organizationMember.findFirst({
      where: {
        userId,
        status: 'active',
        organizationId: { not: invite.organizationId },
      },
      include: { organization: { select: { slug: true } } },
    })
    if (elsewhere) {
      throw new ConflictException(
        `You are already on the team "${elsewhere.organization.slug}". Leave it first — one team per account in this version.`,
      )
    }

    const quota = await this.defaultSeatQuota(invite.organizationId)
    await this.prisma.$transaction([
      this.prisma.organizationMember.upsert({
        where: {
          organizationId_userId: {
            organizationId: invite.organizationId,
            userId,
          },
        },
        create: {
          organizationId: invite.organizationId,
          userId,
          role: invite.role,
          bucketQuota: quota,
          bucketCredits: quota,
          status: 'active',
        },
        update: { status: 'active', role: invite.role },
      }),
      this.prisma.organizationInvite.update({
        where: { id: invite.id },
        data: { status: 'accepted' },
      }),
    ])
    return {
      orgId: invite.organizationId,
      orgRole: invite.role as OrgRole,
      slug: invite.organization.slug,
    }
  }

  // --- Join links + join requests -------------------------------------------
  //
  // The email invite above answers "let this ONE address in". A join link answers
  // "let me post something in the team chat" — a different question, and it must
  // NOT be solved by an invite with the email left blank: an invite is the
  // entitlement, so a bearer token that spreads by design would hand a seat on a
  // paid team to anyone it reached. So the link grants only the right to ASK, and
  // the admin's approval is what creates the seat.

  /**
   * Create the team's shareable join link, or REGENERATE it if one exists.
   *
   * Regenerating replaces the token, which is the only way to make a link that is
   * already circulating stop working. One link per team (unique organizationId)
   * so there is never a question of which of several live secrets is the real one.
   */
  async createJoinLink(
    slug: string,
    adminUserId: number,
    opts: { role?: OrgRole; expiresInDays?: number | null } = {},
  ) {
    const org = await this.requireAdmin(slug, adminUserId)
    const role: OrgRole = opts.role ?? 'member'
    const days =
      opts.expiresInDays === null
        ? null
        : Math.min(365, Math.max(1, opts.expiresInDays ?? JOIN_LINK_TTL_DAYS))
    const expiresAt = days === null ? null : new Date(Date.now() + days * DAY_MS)
    const token = randomBytes(24).toString('hex') // 48 chars, fits VarChar(64)

    const link = await this.prisma.organizationJoinLink.upsert({
      where: { organizationId: org.id },
      create: {
        organizationId: org.id,
        token,
        role,
        status: 'active',
        expiresAt,
        createdById: adminUserId,
      },
      // useCount is deliberately NOT reset: it counts how far this team's links
      // have travelled overall, which is the number worth watching.
      update: { token, role, status: 'active', expiresAt, createdById: adminUserId },
    })
    this.logger.log(
      `team join link issued: org=${org.slug} by=${adminUserId} role=${role} expires=${expiresAt?.toISOString() ?? 'never'}`,
    )
    return this.publicJoinLink(link, org.slug)
  }

  /** Kill the team's join link. Requests already filed through it survive. */
  async revokeJoinLink(slug: string, adminUserId: number) {
    const org = await this.requireAdmin(slug, adminUserId)
    const link = await this.prisma.organizationJoinLink.findUnique({
      where: { organizationId: org.id },
    })
    if (!link) throw new NotFoundException('This team has no join link')
    await this.prisma.organizationJoinLink.update({
      where: { id: link.id },
      data: { status: 'revoked' },
    })
    return { status: 'revoked' as const }
  }

  /**
   * What the join landing page shows a signed-in visitor. It reveals only the
   * team's public identity (name, slug, SSO domain) — which the holder of the
   * link already knows — plus where THEY stand, so the page can say "waiting for
   * approval" instead of asking them to click again.
   */
  async previewJoinLink(token: string, userId: number) {
    const link = await this.prisma.organizationJoinLink.findUnique({
      where: { token },
      include: { organization: true },
    })
    if (!link) throw new NotFoundException('This join link is not valid')
    const org = link.organization

    const [mine, elsewhere, request, memberCount] = await Promise.all([
      this.membershipOf(org.id, userId),
      this.prisma.organizationMember.findFirst({
        where: { userId, status: 'active', organizationId: { not: org.id } },
        include: { organization: { select: { slug: true } } },
      }),
      this.prisma.organizationJoinRequest.findUnique({
        where: { organizationId_userId: { organizationId: org.id, userId } },
      }),
      this.prisma.organizationMember.count({
        where: { organizationId: org.id, status: 'active' },
      }),
    ])

    return {
      team: {
        name: org.name,
        slug: org.slug,
        ssoDomain: org.ssoDomain,
        status: org.status,
        memberCount,
      },
      // 'expired' and 'revoked' are separate answers because they need different
      // advice: one means "ask for a fresh link", the other "ask to be let in".
      linkStatus: this.joinLinkState(link),
      membership: mine ? ('member' as const) : elsewhere ? ('other_team' as const) : ('none' as const),
      otherTeamSlug: elsewhere?.organization.slug ?? null,
      request: request
        ? {
            id: request.id,
            status: request.status,
            createdAt: request.createdAt,
            decidedAt: request.decidedAt,
          }
        : null,
    }
  }

  /**
   * File a request to join through a link. This NEVER creates a membership — that
   * is the whole point of the link/approval split.
   *
   * Asking twice updates the one row this (org, user) pair is allowed, so an
   * impatient visitor cannot flood the admin's queue. A previously rejected
   * person may ask again — the earlier decision stays visible on the row, which
   * is what lets the admin see they are being asked a second time.
   */
  async requestToJoin(token: string, userId: number, message?: string) {
    const link = await this.prisma.organizationJoinLink.findUnique({
      where: { token },
      include: { organization: true },
    })
    if (!link) throw new NotFoundException('This join link is not valid')
    const state = this.joinLinkState(link)
    if (state === 'revoked') {
      throw new ForbiddenException(
        'This join link has been turned off. Ask the team admin for a new one.',
      )
    }
    if (state === 'expired') {
      throw new BadRequestException(
        'This join link has expired. Ask the team admin for a new one.',
      )
    }
    const org = link.organization
    if (org.status !== 'active') throw new ForbiddenException('This team is suspended')

    const existingSeat = await this.membershipOf(org.id, userId)
    if (existingSeat) {
      throw new ConflictException(`You are already a member of "${org.slug}"`)
    }
    // One team per account in this version: say so HERE rather than at approval
    // time, so the admin is never asked to approve something that cannot happen.
    const elsewhere = await this.prisma.organizationMember.findFirst({
      where: { userId, status: 'active', organizationId: { not: org.id } },
      include: { organization: { select: { slug: true } } },
    })
    if (elsewhere) {
      throw new ConflictException(
        `You are already on the team "${elsewhere.organization.slug}". Leave it first — one team per account in this version.`,
      )
    }

    const existing = await this.prisma.organizationJoinRequest.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId } },
    })
    if (existing?.status === 'pending') {
      // Idempotent: re-opening the link is not a new request.
      return this.publicJoinRequest(existing, org.slug)
    }
    const trimmed = message?.trim().slice(0, 280) || null
    const request = existing
      ? await this.prisma.organizationJoinRequest.update({
          where: { id: existing.id },
          data: {
            status: 'pending',
            message: trimmed,
            joinLinkId: link.id,
            decidedById: null,
            decidedAt: null,
          },
        })
      : await this.prisma.organizationJoinRequest.create({
          data: {
            organizationId: org.id,
            userId,
            joinLinkId: link.id,
            status: 'pending',
            message: trimmed,
          },
        })
    if (!existing) {
      await this.prisma.organizationJoinLink.update({
        where: { id: link.id },
        data: { useCount: { increment: 1 } },
      })
    }
    this.logger.log(`team join request: org=${org.slug} user=${userId} request=${request.id}`)
    return this.publicJoinRequest(request, org.slug)
  }

  /** The requester changes their mind. Only their own pending request. */
  async cancelJoinRequest(token: string, userId: number) {
    const link = await this.prisma.organizationJoinLink.findUnique({
      where: { token },
      select: { organizationId: true },
    })
    if (!link) throw new NotFoundException('This join link is not valid')
    const request = await this.prisma.organizationJoinRequest.findUnique({
      where: {
        organizationId_userId: { organizationId: link.organizationId, userId },
      },
    })
    if (!request || request.status !== 'pending') {
      throw new NotFoundException('You have no pending request for this team')
    }
    const updated = await this.prisma.organizationJoinRequest.update({
      where: { id: request.id },
      data: { status: 'canceled' },
    })
    return { id: updated.id, status: 'canceled' as const }
  }

  /**
   * Approve a request: create (or re-activate) the seat and stamp the decision.
   *
   * The same guards as accepting an email invite apply, because the outcome is
   * identical — a seat that spends the team's credits: the team must be active,
   * and the person must not already hold a seat on another team. A pending EMAIL
   * invite for the same person is marked accepted so the admin's invite list does
   * not keep asking about someone who is already in.
   */
  async approveJoinRequest(slug: string, adminUserId: number, requestId: number) {
    const org = await this.requireAdmin(slug, adminUserId)
    if (org.status !== 'active') throw new ForbiddenException('This team is suspended')
    const request = await this.loadPendingRequest(org.id, requestId)

    const elsewhere = await this.prisma.organizationMember.findFirst({
      where: {
        userId: request.userId,
        status: 'active',
        organizationId: { not: org.id },
      },
      include: { organization: { select: { slug: true } } },
    })
    if (elsewhere) {
      throw new ConflictException(
        `That person is already on the team "${elsewhere.organization.slug}" — they have to leave it before they can join this one.`,
      )
    }

    const role: OrgRole = (request.joinLink?.role as OrgRole) ?? 'member'
    const quota = await this.defaultSeatQuota(org.id)
    await this.prisma.$transaction([
      this.prisma.organizationMember.upsert({
        where: {
          organizationId_userId: { organizationId: org.id, userId: request.userId },
        },
        create: {
          organizationId: org.id,
          userId: request.userId,
          role,
          bucketQuota: quota,
          bucketCredits: quota,
          status: 'active',
        },
        update: { status: 'active', role },
      }),
      this.prisma.organizationJoinRequest.update({
        where: { id: request.id },
        data: { status: 'approved', decidedById: adminUserId, decidedAt: new Date() },
      }),
    ])
    await this.markInvitesAccepted(org.id, request.userId)
    this.logger.log(
      `team join approved: org=${org.slug} user=${request.userId} by=${adminUserId} role=${role}`,
    )
    return {
      id: request.id,
      userId: request.userId,
      status: 'approved' as const,
      role,
      bucketQuota: quota,
    }
  }

  /**
   * Reject a request. The row is kept (not deleted) so the same person asking
   * again shows up as a repeat ask rather than as a stranger.
   */
  async rejectJoinRequest(slug: string, adminUserId: number, requestId: number) {
    const org = await this.requireAdmin(slug, adminUserId)
    const request = await this.loadPendingRequest(org.id, requestId)
    await this.prisma.organizationJoinRequest.update({
      where: { id: request.id },
      data: { status: 'rejected', decidedById: adminUserId, decidedAt: new Date() },
    })
    return { id: request.id, userId: request.userId, status: 'rejected' as const }
  }

  // --- Members ---------------------------------------------------------------

  /**
   * Remove a member. Their bucket is zeroed so nothing further can be spent, but
   * the row (and therefore their share of the ledger) is kept.
   */
  async removeMember(slug: string, adminUserId: number, targetUserId: number) {
    const org = await this.requireAdmin(slug, adminUserId)
    if (targetUserId === org.adminId) {
      throw new BadRequestException(
        'The team owner cannot be removed. Delete the team instead.',
      )
    }
    const member = await this.membershipOf(org.id, targetUserId)
    if (!member) throw new NotFoundException('Member not found')
    await this.prisma.organizationMember.update({
      where: { id: member.id },
      data: { status: 'removed', bucketCredits: 0 },
    })
    return { userId: targetUserId, status: 'removed' as const }
  }

  /**
   * Set a member's per-period quota. Raising it credits the difference to their
   * remaining balance; lowering it clamps the remainder — so the change takes
   * effect now instead of only at the next renewal.
   */
  async setMemberQuota(
    slug: string,
    adminUserId: number,
    targetUserId: number,
    bucketQuota: number,
  ) {
    const org = await this.requireAdmin(slug, adminUserId)
    const member = await this.membershipOf(org.id, targetUserId)
    if (!member) throw new NotFoundException('Member not found')
    const delta = bucketQuota - member.bucketQuota
    const nextCredits =
      delta >= 0
        ? member.bucketCredits + delta
        : Math.min(member.bucketCredits, bucketQuota)
    const updated = await this.prisma.organizationMember.update({
      where: { id: member.id },
      data: { bucketQuota, bucketCredits: Math.max(0, nextCredits) },
    })
    return {
      userId: targetUserId,
      bucketQuota: updated.bucketQuota,
      bucketCredits: updated.bucketCredits,
    }
  }

  /** A member gives up their own seat. The owner must delete the team instead. */
  async leave(slug: string, userId: number) {
    const org = await this.loadOrg(slug)
    if (userId === org.adminId) {
      throw new BadRequestException(
        'The team owner cannot leave their own team. Delete the team instead.',
      )
    }
    const member = await this.membershipOf(org.id, userId)
    if (!member) throw new NotFoundException('You are not a member of this team')
    await this.prisma.organizationMember.update({
      where: { id: member.id },
      data: { status: 'removed', bucketCredits: 0 },
    })
    return { slug, status: 'left' as const }
  }

  // --- Billing ---------------------------------------------------------------

  /**
   * Activate (or renew) a team's plan: upsert the org subscription, seed the
   * shared pool with the plan's per-period credit allowance, and allocate a
   * bucket to every active member.
   *
   * Called from PaymentsService when an org-owned payment is confirmed. It is
   * deliberately idempotent per period — re-running it re-seeds the same numbers
   * rather than stacking credits, so a duplicate webhook/poll cannot mint a
   * second allowance.
   */
  async activateSubscription(
    organizationId: number,
    plan: Plan,
    periodEnd: Date,
  ): Promise<{ totalCredits: number; members: number }> {
    const limits = this.plans.getLimits(plan)
    const totalCredits =
      typeof limits.creditsPerPeriod === 'number' && limits.creditsPerPeriod > 0
        ? limits.creditsPerPeriod
        : 0

    await this.prisma.organizationSubscription.upsert({
      where: { organizationId },
      create: {
        organizationId,
        planId: plan.id,
        status: 'active',
        currentPeriodEnd: periodEnd,
      },
      update: {
        planId: plan.id,
        status: 'active',
        startedAt: new Date(),
        currentPeriodEnd: periodEnd,
      },
    })
    await this.prisma.creditPool.upsert({
      where: { organizationId },
      // extraCredits: 0 on BOTH paths is the expiry of purchased credits. The
      // product promise is "purchased credits last until the period ends", and
      // this reset is the only thing that enforces it — which is deliberate: a
      // sweep job or a per-row expiry status could drift from the pool the
      // gateway actually reads, whereas this cannot.
      create: { organizationId, totalCredits, usedCredits: 0, extraCredits: 0, periodEnd },
      update: { totalCredits, usedCredits: 0, extraCredits: 0, periodEnd },
    })
    const members = await this.allocateBuckets(organizationId, plan, totalCredits)
    this.logger.log(
      `team plan activated: org=${organizationId} plan=${plan.code} pool=${totalCredits} members=${members}`,
    )
    return { totalCredits, members }
  }

  /**
   * Roll the team into a new period: re-seed the pool and reset every active
   * member's bucket to their quota. Safe to call repeatedly; returns null when
   * the org has no active subscription.
   *
   * There is no cron in this backend today, so this is driven by the admin
   * oversight endpoint and by a new payment. Wiring a scheduler later needs only
   * to call this per org whose period has lapsed.
   */
  async renewSubscription(organizationId: number) {    const sub = await this.prisma.organizationSubscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    })
    if (!sub || sub.status === 'canceled') return null
    const periodEnd = new Date(Date.now() + PERIOD_MS)
    const result = await this.activateSubscription(organizationId, sub.plan, periodEnd)
    return { ...result, periodEnd }
  }

  /**
   * Grant PURCHASED (pay-as-you-go) credits to a team. Called from
   * PaymentsService when an org credit purchase is confirmed — never directly
   * from an HTTP route, because credits are only ever created by money landing.
   *
   * Two writes, and the first one is the one that matters:
   *
   *  - the POOL's extraCredits always goes up. The pool is the HARD cap on team
   *    spending, so this is what makes the purchase spendable at all;
   *  - a named member's bucket ALSO goes up. That bucket is a SOFT quota, so on
   *    its own it would be a promise the pool refuses to honour — which is why
   *    "buy credits for Bob" raises both, not just Bob's.
   *
   * The grant NEVER fails once money has moved: a target who has left the team
   * degrades to a pool-only grant (reported via `targetMissing` so the caller can
   * tell the admin) rather than throwing and leaving a paid purchase ungranted.
   */
  async grantExtraCredits(
    organizationId: number,
    credits: number,
    targetUserId?: number | null,
  ): Promise<{
    organizationId: number
    credits: number
    targetUserId: number | null
    targetMissing: boolean
    extraCredits: number
    poolRemaining: number
    periodEnd: Date | null
  }> {
    if (!Number.isFinite(credits) || credits <= 0) {
      throw new BadRequestException('Credits to grant must be a positive number')
    }
    const pool = await this.prisma.creditPool.findUnique({ where: { organizationId } })

    // A team always gets a pool row at creation, so a missing one means an old
    // org (or a hand-edited database). Creating it here keeps a paid purchase
    // from being lost over a bookkeeping gap.
    const updatedPool = pool
      ? await this.prisma.creditPool.update({
          where: { organizationId },
          data: { extraCredits: { increment: credits } },
        })
      : await this.prisma.creditPool.upsert({
          where: { organizationId },
          create: { organizationId, totalCredits: 0, usedCredits: 0, extraCredits: credits },
          update: { extraCredits: { increment: credits } },
        })

    let grantedTo: number | null = null
    let targetMissing = false
    if (targetUserId) {
      const member = await this.membershipOf(organizationId, targetUserId)
      if (member) {
        await this.prisma.organizationMember.update({
          where: { id: member.id },
          data: {
            bucketQuota: member.bucketQuota + credits,
            bucketCredits: member.bucketCredits + credits,
          },
        })
        grantedTo = targetUserId
      } else {
        targetMissing = true
        this.logger.warn(
          `team credits: org=${organizationId} target user=${targetUserId} is no longer an active member — granted ${credits} to the shared pool instead`,
        )
      }
    }

    const extraCredits = updatedPool.extraCredits ?? credits
    this.logger.log(
      `team credits granted: org=${organizationId} credits=${credits} target=${grantedTo ?? 'pool'} extra=${extraCredits}`,
    )
    return {
      organizationId,
      credits,
      targetUserId: grantedTo,
      targetMissing,
      extraCredits,
      poolRemaining: this.poolRemaining(updatedPool),
      periodEnd: updatedPool.periodEnd ?? null,
    }
  }

  /**
   * Cancel a team's subscription in response to a refunded team plan purchase.
   * Called from the Stripe `charge.refunded` webhook when the refunded payment
   * was a team plan checkout (has `organizationId` + `planId`, no linked
   * organization_credit_topups row).
   *
   * Mirrors activateSubscription's writes in reverse:
   *  - the subscription row goes 'canceled' (the team can no longer make claims);
   *  - the credit pool's totalCredits AND extraCredits are zeroed, and usedCredits
   *    is reset, so poolRemaining reads 0 and the gateway stops serving the team;
   *  - every active member's bucket is zeroed so a per-member reader does not
   *    show spendable credits the pool no longer backs.
   *
   * Deliberately NOT reversed (documented here so a future change does not
   * silently undo the policy):
   *  - already-spent credits are not clawed back from the ledger — a refund is a
   *    money reversal, not a usage reversal, and the gateway's consumption rows
   *    are the source of truth for what was used;
   *  - already-minted carry-over credits are not reversed — those were a
   *    permanent grant from the prior period, not part of this purchase;
   *  - no proration: a refund of a 30-day plan used for 20 days refunds the full
   *    amount and cancels fully. Stripe does not partial-refund here.
   *
   * Idempotent: re-running on a subscription already 'canceled' zeroes the pool
   * again (a no-op on already-zeroed rows) and re-zeroes buckets. Safe.
   */
  async cancelSubscription(organizationId: number): Promise<{ organizationId: number; status: 'canceled' }> {
    await this.prisma.$transaction([
      this.prisma.organizationSubscription.updateMany({
        where: { organizationId },
        data: { status: 'canceled' },
      }),
      this.prisma.creditPool.upsert({
        where: { organizationId },
        create: { organizationId, totalCredits: 0, usedCredits: 0, extraCredits: 0 },
        update: { totalCredits: 0, usedCredits: 0, extraCredits: 0 },
      }),
      this.prisma.organizationMember.updateMany({
        where: { organizationId, status: 'active' },
        data: { bucketQuota: 0 },
      }),
    ])
    this.logger.warn(`team plan canceled: org=${organizationId} (refund)`)
    return { organizationId, status: 'canceled' }
  }

  /**
   * Spend team credits for one member: their own bucket first, then the shared
   * pool. The POOL is the hard cap — that is what lets a team invite unlimited
   * members without a seat count.
   */
  async chargeMemberBucket(
    organizationId: number,
    userId: number,
    credits: number,
  ): Promise<ChargeResult> {
    if (credits <= 0) {
      const m = await this.membershipOf(organizationId, userId)
      const pool = await this.prisma.creditPool.findUnique({ where: { organizationId } })
      return {
        source: 'bucket',
        fromBucket: 0,
        fromPool: 0,
        bucketRemaining: m?.bucketCredits ?? 0,
        poolRemaining: this.poolRemaining(pool),
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const member = await tx.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
      })
      if (!member || member.status !== 'active') {
        throw new ForbiddenException('Not an active member of this team')
      }
      const pool = await tx.creditPool.findUnique({ where: { organizationId } })
      const remaining = this.poolRemaining(pool)
      if (remaining < credits) {
        throw new InsufficientCreditsError(
          `Team credit pool exhausted (${remaining} left, ${credits} needed)`,
        )
      }
      const fromBucket = Math.min(member.bucketCredits, credits)
      const fromPool = credits - fromBucket
      const updatedMember = await tx.organizationMember.update({
        where: { id: member.id },
        data: { bucketCredits: member.bucketCredits - fromBucket },
      })
      const updatedPool = await tx.creditPool.update({
        where: { organizationId },
        data: { usedCredits: (pool?.usedCredits ?? 0) + credits },
      })
      return {
        source: fromPool > 0 ? ('pool' as const) : ('bucket' as const),
        fromBucket,
        fromPool,
        bucketRemaining: updatedMember.bucketCredits,
        poolRemaining: this.poolRemaining(updatedPool),
      }
    })
  }

  // --- Super-admin oversight -------------------------------------------------

  async listOrganizations(opts: { page: number; pageSize: number; search?: string }) {
    const page = Math.max(1, opts.page)
    const pageSize = Math.min(100, Math.max(1, opts.pageSize))
    const where: Prisma.OrganizationWhereInput = opts.search
      ? {
          OR: [
            { name: { contains: opts.search } },
            { slug: { contains: opts.search } },
            { ssoDomain: { contains: opts.search } },
          ],
        }
      : {}
    const [items, total] = await Promise.all([
      this.prisma.organization.findMany({
        where,
        include: {
          creditPool: true,
          subscription: { include: { plan: true } },
          _count: { select: { members: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.organization.count({ where }),
    ])
    return {
      items: items.map((o) => ({
        ...this.publicOrg(o),
        memberCount: o._count.members,
      })),
      total,
      page,
      pageSize,
    }
  }

  async getOrganizationDetail(id: number) {
    const org = await this.prisma.organization.findUnique({
      where: { id },
      include: {
        creditPool: true,
        subscription: { include: { plan: true } },
        members: {
          include: {
            user: {
              select: { id: true, email: true, displayName: true, avatarUrl: true },
            },
          },
          orderBy: { joinedAt: 'asc' },
        },
        invites: { orderBy: { createdAt: 'desc' } },
        payments: {
          include: { plan: { select: { code: true } } },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    })
    if (!org) throw new NotFoundException('Organization not found')
    return {
      ...this.publicOrg(org),
      members: org.members.map((m) => this.publicMember(m as MemberWithUser)),
      invites: org.invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        status: i.status,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
      })),
      payments: org.payments.map((p) => ({
        id: p.id,
        planCode: p.plan?.code ?? null,
        provider: p.provider,
        amountCents: p.amountCents,
        status: p.status,
        createdAt: p.createdAt,
        paidAt: p.paidAt,
      })),
    }
  }

  /**
   * Suspend a team: cancel its subscription and deactivate every seat, so each
   * member's next request carries no org claim and falls back to their own
   * individual plan. Nothing is deleted — resumeOrganization restores access.
   */
  async suspendOrganization(id: number) {
    const org = await this.prisma.organization.findUnique({ where: { id } })
    if (!org) throw new NotFoundException('Organization not found')
    await this.prisma.$transaction([
      this.prisma.organization.update({
        where: { id },
        data: { status: 'suspended' },
      }),
      this.prisma.organizationMember.updateMany({
        where: { organizationId: id, status: 'active' },
        data: { status: 'removed' },
      }),
      this.prisma.organizationSubscription.updateMany({
        where: { organizationId: id },
        data: { status: 'canceled' },
      }),
    ])
    this.logger.warn(`team suspended: org=${org.slug} (id=${id})`)
    return { id, status: 'suspended' as const }
  }

  /** Undo a suspension: the owner's seat is restored; others re-join or are re-invited. */
  async resumeOrganization(id: number) {
    const org = await this.prisma.organization.findUnique({ where: { id } })
    if (!org) throw new NotFoundException('Organization not found')
    await this.prisma.$transaction([
      this.prisma.organization.update({ where: { id }, data: { status: 'active' } }),
      this.prisma.organizationMember.updateMany({
        where: { organizationId: id, userId: org.adminId },
        data: { status: 'active' },
      }),
      this.prisma.organizationSubscription.updateMany({
        where: { organizationId: id },
        data: { status: 'active' },
      }),
    ])
    return { id, status: 'active' as const }
  }

  // --- Internals -------------------------------------------------------------

  /**
   * What the team may still spend: the plan's allowance PLUS anything it bought
   * this period, minus everything spent. Purchased credits are part of the hard
   * cap, so every caller that gates spending has to see them — which is why this
   * one helper is the only place the sum is computed.
   */
  private poolRemaining(
    pool: (CreditPool | { totalCredits: number; usedCredits: number; extraCredits?: number }) | null | undefined,
  ): number {
    if (!pool) return 0
    const extra = 'extraCredits' in pool ? (pool.extraCredits ?? 0) : 0
    return Math.max(0, pool.totalCredits + extra - pool.usedCredits)
  }

  private async loadOrg(slug: string): Promise<
    Organization & {
      creditPool: CreditPool | null
      subscription: ({ plan: Plan } & { currentPeriodEnd: Date | null; status: string }) | null
    }
  > {
    const org = await this.prisma.organization.findUnique({
      where: { slug },
      include: { creditPool: true, subscription: { include: { plan: true } } },
    })
    if (!org) throw new NotFoundException('Team not found')
    return org
  }

  private membershipOf(organizationId: number, userId: number) {
    return this.prisma.organizationMember.findFirst({
      where: { organizationId, userId, status: 'active' },
    })
  }

  /**
   * Default quota for a seat created AFTER the pool was seeded: the plan's
   * seatCredits when the admin configured one, else an equal split of the pool
   * across the members (including the newcomer). Nothing is over-committed by
   * this because the pool — not the sum of quotas — is the enforced cap.
   */
  private async defaultSeatQuota(organizationId: number): Promise<number> {
    const [sub, pool, activeMembers] = await Promise.all([
      this.prisma.organizationSubscription.findUnique({
        where: { organizationId },
        include: { plan: true },
      }),
      this.prisma.creditPool.findUnique({ where: { organizationId } }),
      this.prisma.organizationMember.count({
        where: { organizationId, status: 'active' },
      }),
    ])
    if (sub?.plan.seatCredits && sub.plan.seatCredits > 0) return sub.plan.seatCredits
    const remaining = this.poolRemaining(pool)
    if (remaining <= 0) return 0
    return Math.floor(remaining / (activeMembers + 1))
  }

  /**
   * Hand every active member a bucket for the new period: the plan's seatCredits
   * when set, otherwise an equal split of the pool.
   */
  private async allocateBuckets(
    organizationId: number,
    plan: Plan,
    totalCredits: number,
  ): Promise<number> {
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId, status: 'active' },
      select: { id: true },
    })
    if (members.length === 0) return 0
    const quota =
      plan.seatCredits > 0
        ? plan.seatCredits
        : Math.floor(totalCredits / members.length)
    await this.prisma.organizationMember.updateMany({
      where: { organizationId, status: 'active' },
      data: { bucketQuota: quota, bucketCredits: quota },
    })
    return members.length
  }

  private inviteUrl(slug: string, token: string): string {
    return `${this.webOrigin()}/dashboard/team/${slug}/invite/${token}`
  }

  /** Landing page for a shareable link: request-to-join, not accept-invite. */
  private joinUrl(slug: string, token: string): string {
    return `${this.webOrigin()}/dashboard/team/${slug}/join/${token}`
  }

  private webOrigin(): string {
    return (
      this.config.get<string>('app.webOrigin') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '')
  }

  /**
   * Live state of a join link. Expiry is computed rather than stored as a status
   * so no background job is needed to age links out, and 'expired' is kept
   * distinct from 'revoked' because the two need different advice.
   */
  private joinLinkState(link: {
    status: string
    expiresAt: Date | null
  }): 'active' | 'revoked' | 'expired' {
    if (link.status !== 'active') return 'revoked'
    if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) return 'expired'
    return 'active'
  }

  /** Load a request that belongs to this org and is still awaiting a decision. */
  private async loadPendingRequest(organizationId: number, requestId: number) {
    const request = await this.prisma.organizationJoinRequest.findUnique({
      where: { id: requestId },
      include: { joinLink: true },
    })
    if (!request || request.organizationId !== organizationId) {
      throw new NotFoundException('Join request not found')
    }
    if (request.status !== 'pending') {
      throw new ConflictException(`This request was already ${request.status}`)
    }
    return request
  }

  /**
   * Admin view of the join link. The TOKEN is included on purpose — the admin has
   * to be able to copy the URL — which is also why the caller must be an admin
   * (a plain member could otherwise mint requests they were never given access to
   * approve, and hand the link to anyone).
   */
  private publicJoinLink(
    link: {
      id: number
      token: string
      role: string
      status: string
      expiresAt: Date | null
      useCount: number
      createdAt: Date
    },
    slug: string,
  ) {
    return {
      id: link.id,
      url: this.joinUrl(slug, link.token),
      role: link.role,
      status: link.status,
      state: this.joinLinkState(link),
      expiresAt: link.expiresAt,
      useCount: link.useCount,
      createdAt: link.createdAt,
    }
  }

  /** What the requester's own page shows. Carries no team-internal detail. */
  private publicJoinRequest(
    request: {
      id: number
      status: string
      message: string | null
      createdAt: Date
      decidedAt: Date | null
    },
    slug: string,
  ) {
    return {
      id: request.id,
      slug,
      status: request.status,
      message: request.message,
      createdAt: request.createdAt,
      decidedAt: request.decidedAt,
    }
  }

  /** A pending request as the admin's queue shows it: who is asking, and why. */
  private adminJoinRequest(request: {
    id: number
    userId: number
    status: string
    message: string | null
    createdAt: Date
    decidedAt: Date | null
    user: { email: string | null; displayName: string | null; avatarUrl: string | null }
  }) {
    return {
      id: request.id,
      userId: request.userId,
      email: request.user.email,
      displayName: request.user.displayName,
      avatarUrl: request.user.avatarUrl,
      status: request.status,
      message: request.message,
      createdAt: request.createdAt,
      decidedAt: request.decidedAt,
    }
  }

  private publicOrg(
    org: Organization & {
      creditPool?: CreditPool | null
      subscription?: ({ plan?: Plan | null } & Record<string, unknown>) | null
    },
  ) {
    const pool = org.creditPool ?? null
    const sub = org.subscription ?? null
    const plan = (sub?.plan ?? null) as Plan | null
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      ssoDomain: org.ssoDomain,
      status: org.status,
      adminId: org.adminId,
      createdAt: org.createdAt,
      plan: plan
        ? {
            code: plan.code,
            name: plan.name,
            priceCents: plan.priceCents,
            isTeamPlan: plan.isTeamPlan,
            seatCredits: plan.seatCredits,
          }
        : null,
      subscription: sub
        ? {
            status: sub.status as string,
            currentPeriodEnd: (sub.currentPeriodEnd as Date | null) ?? null,
          }
        : null,
      creditPool: pool
        ? {
            totalCredits: pool.totalCredits,
            usedCredits: pool.usedCredits,
            // Purchased credits are reported SEPARATELY from the plan allowance
            // rather than folded into one total: they are bought, they expire at
            // the period end, and an admin deciding whether to buy more needs to
            // see which of the two is actually running out.
            extraCredits: pool.extraCredits ?? 0,
            remainingCredits: this.poolRemaining(pool),
            planRemaining: Math.max(0, pool.totalCredits - pool.usedCredits),
            extraRemaining: this.extraRemaining(pool),
            periodEnd: pool.periodEnd,
          }
        : null,
    }
  }

  /**
   * How much of the PURCHASED credits is left. Spending fills the plan's
   * allowance first (usedCredits is one counter over both tiers), so purchased
   * credits are only touched once usedCredits passes totalCredits — and that
   * ordering is exactly what the product promises.
   */
  private extraRemaining(pool: {
    totalCredits: number
    usedCredits: number
    extraCredits?: number | null
  }): number {
    const extra = pool.extraCredits ?? 0
    if (extra <= 0) return 0
    const intoExtra = Math.max(0, pool.usedCredits - pool.totalCredits)
    return Math.max(0, extra - intoExtra)
  }

  private publicMember(m: MemberWithUser) {
    return {
      userId: m.userId,
      email: m.user.email,
      displayName: m.user.displayName,
      avatarUrl: m.user.avatarUrl,
      role: m.role,
      status: m.status,
      bucketQuota: m.bucketQuota,
      bucketCredits: m.bucketCredits,
      joinedAt: m.joinedAt,
    }
  }
}
