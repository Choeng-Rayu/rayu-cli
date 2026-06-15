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

  it('GET /api/plans -> 5 plans, free active, paid coming_soon', async () => {
    const res = await request(app.getHttpServer()).get('/api/plans')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(5)
    const byCode = Object.fromEntries(
      res.body.map((p: any) => [p.code, p.availability]),
    )
    expect(byCode.free).toBe('active')
    expect(byCode.pro).toBe('coming_soon')
    expect(byCode.pro_plus).toBe('coming_soon')
    expect(byCode.max).toBe('coming_soon')
    expect(byCode.enterprise).toBe('coming_soon')
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
