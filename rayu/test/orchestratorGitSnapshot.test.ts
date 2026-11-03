/**
 * Task 8: working-tree snapshots for Orchestrator runs. They must capture untracked
 * files, skip ignored files and agent worktrees, keep bytes exact, and leave the user's
 * index, HEAD, branch and stash exactly as they were.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteSnapshotRefs,
  diffTrees,
  isLfsPointer,
  isSpecialMode,
  lfsFilteredPaths,
  parseRawDiff,
  readBlob,
  readBlobsForCheckout,
  refComponent,
  snapshotRefPrefix,
  snapshotWorkingTree,
  treeWithEntriesFrom,
} from '../src/orchestrator/gitSnapshot.ts'
import { runGitBinary } from '../src/utils/git/gitBinary.ts'

const savedEnv = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM }
let scratch: string
let repo: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'rayu-git-snapshot-'))
  // Hermetic git: no user or system config (autocrlf, signing, hooks paths).
  const emptyConfig = join(scratch, 'gitconfig')
  writeFileSync(emptyConfig, '')
  process.env.GIT_CONFIG_GLOBAL = emptyConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})

afterAll(() => {
  for (const [key, value] of [['GIT_CONFIG_GLOBAL', savedEnv.global], ['GIT_CONFIG_NOSYSTEM', savedEnv.nosystem]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(scratch, { recursive: true, force: true })
})

function git(...args: string[]): string {
  const out = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' },
  })
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`)
  return out.stdout
}

function write(path: string, content: string | Buffer): void {
  mkdirSync(join(repo, path, '..'), { recursive: true })
  writeFileSync(join(repo, path), content)
}

beforeEach(() => {
  repo = mkdtempSync(join(scratch, 'repo-'))
  git('init', '-q', '-b', 'main')
  write('.gitignore', 'node_modules/\n')
  write('src/user.ts', 'export type User = { id: string }\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

const PREFIX = snapshotRefPrefix('brave-new-slug', 'run-1')

describe('snapshotWorkingTree', () => {
  test('captures staged, unstaged and untracked changes; skips ignored files and worktrees', async () => {
    write('src/user.ts', 'export type User = { id: string; displayName: string }\n')
    write('src/new.ts', 'export const x = 1\n')
    write('node_modules/pkg/index.js', 'ignored\n')
    write('.rayu/worktrees/agent-a/src/user.ts', 'worker copy\n')
    write('staged.txt', 'staged\n')
    git('add', 'staged.txt')
    const snapshot = await snapshotWorkingTree({ repoRoot: repo, refPrefix: PREFIX, label: 'baseline' })
    const files = git('ls-tree', '-r', '--name-only', snapshot.commit).trim().split('\n').sort()
    expect(files).toEqual(['.gitignore', 'src/new.ts', 'src/user.ts', 'staged.txt'])
    expect(git('show', `${snapshot.commit}:src/user.ts`)).toContain('displayName')
    expect(git('rev-parse', `${PREFIX}/baseline`).trim()).toBe(snapshot.commit)
    expect(git('rev-parse', `${snapshot.commit}^`).trim()).toBe(git('rev-parse', 'HEAD').trim())
  })

  test('leaves the index, HEAD, branch and stash untouched', async () => {
    write('src/user.ts', 'changed\n')
    write('untracked.txt', 'u\n')
    const before = { status: git('status', '--porcelain=v1', '-uall'), head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), staged: git('diff', '--cached', '--name-only') }
    await snapshotWorkingTree({ repoRoot: repo, refPrefix: PREFIX, label: 'baseline' })
    expect({ status: git('status', '--porcelain=v1', '-uall'), head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), staged: git('diff', '--cached', '--name-only') }).toEqual(before)
    expect(git('stash', 'list')).toBe('')
  })

  test('works in a repository with no commits yet', async () => {
    rmSync(repo, { recursive: true, force: true })
    repo = mkdtempSync(join(scratch, 'empty-'))
    git('init', '-q', '-b', 'main')
    write('a.txt', 'a\n')
    const snapshot = await snapshotWorkingTree({ repoRoot: repo, refPrefix: PREFIX, label: 'baseline' })
    expect(git('ls-tree', '-r', '--name-only', snapshot.commit).trim()).toBe('a.txt')
  })

  test('honors extra excluded paths', async () => {
    write('plans/run-1/run.json', '{}\n')
    const snapshot = await snapshotWorkingTree({ repoRoot: repo, refPrefix: PREFIX, label: 'baseline', excludePaths: ['plans'] })
    expect(git('ls-tree', '-r', '--name-only', snapshot.commit)).not.toContain('plans/')
  })

  test('sees a same-size edit made in the same second as the last git add', async () => {
    // Same size, same inode, same mtime second: only git's racy-clean check catches
    // it, and that check needs the copied index to keep the original's mtime.
    write('src/user.ts', 'export type User = { id: string }\n')
    git('add', 'src/user.ts')
    write('src/user.ts', 'export type User = { id: number }\n')
    const snapshot = await snapshotWorkingTree({ repoRoot: repo, refPrefix: PREFIX, label: 'baseline' })
    expect(git('show', `${snapshot.commit}:src/user.ts`)).toBe('export type User = { id: number }\n')
  })
})

describe('building trees', () => {
  test('treeWithEntriesFrom puts chosen paths back to another tree, removing ones it lacks', async () => {
    const before = await snapshotWorkingTree({ repoRoot: repo, refPrefix: PREFIX, label: 'baseline' })
    write('src/user.ts', 'changed\n')
    write('src/added.ts', 'added\n')
    write('src/kept.ts', 'kept\n')
    const after = await snapshotWorkingTree({ repoRoot: repo, refPrefix: PREFIX, label: 'checkpoint-1' })
    const mixed = await treeWithEntriesFrom(repo, after.tree, before.tree, ['src/user.ts', 'src/added.ts'])
    expect(git('ls-tree', '-r', '--name-only', mixed).trim().split('\n').sort()).toEqual(['.gitignore', 'src/kept.ts', 'src/user.ts'])
    expect(git('cat-file', '-p', `${mixed}:src/user.ts`)).toBe('export type User = { id: string }\n')
    expect(await treeWithEntriesFrom(repo, after.tree, before.tree, [])).toBe(after.tree)
  })

  test('readBlobsForCheckout returns checkout content, line-ending conversion applied', async () => {
    write('.gitattributes', '*.bat text eol=crlf\n')
    write('run.bat', 'echo a\r\necho b\r\n')
    const snapshot = await snapshotWorkingTree({ repoRoot: repo, refPrefix: PREFIX, label: 'baseline' })
    const changes = await diffTrees(repo, git('rev-parse', 'HEAD').trim(), snapshot.commit)
    const bat = changes.find(change => change.path === 'run.bat')!
    expect((await readBlob(repo, bat.newBlob)).toString('utf8')).toBe('echo a\necho b\n')
    const empty = changes.find(change => change.path === '.gitattributes')!
    const read = await readBlobsForCheckout(repo, [{ blob: bat.newBlob, path: 'run.bat' }, { blob: empty.newBlob, path: '.gitattributes' }])
    expect(read.get('run.bat')!.toString('utf8')).toBe('echo a\r\necho b\r\n')
    expect(read.get('.gitattributes')!.toString('utf8')).toBe('*.bat text eol=crlf\n')
  })
})

describe('diffs and blobs', () => {
  test('diffTrees lists what changed between two snapshots, with modes', async () => {
    const before = await snapshotWorkingTree({ repoRoot: repo, refPrefix: PREFIX, label: 'baseline' })
    write('src/user.ts', 'export type User = { id: string; displayName: string }\n')
    write('src/api.ts', 'export {}\n')
    rmSync(join(repo, '.gitignore'))
    const after = await snapshotWorkingTree({ repoRoot: repo, refPrefix: PREFIX, label: 'checkpoint-1' })
    const changes = await diffTrees(repo, before.commit, after.commit)
    expect(changes.map(change => [change.status, change.path]).sort()).toEqual([
      ['added', 'src/api.ts'],
      ['deleted', '.gitignore'],
      ['modified', 'src/user.ts'],
    ])
    expect(changes.find(change => change.path === 'src/api.ts')?.newMode).toBe('100644')
    expect(await diffTrees(repo, before.commit, after.commit, ['src/api.ts'])).toHaveLength(1)
  })

  test('readBlob returns exact bytes: trailing newlines, CRLF and binary data', async () => {
    const binary = Buffer.from([0, 255, 10, 13, 10, 0])
    write('crlf.txt', 'a\r\nb\r\n\n')
    write('bin.dat', binary)
    const snapshot = await snapshotWorkingTree({ repoRoot: repo, refPrefix: PREFIX, label: 'baseline' })
    const changes = await diffTrees(repo, git('rev-parse', 'HEAD').trim(), snapshot.commit)
    const blobOf = (path: string) => changes.find(change => change.path === path)!.newBlob
    expect((await readBlob(repo, blobOf('crlf.txt'))).toString('utf8')).toBe('a\r\nb\r\n\n')
    expect((await readBlob(repo, blobOf('bin.dat'))).equals(binary)).toBe(true)
  })

  test('parseRawDiff handles paths with spaces and unusual characters', () => {
    const raw = Buffer.from(':100644 100644 aaa bbb M\0src/a b.ts\0:000000 120000 000 ccc A\0link\0')
    expect(parseRawDiff(raw)).toEqual([
      { status: 'modified', path: 'src/a b.ts', oldMode: '100644', newMode: '100644', oldBlob: 'aaa', newBlob: 'bbb' },
      { status: 'added', path: 'link', oldMode: '000000', newMode: '120000', oldBlob: '000', newBlob: 'ccc' },
    ])
    expect(isSpecialMode('120000')).toBe(true)
    expect(isSpecialMode('160000')).toBe(true)
    expect(isSpecialMode('100755')).toBe(false)
  })

  test('LFS pointers and LFS-filtered paths are recognized', async () => {
    expect(isLfsPointer(Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n'))).toBe(true)
    expect(isLfsPointer(Buffer.from('plain text'))).toBe(false)
    write('.gitattributes', '*.psd filter=lfs diff=lfs merge=lfs -text\n')
    expect([...(await lfsFilteredPaths(repo, ['art/logo.psd', 'src/user.ts']))]).toEqual(['art/logo.psd'])
  })
})

describe('refs', () => {
  test('ref components are valid git ref names', async () => {
    expect(refComponent('run 1/../x.lock')).toBe('run-1-.-x-lock')
    expect(refComponent('...')).toBe('x')
    const check = await runGitBinary(['check-ref-format', `refs/rayu/${refComponent('..weird..name.lock')}`], { cwd: repo })
    expect(check.code).toBe(0)
  })

  test('deleteSnapshotRefs removes a run\u2019s refs and nothing else', async () => {
    await snapshotWorkingTree({ repoRoot: repo, refPrefix: PREFIX, label: 'baseline' })
    const other = snapshotRefPrefix('brave-new-slug', 'run-2')
    await snapshotWorkingTree({ repoRoot: repo, refPrefix: other, label: 'baseline' })
    await deleteSnapshotRefs(repo, PREFIX)
    const refs = git('for-each-ref', '--format=%(refname)', 'refs/rayu/').trim().split('\n')
    expect(refs).toEqual([`${other}/baseline`])
    // Deleting an empty prefix is a no-op.
    await deleteSnapshotRefs(repo, PREFIX)
  })
})
