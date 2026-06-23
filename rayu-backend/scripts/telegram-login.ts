import 'reflect-metadata'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
// Load rayu-backend/.env so the script sees TELEGRAM_API_ID/HASH the same way
// the NestJS app does (Nest loads .env via @nestjs/config; a bare ts-node run
// does not, so do it explicitly here).
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config()
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'

/**
 * One-time interactive login that prints a TELEGRAM_SESSION string.
 *
 *   npm run telegram:login
 *
 * Requires TELEGRAM_API_ID + TELEGRAM_API_HASH in the environment (from
 * https://my.telegram.org -> API development tools). Answer the prompts:
 *   - Phone number   (international, e.g. +85596xxxxxxx)
 *   - 2FA password   (press Enter if you don't use one)
 *   - Login code     (the code Telegram sends to your app)
 *
 * Paste the printed `TELEGRAM_SESSION=...` line into rayu-backend/.env.
 * The session grants full access to the account — keep it secret, never commit.
 */
async function main(): Promise<void> {
  const apiIdRaw = process.env.TELEGRAM_API_ID
  const apiHash = process.env.TELEGRAM_API_HASH
  if (!apiIdRaw || !apiHash) {
    console.error(
      'Set TELEGRAM_API_ID and TELEGRAM_API_HASH (from my.telegram.org) before running.',
    )
    process.exit(1)
  }
  const apiId = parseInt(apiIdRaw, 10)

  const rl = createInterface({ input: stdin, output: stdout })
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  })

  await client.start({
    phoneNumber: () => rl.question('Phone number (e.g. +85596xxxxxxx): '),
    password: () => rl.question('2FA password (Enter if none): '),
    phoneCode: () => rl.question('Login code: '),
    onError: (err) => console.error(err),
  })

  const session = client.session.save() as unknown as string
  console.log('\nLogin successful. Add this line to rayu-backend/.env:\n')
  console.log(`TELEGRAM_SESSION=${session}\n`)

  rl.close()
  await client.disconnect()
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
