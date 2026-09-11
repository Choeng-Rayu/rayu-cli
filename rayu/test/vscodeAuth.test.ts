/**
 * Test suite for VS Code extension auth bridge, sign-in gate, and watcher sync.
 *
 * Verifies:
 *  - Gate blocks while signed out.
 *  - Unblocks the instant a session file appears (CLI -> extension sync requirement).
 *  - Sign-out propagates (session file is removed, gate re-blocks).
 *  - No second credential file is ever created.
 *  - AuthSnapshot contains no secrets (no accessToken or refreshToken).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getAuthSnapshot,
  hasAccountSession,
  sessionDirPath,
  sessionFilePath,
  signOutShared,
} from '../src/vscode/host/auth/rayuAuthBridge.js'
import { checkTurnAllowed } from '../src/vscode/host/auth/signInGate.js'
import { watchSharedSession } from '../src/vscode/host/auth/authWatcher.js'

describe('VS Code Auth Bridge and Sign-in Gate', () => {
  let testConfigDir: string
  const originalConfigDir = process.env.RAYU_CONFIG_DIR
  const originalOAuthEnv = process.env.USE_RAYU_OAUTH

  beforeEach(() => {
    testConfigDir = mkdtempSync(join(tmpdir(), 'rayucode-auth-test-'))
    process.env.RAYU_CONFIG_DIR = testConfigDir
    process.env.USE_RAYU_OAUTH = 'true'
  })

  afterEach(() => {
    if (originalConfigDir !== undefined) {
      process.env.RAYU_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.RAYU_CONFIG_DIR
    }
    if (originalOAuthEnv !== undefined) {
      process.env.USE_RAYU_OAUTH = originalOAuthEnv
    } else {
      delete process.env.USE_RAYU_OAUTH
    }
    if (existsSync(testConfigDir)) {
      rmSync(testConfigDir, { recursive: true, force: true })
    }
  })

  test('gate blocks while signed out and snapshot exposes no secrets', () => {
    const gate = checkTurnAllowed()
    expect(gate.allowed).toBe(false)
    if (!gate.allowed) {
      expect(gate.reason).toContain('Sign in to Rayu')
    }

    const snapshot = getAuthSnapshot()
    expect(snapshot.signedIn).toBe(false)
    expect(snapshot.gateMessage).not.toBeNull()
    expect(snapshot.identity).toBeNull()
    expect(snapshot.oauthEnabled).toBe(true)

    // Security check: no token exposure to webview
    expect((snapshot as unknown as Record<string, unknown>).accessToken).toBeUndefined()
    expect((snapshot as unknown as Record<string, unknown>).refreshToken).toBeUndefined()
    expect(hasAccountSession()).toBe(false)
  })

  test('unblocks when session file appears (simulating CLI /login)', () => {
    // Write session file as the CLI would
    const sessionData = {
      accessToken: 'test-access-token-12345',
      refreshToken: 'test-refresh-token-67890',
      expiresAt: Date.now() + 3_600_000,
      user: {
        id: 42,
        email: 'dev@rayu.ai',
        displayName: 'Rayu Engineer',
        avatarUrl: null,
        role: 'user',
      },
    }
    writeFileSync(sessionFilePath(), JSON.stringify(sessionData), { mode: 0o600 })

    expect(hasAccountSession()).toBe(true)
    const gate = checkTurnAllowed()
    expect(gate.allowed).toBe(true)

    const snapshot = getAuthSnapshot()
    expect(snapshot.signedIn).toBe(true)
    expect(snapshot.gateMessage).toBeNull()
    expect(snapshot.identity).toEqual({
      email: 'dev@rayu.ai',
      displayName: 'Rayu Engineer',
    })

    // Still strictly no tokens in snapshot
    expect((snapshot as unknown as Record<string, unknown>).accessToken).toBeUndefined()
    expect((snapshot as unknown as Record<string, unknown>).refreshToken).toBeUndefined()
  })

  test('live sync via watchSharedSession triggers on session file creation', async () => {
    let fired = false
    const watcher = watchSharedSession(() => {
      fired = true
    })

    try {
      const sessionData = {
        accessToken: 'watcher-token',
        refreshToken: 'watcher-refresh',
        expiresAt: Date.now() + 3_600_000,
        user: { id: 1, email: 'watcher@rayu.ai', displayName: 'Watcher User' },
      }
      writeFileSync(sessionFilePath(), JSON.stringify(sessionData), { mode: 0o600 })

      // Wait up to 500ms for debounced watcher callback (debounce is 150ms)
      for (let i = 0; i < 10; i++) {
        if (fired) break
        await new Promise(r => setTimeout(r, 50))
      }

      expect(fired).toBe(true)
      expect(checkTurnAllowed().allowed).toBe(true)
    } finally {
      watcher.dispose()
    }
  })

  test('sign-out propagates: removes session file, re-blocks gate, and creates no second file', () => {
    // Write initial session
    const sessionData = {
      accessToken: 'active-token',
      refreshToken: 'active-refresh',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 2, email: 'user@rayu.ai', displayName: 'Active User' },
    }
    writeFileSync(sessionFilePath(), JSON.stringify(sessionData), { mode: 0o600 })
    expect(existsSync(sessionFilePath())).toBe(true)
    expect(checkTurnAllowed().allowed).toBe(true)

    // Sign out
    signOutShared()

    // File must be gone
    expect(existsSync(sessionFilePath())).toBe(false)
    expect(hasAccountSession()).toBe(false)
    expect(checkTurnAllowed().allowed).toBe(false)

    // Verify directory contents: no second credential file or stray backup file created
    const files = readdirSync(sessionDirPath())
    expect(files.filter(f => f.includes('auth') || f.includes('token') || f.includes('session'))).toEqual([])
  })
})
