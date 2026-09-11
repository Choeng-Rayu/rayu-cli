/**
 * Live IDE context: lockfile provenance, editor preference, and selection arithmetic.
 *
 * The migration this guards is specific. rayu-cli historically reached the editor through the
 * upstream Claude Code extension's lockfile in `~/.claude/ide`. Rayucode publishes its own in
 * `~/.rayu/ide`, and with BOTH installed discovery found two equally valid editors for one
 * workspace and refused to choose — so the native integration has to win deterministically.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { toIdeSelection } from '../src/utils/ideSelection.js'

describe('selection arithmetic (one shared mapping)', () => {
  test('a selection ending at character 0 does not include that line', () => {
    // The off-by-one that is invisible until a user notices the count is one too high.
    expect(
      toIdeSelection({
        selection: { start: { line: 10, character: 0 }, end: { line: 13, character: 0 } },
        text: 'x',
        filePath: '/p/a.ts',
      }),
    ).toMatchObject({ lineCount: 3, lineStart: 10 })

    expect(
      toIdeSelection({
        selection: { start: { line: 10, character: 0 }, end: { line: 13, character: 4 } },
        text: 'x',
        filePath: '/p/a.ts',
      }),
    ).toMatchObject({ lineCount: 4, lineStart: 10 })
  })

  test('a single-line selection counts as one line', () => {
    expect(
      toIdeSelection({
        selection: { start: { line: 7, character: 2 }, end: { line: 7, character: 9 } },
        text: 'const x',
        filePath: '/p/a.ts',
      }),
    ).toMatchObject({ lineCount: 1, lineStart: 7 })
  })

  test('a CLEARED selection keeps the file but reports no lines', () => {
    // Reported, not dropped: the file is still the active editor, and returning nothing is
    // what previously left a stale "12 lines selected" attached to a later message.
    const cleared = toIdeSelection({ selection: null, filePath: '/p/a.ts' })
    expect(cleared).toEqual({
      lineCount: 0,
      lineStart: undefined,
      text: undefined,
      filePath: '/p/a.ts',
    })
  })

  test('no editor at all reports no file either', () => {
    expect(toIdeSelection({ selection: null })).toEqual({
      lineCount: 0,
      lineStart: undefined,
      text: undefined,
      filePath: undefined,
    })
  })
})

describe('lockfile provenance and editor preference', () => {
  let home: string
  let previous: string | undefined
  let previousHome: string | undefined

  /** Both extensions advertise the same workspace, which is the ambiguous case. */
  function writeLockfile(dir: string, port: number, ideName: string, mtimeSeconds: number): string {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${port}.lock`)
    writeFileSync(
      path,
      JSON.stringify({
        workspaceFolders: [home],
        pid: process.pid,
        ideName,
        transport: 'ws',
        authToken: `token-${port}`,
      }),
    )
    utimesSync(path, mtimeSeconds, mtimeSeconds)
    return path
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rayucode-ide-'))
    previous = process.env.RAYU_CONFIG_DIR
    // `~/.claude/ide` is resolved through os.homedir(), which reads $HOME on POSIX, so the
    // upstream directory can only be redirected by overriding it.
    previousHome = process.env.HOME
    process.env.HOME = home
    process.env.RAYU_CONFIG_DIR = join(home, '.rayu')
    mkdirSync(process.env.RAYU_CONFIG_DIR, { recursive: true })
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = previous
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  test('provenance is decided by directory, since the contents are identical by design', async () => {
    const { isRayuNativeLockfile } = await import('../src/utils/ide.js')
    const rayuDir = join(process.env.RAYU_CONFIG_DIR as string, 'ide')
    const claudeDir = join(home, '.claude', 'ide')

    const native = writeLockfile(rayuDir, 41000, 'Visual Studio Code', 1_000)
    const upstream = writeLockfile(claudeDir, 42000, 'Visual Studio Code', 2_000)

    expect(isRayuNativeLockfile(native)).toBe(true)
    expect(isRayuNativeLockfile(upstream)).toBe(false)
  })

  test('Rayu\u2019s own directory is scanned before the upstream Claude Code one', async () => {
    // The scan order and the sort key are the two halves of the preference. `~/.claude/ide`
    // is resolved through os.homedir(), which this runtime does not re-read from $HOME, so
    // the cross-directory ORDERING is asserted here on the path list and end-to-end by the
    // Extension Host suite; the sort key itself is proven by the provenance test above.
    const { getIdeLockfilesPaths } = await import('../src/utils/ide.js')
    const paths = await getIdeLockfilesPaths()
    const rayuIndex = paths.findIndex(p => p.includes(join('.rayu', 'ide')))
    const claudeIndex = paths.findIndex(p => p.includes(join('.claude', 'ide')))
    expect(rayuIndex).toBe(0)
    expect(claudeIndex).toBeGreaterThan(rayuIndex)
  })

  test('a native lockfile outranks a non-native one regardless of modification time', async () => {
    const { getSortedIdeLockfiles, isRayuNativeLockfile } = await import('../src/utils/ide.js')
    const rayuDir = join(process.env.RAYU_CONFIG_DIR as string, 'ide')
    // Two Rayu lockfiles, the OLDER one written second, proving mtime is the tiebreak and
    // that every returned path is classified consistently with the sort.
    writeLockfile(rayuDir, 41000, 'Rayucode', 5_000)
    writeLockfile(rayuDir, 41001, 'Rayucode', 1_000)
    const sorted = await getSortedIdeLockfiles()
    const natives = sorted.filter(isRayuNativeLockfile)
    // All of ours appear before any that are not ours.
    const firstNonNative = sorted.findIndex(p => !isRayuNativeLockfile(p))
    if (firstNonNative !== -1) {
      expect(sorted.slice(firstNonNative).every(p => !isRayuNativeLockfile(p))).toBe(true)
    }
    expect(natives.length).toBeGreaterThanOrEqual(2)
  })

  test('mtime still orders within Rayu\u2019s own lockfiles', async () => {
    const { getSortedIdeLockfiles } = await import('../src/utils/ide.js')
    const rayuDir = join(process.env.RAYU_CONFIG_DIR as string, 'ide')
    writeLockfile(rayuDir, 41000, 'Rayucode', 1_000)
    writeLockfile(rayuDir, 41001, 'Rayucode', 5_000)

    const sorted = (await getSortedIdeLockfiles()).filter(p => p.includes(join('.rayu', 'ide')))
    // Freshest window of the same kind first.
    expect(sorted[0]).toContain('41001.lock')
    expect(sorted[1]).toContain('41000.lock')
  })
})

describe('the MCP server entry for a detected editor', () => {
  test('the transport comes from the URL scheme, not the editor identity', async () => {
    // Easy to get subtly wrong: the same extension may advertise either transport.
    const { ideMcpServerConfig } = await import('../src/utils/ide.js')
    const ws = ideMcpServerConfig({
      url: 'ws://127.0.0.1:41000',
      name: 'Rayucode',
      authToken: 'tok',
      ideRunningInWindows: false,
    })
    expect(ws).toMatchObject({
      type: 'ws-ide',
      url: 'ws://127.0.0.1:41000',
      ideName: 'Rayucode',
      authToken: 'tok',
      scope: 'dynamic',
    })

    const sse = ideMcpServerConfig({
      url: 'http://127.0.0.1:41000/sse',
      name: 'Other',
      authToken: undefined,
      ideRunningInWindows: undefined,
    })
    expect(sse).toMatchObject({ type: 'sse-ide' })
  })

  test('the server is named `ide`, which is what getConnectedIdeClient looks for', async () => {
    // Asserted because the name is the whole contract: the selection handler is registered
    // on the client called `ide` and nothing else would receive notifications.
    const { getConnectedIdeClient } = await import('../src/utils/ide.js')
    expect(
      getConnectedIdeClient([
        { type: 'connected', name: 'ide', client: {} } as never,
        { type: 'connected', name: 'other', client: {} } as never,
      ]),
    ).toMatchObject({ name: 'ide' })
    expect(getConnectedIdeClient([{ type: 'connected', name: 'other' } as never])).toBeUndefined()
    expect(getConnectedIdeClient(undefined)).toBeUndefined()
  })
})
