import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runWithCwdOverride } from '../src/utils/cwd.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-mem-'))
  process.env.RAYU_CONFIG_DIR = join(dir, '.rayu-cfg')
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

describe('isMemoryFilePath recognizes Rayu memory filenames', () => {
  test('RAYU.md / AGENTS.md and local + rules variants are memory files', async () => {
    const { isMemoryFilePath } = await import('../src/utils/claudemd.ts')
    for (const name of ['RAYU.md', 'AGENTS.md']) {
      expect(isMemoryFilePath(join('/x/y', name))).toBe(true)
    }
    expect(isMemoryFilePath('/x/y/RAYU.local.md')).toBe(true)
    for (const cfg of ['.rayu', '.agents']) {
      expect(isMemoryFilePath(join('/x/y', cfg, 'rules', 'style.md'))).toBe(true)
    }
    expect(isMemoryFilePath('/x/y/CLAUDE.md')).toBe(false)
    expect(isMemoryFilePath('/x/y/CLAUDE.local.md')).toBe(false)
    expect(isMemoryFilePath('/x/y/.claude/rules/style.md')).toBe(false)
    // negatives
    expect(isMemoryFilePath('/x/y/README.md')).toBe(false)
    expect(isMemoryFilePath('/x/y/notes.md')).toBe(false)
  })
})

describe('nested-directory memory loading covers RAYU.md / AGENTS.md', () => {
  test('getMemoryFilesForNestedDirectory loads Rayu project memory files', async () => {
    writeFileSync(join(dir, 'RAYU.md'), '# rayu rules\nuse bun')
    writeFileSync(join(dir, 'CLAUDE.md'), '# claude rules\nbe terse')
    writeFileSync(join(dir, 'AGENTS.md'), '# agents rules\nrun tests')
    mkdirSync(join(dir, '.rayu', 'rules'), { recursive: true })
    writeFileSync(join(dir, '.rayu', 'rules', 'extra.md'), '# extra rule')

    const m = await import('../src/utils/claudemd.ts')
    const files = await m.getMemoryFilesForNestedDirectory(
      dir,
      join(dir, 'src', 'index.ts'),
      new Set<string>(),
    )
    const names = files.map(f => f.path.split('/').pop())
    expect(names).toContain('RAYU.md')
    expect(names).toContain('AGENTS.md')
    expect(names).toContain('extra.md')
    expect(names).not.toContain('CLAUDE.md')
  })
})

describe('/init auto-creates RAYU.md', () => {
  async function runInit(): Promise<void> {
    const initCmd = (await import('../src/commands/init.ts')).default as any
    await runWithCwdOverride(dir, async () => {
      await initCmd.getPromptForCommand()
    })
  }

  test('creates RAYU.md with content when no memory file exists', async () => {
    await runInit()
    const path = join(dir, 'RAYU.md')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('# RAYU.md')
  })

  test('does not clobber an existing RAYU.md', async () => {
    writeFileSync(join(dir, 'RAYU.md'), '# existing rayu rules')
    await runInit()
    expect(readFileSync(join(dir, 'RAYU.md'), 'utf8')).toBe('# existing rayu rules')
  })
})

describe('real getMemoryFiles + getClaudeMds surface RAYU.md content', () => {
  test('User-scope RAYU.md and AGENTS.md are loaded and injected with a header naming them', async () => {
    // RAYU_CONFIG_DIR points at an isolated temp dir (set in beforeEach); write
    // User-scope memory files there and exercise the real loader + formatter.
    const cfg = process.env.RAYU_CONFIG_DIR as string
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, 'RAYU.md'), 'RAYU_MARKER: prefer bun')
    writeFileSync(join(cfg, 'AGENTS.md'), 'AGENTS_MARKER: run tests')

    const m = await import('../src/utils/claudemd.ts')
    m.resetGetMemoryFilesCache()
    const files = await m.getMemoryFiles()
    type LoadedMemoryFile = Awaited<ReturnType<typeof m.getMemoryFiles>>[number]

    const userPaths = files
      .filter((f: LoadedMemoryFile) => f.type === 'User')
      .map((f: LoadedMemoryFile) => f.path.split('/').pop())
    expect(userPaths).toContain('RAYU.md')
    expect(userPaths).toContain('AGENTS.md')

    const injected = m.getClaudeMds(files)
    expect(injected).toContain('RAYU_MARKER: prefer bun')
    expect(injected).toContain('AGENTS_MARKER: run tests')
    expect(injected).toContain('RAYU.md / AGENTS.md')
    m.resetGetMemoryFilesCache()
  })
})
