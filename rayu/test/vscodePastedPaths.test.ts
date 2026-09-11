/**
 * Recovering file paths from pasted text — the CLI's drag-and-drop mechanism.
 *
 * Dragging a file onto a terminal produces no drop event: the terminal pastes the path. Every
 * fixture below is a shape a real terminal or file manager produces, because these rules exist
 * only to survive those shapes and a made-up fixture would prove nothing.
 *
 * The editor extension shares this module, so a regression here breaks BOTH surfaces — which is
 * the point of extracting it.
 */
import { describe, expect, test } from 'bun:test'

import {
  asImageFilePath,
  cleanPastedPath,
  isImageFilePath,
  readPastedPaths,
  splitPastedPaths,
  stripBackslashEscapes,
} from '../src/vscode/shared/pastedPaths.js'

describe('cleaning one candidate', () => {
  test('escaped spaces become real spaces', () => {
    // What bash-style terminals paste for `my file (1).png`.
    expect(cleanPastedPath('/home/u/my\\ file\\ \\(1\\).png')).toBe('/home/u/my file (1).png')
  })

  test('quotes are stripped', () => {
    expect(cleanPastedPath('"/home/u/my file.png"')).toBe('/home/u/my file.png')
    expect(cleanPastedPath("'/home/u/my file.png'")).toBe('/home/u/my file.png')
  })

  test('a literal backslash in a filename survives', () => {
    // `a\\b.png` on disk is pasted as `a\\\\b.png`. Consuming `\\` as one match is what keeps
    // the backslash instead of eating the character after it.
    expect(stripBackslashEscapes('/home/u/a\\\\b.png')).toBe('/home/u/a\\b.png')
  })

  test('a Windows path keeps its separators', () => {
    // Decided from the STRING, not the host platform, so a Windows path pasted over SSH or in a
    // remote workspace is not mangled into `C:Usersume.png`.
    expect(cleanPastedPath('C:\\Users\\me\\shot.png')).toBe('C:\\Users\\me\\shot.png')
  })

  test('surrounding whitespace from the terminal is dropped', () => {
    expect(cleanPastedPath('  /home/u/a.png  ')).toBe('/home/u/a.png')
  })
})

describe('splitting a multi-file drag', () => {
  test('space-separated absolute paths split, escaped spaces do not', () => {
    // Finder pastes several dragged files on one line. Splitting on every space would break the
    // filename the escaping exists to protect.
    expect(
      splitPastedPaths('/home/u/a.png /home/u/my\\ file.png /home/u/c.png'),
    ).toEqual(['/home/u/a.png', '/home/u/my\\ file.png', '/home/u/c.png'])
  })

  test('newline-separated paths split too', () => {
    expect(splitPastedPaths('/home/u/a.png\n/home/u/b.png')).toEqual([
      '/home/u/a.png',
      '/home/u/b.png',
    ])
  })

  test('Windows paths split on the drive letter', () => {
    expect(splitPastedPaths('C:\\a\\one.png D:\\b\\two.png')).toEqual([
      'C:\\a\\one.png',
      'D:\\b\\two.png',
    ])
  })

  test('order is preserved, because the user chose it', () => {
    expect(splitPastedPaths('/z.png /a.png /m.png')).toEqual(['/z.png', '/a.png', '/m.png'])
  })
})

describe('image detection', () => {
  test('the four API-supported extensions are recognised through escaping', () => {
    for (const name of ['a.png', 'a.PNG', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp']) {
      expect(isImageFilePath(`/home/u/${name}`)).toBe(true)
    }
    expect(isImageFilePath('"/home/u/my\\ shot.png"')).toBe(true)
  })

  test('non-images are not claimed', () => {
    for (const name of ['a.ts', 'a.pdf', 'a.bmp', 'a.svg', 'png', 'a.png.txt']) {
      expect(isImageFilePath(`/home/u/${name}`)).toBe(false)
    }
  })

  test('asImageFilePath returns the CLEANED path, which is what gets read', () => {
    expect(asImageFilePath('"/home/u/my shot.png"')).toBe('/home/u/my shot.png')
    expect(asImageFilePath('/home/u/notes.ts')).toBeNull()
  })
})

describe('deciding whether a paste is a file drop at all', () => {
  test('one absolute path is a drop', () => {
    expect(readPastedPaths('/home/u/a.png')).toEqual(['/home/u/a.png'])
  })

  test('several, mixed image and not, are all returned', () => {
    expect(readPastedPaths('/home/u/a.png /home/u/b.ts')).toEqual([
      '/home/u/a.png',
      '/home/u/b.ts',
    ])
  })

  test('prose is NOT a drop, even when it contains a path', () => {
    // The load-bearing case. Returning paths here would swallow what the user typed and replace
    // it with an attachment they did not ask for.
    expect(readPastedPaths('please look at /usr/bin and tell me')).toBeNull()
    expect(readPastedPaths('refactor this function')).toBeNull()
    expect(readPastedPaths('')).toBeNull()
  })

  test('a RELATIVE path is not accepted', () => {
    // It cannot be resolved without a base, and guessing the workspace root would attach the
    // wrong file silently.
    expect(readPastedPaths('src/a.ts')).toBeNull()
  })

  test('one stray word disqualifies the whole paste', () => {
    expect(readPastedPaths('/home/u/a.png and also this')).toBeNull()
    expect(readPastedPaths('/home/u/a.png /home/u/b.ts trailing words')).toBeNull()
  })

  test('an escaped space is still one path, not prose', () => {
    expect(readPastedPaths('/home/u/my\\ file.png')).toEqual(['/home/u/my file.png'])
  })

  test('a quoted path with spaces is a drop', () => {
    expect(readPastedPaths('"/home/u/my file.png"')).toEqual(['/home/u/my file.png'])
  })
})
