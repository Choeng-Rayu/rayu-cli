import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// A BYO Anthropic API key is first-party SHAPED, but while signed in to Rayu its
// requests are re-pointed at the gateway's /v1/proxy, which caps bodies at 8 MiB.
// The request/compact budgets must follow where the body actually goes.

let routed = false
const real = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
mock.module('../src/services/api/rayuHosted/gatewayRouting.ts', () => ({
  ...real,
  shouldRouteViaGateway: () => routed,
}))
mock.module('../src/services/api/rayuHosted/gatewayRouting.js', () => ({
  ...real,
  shouldRouteViaGateway: () => routed,
}))

const { hasFirstPartyBodyCap, isFirstPartyRequest } = await import(
  '../src/utils/model/providerCapabilities.ts'
)
const { getMediaCompactBudgetBytes, getRequestMessagesBudgetBytes } = await import(
  '../src/utils/mediaBytes.ts'
)
const {
  MEDIA_COMPACT_BUDGET_BYTES,
  MEDIA_COMPACT_BUDGET_BYTES_FIRST_PARTY,
  REQUEST_MESSAGES_BUDGET_BYTES,
  REQUEST_MESSAGES_BUDGET_BYTES_FIRST_PARTY,
} = await import('../src/constants/apiLimits.ts')
const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')

let dir: string
let savedBaseUrl: string | undefined
// providers.json lives under RAYU_AUTH_CONFIG_DIR, which outranks
// RAYU_CONFIG_DIR; an agent/editor host may set it to the REAL ~/.rayu.
let savedAuthDir: string | undefined

function seedProvider(provider: Record<string, unknown>): void {
  writeFileSync(
    join(dir, 'providers.json'),
    JSON.stringify({ activeProvider: provider.id, providers: [provider] }, null, 2),
    { mode: 0o600 },
  )
  _resetRayuConfigCache()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-bodycap-'))
  process.env.RAYU_CONFIG_DIR = dir
  savedAuthDir = process.env.RAYU_AUTH_CONFIG_DIR
  process.env.RAYU_AUTH_CONFIG_DIR = dir
  savedBaseUrl = process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_BASE_URL
  routed = false
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  if (savedAuthDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
  else process.env.RAYU_AUTH_CONFIG_DIR = savedAuthDir
  if (savedBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = savedBaseUrl
  _resetRayuConfigCache()
})

afterAll(() => {
  mock.restore()
})

describe('hasFirstPartyBodyCap', () => {
  const anthropicKey = { id: 'anthropic', kind: 'anthropic', apiKey: 'sk-ant-test' }

  test('direct BYO Anthropic key keeps the 32MB-cap budgets', () => {
    seedProvider(anthropicKey)
    expect(isFirstPartyRequest('claude-sonnet-4-6')).toBe(true)
    expect(hasFirstPartyBodyCap('claude-sonnet-4-6')).toBe(true)
    expect(getRequestMessagesBudgetBytes(hasFirstPartyBodyCap('claude-sonnet-4-6'))).toBe(
      REQUEST_MESSAGES_BUDGET_BYTES_FIRST_PARTY,
    )
    expect(getMediaCompactBudgetBytes(hasFirstPartyBodyCap('claude-sonnet-4-6'))).toBe(
      MEDIA_COMPACT_BUDGET_BYTES_FIRST_PARTY,
    )
  })

  test('BYO Anthropic key routed via the gateway gets the 8 MiB-cap budgets', () => {
    seedProvider(anthropicKey)
    routed = true
    // Still first-party for betas/headers — only the body cap changes.
    expect(isFirstPartyRequest('claude-sonnet-4-6')).toBe(true)
    expect(hasFirstPartyBodyCap('claude-sonnet-4-6')).toBe(false)
    expect(getRequestMessagesBudgetBytes(hasFirstPartyBodyCap('claude-sonnet-4-6'))).toBe(
      REQUEST_MESSAGES_BUDGET_BYTES,
    )
    expect(getMediaCompactBudgetBytes(hasFirstPartyBodyCap('claude-sonnet-4-6'))).toBe(
      MEDIA_COMPACT_BUDGET_BYTES,
    )
  })

  test('a non-first-party provider never gets the large budget', () => {
    seedProvider({
      id: 'ds',
      kind: 'openai-compatible',
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com',
    })
    expect(hasFirstPartyBodyCap('deepseek-chat')).toBe(false)
  })
})
