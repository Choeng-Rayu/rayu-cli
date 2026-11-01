/**
 * Change detection outside git: the file scanner, and the tracker that lets checkpoints,
 * the verifier guard and the gate use it exactly as they use git snapshots.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  diffManifests,
  manifestId,
  recallManifest,
  rememberManifest,
  scanManifest,
  unpinManifest,
} from '../src/orchestrator/fileManifest.ts'
import { NO_RUN_WORKSPACE, type RunWorkspace } from '../src/orchestrator/runState.ts'
import { captureTree, changedPaths, snapshotTree } from '../src/orchestrator/treeTracker.ts'
import { runWithCwdOverride } from '../src/utils/cwd.ts'
import { prepareRunWorkspace, resolveProjectRoot } from '../src/orchestrator/runWorkspace.ts'

const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM, config: process.env.RAYU_CONFIG_DIR }
let scratch: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'rayu-manifest-'))
  writeFileSync(join(scratch, 'gitconfig'), '')
  process.env.GIT_CONFIG_GLOBAL = join(scratch, 'gitconfig')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.RAYU_CONFIG_DIR = join(scratch, 'config')
})

afterAll(() => {
  for (const [key, value] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_NOSYSTEM', saved.nosystem], ['RAYU_CONFIG_DIR', saved.config]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(scratch, { recursive: true, force: true })
})

function project(files: Record<string, string> = { 'src/a.ts': 'a\n', 'docs/readme.md': 'r\n' }): string {
  const dir = mkdtempSync(join(scratch, 'p-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

describe('scanning a directory', () => {
  test('lists project files, skips dependencies, build output and VCS data', async () => {
    const dir = project({
      'src/a.ts': 'a', 'node_modules/pkg/i.js': 'x', 'dist/out.js': 'x', '.git/HEAD': 'x',
      'web/.next/cache': 'x', 'web/src/b.ts': 'b', '__pycache__/c.pyc': 'x', 'plans/run.json': '{}',
    })
    const manifest = await scanManifest(dir, { excludePaths: ['plans'] })
    expect([...manifest!.keys()].sort()).toEqual(['src/a.ts', 'web/src/b.ts'])
  })

  test('the id changes with a file\u2019s size or time, a new file, or a removal, and not otherwise', async () => {
    const dir = project()
    const first = await scanManifest(dir)
    const again = await scanManifest(dir)
    expect(manifestId(again!)).toBe(manifestId(first!))

    writeFileSync(join(dir, 'src/a.ts'), 'a\nmore\n')
    const grown = await scanManifest(dir)
    expect(diffManifests(first!, grown!)).toEqual(['src/a.ts'])

    const sameSizeLater = join(dir, 'docs/readme.md')
    utimesSync(sameSizeLater, new Date(), new Date(Date.now() + 5_000))
    expect(diffManifests(grown!, (await scanManifest(dir))!)).toEqual(['docs/readme.md'])

    writeFileSync(join(dir, 'new.txt'), 'n')
    rmSync(join(dir, 'src/a.ts'))
    expect(diffManifests(grown!, (await scanManifest(dir))!)).toEqual(['docs/readme.md', 'new.txt', 'src/a.ts'])
  })

  test('gives up on a tree that is too large or takes too long, instead of stalling', async () => {
    const dir = project({ 'a/1': '1', 'a/2': '2', 'a/3': '3' })
    expect(await scanManifest(dir, { maxFiles: 2 })).toBeNull()
    expect(await scanManifest(dir, { maxMs: -1 })).toBeNull()
    expect(await scanManifest(join(dir, 'missing'))).toEqual(new Map())
  })

  test('remembered manifests are found by id; pinned ones survive eviction, others are dropped oldest first', async () => {
    const dir = project()
    const pinnedId = rememberManifest((await scanManifest(dir))!, true)
    for (let i = 0; i < 40; i++) rememberManifest(new Map([[`f${i}`, String(i)]]))
    expect(recallManifest(pinnedId)).toBeDefined()
    expect(recallManifest(manifestId(new Map([['f0', '0']])))).toBeUndefined()
    unpinManifest(pinnedId)
    for (let i = 40; i < 80; i++) rememberManifest(new Map([[`f${i}`, String(i)]]))
    expect(recallManifest(pinnedId)).toBeUndefined()
  })
})

describe('tracking a project outside git', () => {
  async function workspaceOf(dir: string): Promise<RunWorkspace> {
    const prepared = await runWithCwdOverride(dir, () => prepareRunWorkspace('run-1'))
    return prepared.workspace
  }

  test('the root is the directory the run starts in, and the baseline is a file manifest', async () => {
    const dir = project()
    expect(runWithCwdOverride(dir, () => resolveProjectRoot())).toBe(dir)
    const workspace = await workspaceOf(dir)
    expect(workspace).toMatchObject({ root: dir, tracking: 'files', repoRoot: null })
    expect(workspace.baseline?.commit).toBe(workspace.baseline?.tree)
  })

  test('changes since the baseline are listed, and the same state has the same id', async () => {
    const dir = project()
    const workspace = await workspaceOf(dir)
    const baseline = workspace.baseline!.commit
    expect(await captureTree(workspace)).toBe(baseline)

    writeFileSync(join(dir, 'src/b.ts'), 'b')
    const snapshot = await snapshotTree(workspace, 'checkpoint-1')
    expect(snapshot!.commit).not.toBe(baseline)
    expect(await changedPaths(workspace, baseline, snapshot!.commit)).toEqual(['src/b.ts'])
    expect(await captureTree(workspace)).toBe(snapshot!.commit)
  })

  test('a git project is tracked with git, and a workspace that cannot be tracked answers null', async () => {
    const repo = project()
    for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'i']]) {
      spawnSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } })
    }
    const workspace = await workspaceOf(repo)
    expect(workspace).toMatchObject({ root: repo, tracking: 'git', repoRoot: repo })
    const before = await captureTree(workspace)
    writeFileSync(join(repo, 'src/new.ts'), 'n')
    const snapshot = await snapshotTree(workspace, 'checkpoint-1')
    expect(await changedPaths(workspace, workspace.baseline!.commit, snapshot!.commit)).toEqual(['src/new.ts'])
    expect(await captureTree(workspace)).not.toBe(before)

    expect(await captureTree(NO_RUN_WORKSPACE)).toBeNull()
    expect(await snapshotTree(NO_RUN_WORKSPACE, 'x')).toBeNull()
    expect(await changedPaths(NO_RUN_WORKSPACE, 'a', 'b')).toBeNull()
    expect(await changedPaths(await workspaceOf(project()), 'files:unknown', 'files:other')).toBeNull()
  })
})
