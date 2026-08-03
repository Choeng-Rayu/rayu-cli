import { ConfigService } from '@nestjs/config'
import type { JwtService } from '@nestjs/jwt'
import type { User } from '@prisma/client'
import { AuthService } from './auth.service'
import type { CodeStoreService } from './code-store.service'
import type { OAuthService, VerifiedOAuthProfile } from './oauth.service'
import { OrganizationsService } from '../organizations/organizations.service'
import type { PlansService } from '../plans/plans.service'
import type { PrismaService } from '../prisma/prisma.service'
import type { UsersService } from '../users/users.service'

/**
 * Team SSO: a Google Workspace signer is auto-adopted by the org that owns their
 * hosted domain, and the Rayu JWT they receive carries { orgId, orgRole }. A
 * personal Google account (no `hd`) is untouched and stays an individual user —
 * that ABSENCE of claims is the backwards-compatible contract the CLI and the
 * gateway already rely on.
 */

type Mock = jest.Mock

interface Fixture {
  auth: AuthService
  orgs: OrganizationsService
  prisma: {
    organization: { findUnique: Mock }
    organizationMember: {
      findUnique: Mock
      findFirst: Mock
      create: Mock
      update: Mock
      count: Mock
    }
    organizationInvite: { updateMany: Mock }
    organizationSubscription: { findUnique: Mock }
    creditPool: { findUnique: Mock }
    user: { findUnique: Mock }
  }
  signed: Array<Record<string, unknown>>
  setProfile: (p: VerifiedOAuthProfile) => void
}

const TEAM_USER: User = {
  id: 7,
  email: 'alice@company.com',
  displayName: 'Alice',
  avatarUrl: null,
  emailVerified: true,
  role: 'user',
  status: 'active',
  passwordHash: null,
  createdAt: new Date(),
  lastActiveAt: null,
} as unknown as User

function makeFixture(): Fixture {
  const prisma = {
    organization: { findUnique: jest.fn() },
    organizationMember: {
      findUnique: jest.fn(),
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(() => Promise.resolve({ id: 1 })),
      update: jest.fn(() => Promise.resolve({ id: 1 })),
      count: jest.fn(() => Promise.resolve(1)),
    },
    organizationInvite: { updateMany: jest.fn(() => Promise.resolve({ count: 0 })) },
    organizationSubscription: { findUnique: jest.fn(() => Promise.resolve(null)) },
    creditPool: { findUnique: jest.fn(() => Promise.resolve(null)) },
    user: { findUnique: jest.fn(() => Promise.resolve(TEAM_USER)) },
  }
  const plans = { getLimits: jest.fn(() => ({})) }
  const config = new ConfigService({
    app: { accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 60, webOrigin: 'http://x' },
  })
  const orgs = new OrganizationsService(
    prisma as unknown as PrismaService,
    plans as unknown as PlansService,
    config,
  )

  let profile: VerifiedOAuthProfile = {
    provider: 'google',
    providerAccountId: 'g-alice',
    email: 'alice@company.com',
    displayName: 'Alice',
    avatarUrl: null,
    emailVerified: true,
    hostedDomain: 'company.com',
  }
  const oauth = {
    verifyGoogleIdToken: jest.fn(() => Promise.resolve(profile)),
  }
  const users = { upsertFromOAuth: jest.fn(() => Promise.resolve(TEAM_USER)) }
  const signed: Array<Record<string, unknown>> = []
  const jwt = {
    sign: jest.fn((payload: Record<string, unknown>) => {
      signed.push(payload)
      return `signed.${signed.length}`
    }),
  }
  const auth = new AuthService(
    oauth as unknown as OAuthService,
    users as unknown as UsersService,
    {} as unknown as CodeStoreService,
    jwt as unknown as JwtService,
    config,
    orgs,
  )
  return {
    auth,
    orgs,
    prisma: prisma as unknown as Fixture['prisma'],
    signed,
    setProfile: (p) => {
      profile = p
    },
  }
}

const ACTIVE_ORG = {
  id: 21,
  slug: 'acme',
  ssoDomain: '@company.com',
  status: 'active',
  adminId: 1,
}

describe('Team SSO · Google hosted-domain auto-join', () => {
  it('auto-joins a Workspace signer whose hd matches an org ssoDomain', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue(ACTIVE_ORG)
    // No existing seat, then the seat that was just created.
    f.prisma.organizationMember.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 5, role: 'member', status: 'active' })

    const ctx = await f.orgs.autoJoinFromHostedDomain(TEAM_USER.id, 'company.com')

    expect(f.prisma.organization.findUnique).toHaveBeenCalledWith({
      where: { ssoDomain: '@company.com' },
    })
    expect(f.prisma.organizationMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 21,
          userId: 7,
          role: 'member',
          status: 'active',
        }),
      }),
    )
    expect(ctx).toEqual({ orgId: 21, orgRole: 'member', slug: 'acme' })
  })

  it('normalizes the hd claim, so "Company.COM" matches "@company.com"', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue(ACTIVE_ORG)
    f.prisma.organizationMember.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 5, role: 'member', status: 'active' })

    await f.orgs.autoJoinFromHostedDomain(TEAM_USER.id, 'Company.COM')

    expect(f.prisma.organization.findUnique).toHaveBeenCalledWith({
      where: { ssoDomain: '@company.com' },
    })
  })

  it('does NOT auto-join a personal Google account (no hd claim)', async () => {
    const f = makeFixture()
    const ctx = await f.orgs.autoJoinFromHostedDomain(TEAM_USER.id, null)
    expect(ctx).toBeNull()
    expect(f.prisma.organization.findUnique).not.toHaveBeenCalled()
    expect(f.prisma.organizationMember.create).not.toHaveBeenCalled()
  })

  it('does NOT auto-join a consumer domain even if some org claimed it', async () => {
    const f = makeFixture()
    const ctx = await f.orgs.autoJoinFromHostedDomain(TEAM_USER.id, 'gmail.com')
    expect(ctx).toBeNull()
    expect(f.prisma.organization.findUnique).not.toHaveBeenCalled()
  })

  it('does NOT auto-join when no org claims the domain', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue(null)
    const ctx = await f.orgs.autoJoinFromHostedDomain(TEAM_USER.id, 'company.com')
    expect(ctx).toBeNull()
    expect(f.prisma.organizationMember.create).not.toHaveBeenCalled()
  })

  it('does NOT auto-join into a suspended org', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue({
      ...ACTIVE_ORG,
      status: 'suspended',
    })
    const ctx = await f.orgs.autoJoinFromHostedDomain(TEAM_USER.id, 'company.com')
    expect(ctx).toBeNull()
    expect(f.prisma.organizationMember.create).not.toHaveBeenCalled()
  })

  it('re-activates a previously removed seat instead of creating a duplicate', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue(ACTIVE_ORG)
    f.prisma.organizationMember.findUnique
      .mockResolvedValueOnce({ id: 5, role: 'member', status: 'removed' })
      .mockResolvedValueOnce({ id: 5, role: 'member', status: 'active' })

    const ctx = await f.orgs.autoJoinFromHostedDomain(TEAM_USER.id, 'company.com')

    expect(f.prisma.organizationMember.create).not.toHaveBeenCalled()
    expect(f.prisma.organizationMember.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { status: 'active' },
    })
    expect(ctx).toEqual({ orgId: 21, orgRole: 'member', slug: 'acme' })
  })

  it('leaves a user who already has a seat elsewhere on their current team', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue(ACTIVE_ORG)
    f.prisma.organizationMember.findUnique.mockResolvedValueOnce(null)
    // findActiveMembership → an active seat in a DIFFERENT org.
    f.prisma.organizationMember.findFirst.mockResolvedValueOnce({
      organizationId: 99,
      role: 'admin',
      organization: { id: 99, slug: 'other' },
    })

    const ctx = await f.orgs.autoJoinFromHostedDomain(TEAM_USER.id, 'company.com')

    expect(ctx).toEqual({ orgId: 99, orgRole: 'admin', slug: 'other' })
    expect(f.prisma.organizationMember.create).not.toHaveBeenCalled()
  })
})

describe('Team SSO · JWT claims', () => {
  it('webSession mints an access token carrying orgId + orgRole', async () => {
    const f = makeFixture()
    f.prisma.organization.findUnique.mockResolvedValue(ACTIVE_ORG)
    f.prisma.organizationMember.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 5, role: 'member', status: 'active' })

    const res = await f.auth.webSession('google-id-token')

    expect(res.organization).toEqual({ orgId: 21, orgRole: 'member', slug: 'acme' })
    const access = f.signed[0]
    expect(access).toEqual({
      sub: 7,
      role: 'user',
      type: 'access',
      orgId: 21,
      orgRole: 'member',
    })
  })

  it('an individual user gets the SAME claim set as before teams existed', async () => {
    const f = makeFixture()
    f.setProfile({
      provider: 'google',
      providerAccountId: 'g-bob',
      email: 'bob@gmail.com',
      displayName: 'Bob',
      avatarUrl: null,
      emailVerified: true,
      hostedDomain: null,
    })
    // No team seat anywhere.
    f.prisma.organizationMember.findFirst.mockResolvedValue(null)

    const res = await f.auth.webSession('google-id-token')

    expect(res.organization).toBeNull()
    // Exactly the pre-teams shape: no orgId, no orgRole keys at all.
    expect(f.signed[0]).toEqual({ sub: 7, role: 'user', type: 'access' })
    expect(Object.keys(f.signed[0])).not.toContain('orgId')
  })

  it('mintTokens without an org argument omits the team claims entirely', () => {
    const f = makeFixture()
    f.auth.mintTokens(TEAM_USER)
    expect(f.signed[0]).toEqual({ sub: 7, role: 'user', type: 'access' })
  })
})

describe('OAuthService · hd extraction', () => {
  // The verifier is exercised through a stubbed fetch: the point under test is
  // that `hd` from the Google-signed token reaches the profile (and is
  // lowercased), not Google's HTTP behavior.
  const realFetch = global.fetch

  afterEach(() => {
    global.fetch = realFetch
  })

  it('surfaces hd as hostedDomain, lowercased', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            sub: '123',
            email: 'alice@company.com',
            email_verified: 'true',
            name: 'Alice',
            hd: 'Company.COM',
          }),
      }),
    ) as unknown as typeof fetch
    // Imported lazily so the stubbed fetch is in place for the constructor-free
    // service (it only reads config at construction).
    const { OAuthService: Svc } = await import('./oauth.service')
    const svc = new Svc(new ConfigService({ app: {} }))
    const profile = await svc.verifyGoogleIdToken('token')
    expect(profile.hostedDomain).toBe('company.com')
  })

  it('reports hostedDomain as null for a personal account', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ sub: '123', email: 'bob@gmail.com', email_verified: 'true' }),
      }),
    ) as unknown as typeof fetch
    const { OAuthService: Svc } = await import('./oauth.service')
    const svc = new Svc(new ConfigService({ app: {} }))
    const profile = await svc.verifyGoogleIdToken('token')
    expect(profile.hostedDomain).toBeNull()
  })
})
