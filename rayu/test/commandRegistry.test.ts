import { describe, expect, test } from 'bun:test'

import { builtInCommandNames } from '../src/commands.ts'
import clear from '../src/commands/clear/index.ts'
import installGitHubApp from '../src/commands/install-github-app/index.ts'
import modelImageGeneration from '../src/commands/model-image-generation/index.ts'
import modelVideoGeneration from '../src/commands/model-video-generation/index.ts'
import webBridge from '../src/commands/web-bridge.ts'
import { projectRuntimeCommands } from '../src/runtime/catalog.ts'

describe('Rayu command registry', () => {
  test('removes Claude account auth and subscription commands', () => {
    const names = builtInCommandNames()

    // NOTE: `login`/`logout` were removed during the Claude->Rayu rebrand, but
    // are intentionally reintroduced as Rayu *account* commands (gated by
    // USE_RAYU_OAUTH). They are asserted as present below.
    for (const name of [
      'auth',
      'oauth-refresh',
      'setup-token',
      'upgrade',
      'extra-usage',
      'rate-limit-options',
      'passes',
      'chrome',
      'desktop',
      'mobile',
      'install-slack-app',
      'remote-env',
    ]) {
      expect(names.has(name)).toBe(false)
    }
  })

  test('keeps Rayu provider, config, MCP, and account commands', () => {
    const names = builtInCommandNames()

    for (const name of [
      'connect',
      'model',
      'config',
      'mcp',
      'status',
      'login',
      'logout',
      'install-github-app',
    ]) {
      expect(names.has(name)).toBe(true)
    }
  })

  test('exposes Orchestrator and removes the legacy collaborator commands', () => {
    const names = builtInCommandNames()
    expect(names.has('orchestrator')).toBe(true)
    expect(names.has('normal')).toBe(true)
    expect(names.has('collaborator_swarm')).toBe(false)
    expect(names.has('collaborator_model')).toBe(false)
  })

  test('exposes the all-agent model command', () => {
    const names = builtInCommandNames()
    expect(names.has('subagent_models')).toBe(true)
    expect(names.has('model_subagent')).toBe(true)
    expect(names.has('subagent_model')).toBe(true)
  })

  test('the GitHub setup command is available: the host runs it natively', () => {
    // extension.ts intercepts `/install-github-app` and runs `runGitHubSetupFromEditor`,
    // so it must not be listed as terminal-only (which would hide it from the menu).
    const [descriptor] = projectRuntimeCommands([installGitHubApp])

    expect(descriptor?.surface).not.toBe('terminal_only')
    expect(descriptor?.available).toBe(true)
    expect(descriptor?.unavailableReason).toBeUndefined()
  })

  test('/clear and /web-bridge are available although they are not headless', () => {
    // Neither supports non-interactive execution in the engine; the VS Code host answers
    // both itself, so the catalogue must say they can run.
    const byName = new Map(
      projectRuntimeCommands([clear, webBridge]).map(d => [d.name, d]),
    )

    expect(byName.get('clear')?.available).toBe(true)
    expect(byName.get('clear')?.aliases).toEqual(['reset', 'new'])
    expect(byName.get('web-bridge')?.available).toBe(true)
  })

  test('the image and video model pickers are available in Rayucode', () => {
    // Rayucode answers both with its own chooser, so they must not be listed as
    // "does not have a Rayucode surface yet".
    for (const descriptor of projectRuntimeCommands([
      modelImageGeneration,
      modelVideoGeneration,
    ])) {
      expect(descriptor.surface).toBe('panel')
      expect(descriptor.available).toBe(true)
      expect(descriptor.unavailableReason).toBeUndefined()
    }
  })
})
