// Layer 2 regression: copying 2+ image files in Windows Explorer and pasting
// into the terminal attached only ONE image, because Windows Terminal forwards
// just the first CF_HDROP path as text. The fix reads the full clipboard
// FileDropList and expands the pasted path to every copied image.
//
// expandWindowsImagePaths is pure, so its selection/dedup/filter/fallback logic
// is verified here off-Windows. getWindowsClipboardFilePaths' platform guard is
// also checked (it must never run PowerShell on macOS/Linux). The PowerShell
// clipboard call itself requires an on-Windows smoke test.
import { describe, expect, test } from 'bun:test'
import {
  expandWindowsImagePaths,
  getWindowsClipboardFilePaths,
} from '../src/utils/imagePaste.ts'

describe('expandWindowsImagePaths', () => {
  test('expands the single pasted path to every copied image (the core fix)', () => {
    expect(
      expandWindowsImagePaths(['/img/a.png'], ['/img/a.png', '/img/b.png']),
    ).toEqual(['/img/a.png', '/img/b.png'])
  })

  test('expands to three images', () => {
    expect(
      expandWindowsImagePaths(
        ['/img/a.png'],
        ['/img/a.png', '/img/b.png', '/img/c.png'],
      ),
    ).toEqual(['/img/a.png', '/img/b.png', '/img/c.png'])
  })

  test('falls back to pasted paths when the clipboard list is empty', () => {
    expect(expandWindowsImagePaths(['/img/a.png'], [])).toEqual(['/img/a.png'])
  })

  test('falls back when the clipboard is a stale, unrelated copy', () => {
    // Pasted path is NOT in the clipboard list -> do not attach the stale files.
    expect(
      expandWindowsImagePaths(['/img/a.png'], ['/img/x.png', '/img/y.png']),
    ).toEqual(['/img/a.png'])
  })

  test('filters non-image files out of the clipboard list', () => {
    expect(
      expandWindowsImagePaths(
        ['/img/a.png'],
        ['/img/a.png', '/img/b.png', '/img/notes.txt', '/img/doc.pdf'],
      ),
    ).toEqual(['/img/a.png', '/img/b.png'])
  })

  test('removes duplicate clipboard entries, preserving order', () => {
    expect(
      expandWindowsImagePaths(
        ['/img/a.png'],
        ['/img/a.png', '/img/b.png', '/img/a.png', '/img/b.png'],
      ),
    ).toEqual(['/img/a.png', '/img/b.png'])
  })

  test('strips outer quotes from clipboard paths', () => {
    expect(
      expandWindowsImagePaths(['/img/a.png'], ['"/img/a.png"', '"/img/b.png"']),
    ).toEqual(['/img/a.png', '/img/b.png'])
  })

  test('expands even when the terminal already delivered several paths', () => {
    expect(
      expandWindowsImagePaths(
        ['/img/a.png', '/img/b.png'],
        ['/img/a.png', '/img/b.png', '/img/c.png'],
      ),
    ).toEqual(['/img/a.png', '/img/b.png', '/img/c.png'])
  })

  test('returns pasted paths unchanged when nothing was pasted', () => {
    expect(expandWindowsImagePaths([], ['/img/a.png'])).toEqual([])
  })

  test('matches the pasted path against quoted clipboard entries', () => {
    expect(
      expandWindowsImagePaths(['"/img/a.png"'], ['/img/a.png', '/img/b.png']),
    ).toEqual(['/img/a.png', '/img/b.png'])
  })
})

describe('getWindowsClipboardFilePaths platform guard', () => {
  test('returns [] on non-Windows (never runs PowerShell here)', async () => {
    // This test runs on Linux/macOS CI; the guard must short-circuit.
    if (process.platform !== 'win32') {
      expect(await getWindowsClipboardFilePaths()).toEqual([])
    }
  })
})
