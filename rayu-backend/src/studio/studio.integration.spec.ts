import { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { ValidationPipe } from '@nestjs/common'
import request from 'supertest'
import { AuthService } from '../auth/auth.service'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import { PrismaService } from '../prisma/prisma.service'
import { StudioConnectionsController } from './studio-connections.controller'
import { StudioConnectionsService } from './studio-connections.service'
import { StudioDeployController } from './studio-deploy.controller'
import { StudioGitProxyController } from './studio-git-proxy.controller'
import { StudioProxyTokenGuard } from './studio-proxy-token.guard'
import { StudioMcpController } from './studio-mcp.controller'
import { StudioGithubController, StudioGitlabController } from './studio-scm.controller'
import { StudioSupabaseController } from './studio-supabase.controller'
import { StudioUpstreamService } from './studio-upstream.service'
import { StudioWebSearchController } from './studio-web-search.controller'

// bolt.diy's server routes were unauthenticated and took third-party tokens from
// the request body — coherent for single-user software on localhost, a
// cross-tenant hole once hosted. These tests assert the two properties that
// replaced that model: every studio route requires a Rayu session, and a stored
// token never appears in a response.

const USER = { id: 42, email: 'u@example.test' }
const OTHER_USER_PROJECT = 'other-tenant-project'
const OWN_PROJECT = 'own-project-ref'

/** Accepts requests carrying `Authorization: Bearer test-token`, rejects the rest. */
class StubAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest()
    if (req.headers.authorization !== 'Bearer test-token') return false
    req.user = USER
    return true
  }
}

/** The secret we assert never escapes the backend. */
const SECRET_TOKEN = 'ghp_supersecret_value_0123456789'

function prismaStub(overrides: Record<string, unknown> = {}) {
  const row = {
    id: 1,
    userId: USER.id,
    kind: 'github',
    // Not a real envelope; requireToken is stubbed where decryption matters.
    encryptedToken: 'v1:stub',
    maskedToken: 'ghp_su••••••••6789(31)',
    meta: { login: 'octocat' },
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  return {
    studioConnection: {
      findMany: jest.fn().mockResolvedValue([row]),
      findUnique: jest.fn().mockResolvedValue(row),
      upsert: jest.fn().mockResolvedValue(row),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1),
    },
    studioMcpConfig: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation((args: { create: { config: unknown } }) =>
        Promise.resolve({ userId: USER.id, config: args.create.config }),
      ),
    },
    ...overrides,
  }
}

describe('studio backend (integration)', () => {
  let app: INestApplication
  let upstream: { call: jest.Mock; callUrl: jest.Mock }

  beforeEach(async () => {
    upstream = {
      call: jest.fn().mockResolvedValue({}),
      callUrl: jest.fn().mockResolvedValue({}),
    }

    const moduleRef = await Test.createTestingModule({
      controllers: [
        StudioConnectionsController,
        StudioGithubController,
        StudioGitlabController,
        StudioDeployController,
        StudioSupabaseController,
        StudioGitProxyController,
        StudioMcpController,
        StudioWebSearchController,
      ],
      providers: [
        StudioConnectionsService,
        { provide: StudioUpstreamService, useValue: upstream },
        { provide: PrismaService, useValue: prismaStub() },
        /*
         * The git proxy authenticates with X-Rayu-Token rather than a bearer
         * token (Authorization carries the git credential to forward upstream),
         * so its guard depends on AuthService. Only resolveAccessToken is
         * exercised, and it is overridden below anyway.
         */
        { provide: AuthService, useValue: { resolveAccessToken: jest.fn().mockResolvedValue(USER) } },
      ],
    })
      .overrideGuard(RayuAuthGuard)
      .useClass(StubAuthGuard)
      // Same accept/reject rule, so the auth table below covers both guards.
      .overrideGuard(StudioProxyTokenGuard)
      .useClass(StubAuthGuard)
      .compile()

    app = moduleRef.createNestApplication<NestExpressApplication>()
    // Same pipe as main.ts, so DTO validation is exercised as in production.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.init()
  })

  afterEach(async () => {
    await app.close()
  })

  describe('authentication', () => {
    // Every route the studio exposes. If a new one is added without a guard,
    // this list is where it should fail.
    const routes: Array<[string, string]> = [
      ['get', '/studio/connections'],
      ['put', '/studio/connections/github'],
      ['delete', '/studio/connections/github'],
      ['get', '/studio/scm/github/user'],
      ['get', '/studio/scm/github/repos'],
      ['get', '/studio/scm/github/branches?owner=o&repo=r'],
      ['get', '/studio/scm/github/stats'],
      ['get', '/studio/scm/gitlab/user'],
      ['get', '/studio/scm/gitlab/projects'],
      ['post', '/studio/scm/gitlab/branches'],
      ['get', '/studio/deploy/netlify/user'],
      ['get', '/studio/deploy/netlify/sites'],
      ['post', '/studio/deploy/netlify'],
      ['get', '/studio/deploy/vercel/user'],
      ['get', '/studio/deploy/vercel/projects'],
      ['post', '/studio/deploy/vercel'],
      ['get', '/studio/deploy/status?id=x&provider=vercel'],
      ['get', '/studio/supabase/projects'],
      ['post', '/studio/supabase/keys'],
      ['post', '/studio/supabase/query'],
      ['get', '/studio/mcp/config'],
      ['put', '/studio/mcp/config'],
      ['post', '/studio/mcp/check'],
      ['post', '/studio/web-search'],
      ['get', '/studio/git-proxy/github.com/o/r.git/info/refs'],
    ]

    it.each(routes)('rejects unauthenticated %s %s', async (method, path) => {
      const res = await (request(app.getHttpServer()) as never as Record<string, Function>)[
        method
      ](path)
      // 403 from the stub guard returning false; the real guard throws 401. Either
      // way the request must not be served.
      expect([401, 403]).toContain(res.status)
    })
  })

  describe('connections', () => {
    it('never returns the stored token, only a masked form', async () => {
      const res = await request(app.getHttpServer())
        .get('/studio/connections')
        .set('Authorization', 'Bearer test-token')
        .expect(200)

      const body = JSON.stringify(res.body)
      expect(body).not.toContain('encryptedToken')
      expect(body).not.toContain(SECRET_TOKEN)
      expect(res.body[0]).toHaveProperty('maskedToken')
      expect(res.body[0]).not.toHaveProperty('encryptedToken')
    })

    it('rejects an unknown connection kind', async () => {
      await request(app.getHttpServer())
        .put('/studio/connections/pastebin')
        .set('Authorization', 'Bearer test-token')
        .send({ token: 'x'.repeat(20) })
        .expect(400)
    })

    it('rejects an absent or too-short token', async () => {
      await request(app.getHttpServer())
        .put('/studio/connections/github')
        .set('Authorization', 'Bearer test-token')
        .send({})
        .expect(400)
      await request(app.getHttpServer())
        .put('/studio/connections/github')
        .set('Authorization', 'Bearer test-token')
        .send({ token: 'short' })
        .expect(400)
    })

    it('rejects unknown body fields, so a stray "userId" cannot be injected', async () => {
      await request(app.getHttpServer())
        .put('/studio/connections/github')
        .set('Authorization', 'Bearer test-token')
        .send({ token: 'x'.repeat(20), userId: 999 })
        .expect(400)
    })
  })

  describe('supabase ownership gate', () => {
    it('refuses a project the caller cannot enumerate', async () => {
      // The caller's own token lists only OWN_PROJECT.
      upstream.call.mockResolvedValue([{ id: OWN_PROJECT, name: 'mine' }])

      await request(app.getHttpServer())
        .post('/studio/supabase/query')
        .set('Authorization', 'Bearer test-token')
        .send({ projectId: OTHER_USER_PROJECT, query: 'select 1' })
        .expect(403)

      // Crucially: the query was never forwarded upstream.
      const forwarded = upstream.call.mock.calls.filter((c) =>
        String(c[2]).includes('database/query'),
      )
      expect(forwarded).toHaveLength(0)
    })

    it('forwards SQL for a project the caller owns', async () => {
      upstream.call.mockImplementation((_u: number, _k: string, path: string) => {
        if (path === '/v1/projects') return Promise.resolve([{ id: OWN_PROJECT }])
        return Promise.resolve({ rows: [] })
      })

      await request(app.getHttpServer())
        .post('/studio/supabase/query')
        .set('Authorization', 'Bearer test-token')
        .send({ projectId: OWN_PROJECT, query: 'select 1' })
        .expect(201)

      expect(
        upstream.call.mock.calls.some((c) => String(c[2]).includes('database/query')),
      ).toBe(true)
    })

    it('gates the api-keys endpoint the same way', async () => {
      upstream.call.mockResolvedValue([{ id: OWN_PROJECT }])
      await request(app.getHttpServer())
        .post('/studio/supabase/keys')
        .set('Authorization', 'Bearer test-token')
        .send({ projectId: OTHER_USER_PROJECT })
        .expect(403)
    })
  })

  describe('git proxy routing', () => {
    // Regression test for a real bug: '*path' is Express 5 syntax and silently
    // matches nothing on Express 4, so the whole proxy 404s. Reaching the
    // allow-list at all proves the route matched.
    it('matches a multi-segment path and applies the host allow-list', async () => {
      const res = await request(app.getHttpServer())
        .get('/studio/git-proxy/evil.example/owner/repo.git/info/refs?service=git-upload-pack')
        .set('Authorization', 'Bearer test-token')

      expect(res.status).toBe(403)
      expect(JSON.stringify(res.body)).toMatch(/not allowed/i)
    })

    it('rejects a missing host segment as a bad request, not a 404', async () => {
      const res = await request(app.getHttpServer())
        .get('/studio/git-proxy/')
        .set('Authorization', 'Bearer test-token')
      expect(res.status).toBe(400)
    })
  })

  describe('mcp config', () => {
    it('refuses a server URL pointing at an internal address', async () => {
      await request(app.getHttpServer())
        .put('/studio/mcp/config')
        .set('Authorization', 'Bearer test-token')
        .send({ mcpServers: { evil: { type: 'sse', url: 'http://169.254.169.254/' } } })
        .expect(403)
    })

    it('refuses a "command" server, which would be RCE on our host', async () => {
      await request(app.getHttpServer())
        .put('/studio/mcp/config')
        .set('Authorization', 'Bearer test-token')
        .send({ mcpServers: { local: { command: 'sh -c "curl evil"' } } })
        .expect(400)
    })

    it('accepts a public SSE server', async () => {
      await request(app.getHttpServer())
        .put('/studio/mcp/config')
        .set('Authorization', 'Bearer test-token')
        .send({ mcpServers: { ok: { type: 'sse', url: 'https://mcp.example.com/sse' } } })
        .expect(200)
    })
  })

  describe('web search', () => {
    it('refuses a private target', async () => {
      await request(app.getHttpServer())
        .post('/studio/web-search')
        .set('Authorization', 'Bearer test-token')
        .send({ url: 'http://127.0.0.1:8080/admin' })
        .expect(403)
    })
  })

  describe('deploy input limits', () => {
    it('rejects an empty file map', async () => {
      await request(app.getHttpServer())
        .post('/studio/deploy/netlify')
        .set('Authorization', 'Bearer test-token')
        .send({ files: {} })
        .expect(400)
    })

    it('rejects a path-traversing file path', async () => {
      await request(app.getHttpServer())
        .post('/studio/deploy/netlify')
        .set('Authorization', 'Bearer test-token')
        .send({ files: { '../../etc/passwd': 'x' } })
        .expect(400)
    })

    it('rejects an absolute file path', async () => {
      await request(app.getHttpServer())
        .post('/studio/deploy/vercel')
        .set('Authorization', 'Bearer test-token')
        .send({ files: { '/etc/passwd': 'x' } })
        .expect(400)
    })

    it('rejects too many files', async () => {
      const files: Record<string, string> = {}
      for (let i = 0; i < 3_001; i++) files[`f${i}.txt`] = 'x'
      await request(app.getHttpServer())
        .post('/studio/deploy/vercel')
        .set('Authorization', 'Bearer test-token')
        .send({ files })
        .expect(400)
    })
  })
})
