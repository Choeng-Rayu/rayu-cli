/**
 * The webview icon set.
 *
 * Every UI glyph is a VS Code codicon, so the panel matches the editor around it. This
 * test pins the name each component maps to, and checks that every name still exists in
 * the shipped codicons release — a rename upstream then fails here instead of rendering
 * an empty square.
 */
import { describe, expect, test } from 'bun:test'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  BackIcon,
  CheckIcon,
  ChevronIcon,
  CircleIcon,
  CloseIcon,
  Codicon,
  CopyIcon,
  EffortIcon,
  EllipsisIcon,
  ErrorIcon,
  FileIcon,
  FolderIcon,
  GearIcon,
  HistoryIcon,
  LinkIcon,
  ListIcon,
  ModelIcon,
  PaperclipIcon,
  PlugIcon,
  PlusIcon,
  ProgressGlyph,
  RayuMark,
  SearchIcon,
  SendIcon,
  ShieldIcon,
  SignInIcon,
  SignOutIcon,
  StopIcon,
  TaskListIcon,
  TerminalIcon,
} from '../src/vscode/webview/components/Icons.js'

const codiconCSS = readFileSync(
  resolve(import.meta.dir, '../node_modules/@vscode/codicons/dist/codicon.css'),
  'utf8',
)

function mark(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element)
}

type IconComponent = ComponentType<{ size?: number; title?: string; className?: string; direction?: 'down' | 'right' | 'left' }>

const MAPPED: Array<[string, IconComponent, string]> = [
  ['SendIcon', SendIcon, 'send'],
  ['StopIcon', StopIcon, 'debug-stop'],
  ['PaperclipIcon', PaperclipIcon, 'attach'],
  ['PlusIcon', PlusIcon, 'add'],
  ['HistoryIcon', HistoryIcon, 'history'],
  ['SearchIcon', SearchIcon, 'search'],
  ['ListIcon', ListIcon, 'list-flat'],
  ['CopyIcon', CopyIcon, 'copy'],
  ['CheckIcon', CheckIcon, 'check'],
  ['CircleIcon', CircleIcon, 'circle-large-outline'],
  ['CloseIcon', CloseIcon, 'close'],
  ['ErrorIcon', ErrorIcon, 'error'],
  ['BackIcon', BackIcon, 'chevron-left'],
  ['EllipsisIcon', EllipsisIcon, 'ellipsis'],
  ['PlugIcon', PlugIcon, 'plug'],
  ['SignOutIcon', SignOutIcon, 'sign-out'],
  ['GearIcon', GearIcon, 'gear'],
  ['TerminalIcon', TerminalIcon, 'terminal'],
  ['ShieldIcon', ShieldIcon, 'shield'],
  ['FolderIcon', FolderIcon, 'folder'],
  ['FileIcon', FileIcon, 'file'],
  ['SignInIcon', SignInIcon, 'sign-in'],
  ['EffortIcon', EffortIcon, 'zap'],
  ['ModelIcon', ModelIcon, 'sparkle'],
  ['TaskListIcon', TaskListIcon, 'checklist'],
  ['LinkIcon', LinkIcon, 'link'],
]

describe('icon components', () => {
  for (const [name, Icon, codicon] of MAPPED) {
    test(`${name} renders codicon-${codicon}`, () => {
      const html = mark(createElement(Icon, { size: 20 }))
      expect(html).toContain(`codicon codicon-${codicon}`)
      expect(html).toContain('font-size:20px')
      // Decorative by default: its label lives on the button or beside it.
      expect(html).toContain('aria-hidden="true"')
      expect(html).not.toContain('role="img"')
    })
  }

  test('each mapped codicon exists in the installed codicons release', () => {
    for (const [name, , codicon] of MAPPED) {
      expect(codiconCSS, `${name} maps to ${codicon}, which codicon.css does not define`)
        .toContain(`.codicon-${codicon}:before`)
    }
    expect(codiconCSS).toContain('.codicon-chevron-down:before')
    expect(codiconCSS).toContain('.codicon-chevron-right:before')
  })

  test('a titled icon is announced, an untitled one is not', () => {
    const titled = mark(createElement(GearIcon, { title: 'Settings' }))
    expect(titled).toContain('role="img"')
    expect(titled).toContain('aria-label="Settings"')
    expect(titled).toContain('title="Settings"')
    expect(titled).not.toContain('aria-hidden')
  })

  test('the size prop becomes the font size', () => {
    expect(mark(createElement(CheckIcon, { size: 9 }))).toContain('font-size:9px')
    expect(mark(createElement(Codicon, { name: 'check', size: 17 }))).toContain('font-size:17px')
  })

  test('ChevronIcon points in the requested direction', () => {
    expect(mark(createElement(ChevronIcon, { direction: 'down' }))).toContain('codicon-chevron-down')
    expect(mark(createElement(ChevronIcon, { direction: 'right' }))).toContain('codicon-chevron-right')
    expect(mark(createElement(ChevronIcon, { direction: 'left' }))).toContain('codicon-chevron-left')
  })

  test('a caller-supplied class is kept alongside the codicon class', () => {
    const html = mark(createElement(CheckIcon, { className: 'rc-tool-file-ok' }))
    expect(html).toContain('codicon codicon-check rc-tool-file-ok')
  })
})

describe('the two Rayu marks stay sprites', () => {
  test('RayuMark renders the sprite avatar, not a codicon', () => {
    const html = mark(createElement(RayuMark, { size: 16 }))
    expect(html).toContain('rc-sprite-avatar')
    expect(html).not.toContain('codicon')
  })

  test('ProgressGlyph renders the sprite avatar in its own class', () => {
    const html = mark(createElement(ProgressGlyph))
    expect(html).toContain('rc-progress-glyph')
    expect(html).not.toContain('codicon')
  })
})
