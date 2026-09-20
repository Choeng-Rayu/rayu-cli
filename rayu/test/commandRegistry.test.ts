import { describe, expect, test } from 'bun:test'

import { builtInCommandNames } from '../src/commands.ts'

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
      'install-github-app',
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
})
