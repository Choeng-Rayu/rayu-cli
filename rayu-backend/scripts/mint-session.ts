import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../src/app.module'
import { AuthService } from '../src/auth/auth.service'
import { UsersService } from '../src/users/users.service'

// Dev/test helper: upsert a user (as if they had signed in via Google OAuth)
// and mint a real Rayu CLI session for them. Prints the same JSON shape the CLI
// stores in ~/.rayu/rayu-auth.json. Useful for exercising the CLI against a
// live local backend without a browser. NOT a production endpoint.
//
//   MINT_OAUTH_SUB=cli_local_test MINT_EMAIL=cli@local.test \
//   npx ts-node scripts/mint-session.ts
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  })
  try {
    const users = app.get(UsersService)
    const auth = app.get(AuthService)
    const user = await users.upsertFromOAuth({
      provider: 'google',
      providerAccountId: process.env.MINT_OAUTH_SUB ?? 'cli_local_test',
      email: process.env.MINT_EMAIL ?? 'cli@local.test',
      displayName: 'CLI Local Test',
      avatarUrl: null,
      emailVerified: true,
    })
    const tokens = auth.mintTokens(user)
    process.stdout.write(
      JSON.stringify({ ...tokens, user: auth.toPublicUser(user) }),
    )
  } finally {
    await app.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})