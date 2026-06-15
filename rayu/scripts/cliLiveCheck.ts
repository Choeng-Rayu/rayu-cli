// Live integration check for the CLI's Rayu auth client against a running
// backend. Uses the SAME code the CLI uses at runtime (rayuSession). Expects a
// session already written to $RAYU_CONFIG_DIR/rayu-auth.json and RAYU_API_URL
// pointing at the live backend.
//
//   RAYU_CONFIG_DIR=/tmp/x RAYU_API_URL=http://localhost:4000/api \
//   bun run scripts/cliLiveCheck.ts
import {
  getValidRayuAccessToken,
  hasRayuSession,
  recordRayuUsageBestEffort,
} from '../src/services/rayuAuth/rayuSession.js'

async function main(): Promise<void> {
  console.log('hasRayuSession:', hasRayuSession())

  const token = await getValidRayuAccessToken()
  console.log('access token present:', !!token)

  // Call the backend /me with the CLI token to prove end-to-end auth.
  const apiBase = (process.env.RAYU_API_URL ?? 'http://localhost:4000/api').replace(/\/$/, '')
  const meRes = await fetch(`${apiBase}/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const me = await meRes.json()
  console.log('/me status:', meRes.status, 'email:', me?.user?.email)

  // Record a usage event exactly as the CLI does on each query.
  await recordRayuUsageBestEffort('anthropic', 'claude-local-test')
  console.log('usage recorded')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
