/**
 * One-off: import provider API keys that used to live in the GATEWAY's
 * environment into the encrypted `provider_api_keys` table.
 *
 * WHY THIS EXISTS
 *
 * Before this release a provider row named an environment variable and the
 * gateway read the secret from its own process env. Keys are now individual
 * encrypted rows entered in the admin dashboard. That is a better design, but the
 * migration that drops `providers.keyEnv` leaves a live deployment with ZERO keys:
 * every hosted request answers "provider key not configured" until an admin has
 * pasted each key back by hand.
 *
 * This script closes that window. Run it once, right after the deploy, with the
 * same key values the gateway used to have, and hosted traffic resumes without
 * anyone opening the dashboard.
 *
 * USAGE (from rayu-backend, with DATABASE_URL + RAYU_PROVIDER_SECRET set):
 *
 *   # provider=ENV_VAR pairs; the env var must be readable by THIS process
 *   PROVIDER_KEYS="deepseek=DEEPSEEK_API_KEY,longcat=LONGCAT_API_KEY" \
 *   DEEPSEEK_API_KEY=sk-... LONGCAT_API_KEY=sk-... \
 *   npx ts-node scripts/backfill-provider-keys.ts
 *
 *   # …or pass the secret inline (provider=VALUE with a literal key):
 *   PROVIDER_KEYS_INLINE="deepseek=sk-abc,longcat=sk-def" \
 *   npx ts-node scripts/backfill-provider-keys.ts
 *
 * A comma-separated env value (the old multi-key convention,
 * OLLAMA_API_KEY="k1,k2") becomes SEVERAL keys with ascending priority, which is
 * exactly how the gateway rotated them before.
 *
 * SAFE TO RE-RUN: it goes through the same service the dashboard uses, so a key
 * that is already stored is rejected as a duplicate and reported as "skipped".
 * Nothing is ever overwritten or deleted.
 */
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../src/app.module'
import { ProvidersService } from '../src/providers/providers.service'

interface Entry {
  provider: string
  /** Where the value came from, for the report — never the value itself. */
  source: string
  secrets: string[]
}

/** Parse `provider=X,provider=Y` into entries, resolving env vars when asked. */
function parseSpec(spec: string, fromEnv: boolean): Entry[] {
  const out: Entry[] = []
  for (const pair of spec.split(',')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) {
      throw new Error(`Bad entry ${JSON.stringify(trimmed)} — expected provider=VALUE`)
    }
    const provider = trimmed.slice(0, eq).trim()
    const rhs = trimmed.slice(eq + 1).trim()
    const raw = fromEnv ? (process.env[rhs] ?? '') : rhs
    if (!raw) {
      throw new Error(
        fromEnv
          ? `Provider "${provider}" points at env var ${rhs}, which is empty or unset in this process`
          : `Provider "${provider}" has an empty key`,
      )
    }
    // The old convention: one variable could hold several comma-separated keys.
    const secrets = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    out.push({ provider, source: fromEnv ? rhs : 'inline', secrets })
  }
  return out
}

async function run(): Promise<void> {
  const fromEnvSpec = process.env.PROVIDER_KEYS
  const inlineSpec = process.env.PROVIDER_KEYS_INLINE
  if (!fromEnvSpec && !inlineSpec) {
    throw new Error(
      'Set PROVIDER_KEYS="provider=ENV_VAR,…" or PROVIDER_KEYS_INLINE="provider=secret,…"',
    )
  }
  const entries = [
    ...(fromEnvSpec ? parseSpec(fromEnvSpec, true) : []),
    ...(inlineSpec ? parseSpec(inlineSpec, false) : []),
  ]

  const app = await NestFactory.createApplicationContext(AppModule, {
    // The seeding/audit chatter would drown the report.
    logger: ['error', 'warn'],
  })
  try {
    const providers = app.get(ProvidersService)
    let added = 0
    let skipped = 0
    for (const entry of entries) {
      for (const [i, secret] of entry.secrets.entries()) {
        const label = entry.secrets.length > 1 ? `${entry.source} #${i + 1}` : entry.source
        try {
          // Same path as the dashboard: validates the provider, encrypts, and
          // audit-logs the MASK only.
          const key = await providers.addKey(entry.provider, {
            key: secret,
            label,
            priority: i,
          })
          added++
          // eslint-disable-next-line no-console
          console.log(`  added   ${entry.provider} ← ${label} (${key.maskedKey})`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (/already/i.test(message)) {
            skipped++
            // eslint-disable-next-line no-console
            console.log(`  skipped ${entry.provider} ← ${label} (already stored)`)
            continue
          }
          throw new Error(`${entry.provider} ← ${label}: ${message}`)
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`\nDone: ${added} key(s) added, ${skipped} already present.`)
    // eslint-disable-next-line no-console
    console.log(
      'The gateway picks them up within CONFIG_REFRESH_SECONDS. Verify with\n' +
        '  GET /v1/_provider-health   (admin token) → usableKeys per provider.',
    )
  } finally {
    await app.close()
  }
}

void run().catch((err) => {
  // Never print a secret: the message only ever names providers and env vars.
  // eslint-disable-next-line no-console
  console.error('Backfill failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
