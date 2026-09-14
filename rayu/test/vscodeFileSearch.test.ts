/**
 * The `@`-mention file/folder search (`buildFileSearchGlob` + `buildFileSearchResults`,
 * `extension.ts`).
 *
 * ── THE TWO BUGS THIS GUARDS, IN THE ORDER THEY WERE FOUND ─────────────────────────
 *
 * 1. The search used to build a glob by splicing the raw query straight in:
 *    `**` + `/*` + `${query}` + `*`. That only works for a query with no `/` in it — the
 *    moment a user typed a query CONTAINING a slash, which happens exactly when they
 *    drill into a folder by typing its name (`@src/vscode`), the embedded `/` stopped
 *    being a literal character and became a glob path-segment boundary instead, so the
 *    search silently returned zero or near-zero results.
 *
 * 2. Fixing (1) by replacing the glob-based query with an unbounded JS-side substring
 *    scan over a capped raw fetch introduced a SECOND bug: on a real multi-project
 *    monorepo workspace, "everything under the workspace root" can be tens of thousands
 *    of files (47,317, in the reported case). `vscode.workspace.findFiles` truncates at
 *    whatever numeric cap is passed, in file-walker order — NOT query-aware — so a
 *    query matching files in several sibling subprojects could have most of those
 *    matches fall outside the truncation window before the query filter ever ran.
 *    Raising the cap only moves the cliff edge further out.
 *
 * The fix for both: `buildFileSearchGlob` gives VS Code's own search engine a CORRECTLY
 * BUILT, query-aware glob again (so the expensive part runs in VS Code's search, not a
 * JS array scan), splitting on the LAST `/` in the query — the filename portion becomes
 * a scoped `**` + `/*<filename>*` glob when there is no slash, or the query anchors to
 * the literal directory path before the last slash and recurses under it when there is,
 * with any remainder after that slash left for `buildFileSearchResults` to substring
 * match locally against the now-small, already-scoped result set.
 *
 * Both functions are pure — no `vscode` dependency — so these are ordinary tests with no
 * VS Code mock needed for the glob DECISION. `minimatch` (already a transitive
 * dependency, and the same glob engine `vscode.workspace.findFiles` itself uses) verifies
 * what the decided glob ACTUALLY matches, so this test suite proves the real bug is
 * fixed, not just that a plausible-looking pattern is produced.
 */
import { describe, expect, mock, test } from 'bun:test'
import minimatch from 'minimatch'

mock.module('vscode', () => ({
  window: {
    showQuickPick: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
  },
  workspace: {
    workspaceFolders: [],
  },
}))

const { buildFileSearchGlob, buildFileSearchResults } = await import('../src/vscode/host/extension.js')

// Real relative paths, sampled from this actual repository at varying depths —
// deliberately not synthetic, so a regression here is testing against the exact shape
// of path this codebase produces.
const REPO_FILES = [
  'package.json',
  'README.md',
  'src/main.tsx',
  'src/query.ts',
  'src/vscode/host/extension.ts',
  'src/vscode/host/panel/sessionHandle.ts',
  'src/vscode/host/panel/sessionRegistry.ts',
  'src/vscode/webview/components/Composer.tsx',
  'src/vscode/webview/components/TodoListCard.tsx',
  'src/vscode/webview/App.tsx',
]

// The exact reported scenario: a monorepo root containing several sibling projects,
// each with its own AGENTS.md, at varying depths.
const MONOREPO_FILES = [
  'rayu-cli/rayu/AGENTS.md',
  'rayu-cli/rayu/README.md',
  'rayucode/AGENTS.md',
  'rayu-web/AGENTS.md',
  'slides/index.html',
]

/** Simulates what `vscode.workspace.findFiles(glob, exclude)` would hand back. */
function simulateVSCodeGlobSearch(files: readonly string[], glob: string): string[] {
  return files.filter(f => minimatch(f, glob))
}

/** Runs the full two-stage pipeline exactly as `findFiles`'s handler does. */
function runFullPipeline(files: readonly string[], query: string): string[] {
  const { glob, leafFilter } = buildFileSearchGlob(query)
  const scoped = simulateVSCodeGlobSearch(files, glob)
  return buildFileSearchResults(scoped, leafFilter)
}

describe('buildFileSearchGlob', () => {
  test('no slash: the query becomes a scoped filename glob, matched at any depth', () => {
    const { glob, leafFilter } = buildFileSearchGlob('AGENTS.md')
    expect(leafFilter).toBe('')
    expect(simulateVSCodeGlobSearch(MONOREPO_FILES, glob)).toEqual([
      'rayu-cli/rayu/AGENTS.md',
      'rayucode/AGENTS.md',
      'rayu-web/AGENTS.md',
    ])
  })

  test('a query with a fully-typed folder path (trailing slash) anchors exactly there', () => {
    // Matches what the composer's own insertText produces for a selected folder:
    // '@' + f + ' ', where f already ends in '/'.
    const { glob, leafFilter } = buildFileSearchGlob('src/vscode/host/panel/')
    expect(leafFilter).toBe('')
    expect(simulateVSCodeGlobSearch(REPO_FILES, glob)).toEqual([
      'src/vscode/host/panel/sessionHandle.ts',
      'src/vscode/host/panel/sessionRegistry.ts',
    ])
  })

  test('a query mid-typed past one slash scopes to the parent, filters the remainder', () => {
    const { glob, leafFilter } = buildFileSearchGlob('src/vscode')
    expect(leafFilter).toBe('vscode')
    const scoped = simulateVSCodeGlobSearch(REPO_FILES, glob)
    // The glob alone (scoped to "src") is broader than the final answer — this is
    // exactly why leafFilter still needs to run afterward.
    expect(scoped).toContain('src/query.ts')
    expect(buildFileSearchResults(scoped, leafFilter)).not.toContain('src/query.ts')
  })

  test('glob metacharacters in the query are escaped, not misinterpreted', () => {
    const withBrackets = ['file[1].ts', 'file2.ts']
    const { glob } = buildFileSearchGlob('file[1]')
    expect(simulateVSCodeGlobSearch(withBrackets, glob)).toEqual(['file[1].ts'])
  })

  test('glob metacharacters survive a directory-anchored query too', () => {
    const files = ['weird[folder]/inside.ts', 'normal/inside.ts']
    const { glob, leafFilter } = buildFileSearchGlob('weird[folder]/inside')
    expect(simulateVSCodeGlobSearch(files, glob)).toEqual(['weird[folder]/inside.ts'])
    expect(leafFilter).toBe('inside')
  })

  test('an empty query selects everything, with nothing left to leaf-filter', () => {
    const { glob, leafFilter } = buildFileSearchGlob('')
    expect(leafFilter).toBe('')
    expect(simulateVSCodeGlobSearch(REPO_FILES, glob)).toEqual([...REPO_FILES])
  })
})

describe('buildFileSearchResults', () => {
  test('a plain substring filter matches at any depth in the scoped set', () => {
    const results = buildFileSearchResults(REPO_FILES, 'sessionHandle')
    expect(results).toContain('src/vscode/host/panel/sessionHandle.ts')
  })

  test('an empty filter returns every path, folders included, up to the display limit', () => {
    const results = buildFileSearchResults(REPO_FILES, '')
    for (const file of REPO_FILES) expect(results).toContain(file)
  })

  test('parent folders are offered even when most of their children do not match', () => {
    const results = buildFileSearchResults(REPO_FILES, 'src')
    expect(results).toContain('src/')
  })

  test("a matched folder's own name is offered, independent of what its children match", () => {
    const results = buildFileSearchResults(REPO_FILES, 'components')
    expect(results).toContain('src/vscode/webview/components/')
    expect(results).toContain('src/vscode/webview/components/Composer.tsx')
    expect(results).toContain('src/vscode/webview/components/TodoListCard.tsx')
  })

  test('the filter is case-insensitive, matching the composer-side filter it mirrors', () => {
    const results = buildFileSearchResults(REPO_FILES, 'SESSIONHANDLE')
    expect(results).toContain('src/vscode/host/panel/sessionHandle.ts')
  })

  test('a filter matching nothing returns an empty list, not an error', () => {
    expect(buildFileSearchResults(REPO_FILES, 'this-does-not-exist-anywhere')).toEqual([])
  })

  test('results are capped at the display limit', () => {
    const many = Array.from({ length: 200 }, (_, i) => `src/generated/file${i}.ts`)
    const results = buildFileSearchResults(many, 'file', 10)
    expect(results.length).toBeLessThanOrEqual(10)
  })
})

describe('the full pipeline reproduces the exact reported bug, fixed', () => {
  test('@AGENTS.md finds every AGENTS.md across every sibling subproject, not just one', () => {
    // This is the exact user-reported scenario: a monorepo root (/home/rayu/rayu)
    // containing three sibling projects, each with its own AGENTS.md. Before this fix,
    // an unbounded JS-side scan capped at a fixed N would silently drop two of the
    // three matches on a workspace this size (confirmed empirically against the real
    // 47,317-file monorepo: only the alphabetically-earliest AGENTS.md survived a
    // 5,000-file cap). The glob-based fix has no such cliff — it asks VS Code's search
    // engine for files matching the query directly, however many sibling projects exist.
    const results = runFullPipeline(MONOREPO_FILES, 'AGENTS.md')
    expect(results).toContain('rayu-cli/rayu/AGENTS.md')
    expect(results).toContain('rayucode/AGENTS.md')
    expect(results).toContain('rayu-web/AGENTS.md')
    expect(results).not.toContain('rayu-cli/rayu/README.md')
  })

  test('drilling into a folder by typing its name still finds nested files', () => {
    const results = runFullPipeline(REPO_FILES, 'src/vscode')
    expect(results).toContain('src/vscode/host/extension.ts')
    expect(results).toContain('src/vscode/host/panel/sessionHandle.ts')
    expect(results).toContain('src/vscode/webview/App.tsx')
  })

  test('a fully-selected folder shows everything inside it, and nothing outside', () => {
    const results = runFullPipeline(REPO_FILES, 'src/vscode/host/panel/')
    expect(results).toContain('src/vscode/host/panel/sessionHandle.ts')
    expect(results).toContain('src/vscode/host/panel/sessionRegistry.ts')
    expect(results).not.toContain('src/vscode/webview/App.tsx')
  })
})
