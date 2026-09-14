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

  test('emits thinking blocks with their wire index, and never redacted thinking', () => {
    const msg: WrappedMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal reasoning' },
          // Opaque provider payload, not readable reasoning: must not be emitted.
          { type: 'redacted_thinking', data: 'AAAAoq==' } as unknown as ContentBlock,
          { type: 'text', text: 'Visible answer' },
        ],
      },
    }
    const blocks = formatMessageForVSCode(msg)
    // blockIndex is the position in the message's own content array (0), which is what
    // correlates this settled copy with the live delta that produced it — NOT the
    // position within the emitted list.
    expect(blocks).toEqual([
      { kind: 'thinking', blockIndex: 0, text: 'internal reasoning' },
      { kind: 'assistant', text: 'Visible answer' },
    ])
  })

  test('carries the true wire index when earlier blocks are skipped', () => {
    const msg: WrappedMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          // Dropped for being empty, but it still occupies index 0 on the wire.
          { type: 'text', text: '   ' },
          { type: 'thinking', thinking: 'reasoning at index 1' },
        ],
      },
    }
    expect(formatMessageForVSCode(msg)).toEqual([
      { kind: 'thinking', blockIndex: 1, text: 'reasoning at index 1' },
    ])
  })

  test('drops empty or whitespace-only thinking blocks', () => {
    const msg: WrappedMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '  \n ' }],
      },
    }
    expect(formatMessageForVSCode(msg)).toEqual([])
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
      label: '1 question', parameters: '', details: [], questions: input.questions,
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
    // `truncatedChars: 0` is present on every result now. It is what drives the
    // "Show N more characters" action, and 0 is the honest value for output that was
    // not withheld — the alternative, omitting it when nothing was cut, would make the
    // absence of the field mean two different things.
    expect(blocks[0]).toEqual({
      kind: 'tool_result',
      toolUseId: 'call_fail',
      text: '',
      isError: true,
      truncatedChars: 0,
    })
    expect(blocks[1]).toEqual({
      kind: 'tool_result',
      toolUseId: 'call_empty_success',
      text: '',
      isError: false,
      truncatedChars: 0,
    })
    expect(blocks[2]).toEqual({
      kind: 'tool_result',
      toolUseId: 'call_success',
      text: 'Tests passed: 5/5',
      isError: false,
      truncatedChars: 0,
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

  test('drops a task-notification instead of showing it as a prompt', () => {
    // Regression: task-notification XML (LocalShellTask.tsx, RemoteAgentTask.tsx,
    // externalAgents/core/eventSinks.ts, PromptInputQueuedCommands.tsx) is injected as
    // a `user`-role text block, not typed by the person. Before this exclusion it
    // rendered in the VS Code panel as a literal `<task-notification>...` prompt
    // bubble instead of being recognised as engine-injected plumbing — mirroring the
    // CLI's own dedicated handling in `UserTextMessage.tsx` / `UserAgentNotificationMessage`.
    const msg: WrappedMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<task-notification>\n<task-id>benxntp38</task-id>\n<tool-use-id>call_2b356938917f4e6580d6b01d</tool-use-id>\n<output-file>/tmp/claude-1000/tasks/benxntp38.output</output-file>\n<status>failed</status>\n<summary>Background command "Run CLI test suite" failed with exit code 1</summary>\n</task-notification>',
          } as unknown as ContentBlock,
        ],
      },
    }
    expect(formatMessageForVSCode(msg)).toEqual([])
  })

  test('drops other engine-injected synthetic user text (bash/local-command output, ticks, teammate relay)', () => {
    const synthetic = [
      '<local-command-stdout>ok</local-command-stdout>',
      '<local-command-stderr>err</local-command-stderr>',
      '<local-command-caveat>note</local-command-caveat>',
      '<bash-stdout>output</bash-stdout>',
      '<bash-stderr>oops</bash-stderr>',
      '<tick>1</tick>',
      '<teammate-message from="a">hi</teammate-message>',
    ]
    for (const text of synthetic) {
      const msg: WrappedMessage = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text } as unknown as ContentBlock] },
      }
      expect(formatMessageForVSCode(msg)).toEqual([])
    }
  })

  test('a real prompt is unaffected by the exclusion', () => {
    const msg: WrappedMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'why did my background task fail?' } as unknown as ContentBlock] },
    }
    expect(formatMessageForVSCode(msg)).toEqual([
      { kind: 'prompt', text: 'why did my background task fail?' },
    ])
  })

  test('the same exclusion does not apply to assistant text (an assistant can legitimately discuss the tag)', () => {
    const msg: WrappedMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'The engine emits a <task-notification> tag internally.' } as unknown as ContentBlock,
        ],
      },
    }
    expect(formatMessageForVSCode(msg)).toEqual([
      { kind: 'assistant', text: 'The engine emits a <task-notification> tag internally.' },
    ])
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
      sessions: { status: 'ready', sessions: [] },
      modelChooser: null,
      ideContext: null,
      turnProgress: null,
      turnCompletions: {},
      thinkingBlocks: [],
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
      details: [{ label: 'Command', value: 'npm test', code: true }],
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


/**
 * The expanded tool row shows NAMED FIELDS, not the model's argument object.
 *
 * It used to print `JSON.stringify(input, null, 2)`, which dumped a `Write`'s entire file
 * body above its own diff, put whatever the model passed on screen unbounded, and showed the
 * user plumbing they did not write. The terminal shows the command, the path, the pattern —
 * the one thing the call acted on — and lets the result carry the detail.
 */
describe('toolDetails', () => {
  async function details(input: unknown) {
    const { toolDetails } = await import(
      '../src/vscode/host/panel/formatActivityForVSCode.js'
    )
    return toolDetails(input)
  }

  test('a shell call reads like the CLI: command, description, and only the flags that are set', async () => {
    expect(
      await details({
        command: 'cd /repo && bun test',
        description: 'Run CLI test suite',
        timeout: 300_000,
        run_in_background: true,
        replace_all: false,
      }),
    ).toEqual([
      // Monospace: whitespace and punctuation are the content of a command.
      { label: 'Command', value: 'cd /repo && bun test', code: true },
      { label: 'Description', value: 'Run CLI test suite' },
      // Milliseconds are the wire format, not something to read.
      { label: 'Timeout', value: '300s' },
      { label: 'Background', value: 'yes' },
      // `replace_all: false` is the default and says nothing, so it is absent entirely.
    ])
  })

  test('a search names its pattern before the path that narrows it', async () => {
    const result = await details({ path: 'src', pattern: 'loadConfig', output_mode: 'content' })
    // Field order is fixed by the label table, NOT by the object's key order — argument order
    // is the model's choice and would otherwise render the same call differently per turn.
    expect(result.map(d => d.label)).toEqual(['Pattern', 'Path', 'Mode'])
  })

  test('bulk content is reported as a size, never printed', async () => {
    const body = 'x'.repeat(4_200)
    const result = await details({ file_path: '/tmp/x.ts', content: body })
    expect(result).toEqual([
      { label: 'File', value: '/tmp/x.ts' },
      { label: 'Content', value: '4.1 KB (see the diff below)' },
    ])
    expect(JSON.stringify(result)).not.toContain(body)
  })

  test("an edit shows only its file, because the diff below renders both sides", async () => {
    expect(
      await details({
        file_path: '/tmp/x.ts',
        old_string: 'a'.repeat(300),
        new_string: 'b'.repeat(320),
      }),
    ).toEqual([{ label: 'File', value: '/tmp/x.ts' }])
  })

  test('a subagent brief is sized, a one-line prompt is shown', async () => {
    const brief = 'p'.repeat(2_600)
    const agent = await details({ subagent_type: 'Explore', description: 'Explore structure', prompt: brief })
    expect(agent).toContainEqual({ label: 'Prompt', value: '2.5 KB' })
    expect(JSON.stringify(agent)).not.toContain(brief)

    const fetch = await details({ url: 'https://example.com', prompt: 'What is the rate limit?' })
    expect(fetch).toContainEqual({ label: 'Prompt', value: 'What is the rate limit?' })
  })

  test('an unrecognised credential argument is hidden; a recognised one is never hidden', async () => {
    // MCP tools arrive with schemas this code has never seen. The key is still reported, so
    // the call stays legible, but the value is not.
    const mcp = await details({ designId: 'DAF123', apiToken: 'live-secret-value' })
    expect(mcp).toEqual([
      { label: 'Design Id', value: 'DAF123' },
      { label: 'Api Token', value: '[hidden]' },
    ])
    expect(JSON.stringify(mcp)).not.toContain('live-secret-value')

    // A `Bash` command is deliberately NOT hidden even when it carries a token: it is the
    // thing the user is being asked to trust, and an unreadable command is worse than a
    // readable one. Redaction of command CONTENT is a separate question from field naming.
    const bash = await details({ command: 'curl -H "Authorization: Bearer abc123"' })
    expect(bash[0]!.value).toContain('Bearer abc123')
  })

  test('shapes are described, not expanded, and internal keys are dropped', async () => {
    expect(
      await details({ nested: { a: 1, b: 2 }, list: [1, 2, 3], _simulatedSedEdit: { x: 1 } }),
    ).toEqual([
      // Enough for a developer to know what was passed, without printing values that may be
      // credentials.
      { label: 'Nested', value: '{ a, b }' },
      { label: 'List', value: '3 items' },
    ])
  })

  test('a non-object argument yields no fields — the row label already carries it', async () => {
    expect(await details('just a string')).toEqual([])
    expect(await details(undefined)).toEqual([])
    expect(await details(null)).toEqual([])
    expect(await details([1, 2, 3])).toEqual([])
  })
})

describe('the tool row label', () => {
  async function labelFor(name: string, input: unknown) {
    const { formatMessageForVSCode } = await import(
      '../src/vscode/host/panel/formatActivityForVSCode.js'
    )
    const blocks = formatMessageForVSCode({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-1', name, input }],
      },
    } as never)
    const block = blocks.find(b => b.kind === 'tool_use')
    if (!block || block.kind !== 'tool_use') throw new Error('no tool_use block')
    return block
  }

  test("a subagent's header shows its description, not its whole brief", async () => {
    const brief = 'Explore every module and report back in detail. '.repeat(60)
    const block = await labelFor('Agent', {
      subagent_type: 'Explore',
      description: 'Explore codebase structure',
      prompt: brief,
    })
    // `summariseInput`'s precedence ends at `prompt`, so this used to put the entire brief in
    // the pill header. The CLI shows the one-line description.
    expect(block.label).toBe('Explore codebase structure')
  })

  test('a command still wins over a description, and the raw arguments are still carried', async () => {
    const block = await labelFor('Bash', { command: 'bun test', description: 'Run tests' })
    expect(block.label).toBe('bun test')
    expect(block.details).toContainEqual({ label: 'Command', value: 'bun test', code: true })
    // Kept for the detailed-view toggle, so nothing is unreachable — it is simply no longer
    // the default reading.
    expect(JSON.parse(block.parameters).command).toBe('bun test')
  })
})
