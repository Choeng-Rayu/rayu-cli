import { afterEach, describe, expect, test } from 'bun:test'

import { subprocessEnv } from '../src/utils/subprocessEnv.ts'

const ORIGINAL = {
  scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
  rayu: process.env.RAYU_API_KEY,
  inputRayu: process.env.INPUT_RAYU_API_KEY,
}

afterEach(() => {
  restore('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', ORIGINAL.scrub)
  restore('RAYU_API_KEY', ORIGINAL.rayu)
  restore('INPUT_RAYU_API_KEY', ORIGINAL.inputRayu)
})

describe('GitHub Actions subprocess environment', () => {
  test('removes Rayu credentials and their action-input duplicate', () => {
    process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1'
    process.env.RAYU_API_KEY = 'rayu-secret'
    process.env.INPUT_RAYU_API_KEY = 'duplicated-action-input'

    const env = subprocessEnv()

    expect(env.RAYU_API_KEY).toBeUndefined()
    expect(env.INPUT_RAYU_API_KEY).toBeUndefined()
    expect(process.env.RAYU_API_KEY).toBe('rayu-secret')
  })
})

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
