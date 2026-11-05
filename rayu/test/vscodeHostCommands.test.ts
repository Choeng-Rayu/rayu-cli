/**
 * The editor commands' pure parts: transcript rendering, default export names, the status
 * report, and the child-frame discriminator.
 *
 * These modules deliberately import no `vscode` and no engine module, so this runs
 * without an editor or a built engine. The UI wrappers around them are exercised by the
 * extension's own host tests.
 */
import { describe, expect, test } from 'bun:test'

import { defaultExportName, transcriptToMarkdown } from '../src/vscode/host/commands/exportFormat.js'
import { statusMarkdown } from '../src/vscode/host/commands/statusFormat.js'
import type { StatusFacts } from '../src/vscode/host/commands/index.js'
import {
  isSettingsChildFrame,
  type SettingsChildAction,
} from '../src/vscode/shared/settingsChildProtocol.js'
import type { TranscriptEntry } from '../src/vscode/shared/webviewProtocol.js'

const entries: TranscriptEntry[] = [
  { id: 'p1', kind: 'prompt', text: 'Fix the parser\nand add tests' },
  { id: 'a1', kind: 'assistant', text: 'I will start with the grammar.' },
  {
    id: 't1',
    kind: 'tool',
    toolUseId: 'tool-1',
    name: 'Bash',
    label: 'npm test',
    details: [
      { label: 'Command', value: 'npm test', code: true },
      { label: 'Description', value: 'Run the suite' },
    ],
    parameters: '{"command":"npm test","token":"sk-do-not-export"}',
    status: 'done',
    output: 'ok',
  },
  {
    id: 's1',
    kind: 'side_question',
    question: 'Is it cached?',
    status: 'done',
    answer: 'Yes.',
  },
]

describe('transcriptToMarkdown', () => {
  test('writes prompts, assistant text and tool rows with projected details', () => {
    const markdown = transcriptToMarkdown(entries, { title: 'Parser fix' })

    expect(markdown).toContain('# Parser fix')
    expect(markdown).toContain('## User')
    expect(markdown).toContain('Fix the parser')
    expect(markdown).toContain('## Rayu')
    expect(markdown).toContain('I will start with the grammar.')
    expect(markdown).toContain('### Tool: Bash')
    expect(markdown).toContain('npm test')
    expect(markdown).toContain('**Command**')
    expect(markdown).toContain('**Description**: Run the suite')
    expect(markdown).toContain('## Side question')
    expect(markdown).toContain('Is it cached?')
  })

  test('never writes the raw tool parameters', () => {
    const markdown = transcriptToMarkdown(entries, { title: null })

    expect(markdown).not.toContain('parameters')
    expect(markdown).not.toContain('sk-do-not-export')
    expect(markdown).not.toContain('"command"')
    // The safe fallback title is used when the caller has none.
    expect(markdown.startsWith('# Conversation')).toBe(true)
  })
})

describe('defaultExportName', () => {
  test('uses a sanitized first prompt after a timestamp', () => {
    const name = defaultExportName([
      { id: 'p1', kind: 'prompt', text: 'Hello, World! / weird: chars\nsecond line' },
    ])
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-hello-world-weird-chars\.md$/)
  })

  test('falls back to the conversation timestamp form', () => {
    expect(defaultExportName([])).toMatch(/^conversation-\d{4}-\d{2}-\d{2}-\d{6}\.md$/)
    expect(
      defaultExportName([{ id: 'p1', kind: 'prompt', text: '!!!' }]),
    ).toMatch(/^conversation-\d{4}-\d{2}-\d{2}-\d{6}\.md$/)
  })
})

describe('statusMarkdown', () => {
  const facts: StatusFacts = {
    extensionVersion: '1.2.3',
    model: null,
    provider: null,
    cwd: '/work/project',
    sessionId: 'session-7',
    permissionMode: 'default',
    signedIn: true,
    account: 'dev@example.com',
    mcpServers: [{ name: 'github', status: 'connected' }],
  }

  test('reports the session facts and MCP connections', () => {
    const markdown = statusMarkdown(facts)
    expect(markdown).toContain('# Rayucode status')
    expect(markdown).toContain('**Extension version**: 1.2.3')
    expect(markdown).toContain('**Model**: not set')
    expect(markdown).toContain('**Provider**: not set')
    expect(markdown).toContain('**Working directory**: `/work/project`')
    expect(markdown).toContain('**Session**: session-7')
    expect(markdown).toContain('**Permission mode**: default')
    expect(markdown).toContain('**Signed in**: yes (dev@example.com)')
    expect(markdown).toContain('**github**: connected')
  })

  test('says so when there are no MCP servers', () => {
    expect(statusMarkdown({ ...facts, mcpServers: [] })).toContain('No MCP servers.')
  })
})

describe('settings child frames', () => {
  test('accepts every frame this protocol defines', () => {
    expect(isSettingsChildFrame({ type: 'rayucode_settings_result', ok: true })).toBe(true)
    expect(
      isSettingsChildFrame({ type: 'rayucode_settings_snapshot', values: {}, outputStyles: [] }),
    ).toBe(true)
    expect(
      isSettingsChildFrame({
        type: 'rayucode_permissions',
        rules: [{ behavior: 'allow', rule: 'Read', source: 'user' }],
      }),
    ).toBe(true)
    expect(isSettingsChildFrame({ type: 'rayucode_hooks', hooks: [] })).toBe(true)
    expect(isSettingsChildFrame({ type: 'rayucode_doctor', diagnostic: {} })).toBe(true)
    expect(isSettingsChildFrame({ type: 'rayucode_memory', files: [] })).toBe(true)
  })

  test('rejects unknown or malformed frames', () => {
    expect(isSettingsChildFrame({ type: 'rayucode_unknown' })).toBe(false)
    expect(isSettingsChildFrame({})).toBe(false)
    expect(isSettingsChildFrame(null)).toBe(false)
    expect(isSettingsChildFrame('rayucode_settings_result')).toBe(false)
  })

  test('the new actions carry the scope and behavior the child validates', () => {
    const action: SettingsChildAction = {
      action: 'permission-add',
      behavior: 'deny',
      rule: 'Bash(rm -rf /)',
      source: 'project',
    }
    expect(action.action).toBe('permission-add')
  })
})
