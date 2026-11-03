/**
 * Regression test for first-run onboarding after a successful login.
 *
 * `Onboarding` used to rebuild its step list from `hasRayuCredential()` on
 * every render. Signing in flips that to true and therefore REMOVES the
 * provider step mid-flow. The login handler had already captured the OLD
 * three-step list, so `goToNextStep()` advanced the index from 1 to 2 — which
 * no longer exists in `[theme, security]`. `currentStep` became undefined and
 * the whole screen collapsed to the welcome banner with nothing beneath it,
 * leaving the CLI stuck until a restart.
 *
 * This test drives the exact sequence: theme → provider (login succeeds) and
 * asserts the security step is rendered afterwards.
 *
 * Isolation note: `mock.module` is PROCESS-WIDE in bun, so mocking
 * `rayuApiKeyAuth.ts` here made every other test file in the same run see a
 * stubbed `hasRayuCredential()`. The credential flow now uses the REAL modules
 * against a throwaway `RAYU_AUTH_CONFIG_DIR`; the mocked first-run component
 * writes the same `rayu-auth.json` the real login flow writes.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as React from 'react'
import { PassThrough } from 'stream'
import { useEffect } from 'react'
import stripAnsi from 'strip-ansi'

// Both config and auth storage must point at the temp dir: `hasRayuCredential`
// also consults `providers.json` (via `loadRayuConfig`) for a Rayu API key, and
// `getRayuAuthConfigDir()` falls back to `RAYU_CONFIG_DIR` when the auth var is
// unset. Saving/restoring both keeps the developer's real config untouched.
const originalConfigDir = process.env.RAYU_CONFIG_DIR
const originalAuthConfigDir = process.env.RAYU_AUTH_CONFIG_DIR
const originalFetch = globalThis.fetch

let dir = ''

mock.module('../src/components/ThemePicker.tsx', () => ({
  ThemePicker: ({
    onThemeSelect,
  }: {
    onThemeSelect: (theme: string) => void
  }) => {
    useEffect(() => {
      onThemeSelect('dark')
    }, [onThemeSelect])
    return null
  },
}))

mock.module('../src/components/RayuFirstRunSetup.tsx', () => ({
  RayuFirstRunSetup: ({ onDone }: { onDone: () => void }) => {
    useEffect(() => {
      // The real login flow writes rayu-auth.json, then RayuFirstRunSetup's
      // onDone runs. Write the same file so the re-render reads a genuine
      // credential — exactly like the real flow.
      writeFileSync(
        join(dir, 'rayu-auth.json'),
        JSON.stringify({
          accessToken: 'test-access',
          refreshToken: 'test-refresh',
          expiresAt: Date.now() + 3600_000,
          user: {
            id: 1,
            email: 'test@example.com',
            displayName: 'Test',
            avatarUrl: null,
            role: 'user',
          },
        }),
        { mode: 0o600 },
      )
      onDone()
    }, [onDone])
    return null
  },
}))

import { render } from '../src/ink.ts'
import { AppStateProvider } from '../src/state/AppState.tsx'
import { KeybindingSetup } from '../src/keybindings/KeybindingProviderSetup.tsx'
import { Onboarding } from '../src/components/Onboarding.tsx'
import { hasRayuSession } from '../src/services/rayuAuth/rayuSession.ts'
import { CaptureStream } from './helpers/captureStream.js'

function makeStdin() {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.ref = () => {}
  stdin.unref = () => {}
  return stdin
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-onboarding-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_AUTH_CONFIG_DIR = dir
  // Module-level caches may hold a provider/session from another test file in
  // this same process; start from an empty config.
  ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
  ;(
    await import('../src/services/rayuAuth/rayuApiKeyAuth.ts')
  )._resetRayuApiKeyStateForTesting()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (originalConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = originalConfigDir
  if (originalAuthConfigDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
  else process.env.RAYU_AUTH_CONFIG_DIR = originalAuthConfigDir
  globalThis.fetch = originalFetch
})

afterAll(() => {
  mock.restore()
})

describe('Onboarding step stability', () => {
  test('advances to the security step after login removes the provider step', async () => {
    const stdout = new CaptureStream({ columns: 100, rows: 40 })
    const instance = await render(
      <AppStateProvider>
        <KeybindingSetup>
          <Onboarding onDone={() => {}} />
        </KeybindingSetup>
      </AppStateProvider>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: makeStdin(),
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )

    // Theme → provider (auto-login) → security are all effect-driven.
    await new Promise(resolve => setTimeout(resolve, 100))
    instance.unmount()
    instance.cleanup()

    const output = stripAnsi(stdout.output)
    expect(hasRayuSession()).toBe(true)
    expect(output).toContain('Security notes')
    expect(output).toContain('Press Enter to continue')
  })
})
