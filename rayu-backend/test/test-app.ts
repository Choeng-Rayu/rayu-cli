import { INestApplication, ValidationPipe } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { json, raw, urlencoded } from 'express'
import { AppModule } from '../src/app.module'
import { OAuthService, VerifiedOAuthProfile } from '../src/auth/oauth.service'
import { BakongService } from '../src/payments/bakong.service'
import { PrismaService } from '../src/prisma/prisma.service'

export interface TestContext {
  app: INestApplication
  // The OAuth verification result the mock will return on the next call.
  setOAuthUser: (u: VerifiedOAuthProfile) => void
  // Control the mocked Bakong payment-status check.
  setBakongPaid: (paid: boolean, ref?: string) => void
  prisma: PrismaService
}

/**
 * Extra provider overrides a caller wants applied on top of the standard
 * OAuth + Bakong mocks. Used by the Stripe webhook e2e to swap in a fake
 * StripeService so the suite never reaches the Stripe API.
 */
export type ExtraOverrides = Array<{
  token: symbol | string | Function
  useValue: unknown
}>

/**
 * Route prefixes that must receive the RAW request body (a Buffer, not parsed
 * JSON). Used by the Stripe webhook e2e: Stripe signs the exact bytes, so the
 * webhook route cannot go through express.json(). When provided, body parsing
 * is registered manually with these prefixes as raw-body exceptions, mirroring
 * main.ts.
 */
export interface RawBodyRoutes {
  /** Path prefixes (with leading slash, e.g. '/api/payments/stripe/webhook') routed to raw(). */
  rawPrefixes: string[]
}

export async function createTestApp(
  overrides?: ExtraOverrides,
  rawBodyRoutes?: RawBodyRoutes,
): Promise<TestContext> {
  let nextOAuthUser: VerifiedOAuthProfile = {
    provider: 'google',
    providerAccountId: 'google_default',
    email: 'default@example.com',
    displayName: 'Default User',
    avatarUrl: null,
    emailVerified: true,
  }

  const oauthMock: Partial<OAuthService> = {
    verifyGoogleIdToken: async () => nextOAuthUser,
  }

  // Deterministic, offline Bakong: generateKhqr returns a fake QR/md5; the
  // paid status is controlled per-test via setBakongPaid.
  let bakongPaid = false
  let bakongRef: string | undefined
  const bakongMock: Partial<BakongService> = {
    generateKhqr: (_amountUsd: number, billNumber: string) => ({
      qr: `TESTQR-${billNumber}`,
      md5: `md5-${billNumber}`,
    }),
    checkPaidByMd5: async () => ({ paid: bakongPaid, ref: bakongRef }),
  }

  let builder = Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(OAuthService)
    .useValue(oauthMock)
    .overrideProvider(BakongService)
    .useValue(bakongMock)
  // Apply any extra overrides last so a caller can swap the Stripe service
  // (or any other) on top of the standard OAuth + Bakong mocks. Each
  // overrideProvider() returns a new builder, so reassign.
  for (const o of overrides ?? []) {
    builder = builder.overrideProvider(o.token).useValue(o.useValue)
  }
  const moduleRef = await builder.compile()

  // When raw-body routes are requested, mirror main.ts: disable the default
  // body parsers and register them manually with the raw-body exception, so the
  // webhook route receives a Buffer (signature-verifiable) and everything else
  // gets JSON.
  const expressApp =
    rawBodyRoutes && rawBodyRoutes.rawPrefixes.length > 0
      ? (moduleRef.createNestApplication({ bodyParser: false }) as NestExpressApplication)
      : moduleRef.createNestApplication()
  if (rawBodyRoutes && rawBodyRoutes.rawPrefixes.length > 0) {
    const prefixes = rawBodyRoutes.rawPrefixes
    expressApp.use((req: { path: string }, res: unknown, next: () => void) => {
      for (const p of prefixes) {
        if (req.path.startsWith(p)) {
          raw({ type: 'application/json' })(req as never, res as never, next)
          return
        }
      }
      json()(req as never, res as never, next)
    })
    expressApp.use((req: { path: string }, res: unknown, next: () => void) => {
      for (const p of prefixes) {
        if (req.path.startsWith(p)) {
          next()
          return
        }
      }
      urlencoded({ extended: true })(req as never, res as never, next)
    })
  }
  expressApp.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  expressApp.setGlobalPrefix('api')
  await expressApp.init()

  return {
    app: expressApp,
    setOAuthUser: (u) => {
      nextOAuthUser = u
    },
    setBakongPaid: (paid, ref) => {
      bakongPaid = paid
      bakongRef = ref
    },
    prisma: moduleRef.get(PrismaService),
  }
}
