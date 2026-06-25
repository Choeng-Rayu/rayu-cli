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

  it('GET /api/plans -> 6 plans; free/basic + hosted tiers active, enterprise coming_soon', async () => {
    const res = await request(app.getHttpServer()).get('/api/plans')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(6)
    const byCode = Object.fromEntries(
      res.body.map((p: any) => [p.code, p.availability]),
    )
    expect(byCode.free).toBe('active')
    expect(byCode.basic).toBe('active')
    expect(byCode.pro).toBe('active')
    expect(byCode.pro_plus).toBe('active')
    expect(byCode.max).toBe('active')
    expect(byCode.enterprise).toBe('coming_soon')
    // Basic is the $3/mo tier (price comes from the DB, not hardcoded in UI).
    const basic = res.body.find((p: any) => p.code === 'basic')
    expect(basic.priceCents).toBe(300)
  })

  it('POST /api/payments/khqr issues KHQR for an active hosted plan, rejects coming_soon', async () => {
    ctx.setClerkUser({
      clerkUserId: 'clerk_buyer',
      email: 'buyer@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const access = await login(app, 'state-buyer-1234')

    // Pro is now purchasable -> a QR + pending payment are created.
    const ok = await request(app.getHttpServer())
      .post('/api/payments/khqr')
      .set('Authorization', `Bearer ${access}`)
      .send({ planCode: 'pro', method: 'bakong' })
    expect(ok.status).toBe(201)
    expect(ok.body.planCode).toBe('pro')
    expect(ok.body.amountCents).toBe(1000)
    expect(typeof ok.body.qr).toBe('string')
    expect(ok.body.qr.length).toBeGreaterThan(0)
    expect(typeof ok.body.paymentId).toBe('number')

    // Enterprise is coming_soon (and $0) -> not purchasable.
    const bad = await request(app.getHttpServer())
      .post('/api/payments/khqr')
      .set('Authorization', `Bearer ${access}`)
      .send({ planCode: 'enterprise' })
    expect(bad.status).toBe(400)
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

    // Active vs non-active filter (derived from lastActiveAt).
    await ctx.prisma.user.update({
      where: { clerkUserId: 'clerk_admin' },
      data: { lastActiveAt: new Date() },
    })
    await ctx.prisma.user.update({
      where: { clerkUserId: 'clerk_regular' },
      data: { lastActiveAt: null },
    })
    const activeList = await request(app.getHttpServer())
      .get('/api/admin/users?activity=active')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(activeList.status).toBe(200)
    const activeIds = activeList.body.items.map(
      (u: { clerkUserId: string }) => u.clerkUserId,
    )
    expect(activeIds).toContain('clerk_admin')
    expect(activeIds).not.toContain('clerk_regular')

    const inactiveList = await request(app.getHttpServer())
      .get('/api/admin/users?activity=inactive')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(inactiveList.status).toBe(200)
    const inactiveIds = inactiveList.body.items.map(
      (u: { clerkUserId: string }) => u.clerkUserId,
    )
    expect(inactiveIds).toContain('clerk_regular')
    expect(inactiveIds).not.toContain('clerk_admin')

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
      .send({ provider: 'openai', model: 'gpt', source: 'cli', tool: 'BashTool' })
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
    expect(a.activeByDay).toHaveLength(30)
    expect(Array.isArray(a.usageByProvider)).toBe(true)
    expect(Array.isArray(a.topUsers)).toBe(true)
    expect(typeof a.canceledSubscriptions).toBe('number')
    // The usage we posted shows in provider breakdown + top users.
    expect(a.usageByProvider.map((u: any) => u.provider)).toContain('openai')
    expect(Array.isArray(a.usageByTool)).toBe(true)
    expect(a.usageByTool.map((u: any) => u.tool)).toContain('BashTool')
    expect(a.profit).toBeDefined()
    expect(typeof a.profit.revenueCents).toBe('number')
    expect(typeof a.profit.aiCostCents).toBe('number')
    expect(typeof a.profit.marginCents).toBe('number')
    expect(Array.isArray(a.creditsByModel)).toBe(true)
    expect(a.topUsers.length).toBeGreaterThan(0)
  })

  it('analytics ?days= range adjusts the time-series length', async () => {
    ctx.setClerkUser({
      clerkUserId: 'clerk_range_admin',
      email: 'range@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-range-123456')
    await ctx.prisma.user.update({
      where: { clerkUserId: 'clerk_range_admin' },
      data: { role: 'admin' },
    })
    const res = await request(app.getHttpServer())
      .get('/api/admin/analytics?days=7')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(res.status).toBe(200)
    expect(res.body.signupsByDay).toHaveLength(7)
    expect(res.body.activeByDay).toHaveLength(7)
  })

  it('admin feedback inbox + bulk status (admin only)', async () => {
    ctx.setClerkUser({
      clerkUserId: 'clerk_fbadmin',
      email: 'fbadmin@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-fbadmin-123456')
    await ctx.prisma.user.update({
      where: { clerkUserId: 'clerk_fbadmin' },
      data: { role: 'superadmin' },
    })

    // A user submits feedback.
    ctx.setClerkUser({
      clerkUserId: 'clerk_fbuser',
      email: 'fbuser@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const userAccess = await login(app, 'state-fbuser-123456')
    await request(app.getHttpServer())
      .post('/api/feedback')
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ type: 'bug', message: 'something broke', rating: 2 })
      .expect(201)

    // Non-admin blocked from inbox.
    await request(app.getHttpServer())
      .get('/api/admin/feedback')
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(403)

    // Admin reads the inbox.
    const inbox = await request(app.getHttpServer())
      .get('/api/admin/feedback?type=bug')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(inbox.status).toBe(200)
    expect(inbox.body.total).toBeGreaterThan(0)
    expect(inbox.body.items[0].type).toBe('bug')
    expect(inbox.body.items[0].userEmail).toBe('fbuser@example.com')

    // Bulk-suspend the feedback user.
    const fbUser = await ctx.prisma.user.findUnique({
      where: { clerkUserId: 'clerk_fbuser' },
    })
    const bulk = await request(app.getHttpServer())
      .patch('/api/admin/users/bulk-status')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ ids: [fbUser!.id], status: 'suspended' })
    expect(bulk.status).toBe(200)
    expect(bulk.body.updated).toBe(1)

    // Suspended user's token now rejected.
    await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(401)
  })

  it('hosted models CRUD + credit settings (admin only)', async () => {
    ctx.setClerkUser({
      clerkUserId: 'clerk_modeladmin',
      email: 'modeladmin@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-modeladmin-1234')
    await ctx.prisma.user.update({
      where: { clerkUserId: 'clerk_modeladmin' },
      data: { role: 'superadmin' },
    })
    ctx.setClerkUser({
      clerkUserId: 'clerk_modelreg',
      email: 'modelreg@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const regAccess = await login(app, 'state-modelreg-1234')

    // Seeded models present.
    const list = await request(app.getHttpServer())
      .get('/api/admin/models')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(list.status).toBe(200)
    expect(list.body.map((m: any) => m.code)).toEqual(
      expect.arrayContaining(['deepseek-v4-flash', 'deepseek-v4-pro']),
    )

    // Non-admin blocked.
    await request(app.getHttpServer())
      .get('/api/admin/models')
      .set('Authorization', `Bearer ${regAccess}`)
      .expect(403)

    // Create a model.
    const created = await request(app.getHttpServer())
      .post('/api/admin/models')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        code: 'qwen-turbo',
        label: 'Qwen Turbo',
        provider: 'deepinfra',
        upstreamBaseUrl: 'https://api.deepinfra.com/v1/openai',
        upstreamModelId: 'qwen-3.5-turbo',
        inputPricePer1MCents: 4,
        outputPricePer1MCents: 20,
        creditMultiplier: 1,
        allowedPlanCodes: ['pro', 'pro_plus', 'max'],
        enabled: true,
      })
    expect(created.status).toBe(201)

    // Bad plan code rejected.
    await request(app.getHttpServer())
      .post('/api/admin/models')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ code: 'bad', allowedPlanCodes: ['nope'] })
      .expect(400)

    // Patch + delete.
    const patched = await request(app.getHttpServer())
      .patch('/api/admin/models/qwen-turbo')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ creditMultiplier: 2.5 })
    expect(patched.status).toBe(200)
    expect(patched.body.creditMultiplier).toBe(2.5)
    await request(app.getHttpServer())
      .delete('/api/admin/models/qwen-turbo')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)

    // Credit settings get + patch persists.
    const s = await request(app.getHttpServer())
      .get('/api/admin/credit-settings')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(s.status).toBe(200)
    expect(s.body.baselineCreditsPer1M).toBe(1)
    const sp = await request(app.getHttpServer())
      .patch('/api/admin/credit-settings')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ baselineCreditsPer1M: 1200, maxConcurrentStreams: 5 })
    expect(sp.status).toBe(200)
    expect(sp.body.baselineCreditsPer1M).toBe(1200)
    expect(sp.body.maxConcurrentStreams).toBe(5)
  })

  it('plan credit allowances drive /me/entitlements (allowed models + credits)', async () => {
    ctx.setClerkUser({
      clerkUserId: 'clerk_credadmin',
      email: 'credadmin@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-credadmin-1234')
    await ctx.prisma.user.update({
      where: { clerkUserId: 'clerk_credadmin' },
      data: { role: 'admin' },
    })

    // Admin sets Pro plan credit allowances.
    const patched = await request(app.getHttpServer())
      .patch('/api/admin/plans/pro')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ creditsPerPeriod: 50, topUpEnabled: true })
    expect(patched.status).toBe(200)

    // A free user: no hosted models, null credit allowance.
    ctx.setClerkUser({
      clerkUserId: 'clerk_creditfree',
      email: 'creditfree@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const freeAccess = await login(app, 'state-creditfree-1234')
    const freeEnt = await request(app.getHttpServer())
      .get('/api/me/entitlements')
      .set('Authorization', `Bearer ${freeAccess}`)
    expect(freeEnt.status).toBe(200)
    expect(freeEnt.body.allowedModels).toEqual([])
    // Free still SEES the hosted catalog (so the provider is visible) — it just
    // can't use it. Visibility (hostedModels) is decoupled from entitlement.
    expect(freeEnt.body.hostedModels.map((m: any) => m.code)).toEqual(
      expect.arrayContaining(['deepseek-v4-flash', 'deepseek-v4-pro']),
    )
    expect(freeEnt.body.creditAllowance.creditsPerPeriod).toBeNull()
    expect(freeEnt.body.creditConfig.baselineCreditsPer1M).toBeGreaterThan(0)

    // A Pro user: hosted models allowed + credit allowance reflected.
    ctx.setClerkUser({
      clerkUserId: 'clerk_creditpro',
      email: 'creditpro@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const proAccess = await login(app, 'state-creditpro-1234')
    const proUser = await ctx.prisma.user.findUnique({
      where: { clerkUserId: 'clerk_creditpro' },
    })
    const proPlan = await ctx.prisma.plan.findUnique({ where: { code: 'pro' } })
    await ctx.prisma.subscription.updateMany({
      where: { userId: proUser!.id, status: 'active' },
      data: { status: 'canceled' },
    })
    await ctx.prisma.subscription.create({
      data: { userId: proUser!.id, planId: proPlan!.id, status: 'active' },
    })
    const proEnt = await request(app.getHttpServer())
      .get('/api/me/entitlements')
      .set('Authorization', `Bearer ${proAccess}`)
    expect(proEnt.status).toBe(200)
    expect(proEnt.body.plan.code).toBe('pro')
    expect(proEnt.body.creditAllowance.creditsPerPeriod).toBe(50)
    expect(proEnt.body.creditAllowance.topUpEnabled).toBe(true)
    expect(proEnt.body.allowedModels.map((m: any) => m.code)).toEqual(
      expect.arrayContaining(['deepseek-v4-flash', 'deepseek-v4-pro']),
    )
  })

  it('credit projection: suggested multiplier from price + plan margin (admin only)', async () => {
    ctx.setClerkUser({
      clerkUserId: 'clerk_projadmin',
      email: 'projadmin@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-projadmin-1234')
    await ctx.prisma.user.update({
      where: { clerkUserId: 'clerk_projadmin' },
      data: { role: 'superadmin' },
    })
    // Give Pro a weekly allowance so the projection has something to cost.
    await request(app.getHttpServer())
      .patch('/api/admin/plans/pro')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ creditsPerPeriod: 50 })
      .expect(200)

    // Set projection knobs + baseline model.
    const sp = await request(app.getHttpServer())
      .patch('/api/admin/credit-settings')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        baselineModelCode: 'deepseek-v4-flash',
        assumedInputRatio: 0.67,
        assumedUsagePercent: 30,
        infraCostCentsPerUser: 100,
      })
    expect(sp.status).toBe(200)
    expect(sp.body.assumedUsagePercent).toBe(30)
    expect(sp.body.baselineModelCode).toBe('deepseek-v4-flash')

    // Non-admin blocked.
    ctx.setClerkUser({
      clerkUserId: 'clerk_projreg',
      email: 'projreg@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const regAccess = await login(app, 'state-projreg-1234')
    await request(app.getHttpServer())
      .get('/api/admin/credit-projection')
      .set('Authorization', `Bearer ${regAccess}`)
      .expect(403)

    const proj = await request(app.getHttpServer())
      .get('/api/admin/credit-projection')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(proj.status).toBe(200)
    const flash = proj.body.models.find((m: any) => m.code === 'deepseek-v4-flash')
    const proM = proj.body.models.find((m: any) => m.code === 'deepseek-v4-pro')
    // Baseline (flash) suggested ~1; Pro's real price is far higher than its
    // seeded 3x multiplier → suggested should be much larger than current.
    expect(flash.suggestedMultiplier).toBeCloseTo(1, 1)
    expect(proM.suggestedMultiplier).toBeGreaterThan(proM.currentMultiplier)
    expect(proM.suggestedMultiplier).toBeGreaterThan(5)

    const proPlan = proj.body.plans.find((p: any) => p.code === 'pro')
    expect(proPlan).toBeDefined()
    expect(typeof proPlan.worstCaseMonthlyCostCents).toBe('number')
    expect(typeof proPlan.marginCents).toBe('number')
    expect(typeof proPlan.marginNegative).toBe('boolean')
  })

  it('subscription: 30-day period on activation + expiry reverts to free', async () => {
    ctx.setClerkUser({
      clerkUserId: 'clerk_sub',
      email: 'sub@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const access = await login(app, 'state-sub-1')
    const auth = (req: request.Test) => req.set('Authorization', `Bearer ${access}`)

    // Purchase the active 'basic' plan via (mocked) Bakong KHQR.
    const khqr = await auth(
      request(app.getHttpServer()).post('/api/payments/khqr'),
    ).send({ planCode: 'basic', method: 'bakong' })
    expect(khqr.status).toBe(201)
    expect(khqr.body.qr).toContain('TESTQR-')

    ctx.setBakongPaid(true, 'ext-sub')
    const status = await auth(
      request(app.getHttpServer()).get(`/api/payments/${khqr.body.paymentId}/status`),
    )
    expect(status.status).toBe(200)
    expect(status.body.activated).toBe(true)

    const u = await ctx.prisma.user.findUnique({ where: { clerkUserId: 'clerk_sub' } })
    const sub = await ctx.prisma.subscription.findFirst({
      where: { userId: u!.id, status: 'active' },
      orderBy: { startedAt: 'desc' },
    })
    expect(sub?.currentPeriodEnd).toBeTruthy()
    const days = (sub!.currentPeriodEnd!.getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29)
    expect(days).toBeLessThan(31)

    let ent = await auth(request(app.getHttpServer()).get('/api/me/entitlements'))
    expect(ent.body.plan.code).toBe('basic')
    expect(ent.body.plan.currentPeriodEnd).toBeTruthy()

    // Expire the period -> entitlements revert to free.
    await ctx.prisma.subscription.update({
      where: { id: sub!.id },
      data: { currentPeriodEnd: new Date(Date.now() - 1000) },
    })
    ent = await auth(request(app.getHttpServer()).get('/api/me/entitlements'))
    expect(ent.body.plan.code).toBe('free')
    ctx.setBakongPaid(false)
  })

  it('top-up: KHQR grants credits + exposes balance; guarded when rate is 0', async () => {
    // Admin enables top-up by setting the per-1k rate.
    ctx.setClerkUser({
      clerkUserId: 'clerk_topadmin',
      email: 'topadmin@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-topadmin-1')
    await ctx.prisma.user.update({
      where: { clerkUserId: 'clerk_topadmin' },
      data: { role: 'superadmin' },
    })
    await request(app.getHttpServer())
      .patch('/api/admin/credit-settings')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ topupCentsPer1kCredits: 100 })
      .expect(200)

    // User buys 5000 credits -> 5000/1000 * 100¢ = 500¢.
    ctx.setClerkUser({
      clerkUserId: 'clerk_topuser',
      email: 'topuser@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const access = await login(app, 'state-topuser-1')
    const auth = (req: request.Test) => req.set('Authorization', `Bearer ${access}`)

    const khqr = await auth(
      request(app.getHttpServer()).post('/api/payments/topup-khqr'),
    ).send({ credits: 5000, method: 'bakong' })
    expect(khqr.status).toBe(201)
    expect(khqr.body.amountCents).toBe(500)
    expect(khqr.body.qr).toContain('TESTQR-')

    ctx.setBakongPaid(true, 'ext-top')
    const status = await auth(
      request(app.getHttpServer()).get(`/api/payments/${khqr.body.paymentId}/status`),
    )
    expect(status.status).toBe(200)
    expect(status.body.activated).toBe(true)
    expect(status.body.kind).toBe('topup')
    expect(status.body.credits).toBe(5000)

    const ent = await auth(request(app.getHttpServer()).get('/api/me/entitlements'))
    expect(ent.body.topupBalance).toBe(5000)
    ctx.setBakongPaid(false)

    // Guarded when the rate is 0.
    await request(app.getHttpServer())
      .patch('/api/admin/credit-settings')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ topupCentsPer1kCredits: 0 })
      .expect(200)
    await auth(request(app.getHttpServer()).post('/api/payments/topup-khqr'))
      .send({ credits: 5000 })
      .expect(400)
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
