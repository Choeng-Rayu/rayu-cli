// `/login` must open the sign-in flow whenever the stored session cannot work.
//
// The reported bug: after an update (or a backend deploy that invalidated the
// refresh token) sending a message failed with an auth error, and `/login`
// answered "Already signed in … Run /logout to switch accounts" — so the only
// way back in was /logout then /login. The guard now asks whether the session is
// USABLE, not merely whether a token file exists.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
const originalConfigDir = process.env.RAYU_CONFIG_DIR
const originalAuthConfigDir = process.env.RAYU_AUTH_CONFIG_DIR

const user = {
  id: 1,
  email: 'u@example.com',
  displayName: 'U',
  avatarUrl: null,
  role: 'user',
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-login-cmd-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_AUTH_CONFIG_DIR = dir
  process.env.USE_RAYU_OAUTH = 'true'
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (originalConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = originalConfigDir
  if (originalAuthConfigDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
  else process.env.RAYU_AUTH_CONFIG_DIR = originalAuthConfigDir
  delete process.env.USE_RAYU_OAUTH
})

describe('/login command', () => {
  test('starts the sign-in flow when the stored session cannot be renewed', async () => {
    const session = await import('../src/services/rayuAuth/rayuSession.ts')
    session.writeRayuSession({
      accessToken: 'dead-at',
      refreshToken: '',
      expiresAt: Date.now() - 1000,
      user,
    })

    const { call } = await import('../src/commands/login/login.tsx')
    let done: string | null = null
    // The command's own arguments are unused by the branch under test.
    const element = await call(
      (result?: string) => {
        done = result ?? ''
      },
      {} as never,
      '',
    )

    // No "Already signed in" short-circuit: the pane is rendered instead.
    expect(done).toBeNull()
    expect(element).not.toBeNull()
  })

  test('still short-circuits with a working session', async () => {
    const session = await import('../src/services/rayuAuth/rayuSession.ts')
    session.writeRayuSession({
      accessToken: 'live-at',
      refreshToken: 'rt',
      expiresAt: Date.now() + 60 * 60 * 1000,
      user,
    })

    const { call } = await import('../src/commands/login/login.tsx')
    let done: string | null = null
    const element = await call(
      (result?: string) => {
        done = result ?? ''
      },
      {} as never,
      '',
    )

    expect(element).toBeNull()
    // `String(...)`: the assignment happens inside the onDone callback, so TS
    // still sees the initial `null` at this point.
    expect(String(done)).toContain('Already signed in')
    expect(String(done)).toContain('u@example.com')
  })
})
