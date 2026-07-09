import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildInheritedEnvVars } from '../src/utils/swarm/spawnUtils.ts'

// External agent-aware CLIs (e.g. `npx skills add …`, which uses
// @vercel/detect-agent) must detect Rayu as "rayu", not "claude".
// detect-agent reads AI_AGENT *before* CLAUDECODE, so Rayu sets AI_AGENT=rayu
// in every subprocess env alongside the legacy CLAUDECODE=1 hint signal.

describe('external agent detection identifies Rayu', () => {
  test('teammate/swarm spawn env sets AI_AGENT=rayu', () => {
    const env = buildInheritedEnvVars()
    expect(env).toContain('AI_AGENT=rayu')
    // CLAUDECODE stays for the CLI hint protocol; AI_AGENT wins in detect-agent.
    expect(env).toContain('CLAUDECODE=1')
  })

  test('the Bash shell + snapshot envs inject AI_AGENT=rayu next to CLAUDECODE', () => {
    const shell = readFileSync(
      join(import.meta.dir, '..', 'src', 'utils', 'Shell.ts'),
      'utf8',
    )
    expect(shell).toContain("AI_AGENT: 'rayu'")
    const snap = readFileSync(
      join(import.meta.dir, '..', 'src', 'utils', 'bash', 'ShellSnapshot.ts'),
      'utf8',
    )
    expect(snap).toContain("AI_AGENT: 'rayu'")
  })
})
