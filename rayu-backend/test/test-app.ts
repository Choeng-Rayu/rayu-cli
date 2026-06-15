import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { AppModule } from '../src/app.module'
import { ClerkService, VerifiedClerkUser } from '../src/auth/clerk.service'
import { PrismaService } from '../src/prisma/prisma.service'

export interface TestContext {
  app: INestApplication
  // The Clerk verification result the mock will return on the next call.
  setClerkUser: (u: VerifiedClerkUser) => void
  prisma: PrismaService
}

export async function createTestApp(): Promise<TestContext> {
  let nextClerkUser: VerifiedClerkUser = {
    clerkUserId: 'clerk_default',
    email: 'default@example.com',
    displayName: 'Default User',
    avatarUrl: null,
  }

  const clerkMock: Partial<ClerkService> = {
    verifySessionToken: async () => nextClerkUser,
  }

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(ClerkService)
    .useValue(clerkMock)
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
    setClerkUser: (u) => {
      nextClerkUser = u
    },
    prisma: moduleRef.get(PrismaService),
  }
}
