/**
 * A real engine starts in the permission mode Rayucode's profile records.
 *
 * This is the end-to-end half of the Task 9 gap: the spawn flag (`--permission-mode`) is
 * covered by `engineArgsFor` unit tests, but only a real engine proves it OUTRANKS a
 * `permissions.defaultMode` written for the terminal, and that "no edits" and "no
 * questions" actually hold when a model asks for those tools.
 *
 * Gated on the built engines, like the other real-engine tests.
 */
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import { sessionCallbacks, until } from './helpers/vscodeSession.js'
import { startLocalProvider } from './helpers/localProvider.js'

const SCRIPT_ENGINE = resolve(import.meta.dir, '../dist/vscode-stage/engine.mjs')
const COMPILED_ENGINE = resolve(import.meta.dir, '../dist/vscode-stage/bin/rayucode-engine')

interface Outcome {
  file: string
  permissionRequests: number
  errors: string[]
  finished: boolean
  /** The mode the session holds after startup, resynced from the engine's own report. */
  modeId: string
}

/**
 * Run the fixture conversation with a profile that records `permissionMode`, and a
 * terminal `permissions.defaultMode` that disagrees, so passing the flag is observable.
 */
async function runFixture(
  launch: { enginePath: string; nodePath?: string },
  permissionMode: string,
): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), 'rayucode-startup-mode-'))
  const provider = await startLocalProvider()
  const originalAuthConfig = process.env.RAYU_AUTH_CONFIG_DIR
  const originalConfig = process.env.RAYU_CONFIG_DIR
  let session: ChatSession | undefined
  try {
    const config = join(dir, 'config')
    mkdirSync(config)
    process.env.RAYU_CONFIG_DIR = config
    // `readRayucodePreferences()` only reads a profile when this marker is present.
    process.env.RAYU_AUTH_CONFIG_DIR = config
    writeFileSync(join(config, 'providers.json'), JSON.stringify({
      activeProvider: 'test',
      providers: [{
        id: 'test', kind: 'openai-compatible', baseURL: provider.url, apiKey: 'fixture-key',
        defaultModel: 'test-model', fetchedModels: ['test-model'],
        modelContextWindows: { 'test-model': 32000 },
      }],
    }), { mode: 0o600 })
    // The hostile shared setting: a terminal default that must NOT win. No allow rules,
    // so any tool that runs without a prompt ran because of the mode, not a rule.
    writeFileSync(join(config, 'settings.json'), JSON.stringify({
      permissions: { defaultMode: 'acceptEdits' },
      alwaysThinkingEnabled: false,
    }))
    writeFileSync(join(config, 'rayucode-preferences.json'), JSON.stringify({ permissionMode }))
    writeFileSync(join(dir, 'fixture.txt'), 'before\n')

    const errors: string[] = []
    let permissionRequests = 0
    let finished = false
    session = new ChatSession({
      ...launch,
      cwd: dir,
      env: {
        RAYU_CONFIG_DIR: config,
        RAYU_AUTH_CONFIG_DIR: config,
        USE_RAYU_OAUTH: 'false',
        RAYU_EXTERNAL_AGENTS: '0',
      },
    }, sessionCallbacks({
      onError: error => errors.push(error),
      onTurnState: running => { if (!running) finished = true },
      onPermissionRequest: request => {
        permissionRequests += 1
        // Deny, so a file change can only be the engine's own mode allowing it.
        session!.controlClient!.respond(request.requestId, {
          behavior: 'deny',
          message: 'Denied by the permission-mode test.',
        })
      },
    }))

    await session.submitPrompt('Read fixture.txt, change before to after, run true, then summarize.')
    await until(() => finished || errors.length > 0, 60_000)
    return {
      file: readFileSync(join(dir, 'fixture.txt'), 'utf8'),
      permissionRequests,
      errors,
      finished,
      modeId: session.currentPermissionMode.id,
    }
  } finally {
    if (originalAuthConfig === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
    else process.env.RAYU_AUTH_CONFIG_DIR = originalAuthConfig
    if (originalConfig === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = originalConfig
    session?.dispose()
    // Let the engine's in-flight connection drain before the fixture server closes;
    // closing it under a live request surfaces as an ECONNRESET on the server.
    await new Promise(resolve => setTimeout(resolve, 300))
    await provider.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── what the mode flag actually changes ────────────────────────────────────────
//
// This fork's plan mode is ADVISORY: it tells the model to plan and offers
// ExitPlanMode, but it does not deny Edit/Bash at the tool layer (measured on the
// real engine: plan raised no permission request and the edit landed). So the
// behavioural proof that the flag is honoured is default-vs-fullManage, not plan.
// Plan is still asserted on the reported mode, which is what the pill shows.

test.if(existsSync(SCRIPT_ENGINE))('default asks before changing a file, so the mode is in effect', async () => {
  const ask = await runFixture({ enginePath: SCRIPT_ENGINE, nodePath: 'node' }, 'default')
  expect(ask.errors).toEqual([])
  expect(ask.finished).toBe(true)
  expect(ask.modeId).toBe('default')
  // The handler denies, so nothing lands and at least one prompt was raised.
  expect(ask.permissionRequests).toBeGreaterThan(0)
  expect(ask.file).toBe('before\n')
}, 90_000)

test.if(existsSync(SCRIPT_ENGINE))('fullManage runs tools without asking', async () => {
  const full = await runFixture({ enginePath: SCRIPT_ENGINE, nodePath: 'node' }, 'fullManage')
  expect(full.errors).toEqual([])
  expect(full.finished).toBe(true)
  expect(full.modeId).toBe('fullManage')
  expect(full.permissionRequests).toBe(0)
  expect(full.file).toBe('after\n')
}, 90_000)

test.if(existsSync(SCRIPT_ENGINE))('plan is accepted and reported at startup', async () => {
  const plan = await runFixture({ enginePath: SCRIPT_ENGINE, nodePath: 'node' }, 'plan')
  expect(plan.errors).toEqual([])
  // If the engine had rejected the flag, the host would have resynced to its report.
  expect(plan.modeId).toBe('plan')
}, 90_000)

test.if(existsSync(COMPILED_ENGINE))('the compiled engine honours the same profile mode', async () => {
  const ask = await runFixture({ enginePath: COMPILED_ENGINE }, 'default')
  expect(ask.errors).toEqual([])
  expect(ask.permissionRequests).toBeGreaterThan(0)
  expect(ask.file).toBe('before\n')

  const full = await runFixture({ enginePath: COMPILED_ENGINE }, 'fullManage')
  expect(full.errors).toEqual([])
  expect(full.modeId).toBe('fullManage')
  expect(full.permissionRequests).toBe(0)
  expect(full.file).toBe('after\n')
}, 240_000)
