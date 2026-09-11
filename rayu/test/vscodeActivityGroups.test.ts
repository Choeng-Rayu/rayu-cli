/**
 * Grouping consecutive tool calls, and the header that describes a group.
 *
 * The regression this guards is data loss through summarisation: a group must never swallow a
 * tool that has its own renderer (AskUserQuestion, TodoWrite), and expanding one must still
 * yield the individual calls in order.
 */
import { describe, expect, test } from 'bun:test'

import {
  activityKindFor,
  groupLabel,
  groupStatus,
  groupTranscript,
  latestAction,
} from '../src/vscode/webview/state/activityGroups.js'
import type { TranscriptEntry } from '../src/vscode/shared/webviewProtocol.js'

type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>

function tool(
  id: string,
  name: string,
  overrides: Partial<ToolEntry> = {},
): ToolEntry {
  return {
    id,
    kind: 'tool',
    toolUseId: id,
    name,
    label: '',
    parameters: '',
    status: 'done',
    output: null,
    ...overrides,
  }
}

describe('classification', () => {
  test('tools map to the verb that describes them', () => {
    expect(activityKindFor('Read')).toBe('read')
    expect(activityKindFor('Glob')).toBe('read')
    expect(activityKindFor('Grep')).toBe('search')
    expect(activityKindFor('WebSearch')).toBe('search')
    expect(activityKindFor('Edit')).toBe('edit')
    expect(activityKindFor('Write')).toBe('edit')
    expect(activityKindFor('Bash')).toBe('run')
    expect(activityKindFor('TaskCreate')).toBe('other')
  })
})

describe('grouping', () => {
  test('consecutive same-kind calls join; a different kind starts a new group', () => {
    const blocks = groupTranscript([
      tool('a', 'Read'),
      tool('b', 'Read'),
      tool('c', 'Edit'),
      tool('d', 'Read'),
    ])
    // Merging read+edit would produce "Ran 4 tools", which says nothing.
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toMatchObject({ kind: 'activity', activity: 'read' })
    expect(blocks[0]?.kind === 'activity' && blocks[0].tools).toHaveLength(2)
    expect(blocks[1]).toMatchObject({ kind: 'activity', activity: 'edit' })
    expect(blocks[2]).toMatchObject({ kind: 'activity', activity: 'read' })
  })

  test('a non-tool entry between two runs breaks the group', () => {
    const blocks = groupTranscript([
      tool('a', 'Read'),
      { id: 'x', kind: 'assistant', text: 'thinking out loud' },
      tool('b', 'Read'),
    ])
    expect(blocks.map(b => b.kind)).toEqual(['activity', 'entry', 'activity'])
  })

  test('AskUserQuestion and TodoWrite are NEVER grouped', () => {
    // They have dedicated renderers; folding them into a count would lose the interaction and
    // the task list, which is exactly the raw-JSON fallback those renderers prevent.
    const blocks = groupTranscript([
      tool('a', 'Read'),
      tool('q', 'AskUserQuestion', {
        questions: [{ question: 'Which?', options: [{ label: 'A' }] }],
      }),
      tool('t', 'TodoWrite', {
        todos: [{ content: 'do it', status: 'pending', activeForm: 'doing it' }],
      }),
      tool('b', 'Read'),
    ])
    expect(blocks.map(b => b.kind)).toEqual(['activity', 'entry', 'entry', 'activity'])
  })

  test('ordering and identity are preserved so expanding loses nothing', () => {
    const blocks = groupTranscript([tool('a', 'Read'), tool('b', 'Read'), tool('c', 'Read')])
    const group = blocks[0]
    expect(group?.kind === 'activity' && group.tools.map(t => t.id)).toEqual(['a', 'b', 'c'])
    // The group id is stable — the first member's — so React does not remount it as calls land.
    expect(group?.kind === 'activity' && group.id).toBe('a')
  })

  test('an empty transcript produces no blocks', () => {
    expect(groupTranscript([])).toEqual([])
  })

  test('prompts, notices, summaries and review cards pass through untouched', () => {
    const entries: TranscriptEntry[] = [
      { id: 'p', kind: 'prompt', text: 'hi' },
      { id: 'n', kind: 'notice', text: 'careful', severity: 'info' },
      {
        id: 's', kind: 'summary', title: 'Done', description: 'd',
        statusCategory: 'completed', statusDetail: '', needsAction: '', isNoteworthy: false,
      },
      { id: 'r', kind: 'review', totalFiles: 1, totalAdditions: 1, totalRemovals: 0, files: [] },
    ]
    expect(groupTranscript(entries).map(b => b.kind)).toEqual(['entry', 'entry', 'entry', 'entry'])
  })
})

describe('group status', () => {
  test('running outranks a failure, because more results are still arriving', () => {
    expect(groupStatus([tool('a', 'Read', { status: 'error' }), tool('b', 'Read', { status: 'running' })])).toBe('running')
  })

  test('partial is distinguished from total failure', () => {
    expect(groupStatus([tool('a', 'Read'), tool('b', 'Read', { status: 'error' })])).toBe('partial')
    expect(groupStatus([tool('a', 'Read', { status: 'error' })])).toBe('error')
    expect(groupStatus([tool('a', 'Read'), tool('b', 'Read')])).toBe('done')
  })

  test('an empty successful result still counts as done, not running', () => {
    // A Bash that writes nothing to stdout is the common case, not an edge case.
    expect(groupStatus([tool('a', 'Bash', { status: 'done', output: '' })])).toBe('done')
  })
})

describe('group header', () => {
  test('the verb and plural agree with the count', () => {
    expect(groupLabel('read', [tool('a', 'Read')])).toBe('Read 1 file')
    expect(groupLabel('read', [tool('a', 'Read'), tool('b', 'Read')])).toBe('Read 2 files')
    expect(groupLabel('search', [tool('a', 'Grep')])).toBe('Searched 1 time')
    expect(groupLabel('search', [tool('a', 'Grep'), tool('b', 'Grep')])).toBe('Searched 2 times')
    expect(groupLabel('edit', [tool('a', 'Edit')])).toBe('Edited 1 file')
    expect(groupLabel('run', [tool('a', 'Bash'), tool('b', 'Bash')])).toBe('Ran 2 commands')
  })

  test('an unrecognised single tool is NAMED rather than counted', () => {
    expect(groupLabel('other', [tool('a', 'TaskCreate')])).toBe('Used TaskCreate')
    expect(groupLabel('other', [tool('a', 'TaskCreate'), tool('b', 'CronList')])).toBe('Used 2 tools')
  })

  test('the latest action is the NEWEST labelled call', () => {
    expect(
      latestAction([
        tool('a', 'Read', { label: 'src/a.ts' }),
        tool('b', 'Read', { label: 'src/b.ts' }),
      ]),
    ).toBe('src/b.ts')
    // Unlabelled trailing calls fall back to the most recent one that had a label.
    expect(
      latestAction([tool('a', 'Read', { label: 'src/a.ts' }), tool('b', 'Read', { label: '  ' })]),
    ).toBe('src/a.ts')
    expect(latestAction([tool('a', 'Read')])).toBeNull()
  })
})
