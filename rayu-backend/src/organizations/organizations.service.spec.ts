import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Plan } from '@prisma/client'
import {
  InsufficientCreditsError,
  OrganizationsService,
} from './organizations.service'
import type { PlansService } from '../plans/plans.service'
import type { PrismaService } from '../prisma/prisma.service'

type Mock = jest.Mock

const TEAM_PLAN = {
  id: 3,
  code: 'team',
  name: 'Team',
  priceCents: 5000,
  availability: 'active',
  limits: { creditsPerPeriod: 1000 },
  isTeamPlan: true,
  seatCredits: 0,
} as unknown as Plan

const SEATED_PLAN = { ...TEAM_PLAN, seatCredits: 150 } as unknown as Plan

interface Fixture {
  svc: OrganizationsService
  prisma: {
    organization: {
      findUnique: Mock
      findMany: Mock
      create: Mock
      update: Mock
      count: Mock
    }
    organizationMember: {
      findUnique: Mock
      findFirst: Mock
      findMany: Mock
      create: Mock
      update: Mock
      updateMany: Mock
      upsert: Mock
      count: Mock
    }
    organizationInvite: {
      findUnique: Mock
      findMany: Mock
      upsert: Mock
      update: Mock
      updateMany: Mock
    }
    organizationJoinLink: {
      findUnique: Mock
      upsert: Mock
      update: Mock
    }
    organizationJoinRequest: {
      findUnique: Mock
      findMany: Mock
      create: Mock
      update: Mock
    }
    organizationCreditTopup: {
      findFirst: Mock
      findMany: Mock
      update: Mock
      updateMany: Mock
    }
    organizationSubscription: { findUnique: Mock; upsert: Mock; updateMany: Mock }
    creditPool: { findUnique: Mock; upsert: Mock; update: Mock }
    user: { findUnique: Mock }
    $transaction: Mock
  }
}

function makeFixture(): Fixture {
  const prisma: Fixture['prisma'] = {
    organization: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 21, createdAt: new Date(), ...data, creditPool: null }),
      ),
      update: jest.fn(() => Promise.resolve({})),
      count: jest.fn(() => Promise.resolve(0)),
    },
    organizationMember: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      findFirst: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
      create: jest.fn(() => Promise.resolve({ id: 1 })),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 1, bucketCredits: 0, bucketQuota: 0, ...data }),
      ),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      upsert: jest.fn(() => Promise.resolve({ id: 4 })),
      count: jest.fn(() => Promise.resolve(1)),
    },
    organizationInvite: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
      upsert: jest.fn(({ create }: { create: Record<string, unknown> }) =>
        Promise.resolve({ id: 9, ...create }),
      ),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
    organizationJoinLink: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      upsert: jest.fn(({ create }: { create: Record<string, unknown> }) =>
        Promise.resolve({ id: 31, useCount: 0, createdAt: new Date(), ...create }),
      ),
      update: jest.fn(() => Promise.resolve({})),
    },
    organizationJoinRequest: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 41,
          createdAt: new Date(),
          decidedAt: null,
          message: null,
          ...data,
        }),
      ),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 41, createdAt: new Date(), message: null, ...data }),
      ),
    },
    organizationSubscription: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      upsert: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    organizationCreditTopup: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    creditPool: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      upsert: jest.fn(() => Promise.resolve({})),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ totalCredits: 1000, usedCredits: 0, ...data }),
      ),
    },
    user: { findUnique: jest.fn(() => Promise.resolve(null)) },
    // Supports BOTH forms the service uses: an array of already-running promises,
    // and an interactive callback (which receives this same mock as `tx`).
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
        : Promise.all(arg as Promise<unknown>[]),
    ),
  }
  const plans = {
    getLimits: jest.fn((p: Plan) => (p.limits ?? {}) as Record<string, unknown>),
  }
  const svc = new OrganizationsService(
    prisma as unknown as PrismaService,
    plans as unknown as PlansService,
    new ConfigService({ app: { webOrigin: 'https://rayucode.com' } }),
  )
  return { svc, prisma }
}

const ORG = {
  id: 21,
  name: 'Acme',
  slug: 'acme',
  ssoDomain: '@company.com',
  adminId: 1,
  status: 'active',
  createdAt: new Date(),
  creditPool: { totalCredits: 1000, usedCredits: 0, periodEnd: null },
  subscription: null,
}

describe('OrganizationsService · team creation', () => {
  it('creates the team with the caller as admin and an empty pool', async () => {
    const f = makeFixture()
    const res = await f.svc.createOrganization(1, {
      name: 'Acme',
      slug: 'acme',
      ssoDomain: 'company.com',
    })

    const arg = f.prisma.organization.create.mock.calls[0][0]
    expect(arg.data.adminId).toBe(1)
    expect(arg.data.ssoDomain).toBe('@company.com') // normalized
    expect(arg.data.members.create).toEqual(
      expect.objectContaining({ userId: 1, role: 'admin', status: 'active' }),
    )
    // The pool row exists from day one, so every later path can assume it.
    expect(arg.data.creditPool).toEqual({ create: {} })
    expect(res.slug).toBe('acme')
  })

  it('refuses a consumer email domain for SSO', async () => {
    const f = makeFixture()
    await expect(
      f.svc.createOrganization(1, { name: 'X', slug: 'x-team', ssoDomain: 'gmail.com' }),
    ).rejects.toThrow(BadRequestException)
    expect(f.prisma.organization.create).not.toHaveBeenCalled()
  })

  it('refuses a second team while the user still holds a seat', async () => {
    const f = makeFixture()
    f.prisma.organizationMember.findFirst.mockResolvedValue({
      organizationId: 5,
      role: 'member',
      organization: { id: 5, slug: 'other' },
    })
    await expect(
      f.svc.createOrganization(1, { name: 'X', slug: 'x-team' }),
    ).rejects.toThrow(ConflictException)
  })

  it('refuses a slug that is already taken', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue(ORG)
    await expect(
      f.svc.createOrganization(1, { name: 'Acme 2', slug: 'acme' }),
    ).rejects.toThrow(ConflictException)
  })
})

describe('OrganizationsService · invites', () => {
  it('creates a pending invite and returns a copyable accept URL', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue(ORG)
    f.prisma.organizationMember.findFirst
      // requireAdmin → the caller's admin seat
      .mockResolvedValueOnce({ id: 1, role: 'admin', status: 'active' })
      // "is the invitee already a member?" → no
      .mockResolvedValueOnce(null)

    const res = await f.svc.invite('acme', 1, 'Bob@Company.com')

    const arg = f.prisma.organizationInvite.upsert.mock.calls[0][0]
    expect(arg.create.email).toBe('bob@company.com') // normalized
    expect(arg.create.status).toBe('pending')
    expect((arg.create.expiresAt as Date).getTime()).toBeGreaterThan(Date.now())
    expect(res.acceptUrl).toMatch(
      /^https:\/\/rayucode\.com\/dashboard\/team\/acme\/invite\/[0-9a-f]{48}$/,
    )
  })

  it('refuses to invite when the caller is not the team admin', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue(ORG)
    f.prisma.organizationMember.findFirst.mockResolvedValue({
      id: 2,
      role: 'member',
      status: 'active',
    })
    await expect(f.svc.invite('acme', 2, 'bob@company.com')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('accepts an invite whose email matches the signed-in account', async () => {
    const f = makeFixture()
    f.prisma.organizationInvite.findUnique.mockResolvedValue({
      id: 9,
      organizationId: 21,
      email: 'bob@company.com',
      role: 'member',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
      organization: { ...ORG, status: 'active' },
    })
    f.prisma.user.findUnique.mockResolvedValue({ id: 8, email: 'bob@company.com' })

    const ctx = await f.svc.acceptInvite('tok', 8)

    expect(ctx).toEqual({ orgId: 21, orgRole: 'member', slug: 'acme' })
    // Seat creation + invite status flip happen together.
    expect(f.prisma.organizationMember.upsert).toHaveBeenCalled()
    expect(f.prisma.organizationInvite.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { status: 'accepted' },
    })
  })

  it('refuses an invite for a different email address', async () => {
    const f = makeFixture()
    f.prisma.organizationInvite.findUnique.mockResolvedValue({
      id: 9,
      organizationId: 21,
      email: 'bob@company.com',
      role: 'member',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
      organization: { ...ORG, status: 'active' },
    })
    f.prisma.user.findUnique.mockResolvedValue({ id: 9, email: 'eve@evil.com' })
    await expect(f.svc.acceptInvite('tok', 9)).rejects.toThrow(ForbiddenException)
  })

  it('refuses an expired invite', async () => {
    const f = makeFixture()
    f.prisma.organizationInvite.findUnique.mockResolvedValue({
      id: 9,
      organizationId: 21,
      email: 'bob@company.com',
      role: 'member',
      status: 'pending',
      expiresAt: new Date(Date.now() - 1),
      organization: { ...ORG, status: 'active' },
    })
    await expect(f.svc.acceptInvite('tok', 8)).rejects.toThrow(BadRequestException)
  })
})

describe('OrganizationsService · shareable join links', () => {
  const LINK = {
    id: 31,
    organizationId: 21,
    token: 'a'.repeat(48),
    role: 'member',
    status: 'active',
    expiresAt: new Date(Date.now() + 60_000),
    useCount: 3,
    createdById: 1,
    createdAt: new Date(),
    organization: { ...ORG, status: 'active' },
  }

  /** requireAdmin: org lookup + the caller's admin seat. */
  function asAdmin(f: Fixture) {
    f.prisma.organization.findUnique.mockResolvedValue(ORG)
    f.prisma.organizationMember.findFirst.mockResolvedValueOnce({
      id: 1,
      role: 'admin',
      status: 'active',
    })
  }

  it('issues a link whose URL is shareable and whose role is the ADMIN’s choice', async () => {
    const f = makeFixture()
    asAdmin(f)

    const res = await f.svc.createJoinLink('acme', 1, {})

    const arg = f.prisma.organizationJoinLink.upsert.mock.calls[0][0]
    expect(arg.where).toEqual({ organizationId: 21 })
    expect(arg.create.role).toBe('member')
    expect(arg.create.status).toBe('active')
    expect((arg.create.expiresAt as Date).getTime()).toBeGreaterThan(Date.now())
    // A join URL, NOT an invite URL: the landing page it points at files a
    // request instead of granting a seat.
    expect(res.url).toMatch(
      /^https:\/\/rayucode\.com\/dashboard\/team\/acme\/join\/[0-9a-f]{48}$/,
    )
    expect(res.state).toBe('active')
  })

  it('regenerating replaces the token so a link already shared stops working', async () => {
    const f = makeFixture()
    asAdmin(f)
    await f.svc.createJoinLink('acme', 1, { expiresInDays: 3 })

    const arg = f.prisma.organizationJoinLink.upsert.mock.calls[0][0]
    expect(arg.update.token).toEqual(expect.stringMatching(/^[0-9a-f]{48}$/))
    expect(arg.update.token).not.toBe(LINK.token)
    expect(arg.update.status).toBe('active')
    // useCount is not in the update: it counts how far this team's links have
    // travelled overall, so rotating must not reset it.
    expect(arg.update).not.toHaveProperty('useCount')
  })

  it('a never-expiring link is only ever an explicit choice', async () => {
    const f = makeFixture()
    asAdmin(f)
    await f.svc.createJoinLink('acme', 1, { expiresInDays: null })
    expect(f.prisma.organizationJoinLink.upsert.mock.calls[0][0].create.expiresAt).toBeNull()
  })

  it('opening a link files a PENDING request and creates no seat', async () => {
    const f = makeFixture()
    f.prisma.organizationJoinLink.findUnique.mockResolvedValue(LINK)

    const res = await f.svc.requestToJoin(LINK.token, 8, '  I am the new contractor  ')

    const arg = f.prisma.organizationJoinRequest.create.mock.calls[0][0]
    expect(arg.data).toEqual(
      expect.objectContaining({
        organizationId: 21,
        userId: 8,
        joinLinkId: 31,
        status: 'pending',
        message: 'I am the new contractor',
      }),
    )
    expect(res.status).toBe('pending')
    // The whole point of the link/approval split.
    expect(f.prisma.organizationMember.upsert).not.toHaveBeenCalled()
    expect(f.prisma.organizationMember.create).not.toHaveBeenCalled()
    // Counted, so a spike tells the admin the link has spread.
    expect(f.prisma.organizationJoinLink.update).toHaveBeenCalledWith({
      where: { id: 31 },
      data: { useCount: { increment: 1 } },
    })
  })

  it('asking twice does not queue a second request', async () => {
    const f = makeFixture()
    f.prisma.organizationJoinLink.findUnique.mockResolvedValue(LINK)
    f.prisma.organizationJoinRequest.findUnique.mockResolvedValue({
      id: 41,
      status: 'pending',
      message: null,
      createdAt: new Date(),
      decidedAt: null,
    })

    const res = await f.svc.requestToJoin(LINK.token, 8)

    expect(res.id).toBe(41)
    expect(f.prisma.organizationJoinRequest.create).not.toHaveBeenCalled()
    expect(f.prisma.organizationJoinLink.update).not.toHaveBeenCalled()
  })

  it('a rejected person may ask again, and the old verdict is cleared from the row', async () => {
    const f = makeFixture()
    f.prisma.organizationJoinLink.findUnique.mockResolvedValue(LINK)
    f.prisma.organizationJoinRequest.findUnique.mockResolvedValue({
      id: 41,
      status: 'rejected',
      message: null,
      createdAt: new Date(),
      decidedById: 1,
      decidedAt: new Date(),
    })

    await f.svc.requestToJoin(LINK.token, 8, 'please?')

    expect(f.prisma.organizationJoinRequest.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: {
        status: 'pending',
        message: 'please?',
        joinLinkId: 31,
        decidedById: null,
        decidedAt: null,
      },
    })
    // Re-asking is not a new arrival, so it must not inflate the use count.
    expect(f.prisma.organizationJoinLink.update).not.toHaveBeenCalled()
  })

  it('a revoked link is refused, and says so differently from an expired one', async () => {
    const f = makeFixture()
    f.prisma.organizationJoinLink.findUnique.mockResolvedValue({
      ...LINK,
      status: 'revoked',
    })
    await expect(f.svc.requestToJoin(LINK.token, 8)).rejects.toThrow(ForbiddenException)

    const g = makeFixture()
    g.prisma.organizationJoinLink.findUnique.mockResolvedValue({
      ...LINK,
      expiresAt: new Date(Date.now() - 1),
    })
    await expect(g.svc.requestToJoin(LINK.token, 8)).rejects.toThrow(BadRequestException)
  })

  it('refuses a request from someone who already holds a seat elsewhere', async () => {
    const f = makeFixture()
    f.prisma.organizationJoinLink.findUnique.mockResolvedValue(LINK)
    f.prisma.organizationMember.findFirst
      // membershipOf(this org) → not a member here
      .mockResolvedValueOnce(null)
      // …but they are on another team
      .mockResolvedValueOnce({ organizationId: 5, organization: { slug: 'other' } })

    await expect(f.svc.requestToJoin(LINK.token, 8)).rejects.toThrow(ConflictException)
    expect(f.prisma.organizationJoinRequest.create).not.toHaveBeenCalled()
  })

  it('approval is what creates the seat, with the role the LINK carries', async () => {
    const f = makeFixture()
    asAdmin(f)
    f.prisma.organizationJoinRequest.findUnique.mockResolvedValue({
      id: 41,
      organizationId: 21,
      userId: 8,
      status: 'pending',
      joinLink: { ...LINK, role: 'admin' },
    })
    f.prisma.creditPool.findUnique.mockResolvedValue({
      totalCredits: 1000,
      usedCredits: 0,
    })
    f.prisma.organizationMember.count.mockResolvedValue(1)

    const res = await f.svc.approveJoinRequest('acme', 1, 41)

    const seat = f.prisma.organizationMember.upsert.mock.calls[0][0]
    expect(seat.where).toEqual({
      organizationId_userId: { organizationId: 21, userId: 8 },
    })
    expect(seat.create).toEqual(
      expect.objectContaining({ userId: 8, role: 'admin', status: 'active' }),
    )
    // Same equal-split default a new seat gets anywhere else: pool / (members+1).
    expect(seat.create.bucketQuota).toBe(500)
    const decision = f.prisma.organizationJoinRequest.update.mock.calls[0][0]
    expect(decision.data).toEqual(
      expect.objectContaining({ status: 'approved', decidedById: 1 }),
    )
    expect(res).toEqual(
      expect.objectContaining({ userId: 8, status: 'approved', role: 'admin' }),
    )
  })

  it('refuses to approve a request that was already decided', async () => {
    const f = makeFixture()
    asAdmin(f)
    f.prisma.organizationJoinRequest.findUnique.mockResolvedValue({
      id: 41,
      organizationId: 21,
      userId: 8,
      status: 'approved',
      joinLink: LINK,
    })
    await expect(f.svc.approveJoinRequest('acme', 1, 41)).rejects.toThrow(
      ConflictException,
    )
    expect(f.prisma.organizationMember.upsert).not.toHaveBeenCalled()
  })

  it('refuses to approve a request belonging to another team', async () => {
    const f = makeFixture()
    asAdmin(f)
    f.prisma.organizationJoinRequest.findUnique.mockResolvedValue({
      id: 41,
      organizationId: 99,
      userId: 8,
      status: 'pending',
      joinLink: LINK,
    })
    await expect(f.svc.approveJoinRequest('acme', 1, 41)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('refuses to approve someone who joined another team while waiting', async () => {
    const f = makeFixture()
    asAdmin(f)
    f.prisma.organizationJoinRequest.findUnique.mockResolvedValue({
      id: 41,
      organizationId: 21,
      userId: 8,
      status: 'pending',
      joinLink: LINK,
    })
    f.prisma.organizationMember.findFirst.mockResolvedValueOnce({
      organizationId: 5,
      organization: { slug: 'other' },
    })
    await expect(f.svc.approveJoinRequest('acme', 1, 41)).rejects.toThrow(
      ConflictException,
    )
    expect(f.prisma.organizationMember.upsert).not.toHaveBeenCalled()
  })

  it('rejection keeps the row, so a repeat ask is visible as one', async () => {
    const f = makeFixture()
    asAdmin(f)
    f.prisma.organizationJoinRequest.findUnique.mockResolvedValue({
      id: 41,
      organizationId: 21,
      userId: 8,
      status: 'pending',
      joinLink: LINK,
    })

    const res = await f.svc.rejectJoinRequest('acme', 1, 41)

    expect(res.status).toBe('rejected')
    const arg = f.prisma.organizationJoinRequest.update.mock.calls[0][0]
    expect(arg.data).toEqual(
      expect.objectContaining({ status: 'rejected', decidedById: 1 }),
    )
    expect(f.prisma.organizationMember.upsert).not.toHaveBeenCalled()
  })

  it('the landing page sees the link state and its own request, not team internals', async () => {
    const f = makeFixture()
    f.prisma.organizationJoinLink.findUnique.mockResolvedValue({
      ...LINK,
      expiresAt: new Date(Date.now() - 1),
    })
    f.prisma.organizationJoinRequest.findUnique.mockResolvedValue({
      id: 41,
      status: 'pending',
      createdAt: new Date(),
      decidedAt: null,
    })
    f.prisma.organizationMember.count.mockResolvedValue(4)

    const res = await f.svc.previewJoinLink(LINK.token, 8)

    expect(res.linkStatus).toBe('expired')
    expect(res.membership).toBe('none')
    expect(res.request?.status).toBe('pending')
    expect(res.team).toEqual(
      expect.objectContaining({ name: 'Acme', slug: 'acme', memberCount: 4 }),
    )
    // No roster, no credits, no token echoed back.
    expect(JSON.stringify(res)).not.toContain(LINK.token)
    expect(res).not.toHaveProperty('members')
  })

  it('a plain member never receives the join link or the approval queue', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue(ORG)
    f.prisma.organizationMember.findFirst.mockResolvedValueOnce({
      id: 2,
      role: 'member',
      status: 'active',
      bucketCredits: 0,
      bucketQuota: 0,
    })

    const res = await f.svc.getForMember('acme', 8)

    expect(res.joinLink).toBeNull()
    expect(res.joinRequests).toEqual([])
    // Not even queried for a non-admin — the token must not leave the DB.
    expect(f.prisma.organizationJoinLink.findUnique).not.toHaveBeenCalled()
    expect(f.prisma.organizationJoinRequest.findMany).not.toHaveBeenCalled()
  })
})

describe('OrganizationsService · members', () => {
  it('removes a member by flipping status and zeroing their bucket', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue(ORG)
    f.prisma.organizationMember.findFirst
      .mockResolvedValueOnce({ id: 1, role: 'admin', status: 'active' }) // requireAdmin
      .mockResolvedValueOnce({ id: 4, role: 'member', status: 'active' }) // target

    await f.svc.removeMember('acme', 1, 8)

    expect(f.prisma.organizationMember.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { status: 'removed', bucketCredits: 0 },
    })
  })

  it('refuses to remove the team owner', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue(ORG)
    f.prisma.organizationMember.findFirst.mockResolvedValue({
      id: 1,
      role: 'admin',
      status: 'active',
    })
    await expect(f.svc.removeMember('acme', 1, ORG.adminId)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('raising a quota credits the difference immediately', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue(ORG)
    f.prisma.organizationMember.findFirst
      .mockResolvedValueOnce({ id: 1, role: 'admin', status: 'active' })
      .mockResolvedValueOnce({ id: 4, bucketQuota: 100, bucketCredits: 40 })

    await f.svc.setMemberQuota('acme', 1, 8, 250)

    expect(f.prisma.organizationMember.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { bucketQuota: 250, bucketCredits: 190 }, // 40 + (250-100)
    })
  })

  it('lowering a quota clamps the remaining balance', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue(ORG)
    f.prisma.organizationMember.findFirst
      .mockResolvedValueOnce({ id: 1, role: 'admin', status: 'active' })
      .mockResolvedValueOnce({ id: 4, bucketQuota: 300, bucketCredits: 280 })

    await f.svc.setMemberQuota('acme', 1, 8, 50)

    expect(f.prisma.organizationMember.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { bucketQuota: 50, bucketCredits: 50 },
    })
  })

  it('refuses to let the owner leave their own team', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue(ORG)
    await expect(f.svc.leave('acme', ORG.adminId)).rejects.toThrow(BadRequestException)
  })
})

describe('OrganizationsService · purchased (pay-as-you-go) team credits', () => {
  it('a plain grant raises the team’s hard cap and nobody’s bucket', async () => {
    const f = makeFixture()
    f.prisma.creditPool.findUnique.mockResolvedValue({
      organizationId: 21,
      totalCredits: 1000,
      usedCredits: 900,
      extraCredits: 0,
      periodEnd: new Date('2099-01-01'),
    })
    f.prisma.creditPool.update.mockResolvedValue({
      organizationId: 21,
      totalCredits: 1000,
      usedCredits: 900,
      extraCredits: 500,
      periodEnd: new Date('2099-01-01'),
    })

    const res = await f.svc.grantExtraCredits(21, 500)

    // The pool is the HARD cap, so this is the write that actually makes the
    // purchase spendable.
    expect(f.prisma.creditPool.update).toHaveBeenCalledWith({
      where: { organizationId: 21 },
      data: { extraCredits: { increment: 500 } },
    })
    expect(f.prisma.organizationMember.update).not.toHaveBeenCalled()
    expect(res).toEqual(
      expect.objectContaining({ credits: 500, targetUserId: null, extraCredits: 500 }),
    )
  })

  it('a targeted grant raises the member’s quota AND the pool', async () => {
    const f = makeFixture()
    f.prisma.creditPool.findUnique.mockResolvedValue({
      organizationId: 21,
      totalCredits: 1000,
      usedCredits: 0,
      extraCredits: 200,
      periodEnd: null,
    })
    f.prisma.organizationMember.findFirst.mockResolvedValue({
      id: 4,
      userId: 8,
      status: 'active',
      bucketQuota: 100,
      bucketCredits: 30,
    })

    const res = await f.svc.grantExtraCredits(21, 500, 8)

    // Raising the bucket alone would hand the member a number they cannot spend:
    // the pool caps everyone. So both move.
    expect(f.prisma.creditPool.update).toHaveBeenCalledWith({
      where: { organizationId: 21 },
      data: { extraCredits: { increment: 500 } },
    })
    expect(f.prisma.organizationMember.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { bucketQuota: 600, bucketCredits: 530 },
    })
    expect(res.targetUserId).toBe(8)
  })

  it('a grant aimed at someone who left falls back to the pool, and says so', async () => {
    const f = makeFixture()
    f.prisma.creditPool.findUnique.mockResolvedValue({
      organizationId: 21,
      totalCredits: 1000,
      usedCredits: 0,
      extraCredits: 0,
      periodEnd: null,
    })
    // No ACTIVE seat for that user any more.
    f.prisma.organizationMember.findFirst.mockResolvedValue(null)

    const res = await f.svc.grantExtraCredits(21, 500, 8)

    // The money already moved, so the grant must never fail — it lands in the
    // pool where the rest of the team can use it.
    expect(f.prisma.creditPool.update).toHaveBeenCalled()
    expect(f.prisma.organizationMember.update).not.toHaveBeenCalled()
    expect(res.targetUserId).toBeNull()
    expect(res.targetMissing).toBe(true)
  })

  it('creates the pool row when a grant arrives before one exists', async () => {
    const f = makeFixture()
    f.prisma.creditPool.findUnique.mockResolvedValue(null)

    await f.svc.grantExtraCredits(21, 500)

    expect(f.prisma.creditPool.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 21 },
        create: expect.objectContaining({ organizationId: 21, extraCredits: 500 }),
      }),
    )
  })

  it('refuses a non-positive grant rather than writing a no-op', async () => {
    const f = makeFixture()
    await expect(f.svc.grantExtraCredits(21, 0)).rejects.toThrow(BadRequestException)
    await expect(f.svc.grantExtraCredits(21, -5)).rejects.toThrow(BadRequestException)
    expect(f.prisma.creditPool.update).not.toHaveBeenCalled()
  })

  it('renewal zeroes purchased credits — that IS the expiry', async () => {
    const f = makeFixture()
    f.prisma.organizationMember.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }])

    await f.svc.activateSubscription(21, TEAM_PLAN, new Date('2099-01-01'))

    const arg = f.prisma.creditPool.upsert.mock.calls[0][0]
    // Both the create and the update path must zero it: a renewal that only
    // reset total_credits would silently carry purchased credits into the next
    // period, which is the opposite of what the product promises.
    expect(arg.create.extraCredits).toBe(0)
    expect(arg.update.extraCredits).toBe(0)
  })

  it('reports the allowance split so the dashboard never conflates the two', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue({
      ...ORG,
      creditPool: {
        totalCredits: 1000,
        usedCredits: 1150,
        extraCredits: 500,
        periodEnd: new Date('2099-01-01'),
      },
    })
    f.prisma.organizationMember.findFirst.mockResolvedValueOnce({
      id: 1,
      role: 'admin',
      status: 'active',
      bucketCredits: 0,
      bucketQuota: 0,
    })

    const res = await f.svc.getForMember('acme', 1)

    expect(res.creditPool).toEqual(
      expect.objectContaining({
        totalCredits: 1000,
        extraCredits: 500,
        // 1000 + 500 - 1150 spent
        remainingCredits: 350,
        // The plan's own allowance is gone; what is left is purchased.
        planRemaining: 0,
        extraRemaining: 350,
      }),
    )
  })
})

describe('OrganizationsService · team billing', () => {
  it('seeds the pool from the plan allowance and splits it across members', async () => {
    const f = makeFixture()
    f.prisma.organizationMember.findMany.mockResolvedValue([
      { id: 1 },
      { id: 2 },
      { id: 3 },
      { id: 4 },
    ])
    const periodEnd = new Date(Date.now() + 1000)

    const res = await f.svc.activateSubscription(21, TEAM_PLAN, periodEnd)

    // Org-owned subscription, NOT an individual one.
    expect(f.prisma.organizationSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 21 } }),
    )
    expect(f.prisma.creditPool.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        // extraCredits: 0 — a renewal must not carry purchased credits into the
        // next period (that is how they expire).
        update: { totalCredits: 1000, usedCredits: 0, extraCredits: 0, periodEnd },
      }),
    )
    // seatCredits = 0 → equal split: 1000 / 4 members.
    expect(f.prisma.organizationMember.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 21, status: 'active' },
      data: { bucketQuota: 250, bucketCredits: 250 },
    })
    expect(res).toEqual({ totalCredits: 1000, members: 4 })
  })

  it("uses the plan's seatCredits when the admin configured one", async () => {
    const f = makeFixture()
    f.prisma.organizationMember.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }])

    await f.svc.activateSubscription(21, SEATED_PLAN, new Date())

    expect(f.prisma.organizationMember.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 21, status: 'active' },
      data: { bucketQuota: 150, bucketCredits: 150 },
    })
  })

  it('renewal re-seeds the pool and resets every bucket to its quota', async () => {
    const f = makeFixture()
    f.prisma.organizationSubscription.findUnique.mockResolvedValue({
      organizationId: 21,
      status: 'active',
      plan: SEATED_PLAN,
    })
    f.prisma.organizationMember.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }])

    const res = await f.svc.renewSubscription(21)

    expect(f.prisma.creditPool.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ totalCredits: 1000, usedCredits: 0 }),
      }),
    )
    expect(f.prisma.organizationMember.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 21, status: 'active' },
      data: { bucketQuota: 150, bucketCredits: 150 },
    })
    expect(res?.periodEnd.getTime()).toBeGreaterThan(Date.now())
  })

  it('charges the member bucket first', async () => {
    const f = makeFixture()
    f.prisma.organizationMember.findUnique.mockResolvedValue({
      id: 4,
      status: 'active',
      bucketCredits: 100,
    })
    f.prisma.creditPool.findUnique.mockResolvedValue({
      totalCredits: 1000,
      usedCredits: 0,
    })

    const res = await f.svc.chargeMemberBucket(21, 8, 30)

    expect(res.source).toBe('bucket')
    expect(res.fromBucket).toBe(30)
    expect(res.fromPool).toBe(0)
    expect(f.prisma.organizationMember.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { bucketCredits: 70 },
    })
    // The pool drains too — it is the cap on TOTAL team usage.
    expect(f.prisma.creditPool.update).toHaveBeenCalledWith({
      where: { organizationId: 21 },
      data: { usedCredits: 30 },
    })
  })

  it('falls back to the shared pool when the bucket is exhausted', async () => {
    const f = makeFixture()
    f.prisma.organizationMember.findUnique.mockResolvedValue({
      id: 4,
      status: 'active',
      bucketCredits: 10,
    })
    f.prisma.creditPool.findUnique.mockResolvedValue({
      totalCredits: 1000,
      usedCredits: 100,
    })

    const res = await f.svc.chargeMemberBucket(21, 8, 50)

    expect(res.source).toBe('pool')
    expect(res.fromBucket).toBe(10)
    expect(res.fromPool).toBe(40)
    expect(f.prisma.organizationMember.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { bucketCredits: 0 },
    })
  })

  it('blocks the charge when the pool is exhausted', async () => {
    const f = makeFixture()
    f.prisma.organizationMember.findUnique.mockResolvedValue({
      id: 4,
      status: 'active',
      bucketCredits: 500,
    })
    f.prisma.creditPool.findUnique.mockResolvedValue({
      totalCredits: 1000,
      usedCredits: 1000,
    })

    await expect(f.svc.chargeMemberBucket(21, 8, 1)).rejects.toThrow(
      InsufficientCreditsError,
    )
    expect(f.prisma.organizationMember.update).not.toHaveBeenCalled()
    expect(f.prisma.creditPool.update).not.toHaveBeenCalled()
  })

  it('refuses to charge a removed member', async () => {
    const f = makeFixture()
    f.prisma.organizationMember.findUnique.mockResolvedValue({
      id: 4,
      status: 'removed',
      bucketCredits: 500,
    })
    await expect(f.svc.chargeMemberBucket(21, 8, 1)).rejects.toThrow(ForbiddenException)
  })
})

describe('OrganizationsService · super-admin oversight', () => {
  it('suspending a team cancels its subscription and deactivates every seat', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue(ORG)

    await f.svc.suspendOrganization(21)

    expect(f.prisma.organization.update).toHaveBeenCalledWith({
      where: { id: 21 },
      data: { status: 'suspended' },
    })
    expect(f.prisma.organizationMember.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 21, status: 'active' },
      data: { status: 'removed' },
    })
    expect(f.prisma.organizationSubscription.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 21 },
      data: { status: 'canceled' },
    })
  })

  it('findActiveMembership ignores a seat in a suspended org', async () => {
    const f = makeFixture()
    f.prisma.organizationMember.findFirst.mockResolvedValue(null)
    await expect(f.svc.findActiveMembership(8)).resolves.toBeNull()
    // The suspended-org filter is part of the QUERY, not post-filtering.
    expect(f.prisma.organizationMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'active',
          organization: { status: 'active' },
        }),
      }),
    )
  })
})
