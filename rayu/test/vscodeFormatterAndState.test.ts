/**
 * Test suite for VS Code formatter, state reducer, permission mode cycling,
 * review command quoting, and autocomplete navigation logic.
 */
import { describe, expect, mock, test } from 'bun:test'

// Mock vscode module before dynamic import so fileChangeReview.js can load
mock.module('vscode', () => ({
  window: {
    showWarningMessage: () => Promise.resolve(undefined),
    showTextDocument: () => Promise.resolve(undefined),
  },
  commands: {
    executeCommand: () => Promise.resolve(undefined),
  },
  Uri: {
    file: (f: string) => ({ fsPath: f, scheme: 'file', with: () => ({}) }),
    joinPath: (base: { fsPath: string }, ...segments: string[]) => ({
      fsPath: `${base.fsPath}/${segments.join('/')}`,
      with: () => ({}),
    }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
  },
}))

const { reviewCommand } = (await import('../src/vscode/host/review/fileChangeReview.js')) as {
  reviewCommand: (action: 'keep' | 'undo', path?: string) => string
}

import {
  formatActivityForVSCode,
  formatMessageForVSCode,
} from '../src/vscode/host/panel/formatActivityForVSCode.js'
import {
  chatReducer,
  initialChatState,
  type ChatState,
} from '../src/vscode/webview/state/reducer.js'
import {
  nextPermissionMode,
  permissionModeById,
  PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
} from '../src/vscode/shared/permissionModes.js'
import type { ContentBlock, WrappedMessage } from '../src/telegram/formatActivity.js'
import type { TranscriptEntry, WebviewState } from '../src/vscode/shared/webviewProtocol.js'

describe('VS Code Activity Formatter (formatActivityForVSCode)', () => {
  test('drops meta messages', () => {
    const metaMsg: WrappedMessage = {
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: 'system meta instructions' },
    }
    expect(formatMessageForVSCode(metaMsg)).toEqual([])
  })

  test('drops thinking blocks', () => {
    const msg: WrappedMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal reasoning' },
          { type: 'text', text: 'Visible answer' },
        ],
      },
    }
    const blocks = formatMessageForVSCode(msg)
    expect(blocks).toEqual([{ kind: 'assistant', text: 'Visible answer' }])
  })

  test('drops empty or whitespace-only text blocks', () => {
    const msg: WrappedMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '   \n  ' },
          { type: 'text', text: 'Actual content' },
        ],
      },
    }
    const blocks = formatMessageForVSCode(msg)
    expect(blocks).toEqual([{ kind: 'assistant', text: 'Actual content' }])
  })

  test('formats tool_use with label and parameters', () => {
    const msg: WrappedMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_123',
            name: 'Bash',
            input: { command: 'npm test' },
          } as unknown as ContentBlock,
        ],
      },
    }
    const blocks = formatMessageForVSCode(msg)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('tool_use')
    if (blocks[0].kind === 'tool_use') {
      expect(blocks[0].toolUseId).toBe('call_123')
      expect(blocks[0].name).toBe('Bash')
      expect(blocks[0].label).toContain('npm test')
      expect(blocks[0].parameters).toContain('npm test')
    }
  })

  test('formats AskUserQuestion as structured questions without raw JSON parameters', () => {
    const input = {
      questions: [{
        question: 'Which files?', header: 'Files', multiSelect: false,
        options: [
          { label: 'Text', description: 'Text files' },
          { label: 'Python', description: 'Python files' },
        ],
      }],
    }
    const blocks = formatMessageForVSCode({
      type: 'assistant',
      message: { role: 'assistant', content: [{
        type: 'tool_use', id: 'ask_1', name: 'AskUserQuestion', input,
      } as unknown as ContentBlock] },
    })

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: 'tool_use', toolUseId: 'ask_1', name: 'AskUserQuestion',
      label: '1 question', parameters: '', questions: input.questions,
    })
  })

  test('propagates is_error and keeps empty failed result', () => {
    const msg: WrappedMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          // Empty failure must not be dropped
          {
            type: 'tool_result',
            tool_use_id: 'call_fail',
            content: '',
            is_error: true,
          } as unknown as ContentBlock,
          // Empty SUCCESS must not be dropped either — see the assertion below.
          {
            type: 'tool_result',
            tool_use_id: 'call_empty_success',
            content: '',
            is_error: false,
          } as unknown as ContentBlock,
          // Normal result with content
          {
            type: 'tool_result',
            tool_use_id: 'call_success',
            content: 'Tests passed: 5/5',
            is_error: false,
          } as unknown as ContentBlock,
        ],
      },
    }
    const blocks = formatMessageForVSCode(msg)

    // ── ALL THREE ARE EMITTED, INCLUDING THE EMPTY SUCCESS ────────────────────
    //
    // This originally expected 2, dropping the empty successful result on the
    // reasonable-sounding grounds that there is nothing to show. That was a bug:
    // the consumer learns a tool FINISHED from its result block, so dropping it
    // left the tool pill spinning on "running" forever. A `Bash` that writes
    // nothing to stdout is the common case, not an edge case.
    //
    // Suppressing the empty output BODY is the renderer's job — `ToolActionEntry`
    // only draws the Output section when `output` is non-empty. That keeps the
    // presentation decision in the renderer and makes it impossible to lose the
    // completion.
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toEqual({
      kind: 'tool_result',
      toolUseId: 'call_fail',
      text: '',
      isError: true,
    })
    expect(blocks[1]).toEqual({
      kind: 'tool_result',
      toolUseId: 'call_empty_success',
      text: '',
      isError: false,
    })
    expect(blocks[2]).toEqual({
      kind: 'tool_result',
      toolUseId: 'call_success',
      text: 'Tests passed: 5/5',
      isError: false,
    })
  })

  test('formatActivityForVSCode preserves order across a batch', () => {
    const messages: WrappedMessage[] = [
      {
        type: 'user',
        message: { role: 'user', content: 'Run the tests' },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'Bash',
              input: { command: 'bun test' },
            } as unknown as ContentBlock,
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: '1 pass',
            } as unknown as ContentBlock,
          ],
        },
      },
    ]
    const blocks = formatActivityForVSCode(messages)
    expect(blocks).toHaveLength(3)
    expect(blocks[0].kind).toBe('prompt')
    expect(blocks[1].kind).toBe('tool_use')
    expect(blocks[2].kind).toBe('tool_result')
  })
})

describe('VS Code Webview Reducer (chatReducer)', () => {
  test('init replaces state wholesale without leaking stale entries', () => {
    const dirtyState: ChatState = {
      ...initialChatState,
      entries: [
        {
          id: 'old-1',
          kind: 'prompt',
          text: 'stale entry',
        },
      ],
      notices: ['old notice'],
    }

    const newState: WebviewState = {
      status: 'ready',
      version: '1.6.23',
      workspaceFolder: '/workspace',
      signInMessage: null,
      identity: { email: 'dev@rayu.ai', displayName: 'Dev' },
      oauthEnabled: true,
      transcript: [
        {
          id: 'fresh-1',
          kind: 'prompt',
          text: 'fresh entry',
        },
      ],
      turnRunning: false,
      pendingPermissions: [],
      modelInfo: { model: 'claude-3-7-sonnet', provider: 'Anthropic' },
      attachment: { available: undefined, attached: null, error: null },
      providerSetup: {
        open: false,
        presets: undefined,
        busy: false,
        busyMessage: null,
        error: null,
        discoveredModels: null,
        connectedProviderId: null,
        connectedModel: null,
      },
      inference: {
        supportsEffort: true,
        supportedLevels: ['low', 'medium', 'high'],
        effort: null,
        effortEnvOverride: null,
        supportsThinking: true,
        thinkingEnabled: false,
      },
      modelCatalogue: {
        options: [
          {
            value: 'claude-3-7-sonnet',
            label: 'Claude 3.7 Sonnet',
            description: 'anthropic · claude-3-7-sonnet',
          },
        ],
        loading: false,
        error: null,
      },
      permissionMode: PERMISSION_MODES[0],
      commands: [{ name: 'test', description: 'run tests' }],
      contextUsage: { percentage: 25, totalTokens: 50000, maxTokens: 200000 },
      mcpServers: [{ name: 'filesystem', status: 'connected' }],
    }

    const state = chatReducer(dirtyState, { type: 'init', state: newState })
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0].id).toBe('fresh-1')
    expect(state.notices).toEqual([])
    expect(state.contextUsage?.percentage).toBe(25)
    expect(state.commands).toHaveLength(1)
    expect(state.mcpServers).toHaveLength(1)
  })

  test('addMessage appends new entry or replaces existing by id', () => {
    let state = initialChatState

    const entry1: TranscriptEntry = {
      id: 'tool_1',
      kind: 'tool',
      toolUseId: 't1',
      name: 'Bash',
      label: 'npm test',
      parameters: 'npm test',
      status: 'running',
      output: null,
    }
    state = chatReducer(state, { type: 'addMessage', entry: entry1 })
    expect(state.entries).toHaveLength(1)
    expect((state.entries[0] as { status: string }).status).toBe('running')

    // Tool finishes: re-emitted with updated status and result
    const entry1Finished: TranscriptEntry = {
      ...entry1,
      status: 'done',
      output: 'pass',
    }
    state = chatReducer(state, { type: 'addMessage', entry: entry1Finished })
    expect(state.entries).toHaveLength(1)
    expect((state.entries[0] as { status: string }).status).toBe('done')
  })

  test('appendPartial accumulates stream and drops unknown-id or thinking deltas', () => {
    let state = initialChatState
    const assistantEntry: TranscriptEntry = {
      id: 'msg_1',
      kind: 'assistant',
      text: 'Hello',
      streaming: true,
    }
    state = chatReducer(state, { type: 'addMessage', entry: assistantEntry })

    // Normal text delta
    state = chatReducer(state, {
      type: 'appendPartial',
      id: 'msg_1',
      kind: 'text',
      delta: ' world!',
    })
    expect((state.entries[0] as { text: string }).text).toBe('Hello world!')

    // Thinking delta is dropped
    state = chatReducer(state, {
      type: 'appendPartial',
      id: 'msg_1',
      kind: 'thinking',
      delta: 'thinking tokens',
    })
    expect((state.entries[0] as { text: string }).text).toBe('Hello world!')

    // Delta for unknown id is safely dropped
    state = chatReducer(state, {
      type: 'appendPartial',
      id: 'unknown_msg',
      kind: 'text',
      delta: 'dropped',
    })
    expect(state.entries).toHaveLength(1)
  })

  test('completeMessage marks assistant entry streaming as false', () => {
    let state = initialChatState
    state = chatReducer(state, {
      type: 'addMessage',
      entry: {
        id: 'msg_1',
        kind: 'assistant',
        text: 'Finished text',
        streaming: true,
      },
    })
    expect((state.entries[0] as { streaming: boolean }).streaming).toBe(true)

    state = chatReducer(state, { type: 'completeMessage', id: 'msg_1' })
    expect((state.entries[0] as { streaming: boolean }).streaming).toBe(false)
  })

  test('permission lifecycle: show and dismiss permission request', () => {
    let state = initialChatState
    state = chatReducer(state, {
      type: 'showPermissionRequest',
      request: {
        requestId: 'req_p1',
        toolName: 'Bash',
        label: 'rm -rf /',
        parameters: '',
        description: null,
        blockedPath: null,
        reason: null,
        canAlwaysAllow: true,
      },
    })
    expect(state.pendingPermissions).toHaveLength(1)
    expect(state.pendingPermissions[0].requestId).toBe('req_p1')

    // Dismissal
    state = chatReducer(state, {
      type: 'dismissPermissionRequest',
      requestId: 'req_p1',
    })
    expect(state.pendingPermissions).toHaveLength(0)
  })

  test('removeEntry deletes entry by id (used for Copilot Edits review card)', () => {
    let state = initialChatState
    state = chatReducer(state, {
      type: 'addMessage',
      entry: {
        id: 'review_turn_1',
        kind: 'review',
        totalFiles: 1,
        totalAdditions: 2,
        totalRemovals: 1,
        files: [
          {
            displayPath: 'foo.ts',
            additions: 2,
            removals: 1,
            isCreated: false,
            // Preserved from the engine's FileChangeReviewFile rather than dropped:
            // `status` is what stops the card offering Keep on an already-kept file,
            // and `changeIds` is how the engine identifies the recorded change.
            status: 'pending',
            changeIds: ['chg_1'],
          },
        ],
      },
    })
    expect(state.entries).toHaveLength(1)

    state = chatReducer(state, { type: 'removeEntry', id: 'review_turn_1' })
    expect(state.entries).toHaveLength(0)
  })

  test('setContextUsage, setMcpServers, and setCommands updates', () => {
    let state = initialChatState
    state = chatReducer(state, {
      type: 'setContextUsage',
      percentage: 42,
      totalTokens: 84000,
      maxTokens: 200000,
    })
    expect(state.contextUsage).toEqual({
      percentage: 42,
      totalTokens: 84000,
      maxTokens: 200000,
    })

    state = chatReducer(state, {
      type: 'setMcpServers',
      servers: [{ name: 'git', status: 'connected' }],
    })
    expect(state.mcpServers).toHaveLength(1)
    expect(state.mcpServers[0].name).toBe('git')

    state = chatReducer(state, {
      type: 'setCommands',
      commands: [{ name: 'review', description: 'review diff' }],
    })
    expect(state.commands).toHaveLength(1)
  })
})

describe('Permission mode cycling and wrapping (nextPermissionMode)', () => {
  test('cycles through modes in order and wraps back to start', () => {
    expect(nextPermissionMode('plan').id).toBe('default')
    expect(nextPermissionMode('default').id).toBe('acceptEdits')
    expect(nextPermissionMode('acceptEdits').id).toBe('bypassPermissions')
    expect(nextPermissionMode('bypassPermissions').id).toBe('plan')
  })

  test('unknown id restarts cycle cleanly at first mode', () => {
    expect(nextPermissionMode('unknown_internal_mode').id).toBe('plan')
  })

  test('permissionModeById resolves correctly with fallback', () => {
    expect(permissionModeById('bypassPermissions').id).toBe('bypassPermissions')
    expect(permissionModeById('not_a_mode')).toBe(DEFAULT_PERMISSION_MODE)
  })
})

describe('Review command argument quoting (reviewCommand)', () => {
  test('without path produces the shared all-files command', () => {
    expect(reviewCommand('keep')).toBe('/keep')
    expect(reviewCommand('undo')).toBe('/undo all')
  })

  test('path without whitespace is not quoted', () => {
    expect(reviewCommand('keep', 'src/auth/login.ts')).toBe('/keep src/auth/login.ts')
    expect(reviewCommand('undo', 'package.json')).toBe('/undo package.json')
  })

  test('path with whitespace is enclosed in double quotes', () => {
    expect(reviewCommand('keep', 'src/my folder/my file.ts')).toBe('/keep "src/my folder/my file.ts"')
    expect(reviewCommand('undo', 'docs/Getting Started.md')).toBe('/undo "docs/Getting Started.md"')
  })
})

describe('Autocomplete filtering and navigation logic', () => {
  test('slash-command filtering by prefix', () => {
    const commands = [
      { name: 'cost', description: 'Show cost' },
      { name: 'review', description: 'Review changes' },
      { name: 'review_detail', description: 'Detailed review' },
      { name: 'undo', description: 'Undo changes' },
    ]
    const filterCommands = (query: string) =>
      commands.filter(c => c.name.toLowerCase().startsWith(query.toLowerCase()))

    expect(filterCommands('rev')).toHaveLength(2)
    expect(filterCommands('rev').map(c => c.name)).toEqual(['review', 'review_detail'])
    expect(filterCommands('und')).toEqual([{ name: 'undo', description: 'Undo changes' }])
  })

  test('keyboard selection index wraps around items boundary', () => {
    const itemCount = 4
    const nextIndex = (curr: number, dir: 1 | -1) =>
      (curr + dir + itemCount) % itemCount

    // Arrow down
    expect(nextIndex(0, 1)).toBe(1)
    expect(nextIndex(3, 1)).toBe(0) // Wrap to start

    // Arrow up
    expect(nextIndex(0, -1)).toBe(3) // Wrap to end
    expect(nextIndex(2, -1)).toBe(1)
  })
})
