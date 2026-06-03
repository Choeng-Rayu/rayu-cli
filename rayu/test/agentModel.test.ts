import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-agent-model-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.RAYU_OPENAI_COMPATIBLE
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
})

async function fresh() {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg._resetRayuConfigCache()
  return cfg
}

describe('agent model resolution', () => {
  test('first-party resolution', async () => {
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    const res = getAgentModel('haiku', 'claude-sonnet-4-6')
    expect(res).toContain('haiku')
  })

  test('openai-compatible provider resolution for aliases', async () => {
    const cfg = await fresh()
    cfg.upsertProvider({
      id: 'nvidia',
      kind: 'openai-compatible',
      apiKey: 'k',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      defaultModel: 'meta/llama-3.3-70b-instruct',
      smallFastModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
    })

    const { getAgentModel } = await import('../src/utils/model/agent.ts')

    // 'haiku' maps to smallFastModel
    expect(getAgentModel('haiku', 'meta/llama-3.3-70b-instruct')).toBe('nvidia/llama-3.1-nemotron-70b-instruct')

    // 'sonnet' maps to parentModel
    expect(getAgentModel('sonnet', 'meta/llama-3.3-70b-instruct')).toBe('meta/llama-3.3-70b-instruct')

    // 'inherit' maps to parentModel
    expect(getAgentModel('inherit', 'meta/llama-3.3-70b-instruct')).toBe('meta/llama-3.3-70b-instruct')

    // custom models are preserved as-is
    expect(getAgentModel('my-special-llm', 'meta/llama-3.3-70b-instruct')).toBe('my-special-llm')
  })

  test('openai-compatible with global override CLAUDE_CODE_SUBAGENT_MODEL', async () => {
    const cfg = await fresh()
    cfg.upsertProvider({
      id: 'nvidia',
      kind: 'openai-compatible',
      apiKey: 'k',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      defaultModel: 'meta/llama-3.3-70b-instruct',
      smallFastModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
    })

    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'haiku'
    const { getAgentModel } = await import('../src/utils/model/agent.ts')

    expect(getAgentModel('sonnet', 'meta/llama-3.3-70b-instruct')).toBe('nvidia/llama-3.1-nemotron-70b-instruct')
  })
})
