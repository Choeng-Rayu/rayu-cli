import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Model-fidelity guarantee: the model the user selects must resolve to a wire
// id of the SAME Claude family. A family-crossing modelOverride (the exact
// misconfiguration that made a Sonnet selection route to Opus while still
// displaying "Sonnet 4.6") must be dropped, and reverse-resolution must report
// the ACTUAL model — never relabel an Opus id as Sonnet.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-fidelity-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

async function fresh() {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg._resetRayuConfigCache()
  const state = await import('../src/bootstrap/state.ts')
  state.resetModelStringsForTestingOnly()
  const ms = await import('../src/utils/model/modelStrings.ts')
  ms._resetModelOverrideFidelityWarningsForTesting()
}

describe('modelFamilyOf', () => {
  test('classifies canonical, bedrock/cross-region, alias, and non-Claude ids', async () => {
    const { modelFamilyOf } = await import('../src/utils/model/configs.ts')
    expect(modelFamilyOf('claude-sonnet-4-6')).toBe('sonnet')
    expect(modelFamilyOf('us.anthropic.claude-opus-4-6-v1')).toBe('opus')
    expect(modelFamilyOf('global.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
      'haiku',
    )
    expect(modelFamilyOf('opus')).toBe('opus')
    expect(modelFamilyOf('sonnet')).toBe('sonnet')
    expect(modelFamilyOf('haiku')).toBe('haiku')
    // Non-Claude / opaque ids carry no family constraint.
    expect(modelFamilyOf('deepseek-v4-pro')).toBe('other')
    expect(modelFamilyOf('my-custom-deployment-id')).toBe('other')
  })
})

describe('isFamilyConsistentOverride', () => {
  test('rejects a DEFINITE cross-family mapping (sonnet key -> opus value)', async () => {
    const { isFamilyConsistentOverride } = await import(
      '../src/utils/model/configs.ts'
    )
    expect(
      isFamilyConsistentOverride(
        'claude-sonnet-4-6',
        'us.anthropic.claude-opus-4-6-v1',
      ),
    ).toBe(false)
    expect(
      isFamilyConsistentOverride(
        'claude-opus-4-6',
        'global.anthropic.claude-sonnet-4-6-v1',
      ),
    ).toBe(false)
  })

  test('allows same-family and opaque (family-less) mappings', async () => {
    const { isFamilyConsistentOverride } = await import(
      '../src/utils/model/configs.ts'
    )
    // same family
    expect(
      isFamilyConsistentOverride(
        'claude-sonnet-4-6',
        'us.anthropic.claude-sonnet-4-6-v1:0',
      ),
    ).toBe(true)
    // opaque value (no family token) -> allowed (enterprise deployment id/ARN)
    expect(
      isFamilyConsistentOverride('claude-sonnet-4-6', 'my-opaque-deployment-id'),
    ).toBe(true)
  })
})

describe('applyModelOverrides model fidelity', () => {
  test('a Sonnet->Opus override is DROPPED; wire id stays Sonnet; display/canonical stay truthful', async () => {
    await fresh()
    const s = await import('../src/utils/settings/settings.ts')
    s.updateSettingsForSource('userSettings', {
      modelOverrides: { 'claude-sonnet-4-6': 'us.anthropic.claude-opus-4-6-v1' },
    })
    const ms = await import('../src/utils/model/modelStrings.ts')
    const model = await import('../src/utils/model/model.ts')

    // Sonnet selection must NOT resolve to an Opus wire id.
    expect(ms.getModelStrings().sonnet46).toBe('claude-sonnet-4-6')
    expect(ms.getModelStrings().sonnet46).not.toContain('opus')

    // Reverse-resolution must never relabel the Opus id as Sonnet.
    expect(model.getCanonicalName('us.anthropic.claude-opus-4-6-v1')).toBe(
      'claude-opus-4-6',
    )
    expect(
      model.getMarketingNameForModel('us.anthropic.claude-opus-4-6-v1'),
    ).toBe('Opus 4.6')
  })

  test('a same-family Sonnet override IS applied and reverse-resolves truthfully', async () => {
    await fresh()
    const s = await import('../src/utils/settings/settings.ts')
    s.updateSettingsForSource('userSettings', {
      modelOverrides: { 'claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6-v1:0' },
    })
    const ms = await import('../src/utils/model/modelStrings.ts')
    const model = await import('../src/utils/model/model.ts')
    expect(ms.getModelStrings().sonnet46).toBe('us.anthropic.claude-sonnet-4-6-v1:0')
    expect(model.getCanonicalName('us.anthropic.claude-sonnet-4-6-v1:0')).toBe(
      'claude-sonnet-4-6',
    )
  })

  test('an opaque (family-less) override IS applied (enterprise deployment id)', async () => {
    await fresh()
    const opaque =
      'arn:aws:bedrock:us-east-1:123:application-inference-profile/abc123'
    const s = await import('../src/utils/settings/settings.ts')
    s.updateSettingsForSource('userSettings', {
      modelOverrides: { 'claude-sonnet-4-6': opaque },
    })
    const ms = await import('../src/utils/model/modelStrings.ts')
    expect(ms.getModelStrings().sonnet46).toBe(opaque)
  })
})
