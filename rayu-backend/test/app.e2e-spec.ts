import { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { createTestApp, TestContext } from './test-app'

describe('rayu-backend (e2e)', () => {
  let ctx: TestContext
  let app: INestApplication

  beforeAll(async () => {
    ctx = await createTestApp()
    app = ctx.app
  })

  afterAll(async () => {
    await app.close()
  })

  it('GET /api/health -> ok', async () => {
    const res = await request(app.getHttpServer()).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
  })

  it('GET /api/plans -> 6 plans, free+basic active, others coming_soon', async () => {
    const res = await request(app.getHttpServer()).get('/api/plans')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(6)
    const byCode = Object.fromEntries(
      res.body.map((p: any) => [p.code, p.availability]),
    )
    expect(byCode.free).toBe('active')
    expect(byCode.basic).toBe('active')
    expect(byCode.pro).toBe('coming_soon')
    expect(byCode.pro_plus).toBe('coming_soon')
    expect(byCode.max).toBe('coming_soon')
    expect(byCode.enterprise).toBe('coming_soon')
    // Basic is the $3/mo tier (price comes from the DB, not hardcoded in UI).
    const basic = res.body.find((p: any) => p.code === 'basic')
    expect(basic.priceCents).toBe(300)
  })

  it('full CLI bridge: exchange -> token -> /me, replay fails', async () => {
    ctx.setClerkUser({
      clerkUserId: 'clerk_user_1',
      email: 'user1@example.com',
      displayName: 'User One',
      avatarUrl: null,
    })

    const exchange = await request(app.getHttpServer())
      .post('/api/cli/exchange')
      .set('Authorization', 'Bearer fake-clerk-token')
      .send({ state: 'state-1' })
    expect(exchange.status).toBe(201)
    const code = exchange.body.code
    expect(typeof code).toBe('string')

    const token = await request(app.getHttpServer())
      .post('/api/cli/token')
      .send({ code })
    expect(token.status).toBe(201)
    expect(token.body.accessToken).toBeTruthy()
    expect(token.body.refreshToken).toBeTruthy()
    expect(token.body.user.email).toBe('user1@example.com')

    const me = await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${token.body.accessToken}`)
    expect(me.status).toBe(200)
    expect(me.body.user.email).toBe('user1@example.com')

    // Replay of the same code must fail.
    const replay = await request(app.getHttpServer())
      .post('/api/cli/token')
      .send({ code })
    expect(replay.status).toBe(401)
  })

  it('web/session mints Rayu tokens directly from a Clerk token', async () => {
    ctx.setClerkUser({
      clerkUserId: 'clerk_web',
      email: 'web@example.com',
      displayName: 'Web User',
      avatarUrl: null,
    })
    const res = await request(app.getHttpServer())
      .post('/api/web/session')
      .set('Authorization', 'Bearer fake-clerk')
      .send({})
    expect(res.status).toBe(201)
    expect(res.body.accessToken).toBeTruthy()
    expect(res.body.user.email).toBe('web@example.com')

    const me = await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
    expect(me.status).toBe(200)
  })

  it('refresh issues a new access token', async () => {
    ctx.setClerkUser({
      clerkUserId: 'clerk_user_refresh',
      email: 'refresh@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const exchange = await request(app.getHttpServer())
      .post('/api/cli/exchange')
      .set('Authorization', 'Bearer t')
      .send({ state: 's' })
    const token = await request(app.getHttpServer())
      .post('/api/cli/token')
      .send({ code: exchange.body.code })

    const refreshed = await request(app.getHttpServer())
      .post('/api/cli/refresh')
      .send({ refreshToken: token.body.refreshToken })
    expect(refreshed.status).toBe(201)
    expect(refreshed.body.accessToken).toBeTruthy()
  })

  it('/me rejects missing/invalid tokens', async () => {
    await request(app.getHttpServer()).get('/api/me').expect(401)
    await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', 'Bearer garbage')
      .expect(401)
  })

  it('usage: record then summary returns top provider', async () => {
    ctx.setClerkUser({
      clerkUserId: 'clerk_usage',
      email: 'usage@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const access = await login(app, 'state-usage')

    const post = (provider: string) =>
      request(app.getHttpServer())
        .post('/api/usage')
        .set('Authorization', `Bearer ${access}`)
        .send({ provider, model: 'm', source: 'cli' })
    await post('anthropic')
    await post('anthropic')
    await post('openai')

    const summary = await request(app.getHttpServer())
      .get('/api/usage/summary')
      .set('Authorization', `Bearer ${access}`)
    expect(summary.status).toBe(200)
    expect(summary.body.total).toBe(3)
    expect(summary.body.topProvider).toBe('anthropic')
  })

  it('feedback persists for an authed user', async () => {
    ctx.setClerkUser({
      clerkUserId: 'clerk_fb',
      email: 'fb@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const access = await login(app, 'state-fb')
    const res = await request(app.getHttpServer())
      .post('/api/feedback')
      .set('Authorization', `Bearer ${access}`)
      .send({ type: 'idea', message: 'add dark mode', rating: 5 })
    expect(res.status).toBe(201)
    expect(res.body.ok).toBe(true)
  })

  it('admin endpoints: non-admin 403, admin can list + suspend, suspended rejected', async () => {
    // Make an admin user.
    ctx.setClerkUser({
      clerkUserId: 'clerk_admin',
      email: 'admin@example.com',
      displayName: 'Admin',
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-admin')
    // Non-admin (regular user) first.
    ctx.setClerkUser({
      clerkUserId: 'clerk_regular',
      email: 'regular@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const regularAccess = await login(app, 'state-regular')

    // Regular user blocked from admin.
    await request(app.getHttpServer())
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${regularAccess}`)
      .expect(403)

    // Promote admin user in the DB.
    await ctx.prisma.user.update({
      where: { clerkUserId: 'clerk_admin' },
      data: { role: 'superadmin' },
    })
    // Re-login to get a token carrying the new role is not required because the
    // guard reads the live user, but role is embedded for RolesGuard via the
    // attached user. The guard loads the live user, so the existing token works.

    const list = await request(app.getHttpServer())
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(list.status).toBe(200)
    expect(list.body.total).toBeGreaterThan(0)

    // Find the regular user id and suspend it.
    const regular = await ctx.prisma.user.findUnique({
      where: { clerkUserId: 'clerk_regular' },
    })
    expect(regular).toBeTruthy()
    const suspend = await request(app.getHttpServer())
      .patch(`/api/admin/users/${regular!.id}/status`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ status: 'suspended' })
    expect(suspend.status).toBe(200)

    // Suspended user's token is now rejected.
    await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${regularAccess}`)
      .expect(401)

    // Stats available to admin.
    const stats = await request(app.getHttpServer())
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(stats.status).toBe(200)
    expect(stats.body.totalUsers).toBeGreaterThan(0)
  })

  it('end-to-end chain: login -> usage -> visible in admin stats', async () => {
    // A fresh user signs in via the CLI bridge.
    ctx.setClerkUser({
      clerkUserId: 'clerk_chain',
      email: 'chain@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const access = await login(app, 'state-chain-123456')

    // The CLI records a query against a provider.
    await request(app.getHttpServer())
      .post('/api/usage')
      .set('Authorization', `Bearer ${access}`)
      .send({ provider: 'deepseek', model: 'deepseek-chat', source: 'cli' })
      .expect(201)

    // An admin sees the usage reflected in global stats.
    ctx.setClerkUser({
      clerkUserId: 'clerk_admin2',
      email: 'admin2@example.com',
      displayName: 'Admin Two',
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-admin2-123456')
    await ctx.prisma.user.update({
      where: { clerkUserId: 'clerk_admin2' },
      data: { role: 'admin' },
    })
    const stats = await request(app.getHttpServer())
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(stats.status).toBe(200)
    const providers = (stats.body.usageByProvider as Array<{ provider: string }>).map(
      (p) => p.provider,
    )
    expect(providers).toContain('deepseek')
  })

  it('admin can manage plans (features, price, limits) and changes persist + drive entitlements', async () => {
    // Promote an admin.
    ctx.setClerkUser({
      clerkUserId: 'clerk_planadmin',
      email: 'planadmin@example.com',
      displayName: 'Plan Admin',
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-planadmin-123456')
    await ctx.prisma.user.update({
      where: { clerkUserId: 'clerk_planadmin' },
      data: { role: 'superadmin' },
    })

    // A regular free user.
    ctx.setClerkUser({
      clerkUserId: 'clerk_freeuser',
      email: 'freeuser@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const freeAccess = await login(app, 'state-freeuser-123456')

    // Non-admin cannot list/patch plans.
    await request(app.getHttpServer())
      .get('/api/admin/plans')
      .set('Authorization', `Bearer ${freeAccess}`)
      .expect(403)
    await request(app.getHttpServer())
      .patch('/api/admin/plans/free')
      .set('Authorization', `Bearer ${freeAccess}`)
      .send({ priceCents: 999 })
      .expect(403)

    // Admin lists plans + feature catalog.
    const listed = await request(app.getHttpServer())
      .get('/api/admin/plans')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(listed.status).toBe(200)
    expect(Array.isArray(listed.body.catalog)).toBe(true)
    expect(listed.body.plans.length).toBe(6)

    // Free user's entitlements start with telegram disabled (default).
    const before = await request(app.getHttpServer())
      .get('/api/me/entitlements')
      .set('Authorization', `Bearer ${freeAccess}`)
    expect(before.status).toBe(200)
    expect(before.body.plan.code).toBe('free')
    expect(before.body.features.telegram.enabled).toBe(false)

    // Admin enables telegram for free + sets maxDailyTurns + a feature limit.
    const patched = await request(app.getHttpServer())
      .patch('/api/admin/plans/free')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        maxDailyTurns: 100,
        features: {
          telegram: { enabled: true },
          image_generation: { enabled: true, limit: 5 },
        },
      })
    expect(patched.status).toBe(200)
    expect(patched.body.maxDailyTurns).toBe(100)
    expect(patched.body.features.telegram.enabled).toBe(true)
    expect(patched.body.features.image_generation.limit).toBe(5)

    // The free user's entitlements now reflect the admin change.
    const after = await request(app.getHttpServer())
      .get('/api/me/entitlements')
      .set('Authorization', `Bearer ${freeAccess}`)
    expect(after.body.maxDailyTurns).toBe(100)
    expect(after.body.features.telegram.enabled).toBe(true)
    expect(after.body.features.image_generation.limit).toBe(5)

    // Admin changes the $3 Basic price -> reflected on the public catalog
    // (proves price is admin-editable, not hardcoded).
    const repriced = await request(app.getHttpServer())
      .patch('/api/admin/plans/basic')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ priceCents: 400 })
    expect(repriced.status).toBe(200)
    expect(repriced.body.priceCents).toBe(400)

    const plans = await request(app.getHttpServer()).get('/api/plans')
    const basic = plans.body.find((p: any) => p.code === 'basic')
    expect(basic.priceCents).toBe(400)

    // Unknown feature key is rejected.
    await request(app.getHttpServer())
      .patch('/api/admin/plans/free')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ features: { not_a_feature: { enabled: true } } })
      .expect(400)
  })

  it('GET /api/me/entitlements rejects unauthenticated', async () => {
    await request(app.getHttpServer()).get('/api/me/entitlements').expect(401)
  })

  it('GET /api/admin/analytics returns the full analytics payload (admin only)', async () => {
    ctx.setClerkUser({
      clerkUserId: 'clerk_analytics_admin',
      email: 'analytics@example.com',
      displayName: 'Analytics Admin',
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-analytics-123456')
    await ctx.prisma.user.update({
      where: { clerkUserId: 'clerk_analytics_admin' },
      data: { role: 'admin' },
    })
    // Generate a usage event so series/top-users have data.
    await request(app.getHttpServer())
      .post('/api/usage')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ provider: 'openai', model: 'gpt', source: 'cli' })
      .expect(201)

    // Non-admin is blocked.
    ctx.setClerkUser({
      clerkUserId: 'clerk_analytics_regular',
      email: 'areg@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const regularAccess = await login(app, 'state-areg-123456')
    await request(app.getHttpServer())
      .get('/api/admin/analytics')
      .set('Authorization', `Bearer ${regularAccess}`)
      .expect(403)

    const res = await request(app.getHttpServer())
      .get('/api/admin/analytics')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(res.status).toBe(200)
    const a = res.body
    expect(a.totals.totalUsers).toBeGreaterThan(0)
    expect(typeof a.totals.activeUsers30d).toBe('number')
    expect(a.statusBreakdown).toHaveProperty('active')
    // Plan distribution includes the seeded catalog (free + basic).
    const codes = a.planDistribution.map((p: any) => p.code)
    expect(codes).toContain('free')
    expect(codes).toContain('basic')
    expect(a.paidVsFree).toHaveProperty('free')
    expect(a.paidVsFree).toHaveProperty('paid')
    expect(a.revenue).toHaveProperty('totalCents')
    expect(Array.isArray(a.revenue.byMonth)).toBe(true)
    expect(a.signupsByDay).toHaveLength(30)
    expect(a.activeByDay).toHaveLength(14)
    expect(Array.isArray(a.usageByProvider)).toBe(true)
    expect(Array.isArray(a.topUsers)).toBe(true)
    expect(typeof a.canceledSubscriptions).toBe('number')
    // The usage we posted shows in provider breakdown + top users.
    expect(a.usageByProvider.map((u: any) => u.provider)).toContain('openai')
    expect(a.topUsers.length).toBeGreaterThan(0)
  })
})

// Helper: run the exchange->token bridge for the currently-set Clerk user and
// return the access token.
async function login(app: INestApplication, state: string): Promise<string> {
  const exchange = await request(app.getHttpServer())
    .post('/api/cli/exchange')
    .set('Authorization', 'Bearer clerk')
    .send({ state })
  const token = await request(app.getHttpServer())
    .post('/api/cli/token')
    .send({ code: exchange.body.code })
  return token.body.accessToken
}
