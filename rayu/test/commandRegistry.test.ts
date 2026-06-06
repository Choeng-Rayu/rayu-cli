import { describe, expect, test } from 'bun:test'

import { builtInCommandNames } from '../src/commands.ts'

describe('Rayu command registry', () => {
  test('removes Claude account auth and subscription commands', () => {
    const names = builtInCommandNames()

    for (const name of [
      'auth',
      'login',
      'logout',
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

  test('keeps Rayu provider, config, and MCP commands', () => {
    const names = builtInCommandNames()

    for (const name of ['connect', 'model', 'config', 'mcp', 'status']) {
      expect(names.has(name)).toBe(true)
    }
  })
})
