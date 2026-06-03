import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-query-config-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  delete process.env.RAYU_DISABLE_STREAMING_TOOL_EXECUTION
  delete process.env.CLAUDE_CODE_DISABLE_STREAMING_TOOL_EXECUTION
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.RAYU_DISABLE_STREAMING_TOOL_EXECUTION
  delete process.env.CLAUDE_CODE_DISABLE_STREAMING_TOOL_EXECUTION
})

async function configureOpenAICompatibleProvider(): Promise<void> {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg._resetRayuConfigCache()
  cfg.upsertProvider({
    id: 'nvidia',
    kind: 'openai-compatible',
    apiKey: 'k',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'stepfun-ai/step-3.7-flash',
  })
}

describe('query config streaming tool execution', () => {
  test('OpenAI-compatible providers enable streaming tool execution by default', async () => {
    await configureOpenAICompatibleProvider()
    const { buildQueryConfig } = await import('../src/query/config.ts')
    expect(buildQueryConfig().gates.streamingToolExecution).toBe(true)
  })

  test('env opt-out disables streaming tool execution for OpenAI-compatible providers', async () => {
    await configureOpenAICompatibleProvider()
    process.env.RAYU_DISABLE_STREAMING_TOOL_EXECUTION = '1'
    const { buildQueryConfig } = await import('../src/query/config.ts')
    expect(buildQueryConfig().gates.streamingToolExecution).toBe(false)
  })
})
