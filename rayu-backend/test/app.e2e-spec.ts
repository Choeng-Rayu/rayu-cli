import { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { createTestApp, TestContext } from './test-app'

/**
 * Set the mocked Google OAuth profile the backend will see on the next
 * /cli/exchange, /web/session, or /auth/oauth/google call. The `sub` is just
 * an opaque per-test identifier used as the OAuth `providerAccountId`; tests
 * look users up by their unique email instead.
 */
function setTestUser(
  ctx: TestContext,
  opts: {
    sub: string
    email: string
    displayName?: string | null
    avatarUrl?: string | null
  },
) {
  ctx.setOAuthUser({
    provider: 'google',
    providerAccountId: opts.sub,
    email: opts.email,
    displayName: opts.displayName ?? null,
    avatarUrl: opts.avatarUrl ?? null,
    emailVerified: true,
  })
}

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
    setTestUser(ctx, {
      sub: 'buyer',
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

  it('reuses the same pending QR on repeat create (page refresh); cancel frees a new one', async () => {
    setTestUser(ctx, {
      sub: 'refresh',
      email: 'refresh@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const access = await login(app, 'state-refresh-1')

    const first = await request(app.getHttpServer())
      .post('/api/payments/khqr')
      .set('Authorization', `Bearer ${access}`)
      .send({ planCode: 'pro', method: 'bakong' })
    expect(first.status).toBe(201)
    expect(first.body.reused).toBe(false)
    const id1 = first.body.paymentId

    // "Refresh the page" → the same QR/payment is returned, not a new one.
    const again = await request(app.getHttpServer())
      .post('/api/payments/khqr')
      .set('Authorization', `Bearer ${access}`)
      .send({ planCode: 'pro', method: 'bakong' })
    expect(again.body.paymentId).toBe(id1)
    expect(again.body.reused).toBe(true)
    expect(again.body.qr).toBe(first.body.qr)

    // Cancel → the next create issues a fresh QR.
    const cancel = await request(app.getHttpServer())
      .post(`/api/payments/${id1}/cancel`)
      .set('Authorization', `Bearer ${access}`)
    expect(cancel.status).toBe(201)
    expect(cancel.body.status).toBe('canceled')

    const fresh = await request(app.getHttpServer())
      .post('/api/payments/khqr')
      .set('Authorization', `Bearer ${access}`)
      .send({ planCode: 'pro', method: 'bakong' })
    expect(fresh.body.paymentId).not.toBe(id1)
    expect(fresh.body.reused).toBe(false)
  })

  it('blocks re-buying an already-active non-credit plan (basic), still allows credit plans', async () => {
    setTestUser(ctx, {
      sub: 'dup',
      email: 'dup@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const access = await login(app, 'state-dup-1')

    // Buy Basic (feature-unlock, no credits) and activate it.
    const buy = await request(app.getHttpServer())
      .post('/api/payments/khqr')
      .set('Authorization', `Bearer ${access}`)
      .send({ planCode: 'basic', method: 'bakong' })
    expect(buy.status).toBe(201)

    ctx.setBakongPaid(true, 'TRX-BASIC')
    const status = await request(app.getHttpServer())
      .get(`/api/payments/${buy.body.paymentId}/status`)
      .set('Authorization', `Bearer ${access}`)
    expect(status.body.status).toBe('paid')
    ctx.setBakongPaid(false)

    // Now actively on Basic → re-buying Basic is rejected (nothing to add).
    const dup = await request(app.getHttpServer())
      .post('/api/payments/khqr')
      .set('Authorization', `Bearer ${access}`)
      .send({ planCode: 'basic', method: 'bakong' })
    expect(dup.status).toBe(400)

    // A credit plan (Pro) is still purchasable while on Basic.
    const pro = await request(app.getHttpServer())
      .post('/api/payments/khqr')
      .set('Authorization', `Bearer ${access}`)
      .send({ planCode: 'pro', method: 'bakong' })
    expect(pro.status).toBe(201)
  })

  it('full CLI bridge: exchange -> token -> /me, replay fails', async () => {
    setTestUser(ctx, {
      sub: 'user_1',
      email: 'user1@example.com',
      displayName: 'User One',
      avatarUrl: null,
    })

    const exchange = await request(app.getHttpServer())
      .post('/api/cli/exchange')
      .set('Authorization', 'Bearer fake-google-token')
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

  it('web/session mints Rayu tokens directly from a Google ID token', async () => {
    setTestUser(ctx, {
      sub: 'web',
      email: 'web@example.com',
      displayName: 'Web User',
      avatarUrl: null,
    })
    const res = await request(app.getHttpServer())
      .post('/api/web/session')
      .set('Authorization', 'Bearer fake-google')
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
    setTestUser(ctx, {
      sub: 'user_refresh',
      email: 'refresh2@example.com',
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
    setTestUser(ctx, {
      sub: 'usage',
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
    setTestUser(ctx, {
      sub: 'fb',
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
    setTestUser(ctx, {
      sub: 'admin',
      email: 'admin@example.com',
      displayName: 'Admin',
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-admin')
    // Non-admin (regular user) first.
    setTestUser(ctx, {
      sub: 'regular',
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
      where: { email: 'admin@example.com' },
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
      where: { email: 'admin@example.com' },
      data: { lastActiveAt: new Date() },
    })
    await ctx.prisma.user.update({
      where: { email: 'regular@example.com' },
      data: { lastActiveAt: null },
    })
    const activeList = await request(app.getHttpServer())
      .get('/api/admin/users?activity=active')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(activeList.status).toBe(200)
    const activeEmails = activeList.body.items.map((u: { email: string }) => u.email)
    expect(activeEmails).toContain('admin@example.com')
    expect(activeEmails).not.toContain('regular@example.com')

    const inactiveList = await request(app.getHttpServer())
      .get('/api/admin/users?activity=inactive')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(inactiveList.status).toBe(200)
    const inactiveEmails = inactiveList.body.items.map(
      (u: { email: string }) => u.email,
    )
    expect(inactiveEmails).toContain('regular@example.com')
    expect(inactiveEmails).not.toContain('admin@example.com')

    // Find the regular user id and suspend it.
    const regular = await ctx.prisma.user.findUnique({
      where: { email: 'regular@example.com' },
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
    setTestUser(ctx, {
      sub: 'chain',
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
    setTestUser(ctx, {
      sub: 'admin2',
      email: 'admin2@example.com',
      displayName: 'Admin Two',
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-admin2-123456')
    await ctx.prisma.user.update({
      where: { email: 'admin2@example.com' },
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
    setTestUser(ctx, {
      sub: 'planadmin',
      email: 'planadmin@example.com',
      displayName: 'Plan Admin',
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-planadmin-123456')
    await ctx.prisma.user.update({
      where: { email: 'planadmin@example.com' },
      data: { role: 'superadmin' },
    })

    // A regular free user.
    setTestUser(ctx, {
      sub: 'freeuser',
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

    // --- Model access, edited per PLAN (Plans & Credits checklist) ---
    // Stored per model in hosted_models.allowedPlanCodes, so this asserts the
    // round trip: the plan list reports it, PUT replaces it, and the user's
    // entitlements (which read the model rows) agree.
    const withModels = await request(app.getHttpServer())
      .get('/api/admin/plans')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(Array.isArray(withModels.body.models)).toBe(true)
    expect(withModels.body.models.length).toBeGreaterThan(0)
    const proPlan = withModels.body.plans.find((p: any) => p.code === 'pro')
    expect(Array.isArray(proPlan.allowedModelCodes)).toBe(true)
    expect(proPlan.allowedModelCodes.length).toBeGreaterThan(0)

    // Grant Pro exactly one model.
    const keepCode = proPlan.allowedModelCodes[0]
    const granted = await request(app.getHttpServer())
      .put('/api/admin/plans/pro/models')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ modelCodes: [keepCode] })
    expect(granted.status).toBe(200)
    expect(granted.body.allowedModelCodes).toEqual([keepCode])

    // A pro user now sees exactly that model.
    setTestUser(ctx, {
      sub: 'promodels',
      email: 'promodels@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const proAccess = await login(app, 'state-promodels-1')
    const proUser = await ctx.prisma.user.findUniqueOrThrow({
      where: { email: 'promodels@example.com' },
    })
    await request(app.getHttpServer())
      .patch(`/api/admin/users/${proUser.id}/plan`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ planCode: 'pro' })
      .expect(200)
    const proEnt = await request(app.getHttpServer())
      .get('/api/me/entitlements')
      .set('Authorization', `Bearer ${proAccess}`)
    expect(proEnt.body.allowedModels.map((m: any) => m.code)).toEqual([keepCode])

    // Revoking everything is a valid state (a plan with no hosted models).
    const revoked = await request(app.getHttpServer())
      .put('/api/admin/plans/pro/models')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ modelCodes: [] })
    expect(revoked.status).toBe(200)
    expect(revoked.body.allowedModelCodes).toEqual([])

    // Restore, and prove an unknown model code is refused WITHOUT partially
    // applying the rest of the list.
    await request(app.getHttpServer())
      .put('/api/admin/plans/pro/models')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ modelCodes: proPlan.allowedModelCodes })
      .expect(200)
    await request(app.getHttpServer())
      .put('/api/admin/plans/pro/models')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ modelCodes: [keepCode, 'no-such-model'] })
      .expect(400)
    const unchanged = await request(app.getHttpServer())
      .get('/api/admin/plans')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(
      unchanged.body.plans.find((p: any) => p.code === 'pro').allowedModelCodes.sort(),
    ).toEqual([...proPlan.allowedModelCodes].sort())

    // Unknown plan is a 404, and a non-admin cannot touch model access.
    await request(app.getHttpServer())
      .put('/api/admin/plans/not-a-plan/models')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ modelCodes: [] })
      .expect(404)
    await request(app.getHttpServer())
      .put('/api/admin/plans/pro/models')
      .set('Authorization', `Bearer ${freeAccess}`)
      .send({ modelCodes: [] })
      .expect(403)
  })

  it('GET /api/me/entitlements rejects unauthenticated', async () => {
    await request(app.getHttpServer()).get('/api/me/entitlements').expect(401)
  })

  it('GET /api/admin/analytics returns the full analytics payload (admin only)', async () => {
    setTestUser(ctx, {
      sub: 'analytics_admin',
      email: 'analytics@example.com',
      displayName: 'Analytics Admin',
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-analytics-123456')
    await ctx.prisma.user.update({
      where: { email: 'analytics@example.com' },
      data: { role: 'admin' },
    })
    // Generate a usage event so series/top-users have data.
    await request(app.getHttpServer())
      .post('/api/usage')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ provider: 'openai', model: 'gpt', source: 'cli', tool: 'BashTool' })
      .expect(201)

    // Non-admin is blocked.
    setTestUser(ctx, {
      sub: 'analytics_regular',
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
    setTestUser(ctx, {
      sub: 'range_admin',
      email: 'range@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-range-123456')
    await ctx.prisma.user.update({
      where: { email: 'range@example.com' },
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
    setTestUser(ctx, {
      sub: 'fbadmin',
      email: 'fbadmin@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-fbadmin-123456')
    await ctx.prisma.user.update({
      where: { email: 'fbadmin@example.com' },
      data: { role: 'superadmin' },
    })

    // A user submits feedback.
    setTestUser(ctx, {
      sub: 'fbuser',
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
      where: { email: 'fbuser@example.com' },
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
    setTestUser(ctx, {
      sub: 'modeladmin',
      email: 'modeladmin@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-modeladmin-1234')
    await ctx.prisma.user.update({
      where: { email: 'modeladmin@example.com' },
      data: { role: 'superadmin' },
    })
    setTestUser(ctx, {
      sub: 'modelreg',
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

    // Create a model. Routing now comes from the provider registry, so the
    // model only names a providerId (no provider string / base URL of its own).
    const providersList = await request(app.getHttpServer())
      .get('/api/admin/providers')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(providersList.status).toBe(200)
    const deepseekProvider = providersList.body.find(
      (p: any) => p.name === 'deepseek',
    )
    expect(deepseekProvider).toBeDefined()

    const created = await request(app.getHttpServer())
      .post('/api/admin/models')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        code: 'qwen-turbo',
        label: 'Qwen Turbo',
        providerId: deepseekProvider.id,
        upstreamModelId: 'qwen-3.5-turbo',
        inputPricePer1MCents: 4,
        outputPricePer1MCents: 20,
        creditMultiplier: 1,
        cacheReadCreditMultiplier: 0.08,
        allowedPlanCodes: ['pro', 'pro_plus', 'max'],
        outputCreditMultiplier: 2.5,
        cacheWriteCreditMultiplier: 1.25,
        supportsReasoning: true,
        supportsImage: false,
        supportsTools: false,
        contextWindow: 200000,
        enabled: true,
      })
    expect(created.status).toBe(201)
    expect(created.body.cacheReadCreditMultiplier).toBe(0.08)
    // All four credit charges are stored explicitly — nothing derived.
    expect(created.body).toMatchObject({
      creditMultiplier: 1,
      outputCreditMultiplier: 2.5,
      cacheReadCreditMultiplier: 0.08,
      cacheWriteCreditMultiplier: 1.25,
      supportsTools: false,
    })

    // A slipped decimal must not be able to bill a customer 1000x.
    for (const bad of [
      { creditMultiplier: -1 },
      { outputCreditMultiplier: 5000 },
      { cacheReadCreditMultiplier: -0.5 },
      { cacheWriteCreditMultiplier: 100000 },
    ]) {
      await request(app.getHttpServer())
        .post('/api/admin/models')
        .set('Authorization', `Bearer ${adminAccess}`)
        .send({ code: 'bad-charge', providerId: deepseekProvider.id, ...bad })
        .expect(400)
    }
    expect(created.body.providerId).toBe(deepseekProvider.id)
    expect(created.body.supportsImage).toBe(false)
    expect(created.body.contextWindow).toBe(200000)

    // Context window validation: absurd or sub-minimum values are refused so the
    // CLI can never budget against a typo'd window.
    for (const contextWindow of [0, 12, 50_000_000, -1, 1.5]) {
      await request(app.getHttpServer())
        .post('/api/admin/models')
        .set('Authorization', `Bearer ${adminAccess}`)
        .send({ code: 'bad-ctx', providerId: deepseekProvider.id, contextWindow })
        .expect(400)
    }

    // Bad plan code rejected.
    await request(app.getHttpServer())
      .post('/api/admin/models')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ code: 'bad', allowedPlanCodes: ['nope'] })
      .expect(400)

    // Unknown providerId rejected (no silent default upstream).
    await request(app.getHttpServer())
      .post('/api/admin/models')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ code: 'bad-provider', providerId: 999999 })
      .expect(400)

    // Patch + delete.
    const patched = await request(app.getHttpServer())
      .patch('/api/admin/models/qwen-turbo')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ creditMultiplier: 2.5, cacheReadCreditMultiplier: 0.12 })
    expect(patched.status).toBe(200)
    expect(patched.body.creditMultiplier).toBe(2.5)
    expect(patched.body.cacheReadCreditMultiplier).toBe(0.12)

    // Context window: patch it, then CLEAR it back to "CLI default" with null.
    const ctxPatched = await request(app.getHttpServer())
      .patch('/api/admin/models/qwen-turbo')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ contextWindow: 1000000 })
    expect(ctxPatched.status).toBe(200)
    expect(ctxPatched.body.contextWindow).toBe(1000000)
    const ctxCleared = await request(app.getHttpServer())
      .patch('/api/admin/models/qwen-turbo')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ contextWindow: null })
    expect(ctxCleared.status).toBe(200)
    expect(ctxCleared.body.contextWindow).toBeNull()

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

  it('admin can manage the provider registry (and its security rules hold)', async () => {
    setTestUser(ctx, {
      sub: 'provadmin',
      email: 'provadmin@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-provadmin-1234')
    await ctx.prisma.user.update({
      where: { email: 'provadmin@example.com' },
      data: { role: 'superadmin' },
    })
    setTestUser(ctx, {
      sub: 'provreg',
      email: 'provreg@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const regAccess = await login(app, 'state-provreg-1234')

    // Seeded providers are present with their wire config.
    const list = await request(app.getHttpServer())
      .get('/api/admin/providers')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(list.status).toBe(200)
    const seeded = list.body.find((p: any) => p.name === 'deepseek')
    expect(seeded).toMatchObject({
      format: 'anthropic_messages',
      authScheme: 'x_api_key',
      endpointPath: '/anthropic/v1/messages',
    })
    // Model counts come back so the UI can block unsafe deletes.
    expect(seeded.modelCount).toBeGreaterThan(0)

    // Non-admin blocked on every route.
    await request(app.getHttpServer())
      .get('/api/admin/providers')
      .set('Authorization', `Bearer ${regAccess}`)
      .expect(403)
    await request(app.getHttpServer())
      .post('/api/admin/providers')
      .set('Authorization', `Bearer ${regAccess}`)
      .send({
        name: 'sneaky',
        format: 'openai_chat',
        baseUrl: 'https://example.com',
      })
      .expect(403)

    // Create an OpenAI-compatible provider; format defaults fill in the path/auth.
    const created = await request(app.getHttpServer())
      .post('/api/admin/providers')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        name: 'openrouter',
        label: 'OpenRouter',
        format: 'openai_chat',
        baseUrl: 'https://openrouter.ai/api',
        supportsReasoning: true,
        supportsImage: true,
      })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      name: 'openrouter',
      endpointPath: '/v1/chat/completions',
      authScheme: 'bearer',
    })
    // The provider row never carries a secret: keys are separate encrypted rows.
    expect(created.body).not.toHaveProperty('apiKey')
    expect(created.body).not.toHaveProperty('keyEnv')

    // SECURITY: baseUrl cannot point at an internal/metadata address or plain http.
    for (const baseUrl of [
      'http://openrouter.ai',
      'https://169.254.169.254',
      'https://127.0.0.1',
      'https://10.1.2.3',
    ]) {
      await request(app.getHttpServer())
        .post('/api/admin/providers')
        .set('Authorization', `Bearer ${adminAccess}`)
        .send({
          name: 'evil-url',
          format: 'openai_chat',
          baseUrl,
        })
        .expect(400)
    }

    // Unknown format rejected by the DTO allowlist.
    await request(app.getHttpServer())
      .post('/api/admin/providers')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        name: 'weird',
        format: 'grpc_magic',
        baseUrl: 'https://example.com',
      })
      .expect(400)

    // Patch: switching format re-derives the endpoint path.
    const patched = await request(app.getHttpServer())
      .patch('/api/admin/providers/openrouter')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ format: 'openai_responses' })
    expect(patched.status).toBe(200)
    expect(patched.body).toMatchObject({
      format: 'openai_responses',
      endpointPath: '/v1/responses',
    })

    // Attach a model, then prove the provider cannot be deleted from under it.
    await request(app.getHttpServer())
      .post('/api/admin/models')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        code: 'or-test-model',
        label: 'OR Test',
        providerId: created.body.id,
        upstreamModelId: 'openai/gpt-5.5',
        allowedPlanCodes: ['pro'],
      })
      .expect(201)
    await request(app.getHttpServer())
      .delete('/api/admin/providers/openrouter')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(409)

    // Disabling the provider hides its models from the USER catalog while the
    // admin catalog still lists them (the provider kill switch).
    await request(app.getHttpServer())
      .patch('/api/admin/providers/openrouter')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ enabled: false })
      .expect(200)
    const ent = await request(app.getHttpServer())
      .get('/api/me/entitlements')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(ent.status).toBe(200)
    expect(ent.body.hostedModels.map((m: any) => m.code)).not.toContain('or-test-model')
    const adminModels = await request(app.getHttpServer())
      .get('/api/admin/models')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(adminModels.body.map((m: any) => m.code)).toContain('or-test-model')

    // Cleanup: model first (FK is RESTRICT), then the provider.
    await request(app.getHttpServer())
      .delete('/api/admin/models/or-test-model')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
    await request(app.getHttpServer())
      .delete('/api/admin/providers/openrouter')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
    await request(app.getHttpServer())
      .delete('/api/admin/providers/openrouter')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(404)
  })

  it('admin manages provider API keys (encrypted, masked-only, rotation-ready)', async () => {
    setTestUser(ctx, {
      sub: 'keyadmin',
      email: 'keyadmin@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-keyadmin-1234')
    await ctx.prisma.user.update({
      where: { email: 'keyadmin@example.com' },
      data: { role: 'superadmin' },
    })
    setTestUser(ctx, {
      sub: 'keyreg',
      email: 'keyreg@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const regAccess = await login(app, 'state-keyreg-1234')

    await request(app.getHttpServer())
      .post('/api/admin/providers')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        name: 'keyprov',
        label: 'Key Provider',
        format: 'openai_chat',
        baseUrl: 'https://api.example.com',
      })
      .expect(201)

    const KEY_A = 'sk-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaa1111'
    const KEY_B = 'sk-test-bbbbbbbbbbbbbbbbbbbbbbbbbbbb2222'

    // Non-admin cannot touch keys at all.
    await request(app.getHttpServer())
      .get('/api/admin/providers/keyprov/keys')
      .set('Authorization', `Bearer ${regAccess}`)
      .expect(403)
    await request(app.getHttpServer())
      .post('/api/admin/providers/keyprov/keys')
      .set('Authorization', `Bearer ${regAccess}`)
      .send({ key: KEY_A })
      .expect(403)

    // Add two DIFFERENT keys → rotation is possible.
    const first = await request(app.getHttpServer())
      .post('/api/admin/providers/keyprov/keys')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ key: KEY_A, label: 'Primary' })
    expect(first.status).toBe(201)
    expect(first.body).toMatchObject({ label: 'Primary', priority: 0, enabled: true, status: 'active' })

    const second = await request(app.getHttpServer())
      .post('/api/admin/providers/keyprov/keys')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ key: KEY_B })
    expect(second.status).toBe(201)
    expect(second.body.priority).toBe(1) // ordered after the first

    // REGRESSION GUARD: no response anywhere may contain the plaintext key, and
    // the encrypted/hash columns must never be serialized.
    const list = await request(app.getHttpServer())
      .get('/api/admin/providers/keyprov/keys')
      .set('Authorization', `Bearer ${adminAccess}`)
    expect(list.status).toBe(200)
    for (const body of [first.body, second.body, list.body]) {
      const serialized = JSON.stringify(body)
      expect(serialized).not.toContain(KEY_A)
      expect(serialized).not.toContain(KEY_B)
      expect(serialized).not.toContain('encryptedKey')
      expect(serialized).not.toContain('keyHash')
    }
    expect(list.body).toHaveLength(2)
    expect(list.body[0].maskedKey).toContain('sk-tes')

    // The DB row itself must be an encrypted envelope, not the key.
    const stored = await ctx.prisma.providerApiKey.findMany({
      orderBy: { priority: 'asc' },
    })
    expect(stored).toHaveLength(2)
    expect(stored[0]!.encryptedKey.startsWith('v1:')).toBe(true)
    expect(stored[0]!.encryptedKey).not.toContain(KEY_A)

    // Duplicate → 409 (otherwise rotation would spin on one exhausted key).
    await request(app.getHttpServer())
      .post('/api/admin/providers/keyprov/keys')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ key: KEY_A })
      .expect(409)

    // Replace the secret in place; id/label survive, secret changes.
    const replaced = await request(app.getHttpServer())
      .patch(`/api/admin/providers/keyprov/keys/${first.body.id}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ key: 'sk-test-cccccccccccccccccccccccccccc3333' })
    expect(replaced.status).toBe(200)
    expect(replaced.body.id).toBe(first.body.id)
    expect(replaced.body.label).toBe('Primary')
    expect(replaced.body.maskedKey).not.toBe(first.body.maskedKey)

    // Disable / re-enable.
    const disabled = await request(app.getHttpServer())
      .patch(`/api/admin/providers/keyprov/keys/${second.body.id}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ enabled: false })
    expect(disabled.body).toMatchObject({ enabled: false, status: 'disabled' })
    const reenabled = await request(app.getHttpServer())
      .patch(`/api/admin/providers/keyprov/keys/${second.body.id}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ enabled: true })
    expect(reenabled.body).toMatchObject({ enabled: true, status: 'active' })

    // Delete one, then confirm deleting the provider cascades the rest away.
    await request(app.getHttpServer())
      .delete(`/api/admin/providers/keyprov/keys/${second.body.id}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
    await request(app.getHttpServer())
      .delete(`/api/admin/providers/keyprov/keys/${second.body.id}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(404)

    await request(app.getHttpServer())
      .delete('/api/admin/providers/keyprov')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
    expect(await ctx.prisma.providerApiKey.count()).toBe(0)
  })

  it('plan credit allowances drive /me/entitlements (allowed models + credits)', async () => {
    setTestUser(ctx, {
      sub: 'credadmin',
      email: 'credadmin@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-credadmin-1234')
    await ctx.prisma.user.update({
      where: { email: 'credadmin@example.com' },
      data: { role: 'admin' },
    })

    // Admin sets Pro plan credit allowances.
    const patched = await request(app.getHttpServer())
      .patch('/api/admin/plans/pro')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ creditsPerPeriod: 50, topUpEnabled: true })
    expect(patched.status).toBe(200)

    // A free user: no hosted models, null credit allowance.
    setTestUser(ctx, {
      sub: 'creditfree',
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
    // The CLI drives its model list, capabilities, and CONTEXT WINDOW off this
    // payload, so every hosted model must carry them — that is what makes an
    // admin-added model (and its window) appear in the CLI with no release.
    const hosted = freeEnt.body.hostedModels as Array<Record<string, unknown>>
    for (const m of hosted) {
      expect(typeof m.code).toBe('string')
      expect(typeof m.provider).toBe('string') // provider NAME only, never the row
      expect(typeof m.supportsReasoning).toBe('boolean')
      expect(typeof m.supportsImage).toBe('boolean')
      expect(typeof m.supportsTools).toBe('boolean')
      expect('contextWindow' in m).toBe(true)
      // The CLI reads all four charges for its cost display.
      expect(typeof m.creditMultiplier).toBe('number')
      expect(typeof m.outputCreditMultiplier).toBe('number')
      expect(typeof m.cacheReadCreditMultiplier).toBe('number')
      expect(typeof m.cacheWriteCreditMultiplier).toBe('number')
      // Internal routing config must never reach a user.
      expect(m).not.toHaveProperty('keyEnv')
      expect(m).not.toHaveProperty('baseUrl')
      expect(m).not.toHaveProperty('upstreamModelId')
    }
    const pro = hosted.find((m) => m.code === 'deepseek-v4-pro')
    expect(pro?.contextWindow).toBe(1000000)
    expect(freeEnt.body.creditAllowance.creditsPerPeriod).toBeNull()
    expect(freeEnt.body.creditConfig.baselineCreditsPer1M).toBeGreaterThan(0)

    // A Pro user: hosted models allowed + credit allowance reflected.
    setTestUser(ctx, {
      sub: 'creditpro',
      email: 'creditpro@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const proAccess = await login(app, 'state-creditpro-1234')
    const proUser = await ctx.prisma.user.findUnique({
      where: { email: 'creditpro@example.com' },
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
    setTestUser(ctx, {
      sub: 'projadmin',
      email: 'projadmin@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-projadmin-1234')
    await ctx.prisma.user.update({
      where: { email: 'projadmin@example.com' },
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

    // The projection reads model PRICES; the seed now bills DeepSeek flat
    // (input==output), so set a deterministic spread here (Flash cheap, Pro ~12x)
    // to exercise the suggested-multiplier math independent of seed pricing.
    await request(app.getHttpServer())
      .patch('/api/admin/models/deepseek-v4-flash')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ inputPricePer1MCents: 14, outputPricePer1MCents: 28 })
      .expect(200)
    await request(app.getHttpServer())
      .patch('/api/admin/models/deepseek-v4-pro')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ inputPricePer1MCents: 174, outputPricePer1MCents: 348 })
      .expect(200)

    // Non-admin blocked.
    setTestUser(ctx, {
      sub: 'projreg',
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
    setTestUser(ctx, {
      sub: 'sub',
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

    const u = await ctx.prisma.user.findUnique({ where: { email: 'sub@example.com' } })
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
    setTestUser(ctx, {
      sub: 'topadmin',
      email: 'topadmin@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-topadmin-1')
    await ctx.prisma.user.update({
      where: { email: 'topadmin@example.com' },
      data: { role: 'superadmin' },
    })
    await request(app.getHttpServer())
      .patch('/api/admin/credit-settings')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ creditsPerDollar: 1000, minTopupCents: 100 })
      .expect(200)

    // User buys 5000 credits at 1000 credits/$ -> $5.00 = 500¢.
    setTestUser(ctx, {
      sub: 'topuser',
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

    // A purchase worth less than minTopupCents is refused (here: 50 credits =
    // $0.05, under the $1 floor) — not silently rounded up to the minimum.
    await auth(request(app.getHttpServer()).post('/api/payments/topup-khqr'))
      .send({ credits: 50, method: 'bakong' })
      .expect(400)

    // Guarded when the rate is 0 (top-up switched off globally).
    await request(app.getHttpServer())
      .patch('/api/admin/credit-settings')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ creditsPerDollar: 0 })
      .expect(200)
    await auth(request(app.getHttpServer()).post('/api/payments/topup-khqr'))
      .send({ credits: 5000 })
      .expect(400)
  })

  it('top-up quote reflects an admin rate change live, and gates on enabled', async () => {
    setTestUser(ctx, {
      sub: 'quoteadmin',
      email: 'quoteadmin@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-quoteadmin-1')
    await ctx.prisma.user.update({
      where: { email: 'quoteadmin@example.com' },
      data: { role: 'superadmin' },
    })
    const setRate = (creditsPerDollar: number, minTopupCents?: number) =>
      request(app.getHttpServer())
        .patch('/api/admin/credit-settings')
        .set('Authorization', `Bearer ${adminAccess}`)
        .send(
          minTopupCents == null
            ? { creditsPerDollar }
            : { creditsPerDollar, minTopupCents },
        )
        .expect(200)

    setTestUser(ctx, {
      sub: 'quoteuser',
      email: 'quoteuser@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const access = await login(app, 'state-quoteuser-1')
    const auth = (req: request.Test) => req.set('Authorization', `Bearer ${access}`)
    const quote = (credits?: number) =>
      auth(
        request(app.getHttpServer()).get(
          credits == null
            ? '/api/payments/topup/quote'
            : `/api/payments/topup/quote?credits=${credits}`,
        ),
      )

    await setRate(1000, 100)
    const first = await quote(5000)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({
      enabled: true,
      credits: 5000,
      amountCents: 500,
      currency: 'USD',
      minCredits: 1000,
      rateCreditsPerDollar: 1000,
      minTopupCents: 100,
      meetsMinimum: true,
    })

    // The quote must equal what the create path actually charges.
    const created = await auth(
      request(app.getHttpServer()).post('/api/payments/topup'),
    ).send({ credits: 5000, method: 'bakong' })
    expect(created.status).toBe(201)
    expect(created.body.amountCents).toBe(first.body.amountCents)
    await auth(
      request(app.getHttpServer()).post(
        `/api/payments/${created.body.paymentId}/cancel`,
      ),
    ).expect(201)

    // Admin halves the rate → the very next quote is re-priced. No redeploy, no
    // restart, nothing cached on this side (AppSettingsService.get() hits the DB).
    await setRate(500)
    expect((await quote(5000)).body.amountCents).toBe(1000)

    // Raising the cents floor re-derives minCredits at the live rate.
    await setRate(500, 200)
    const floored = await quote(5000)
    expect(floored.body.minCredits).toBe(1000)
    expect(floored.body.minTopupCents).toBe(200)

    // A below-floor request is quoted at the floor and flagged, so a UI can
    // explain the bump instead of silently charging more.
    const bumped = await quote(10)
    expect(bumped.body.meetsMinimum).toBe(false)
    expect(bumped.body.credits).toBe(1000)

    // Rate 0 = admin-disabled: enabled=false rather than a $0 price, and the
    // create path refuses on every rail.
    await setRate(0)
    const off = await quote(5000)
    expect(off.body).toMatchObject({
      enabled: false,
      amountCents: 0,
      minCredits: 0,
      rateCreditsPerDollar: 0,
    })
    await auth(request(app.getHttpServer()).post('/api/payments/topup'))
      .send({ credits: 5000, method: 'bakong' })
      .expect(400)
  })

  it('top-up: all rails share one grant path; replay does not double-grant; refund claws back', async () => {
    setTestUser(ctx, {
      sub: 'railadmin',
      email: 'railadmin@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const adminAccess = await login(app, 'state-railadmin-1')
    await ctx.prisma.user.update({
      where: { email: 'railadmin@example.com' },
      data: { role: 'superadmin' },
    })
    await request(app.getHttpServer())
      .patch('/api/admin/credit-settings')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ creditsPerDollar: 1000, minTopupCents: 100 })
      .expect(200)

    setTestUser(ctx, {
      sub: 'railuser',
      email: 'railuser@example.com',
      displayName: null,
      avatarUrl: null,
    })
    const access = await login(app, 'state-railuser-1')
    const auth = (req: request.Test) => req.set('Authorization', `Bearer ${access}`)
    const balance = async () =>
      (await auth(request(app.getHttpServer()).get('/api/me/entitlements'))).body
        .topupBalance

    // ABA and Bakong are priced identically — one shared pricing path.
    const abaBuy = await auth(
      request(app.getHttpServer()).post('/api/payments/topup'),
    ).send({ credits: 2000, method: 'aba' })
    expect(abaBuy.status).toBe(201)
    expect(abaBuy.body.amountCents).toBe(200)
    expect(abaBuy.body.method).toBe('aba')
    await auth(
      request(app.getHttpServer()).post(
        `/api/payments/${abaBuy.body.paymentId}/cancel`,
      ),
    ).expect(201)

    // The card rail is accepted by validation but unavailable → 501, and it does
    // NOT silently fall back to a KHQR.
    const stripe = await auth(
      request(app.getHttpServer()).post('/api/payments/topup'),
    ).send({ credits: 2000, method: 'stripe' })
    expect(stripe.status).toBe(501)

    const buy = await auth(
      request(app.getHttpServer()).post('/api/payments/topup'),
    ).send({ credits: 2000, method: 'bakong' })
    expect(buy.status).toBe(201)
    const paymentId = buy.body.paymentId

    ctx.setBakongPaid(true, 'ext-rail')
    const paid = await auth(
      request(app.getHttpServer()).get(`/api/payments/${paymentId}/status`),
    )
    expect(paid.body).toMatchObject({ kind: 'topup', credits: 2000, activated: true })
    expect(await balance()).toBe(2000)

    // The grant is the credit_topups pending → paid flip (what both balance
    // readers sum); no positive credit_ledger row is written, because
    // source='topup' means CONSUMPTION to those same readers.
    const topupRow = await ctx.prisma.creditTopup.findFirst({ where: { paymentId } })
    expect(topupRow?.status).toBe('paid')
    expect(
      await ctx.prisma.creditLedger.count({
        where: { userId: topupRow!.userId, source: 'topup' },
      }),
    ).toBe(0)

    // Replaying the paid event must not grant twice.
    await auth(
      request(app.getHttpServer()).get(`/api/payments/${paymentId}/status`),
    ).expect(200)
    await auth(
      request(app.getHttpServer()).get(`/api/payments/${paymentId}/status`),
    ).expect(200)
    expect(await balance()).toBe(2000)
    ctx.setBakongPaid(false)

    // Refund clawback: drops the credits out of the granted SUM and audits the
    // reversal as source='refund' (not 'topup', which would subtract twice).
    const refund = await request(app.getHttpServer())
      .post(`/api/admin/payments/${paymentId}/refund-topup`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ ref: 'REV-1' })
    expect(refund.status).toBe(201)
    expect(refund.body).toMatchObject({ clawedBack: true, credits: 2000 })
    expect(await balance()).toBe(0)
    expect(
      await ctx.prisma.creditLedger.count({
        where: { userId: topupRow!.userId, source: 'refund' },
      }),
    ).toBe(1)

    // Replayed refund is a no-op (no second audit row, balance stays clamped).
    const replay = await request(app.getHttpServer())
      .post(`/api/admin/payments/${paymentId}/refund-topup`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({})
    expect(replay.body.clawedBack).toBe(false)
    expect(
      await ctx.prisma.creditLedger.count({
        where: { userId: topupRow!.userId, source: 'refund' },
      }),
    ).toBe(1)
    expect(await balance()).toBe(0)
  })
})

// Helper: run the exchange->token bridge for the currently-set OAuth user and
// return the access token.
async function login(app: INestApplication, state: string): Promise<string> {
  const exchange = await request(app.getHttpServer())
    .post('/api/cli/exchange')
    .set('Authorization', 'Bearer fake-google')
    .send({ state })
  const token = await request(app.getHttpServer())
    .post('/api/cli/token')
    .send({ code: exchange.body.code })
  return token.body.accessToken
}