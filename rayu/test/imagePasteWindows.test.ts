// Windows clipboard-image paste regression tests.
//
// Root cause being pinned: the win32 reader could not report failure, and the
// trigger layer was macOS-only.
//
//   1. `(Get-Clipboard -Format Image) -ne $null` prints True/False and exits 0
//      either way, so getImageFromClipboard's exit-code gate never fired and
//      the fixed temp path could serve a screenshot left by a prior session.
//   2. The save path used single-quoted PowerShell with doubled backslashes —
//      backslashes are literal inside single quotes — and never escaped `'`.
//   3. hasImageInClipboard() returned false for every non-darwin platform, so
//      the "image in clipboard" hint that teaches the Windows alt+v binding
//      never appeared.
//
// execa is mocked process-wide for this file; nothing spawns PowerShell.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let spawnCalls: string[] = []
let exitCodeFor: (cmd: string) => number = () => 0

const realExecaModule = await import('execa')
mock.module('execa', () => ({
  ...realExecaModule,
  execa: (cmd: string) => {
    spawnCalls.push(cmd)
    const exitCode = exitCodeFor(cmd)
    return Promise.resolve({
      exitCode,
      failed: exitCode !== 0,
      stdout: '',
      stderr: '',
    })
  },
}))

const { getClipboardCommands, getImageFromClipboard, hasImageInClipboard } =
  await import('../src/utils/imagePaste.ts')

const REAL_PLATFORM = process.platform
const REAL_TEMP = process.env.TEMP

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  })
}

beforeEach(() => {
  spawnCalls = []
  exitCodeFor = () => 0
})

// 1x1 transparent PNG — smallest valid input for the resize/encode path.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

afterEach(() => {
  setPlatform(REAL_PLATFORM)
  if (REAL_TEMP === undefined) delete process.env.TEMP
  else process.env.TEMP = REAL_TEMP
})

// mock.module is process-wide and outlives this file. Put the real module back
// so later test files in a full `bun test` run do not inherit the fake execa.
afterAll(() => {
  mock.module('execa', () => realExecaModule)
})

describe('windows clipboard command selection', () => {
  test('defaults to win32 commands on a Windows runtime', () => {
    setPlatform('win32')
    const { commands } = getClipboardCommands()
    expect(commands.checkImage).toContain('Get-Clipboard -Format Image')
  })

  test('checkImage sets an exit code instead of printing True/False', () => {
    // PowerShell exits 0 for a False expression, so the caller's exit-code
    // gate is meaningless unless the command sets the code itself.
    const { commands } = getClipboardCommands('win32')
    expect(commands.checkImage).toContain('exit 0')
    expect(commands.checkImage).toContain('exit 1')
  })

  test('saveImage keeps the path literal: backslashes are not doubled', () => {
    const { commands } = getClipboardCommands('win32')
    expect(commands.saveImage).not.toMatch(/\\\\/)
    expect(commands.saveImage).toContain('Add-Type -AssemblyName System.Drawing')
    expect(commands.saveImage).toContain('[System.Drawing.Imaging.ImageFormat]::Png')
  })

  test("saveImage escapes apostrophes in the temp path as PowerShell's ''", () => {
    process.env.TEMP = "C:\\Users\\O'Brien\\AppData\\Local\\Temp"
    const { commands, screenshotPath } = getClipboardCommands('win32')
    expect(screenshotPath).toContain("O'Brien")
    expect(commands.saveImage).toContain("O''Brien")
    expect(commands.saveImage).not.toContain("O'Brien")
  })

  test('saveImage deletes a stale temp file before writing', () => {
    const { commands } = getClipboardCommands('win32')
    expect(commands.saveImage).toContain('Remove-Item -LiteralPath')
  })

  test('uses TEMP as the Windows temp root, not /tmp', () => {
    process.env.TEMP = 'C:\\Temp'
    const { screenshotPath } = getClipboardCommands('win32')
    expect(screenshotPath.startsWith('C:\\Temp')).toBe(true)
    expect(screenshotPath).toContain('rayu_cli_latest_screenshot.png')
  })
})

describe('hasImageInClipboard on non-darwin platforms', () => {
  test('probes the Windows clipboard instead of returning false', async () => {
    setPlatform('win32')
    expect(await hasImageInClipboard()).toBe(true)
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]!).toContain('Get-Clipboard -Format Image')
  })

  test('reports false when the check command exits non-zero', async () => {
    setPlatform('win32')
    exitCodeFor = () => 1
    expect(await hasImageInClipboard()).toBe(false)
  })

  test('probes the Linux clipboard too', async () => {
    setPlatform('linux')
    expect(await hasImageInClipboard()).toBe(true)
    expect(spawnCalls[0]!).toContain('wl-paste')
  })
})

describe('getImageFromClipboard on Windows', () => {
  test('does not read the temp file when the clipboard has no image', async () => {
    setPlatform('win32')
    // The check is the first (and only) spawn.
    exitCodeFor = () => 1

    expect(await getImageFromClipboard()).toBeNull()
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]!).toContain('exit 1')
  })

  test('stops when the save command fails instead of reading a file', async () => {
    setPlatform('win32')
    let call = 0
    exitCodeFor = () => (call++ === 0 ? 0 : 1)

    expect(await getImageFromClipboard()).toBeNull()
    expect(spawnCalls).toHaveLength(2)
    expect(spawnCalls[1]!).toContain('ImageFormat]::Png')
  })

  test('reads, resizes and returns the saved screenshot as base64 PNG', async () => {
    // The whole Windows read path minus PowerShell itself: check → save → read
    // the fixed temp path → resize/encode → base64. The PowerShell commands are
    // stubbed to succeed, so a real PNG is placed where `saveImage` writes it.
    const dir = mkdtempSync(join(tmpdir(), 'rayu-paste-win-'))
    process.env.TEMP = dir
    writeFileSync(join(dir, 'rayu_cli_latest_screenshot.png'), TINY_PNG)
    setPlatform('win32')
    exitCodeFor = () => 0

    try {
      const image = await getImageFromClipboard()
      expect(image).not.toBeNull()
      expect(image!.mediaType).toBe('image/png')
      expect(Buffer.from(image!.base64, 'base64').equals(TINY_PNG)).toBe(true)
      // check → save → fire-and-forget temp cleanup.
      expect(spawnCalls).toHaveLength(3)
      expect(spawnCalls[0]!).toContain('Get-Clipboard -Format Image')
      expect(spawnCalls[1]!).toContain('ImageFormat]::Png')
      expect(spawnCalls[2]!).toContain('del /f')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
