import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-notifications-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  delete process.env.RAYU_OPENAI_BASE_URL
  delete process.env.RAYU_OPENAI_API_KEY
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.RAYU_OPENAI_BASE_URL
  delete process.env.RAYU_OPENAI_API_KEY
})

describe('PromptInput notifications auth status', () => {
  test('missing Claude auth is shown when no Rayu provider can handle auth', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg._resetRayuConfigCache()
    const { shouldShowClaudeAuthError } = await import('../src/components/PromptInput/Notifications.tsx')
    expect(shouldShowClaudeAuthError('missing')).toBe(true)
  })

  test('configured OpenAI-compatible providers suppress Claude login as primary status', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg._resetRayuConfigCache()
    cfg.upsertProvider({
      id: 'nvidia',
      kind: 'openai-compatible',
      apiKey: 'k',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      defaultModel: 'stepfun-ai/step-3.7-flash',
    })
    const { shouldShowClaudeAuthError } = await import('../src/components/PromptInput/Notifications.tsx')
    expect(shouldShowClaudeAuthError('missing')).toBe(false)
    expect(shouldShowClaudeAuthError('invalid')).toBe(false)
  })
})
