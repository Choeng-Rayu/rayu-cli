import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { classify, classifyAll } from '../scripts/origin-manifest.ts'

// Coverage guarantee for the module-origin manifest: every source file must be
// classified, and the committed ORIGIN_MANIFEST.md must be current.

describe('module origin manifest', () => {
  test('every src file is classified into exactly one provenance bucket', () => {
    const { files, byBucket } = classifyAll()
    const valid = ['ORIGINAL', 'GENERATED', 'DERIVATIVE'] as const
    for (const f of files) {
      expect(valid).toContain(classify(f))
    }
    const bucketed =
      byBucket.ORIGINAL.length +
      byBucket.GENERATED.length +
      byBucket.DERIVATIVE.length
    expect(bucketed).toBe(files.length)
    expect(files.length).toBeGreaterThan(0)
  })

  test('ORIGINAL captures first-party features; core stays DERIVATIVE', () => {
    const original = classifyAll().byBucket.ORIGINAL.join('\n')
    expect(original).toMatch(/utils\/swarm\//)
    expect(original).toMatch(/tools\/ImageGenTool\//)
    expect(original).toMatch(/tools\/VideoGenTool\//)
    expect(original).toMatch(/telegram\//)
    // Core engine files must not be misclassified as first-party.
    expect(classify('query.ts')).toBe('DERIVATIVE')
    expect(classify('QueryEngine.ts')).toBe('DERIVATIVE')
    expect(classify('types/generated/events_mono/common/v1/auth.ts')).toBe(
      'GENERATED',
    )
  })

  test('ORIGIN_MANIFEST.md exists, records a file count, and carries the legal caveat', () => {
    const manifest = join(import.meta.dir, '..', 'ORIGIN_MANIFEST.md')
    expect(existsSync(manifest)).toBe(true)
    const src = readFileSync(manifest, 'utf8')
    const m = src.match(/ORIGIN_MANIFEST_FILE_COUNT:\s*(\d+)/)
    expect(m).not.toBeNull()
    // Recorded count must be populated. Exact-count freshness is enforced
    // on demand by `bun run scripts/origin-manifest.ts --check` (not gated in
    // the always-on suite, since the working tree may gain unrelated files
    // between regenerations).
    expect(parseInt(m![1], 10)).toBeGreaterThan(0)
    expect(src).toContain('not legal advice')
  })
})
