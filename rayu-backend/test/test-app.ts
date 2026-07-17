import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
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

export async function createTestApp(): Promise<TestContext> {
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

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(OAuthService)
    .useValue(oauthMock)
    .overrideProvider(BakongService)
    .useValue(bakongMock)
    .compile()

  const app = moduleRef.createNestApplication()
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  app.setGlobalPrefix('api')
  await app.init()

  return {
    app,
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
