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
})
