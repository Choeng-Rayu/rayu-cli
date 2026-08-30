/**
 * Pure wire-to-event translation for the Codex app-server and Claude Code
 * `stream-json` protocols.
 *
 * Both normalizers are pure by contract, which is what makes this possible:
 * feed a recorded wire message in, assert the exact event list out. The
 * behaviour under test that matters most is DEGRADATION — an unknown
 * notification method or item variant must produce `[]`, because a normalizer
 * that threw on a message from a newer provider release would kill a live agent
 * mid-task.
 */
import { describe, expect, test } from 'bun:test'
import {
  inferTurnKind,
  isProviderFault,
  normalizeApprovalRequest,
  normalizeCodexNotification,
} from '../src/externalAgents/adapters/codex/normalize.ts'
import {
  CODEX_APPROVAL_REQUEST,
  CODEX_EVENT,
  codexErrorTag,
  type CodexItem,
} from '../src/externalAgents/adapters/codex/protocol.ts'
import {
  extractEditedPaths,
  extractSessionId,
  isTurnTerminal,
  normalizeClaudeEnvelope,
} from '../src/externalAgents/adapters/claudeCode/normalize.ts'
import {
  buildClaudeArgs,
  buildUserMessage,
  CLAUDE_FILE_WRITING_TOOLS,
  isValidClaudeSessionId,
  newClaudeSessionId,
} from '../src/externalAgents/adapters/claudeCode/protocol.ts'
import type { EventPayload } from '../src/externalAgents/core/normalizer.ts'

const types = (events: EventPayload[]) => events.map(e => e.type)

// ---------------------------------------------------------------------------
// Codex: error classification
// ---------------------------------------------------------------------------

describe('codex error tags', () => {
  test('reads a tag from both the string and the object form', () => {
    expect(codexErrorTag('rateLimitExceeded')).toBe('rateLimitExceeded')
    expect(codexErrorTag({ rateLimitExceeded: { retryAfter: 30 } })).toBe(
      'rateLimitExceeded',
    )
  })

  test('returns undefined for shapes that carry no tag', () => {
    expect(codexErrorTag(undefined)).toBeUndefined()
    expect(codexErrorTag(null)).toBeUndefined()
    expect(codexErrorTag({})).toBeUndefined()
    expect(codexErrorTag(42)).toBeUndefined()
  })

  test.each([
    'rateLimitExceeded',
    'UsageLimitExceeded',
    'SessionBudgetExceeded',
    'HttpConnectionFailed',
    'ResponseStreamConnectionFailed',
    'ResponseStreamDisconnected',
    'ResponseTooManyFailedAttempts',
    'InternalServerError',
  ])('%s is a provider fault', tag => {
    // A provider fault keeps the task alive as waiting-provider. Treating a rate
    // limit as a task failure would discard recoverable work.
    expect(isProviderFault(tag)).toBe(true)
    expect(isProviderFault({ [tag]: {} })).toBe(true)
  })

  test.each([
    'ActiveTurnNotSteerable',
    'InvalidRequest',
    'SandboxDenied',
    'unknownFutureTag',
  ])('%s is NOT a provider fault', tag => {
    expect(isProviderFault(tag)).toBe(false)
  })

  test('an absent tag is not a provider fault', () => {
    expect(isProviderFault(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Codex: turn kind inference
// ---------------------------------------------------------------------------

describe('codex turn kind inference', () => {
  test.each<[string, CodexItem, string | undefined]>([
    ['review entry', { type: 'enteredReviewMode' }, 'review'],
    ['review exit', { type: 'exitedReviewMode' }, 'regular'],
    ['compaction', { type: 'contextCompaction' }, 'compaction'],
    ['compacted', { type: 'compacted' }, 'compaction'],
    [
      'user shell',
      { type: 'commandExecution', source: 'userShell' },
      'shell',
    ],
    ['model shell', { type: 'commandExecution' }, undefined],
    ['agent message', { type: 'agentMessage' }, undefined],
    ['unknown item', { type: 'somethingNew' }, undefined],
  ])('%s → %s', (_label, item, expected) => {
    expect(inferTurnKind(item)).toBe(expected as never)
  })

  test('the protocol has no turn-kind field, so review must be inferred', () => {
    // Codex rejects turn/steer on review and compaction turns; the adapter learns
    // the kind from the items rather than from a dedicated field.
    expect(inferTurnKind({ type: 'enteredReviewMode' })).toBe('review')
  })
})

// ---------------------------------------------------------------------------
// Codex: streaming
// ---------------------------------------------------------------------------

describe('codex streaming notifications', () => {
  test('agent message delta', () => {
    const events = normalizeCodexNotification(CODEX_EVENT.agentMessageDelta, {
      delta: 'Hello',
    })
    expect(events).toEqual([
      { type: 'agent_message', text: 'Hello', delta: true },
    ])
  })

  test('both reasoning delta channels become agent_thinking', () => {
    for (const method of [
      CODEX_EVENT.reasoningSummaryDelta,
      CODEX_EVENT.reasoningTextDelta,
    ]) {
      expect(normalizeCodexNotification(method, { delta: 'pondering' })).toEqual([
        { type: 'agent_thinking', text: 'pondering', delta: true },
      ])
    }
  })

  test('command output delta correlates by itemId and carries the stream', () => {
    expect(
      normalizeCodexNotification(CODEX_EVENT.commandOutputDelta, {
        itemId: 'item_7',
        delta: 'build failed\n',
        stream: 'stderr',
      }),
    ).toEqual([
      {
        type: 'tool_output',
        callId: 'item_7',
        chunk: 'build failed\n',
        stream: 'stderr',
      },
    ])
  })

  test('command output falls back to chunk and defaults to stdout', () => {
    expect(
      normalizeCodexNotification(CODEX_EVENT.commandOutputDelta, {
        itemId: 'i',
        chunk: 'out',
      }),
    ).toEqual([
      { type: 'tool_output', callId: 'i', chunk: 'out', stream: 'stdout' },
    ])
  })

  test('a missing itemId degrades to a placeholder rather than throwing', () => {
    const [event] = normalizeCodexNotification(CODEX_EVENT.commandOutputDelta, {
      delta: 'x',
    })
    expect(event).toMatchObject({ callId: 'unknown' })
  })

  test('a non-string delta becomes empty text, not "undefined"', () => {
    expect(
      normalizeCodexNotification(CODEX_EVENT.agentMessageDelta, { delta: 42 }),
    ).toEqual([{ type: 'agent_message', text: '', delta: true }])
  })
})

// ---------------------------------------------------------------------------
// Codex: items
// ---------------------------------------------------------------------------

describe('codex item notifications', () => {
  test('a shell execution starts a tool with its redacted command', () => {
    const events = normalizeCodexNotification(CODEX_EVENT.itemStarted, {
      item: { id: 'c1', type: 'commandExecution', command: 'npm test' },
    })
    expect(events).toEqual([
      { type: 'tool_started', callId: 'c1', toolName: 'shell', summary: 'npm test' },
    ])
  })

  test('an MCP tool call names server and tool', () => {
    const events = normalizeCodexNotification(CODEX_EVENT.itemStarted, {
      item: { id: 'm1', type: 'mcpToolCall', server: 'github', tool: 'create_pr' },
    })
    expect(events[0]).toMatchObject({ toolName: 'github/create_pr' })
  })

  test('an MCP tool call with missing names still produces a usable label', () => {
    const events = normalizeCodexNotification(CODEX_EVENT.itemStarted, {
      item: { id: 'm1', type: 'mcpToolCall' },
    })
    expect(events[0]).toMatchObject({ toolName: 'mcp/tool' })
  })

  test('web search and image generation are named tools', () => {
    expect(
      normalizeCodexNotification(CODEX_EVENT.itemStarted, {
        item: { id: 'w', type: 'webSearch' },
      })[0],
    ).toMatchObject({ toolName: 'web_search' })
    expect(
      normalizeCodexNotification(CODEX_EVENT.itemStarted, {
        item: { id: 'g', type: 'imageGeneration' },
      })[0],
    ).toMatchObject({ toolName: 'image_generation' })
  })

  test('a completed agentMessage emits the accumulated non-delta text', () => {
    expect(
      normalizeCodexNotification(CODEX_EVENT.itemCompleted, {
        item: { type: 'agentMessage', text: 'Done.' },
      }),
    ).toEqual([{ type: 'agent_message', text: 'Done.', delta: false }])
  })

  test('an empty agentMessage emits nothing', () => {
    expect(
      normalizeCodexNotification(CODEX_EVENT.itemCompleted, {
        item: { type: 'agentMessage', text: '' },
      }),
    ).toEqual([])
  })

  test('one fileChange item yields one event per path', () => {
    const events = normalizeCodexNotification(CODEX_EVENT.itemCompleted, {
      item: {
        type: 'fileChange',
        changes: [
          { path: '/src/a.ts', kind: 'add', diff: '@@ -0,0 +1 @@' },
          { path: '/src/b.ts', kind: 'delete' },
          { path: '/src/c.ts', kind: 'rename' },
          { path: '/src/d.ts' },
        ],
      },
    })
    expect(events).toEqual([
      {
        type: 'file_changed',
        path: '/src/a.ts',
        change: 'created',
        diff: '@@ -0,0 +1 @@',
      },
      { type: 'file_changed', path: '/src/b.ts', change: 'deleted', diff: undefined },
      { type: 'file_changed', path: '/src/c.ts', change: 'renamed', diff: undefined },
      // An unrecognized kind degrades to `modified` — the least destructive
      // interpretation for conflict reporting.
      { type: 'file_changed', path: '/src/d.ts', change: 'modified', diff: undefined },
    ])
  })

  test.each([
    ['added', 'created'],
    ['create', 'created'],
    ['deleted', 'deleted'],
    ['renamed', 'renamed'],
    ['modify', 'modified'],
    ['somethingNew', 'modified'],
  ])('change kind %s maps to %s', (kind, expected) => {
    const events = normalizeCodexNotification(CODEX_EVENT.itemCompleted, {
      item: { type: 'fileChange', changes: [{ path: '/x', kind }] },
    })
    expect(events[0]).toMatchObject({ change: expected })
  })

  test('a patch update reads the item or the params themselves', () => {
    expect(
      normalizeCodexNotification(CODEX_EVENT.fileChangePatchUpdated, {
        item: { type: 'fileChange', changes: [{ path: '/a' }] },
      }),
    ).toHaveLength(1)
    expect(
      normalizeCodexNotification(CODEX_EVENT.fileChangePatchUpdated, {
        type: 'fileChange',
        changes: [{ path: '/a' }, { path: '/b' }],
      }),
    ).toHaveLength(2)
  })

  test('a failed shell command becomes an agent_error, not a task failure', () => {
    // The turn is still running and may recover; only turn/completed decides the
    // task's fate.
    const events = normalizeCodexNotification(CODEX_EVENT.itemCompleted, {
      item: { type: 'commandExecution', status: 'failed', exitCode: 2 },
    })
    expect(events).toEqual([
      {
        type: 'agent_error',
        message: 'shell command failed (exit 2)',
        providerFault: false,
      },
    ])
  })

  test('a successful shell command emits nothing extra', () => {
    expect(
      normalizeCodexNotification(CODEX_EVENT.itemCompleted, {
        item: { type: 'commandExecution', status: 'completed', exitCode: 0 },
      }),
    ).toEqual([])
  })

  test('review output is surfaced as an agent message', () => {
    expect(
      normalizeCodexNotification(CODEX_EVENT.itemCompleted, {
        item: { type: 'exitedReviewMode', review: 'Looks good.' },
      }),
    ).toEqual([{ type: 'agent_message', text: 'Looks good.', delta: false }])
  })

  test('an unknown item type degrades to no events', () => {
    // Codex adds item variants between releases; throwing here would kill a live
    // agent on a Codex upgrade.
    expect(
      normalizeCodexNotification(CODEX_EVENT.itemStarted, {
        item: { id: 'x', type: 'someFutureItem' },
      }),
    ).toEqual([])
    expect(
      normalizeCodexNotification(CODEX_EVENT.itemCompleted, {
        item: { id: 'x', type: 'someFutureItem' },
      }),
    ).toEqual([])
  })

  test('a missing item does not throw', () => {
    expect(normalizeCodexNotification(CODEX_EVENT.itemStarted, {})).toEqual([])
    expect(
      normalizeCodexNotification(CODEX_EVENT.itemStarted, { item: null }),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Codex: turn and thread lifecycle
// ---------------------------------------------------------------------------

describe('codex turn completion', () => {
  test('a completed turn ends the task and goes idle', () => {
    expect(
      types(
        normalizeCodexNotification(CODEX_EVENT.turnCompleted, {
          turn: { id: 't1', status: 'completed' },
        }),
      ),
    ).toEqual(['task_completed', 'agent_idle'])
  })

  test('an interrupted turn goes idle WITHOUT failing the task', () => {
    // The user asked for it. Idle so queued work can drain.
    expect(
      types(
        normalizeCodexNotification(CODEX_EVENT.turnCompleted, {
          turn: { id: 't1', status: 'interrupted' },
        }),
      ),
    ).toEqual(['agent_idle'])
  })

  test('a failed turn reports task_failed with the codex tag as its code', () => {
    const events = normalizeCodexNotification(CODEX_EVENT.turnCompleted, {
      turn: {
        id: 't1',
        status: 'failed',
        error: {
          message: 'tool call rejected',
          codexErrorInfo: { InvalidRequest: {} },
        },
      },
    })
    expect(types(events)).toEqual(['task_failed', 'agent_idle'])
    expect(events[0]).toMatchObject({
      message: 'tool call rejected',
      code: 'InvalidRequest',
    })
  })

  test('a provider-fault failure reports agent_error and does NOT go idle', () => {
    // Going idle would let queued work dispatch straight into the same outage.
    const events = normalizeCodexNotification(CODEX_EVENT.turnCompleted, {
      turn: {
        id: 't1',
        status: 'failed',
        error: { message: 'rate limited', codexErrorInfo: 'rateLimitExceeded' },
      },
    })
    expect(events).toEqual([
      { type: 'agent_error', message: 'rate limited', providerFault: true },
    ])
  })

  test('a failed turn with no error message still reports something actionable', () => {
    const events = normalizeCodexNotification(CODEX_EVENT.turnCompleted, {
      turn: { id: 't1', status: 'failed' },
    })
    expect(events[0]).toMatchObject({ message: 'turn failed' })
  })

  test('an in-progress turn emits nothing', () => {
    expect(
      normalizeCodexNotification(CODEX_EVENT.turnCompleted, {
        turn: { id: 't1', status: 'inProgress' },
      }),
    ).toEqual([])
  })

  test('thread status idle and systemError map to events; active does not', () => {
    expect(
      normalizeCodexNotification(CODEX_EVENT.threadStatusChanged, {
        status: { type: 'idle' },
      }),
    ).toEqual([{ type: 'agent_idle' }])
    expect(
      normalizeCodexNotification(CODEX_EVENT.threadStatusChanged, {
        status: { type: 'systemError' },
      })[0],
    ).toMatchObject({ type: 'agent_error', providerFault: false })
    // `active` and `notLoaded` are tracked by adapter state; emitting them would
    // be noise with no action attached.
    for (const type of ['active', 'notLoaded']) {
      expect(
        normalizeCodexNotification(CODEX_EVENT.threadStatusChanged, {
          status: { type },
        }),
      ).toEqual([])
    }
  })

  test('thread closed reports a shutdown disconnect', () => {
    expect(
      normalizeCodexNotification(CODEX_EVENT.threadClosed, {}),
    ).toEqual([{ type: 'agent_disconnected', reason: 'shutdown' }])
  })

  test('a top-level error carries its tag and fault classification', () => {
    const events = normalizeCodexNotification(CODEX_EVENT.error, {
      error: { message: 'upstream 500', codexErrorInfo: 'InternalServerError' },
    })
    expect(events).toEqual([
      {
        type: 'agent_error',
        message: 'upstream 500',
        code: 'InternalServerError',
        providerFault: true,
      },
    ])
  })

  test('an error with no message still says something', () => {
    expect(
      normalizeCodexNotification(CODEX_EVENT.error, { error: {} })[0],
    ).toMatchObject({ message: 'Codex reported an error' })
  })

  test('a plan update renders readable checkbox lines', () => {
    const events = normalizeCodexNotification(CODEX_EVENT.turnPlanUpdated, {
      explanation: 'refactor auth',
      plan: [
        { step: 'read the code', status: 'completed' },
        { step: 'write the fix', status: 'inProgress' },
        { step: 'run tests', status: 'pending' },
      ],
    })
    expect(events).toHaveLength(1)
    const text = (events[0] as { text: string }).text
    expect(text).toContain('Plan: refactor auth')
    expect(text).toContain('[x] read the code')
    expect(text).toContain('[>] write the fix')
    expect(text).toContain('[ ] run tests')
  })

  test('a plan with no steps still renders a header', () => {
    const events = normalizeCodexNotification(CODEX_EVENT.turnPlanUpdated, {})
    expect((events[0] as { text: string }).text).toBe('Plan:')
  })
})

describe('codex deliberate no-ops', () => {
  test.each([
    CODEX_EVENT.turnStarted,
    CODEX_EVENT.threadStarted,
    CODEX_EVENT.turnDiffUpdated,
    CODEX_EVENT.warning,
    CODEX_EVENT.configWarning,
    CODEX_EVENT.serverRequestResolved,
  ])('%s produces no events', method => {
    expect(normalizeCodexNotification(method, { anything: true })).toEqual([])
  })

  test('warnings are NOT routed through agent_error', () => {
    // They are diagnostics, not agent output; surfacing one would interrupt
    // RAYU's model for a config note.
    expect(
      normalizeCodexNotification(CODEX_EVENT.warning, {
        message: 'config key deprecated',
      }),
    ).toEqual([])
  })

  test('an entirely unknown method degrades to no events', () => {
    expect(
      normalizeCodexNotification('thread/somethingInvented', { x: 1 }),
    ).toEqual([])
  })

  test('malformed params never throw', () => {
    for (const params of [undefined, null, 42, 'string', [], true]) {
      expect(() =>
        normalizeCodexNotification(CODEX_EVENT.itemCompleted, params),
      ).not.toThrow()
      expect(() =>
        normalizeCodexNotification(CODEX_EVENT.turnCompleted, params),
      ).not.toThrow()
      expect(() =>
        normalizeCodexNotification(CODEX_EVENT.agentMessageDelta, params),
      ).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// Codex: approvals
// ---------------------------------------------------------------------------

describe('codex approval requests', () => {
  test('a command approval describes the command and the cwd', () => {
    const events = normalizeApprovalRequest(
      CODEX_APPROVAL_REQUEST.command,
      { command: 'rm -rf build', cwd: '/proj', reason: 'not on the allowlist' },
      'req_1',
    )
    expect(events).toEqual([
      {
        type: 'permission_requested',
        requestId: 'req_1',
        kind: 'command',
        description: 'run: rm -rf build — not on the allowlist',
        cwd: '/proj',
      },
    ])
  })

  test('a file-change approval names the root it wants', () => {
    const events = normalizeApprovalRequest(
      CODEX_APPROVAL_REQUEST.fileChange,
      { grantRoot: '/proj/src' },
      'req_2',
    )
    expect(events[0]).toMatchObject({
      kind: 'file_change',
      description: 'apply file changes under /proj/src',
    })
  })

  test('a command approval with no command still reads sensibly', () => {
    expect(
      normalizeApprovalRequest(CODEX_APPROVAL_REQUEST.command, {}, 'r')[0],
    ).toMatchObject({ description: 'run: a shell command', cwd: undefined })
  })

  test('the requestId is echoed verbatim so the reply can be correlated', () => {
    const events = normalizeApprovalRequest(
      CODEX_APPROVAL_REQUEST.command,
      {},
      'server-request-id-42',
    )
    expect(events[0]).toMatchObject({ requestId: 'server-request-id-42' })
  })
})

// ---------------------------------------------------------------------------
// Claude Code: argv construction
// ---------------------------------------------------------------------------

describe('claude code argv', () => {
  test('always requests stream-json in both directions with verbose', () => {
    // --verbose is mandatory with stream-json output, and --replay-user-messages
    // requires stream-json on both sides. Both are applied unconditionally
    // rather than left to callers to remember.
    const args = buildClaudeArgs({})
    expect(args).toContain('-p')
    expect(args).toContain('--verbose')
    expect(args).toContain('--replay-user-messages')
    expect(args.join(' ')).toContain('--input-format stream-json')
    expect(args.join(' ')).toContain('--output-format stream-json')
  })

  test('NEVER emits a permission bypass flag', () => {
    // RAYU must not silently disarm another agent's approval prompts on the
    // user's behalf.
    const args = buildClaudeArgs({
      sessionId: newClaudeSessionId(),
      model: 'sonnet',
      permissionPromptTool: 'mcp__rayu__approve',
      addDirs: ['/a', '/b'],
      maxTurns: 10,
      maxBudgetUsd: 5,
    }).join(' ')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('bypassPermissions')
  })

  test('routes prompts back to RAYU instead', () => {
    const args = buildClaudeArgs({ permissionPromptTool: 'mcp__rayu__approve' })
    expect(args.join(' ')).toContain('--permission-prompt-tool mcp__rayu__approve')
  })

  test('resume wins over a fresh session id', () => {
    // Sending both would be ambiguous; resume is the caller's explicit intent.
    const args = buildClaudeArgs({
      resumeSessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
      sessionId: newClaudeSessionId(),
    })
    expect(args).toContain('--resume')
    expect(args).not.toContain('--session-id')
  })

  test('fork only applies with resume', () => {
    expect(
      buildClaudeArgs({
        resumeSessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
        forkSession: true,
      }),
    ).toContain('--fork-session')
    expect(
      buildClaudeArgs({ sessionId: newClaudeSessionId(), forkSession: true }),
    ).not.toContain('--fork-session')
  })

  test('rejects a non-UUID session id up front', () => {
    // Claude Code requires a UUID; failing here names the problem instead of
    // surfacing an opaque CLI error after spawn.
    expect(() => buildClaudeArgs({ sessionId: 'agent_01' })).toThrow(
      /must be a UUID|requires --session-id to be a UUID/,
    )
  })

  test('generated session ids validate', () => {
    const id = newClaudeSessionId()
    expect(isValidClaudeSessionId(id)).toBe(true)
    expect(isValidClaudeSessionId('not-a-uuid')).toBe(false)
    expect(isValidClaudeSessionId('')).toBe(false)
  })

  test('each add-dir gets its own flag', () => {
    const args = buildClaudeArgs({ addDirs: ['/one', '/two'] })
    expect(args.filter(a => a === '--add-dir')).toHaveLength(2)
  })

  test('optional limits are omitted when unset', () => {
    const args = buildClaudeArgs({}).join(' ')
    expect(args).not.toContain('--max-turns')
    expect(args).not.toContain('--max-budget-usd')
    expect(args).not.toContain('--model')
  })

  test('a user message is a stream-json user envelope', () => {
    expect(buildUserMessage('fix the bug')).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
    })
  })
})

// ---------------------------------------------------------------------------
// Claude Code: normalization
// ---------------------------------------------------------------------------

describe('claude code envelope normalization', () => {
  function assistant(content: unknown) {
    return normalizeClaudeEnvelope({ type: 'assistant', message: { content } })
  }

  test('text blocks become non-delta agent messages', () => {
    expect(assistant([{ type: 'text', text: 'Hello' }])).toEqual([
      { type: 'agent_message', text: 'Hello', delta: false },
    ])
  })

  test('a string content field is tolerated', () => {
    expect(assistant('plain string reply')).toEqual([
      { type: 'agent_message', text: 'plain string reply', delta: false },
    ])
    expect(assistant('')).toEqual([])
  })

  test('thinking blocks are surfaced separately from text', () => {
    expect(assistant([{ type: 'thinking', thinking: 'hmm' }])).toEqual([
      { type: 'agent_thinking', text: 'hmm', delta: false },
    ])
  })

  test('one envelope can yield several events', () => {
    // Assistant output arrives as whole messages, not typed item notifications.
    const events = assistant([
      { type: 'text', text: 'Editing now.' },
      { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/a.ts' } },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } },
    ])
    expect(types(events)).toEqual([
      'agent_message',
      'tool_started',
      'file_changed',
      'tool_started',
    ])
  })

  test.each([...CLAUDE_FILE_WRITING_TOOLS])(
    '%s implies a file change',
    toolName => {
      const events = assistant([
        { type: 'tool_use', id: 't', name: toolName, input: { file_path: '/x.ts' } },
      ])
      expect(types(events)).toContain('file_changed')
    },
  )

  test('Write reports created while Edit reports modified', () => {
    const write = assistant([
      { type: 'tool_use', id: 't', name: 'Write', input: { file_path: '/n.ts' } },
    ])
    expect(write[1]).toMatchObject({ change: 'created' })
    const edit = assistant([
      { type: 'tool_use', id: 't', name: 'Edit', input: { file_path: '/n.ts' } },
    ])
    expect(edit[1]).toMatchObject({ change: 'modified' })
  })

  test('read-only tools are deliberately excluded', () => {
    // A false positive would make the Workspace Manager report conflicts that do
    // not exist.
    for (const name of ['Read', 'Grep', 'Glob', 'WebFetch', 'Bash']) {
      const events = assistant([
        { type: 'tool_use', id: 't', name, input: { file_path: '/x.ts' } },
      ])
      expect(types(events)).toEqual(['tool_started'])
    }
  })

  test('MultiEdit yields one deduplicated change per file', () => {
    const events = assistant([
      {
        type: 'tool_use',
        id: 't',
        name: 'MultiEdit',
        input: {
          edits: [
            { file_path: '/a.ts' },
            { file_path: '/b.ts' },
            { file_path: '/a.ts' },
          ],
        },
      },
    ])
    const paths = events
      .filter(e => e.type === 'file_changed')
      .map(e => (e as { path: string }).path)
    expect(paths).toEqual(['/a.ts', '/b.ts'])
  })

  test.each([
    ['file_path', { file_path: '/a.ts' }, ['/a.ts']],
    ['path', { path: '/b.ts' }, ['/b.ts']],
    ['notebook_path', { notebook_path: '/c.ipynb' }, ['/c.ipynb']],
    ['edits array', { edits: [{ file_path: '/d.ts' }] }, ['/d.ts']],
    ['unrecognized', { target: '/e.ts' }, []],
    ['empty', {}, []],
  ])('extractEditedPaths reads %s', (_label, input, expected) => {
    // An unrecognized shape yields no paths: a missed path means a missed
    // warning, while a wrong path would block an unrelated agent's write.
    expect(extractEditedPaths({ type: 'tool_use', input })).toEqual(expected)
  })

  test('tool summaries prefer command, then path, then pattern', () => {
    const command = assistant([
      { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls -la' } },
    ])
    expect(command[0]).toMatchObject({ summary: 'ls -la' })
    const path = assistant([
      { type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/f.ts' } },
    ])
    expect(path[0]).toMatchObject({ summary: '/f.ts' })
    const pattern = assistant([
      { type: 'tool_use', id: 't', name: 'Grep', input: { pattern: 'TODO' } },
    ])
    expect(pattern[0]).toMatchObject({ summary: 'TODO' })
    const none = assistant([{ type: 'tool_use', id: 't', name: 'X', input: {} }])
    expect(none[0]).toMatchObject({ summary: undefined })
  })

  test('a tool_use with no id or name degrades to placeholders', () => {
    expect(assistant([{ type: 'tool_use' }])[0]).toMatchObject({
      callId: 'unknown',
      toolName: 'unknown',
    })
  })

  test('tool results arrive on a user envelope', () => {
    expect(
      normalizeClaudeEnvelope({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'exit 0\n' },
          ],
        },
      }),
    ).toEqual([
      { type: 'tool_output', callId: 't1', chunk: 'exit 0\n', stream: 'stdout' },
    ])
  })

  test('an errored tool result goes to stderr', () => {
    const events = normalizeClaudeEnvelope({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'boom',
            is_error: true,
          },
        ],
      },
    })
    expect(events[0]).toMatchObject({ stream: 'stderr' })
  })

  test('a block-array tool result is joined', () => {
    const events = normalizeClaudeEnvelope({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
          },
        ],
      },
    })
    expect(events[0]).toMatchObject({ chunk: 'ab' })
  })

  test('a replayed user prompt produces nothing', () => {
    // --replay-user-messages echoes our own prompt back; emitting it would put
    // RAYU's input into the transcript as agent output.
    expect(
      normalizeClaudeEnvelope({
        type: 'user',
        message: { content: [{ type: 'text', text: 'fix the bug' }] },
      }),
    ).toEqual([])
  })

  test('an empty tool result emits nothing', () => {
    expect(
      normalizeClaudeEnvelope({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't', content: '' }],
        },
      }),
    ).toEqual([])
  })

  test('a successful result completes the task and goes idle', () => {
    expect(
      normalizeClaudeEnvelope({
        type: 'result',
        subtype: 'success',
        result: 'Refactored 3 files.',
      }),
    ).toEqual([
      { type: 'task_completed', summary: 'Refactored 3 files.' },
      { type: 'agent_idle' },
    ])
  })

  test('is_error overrides a success subtype', () => {
    expect(
      types(
        normalizeClaudeEnvelope({
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'partial',
        }),
      ),
    ).toEqual(['task_failed', 'agent_idle'])
  })

  test.each(['error_rate_limit', 'error_overloaded', 'error_api'])(
    '%s stays alive as a provider fault',
    subtype => {
      const events = normalizeClaudeEnvelope({ type: 'result', subtype })
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: 'agent_error',
        providerFault: true,
      })
    },
  )

  test.each(['error_max_turns', 'error_during_execution'])(
    '%s is a genuine task failure',
    subtype => {
      // Retrying without change would fail identically.
      const events = normalizeClaudeEnvelope({ type: 'result', subtype })
      expect(types(events)).toEqual(['task_failed', 'agent_idle'])
      expect(events[0]).toMatchObject({ code: subtype })
    },
  )

  test('a failure with no result text still names the subtype', () => {
    const events = normalizeClaudeEnvelope({
      type: 'result',
      subtype: 'error_max_turns',
    })
    expect((events[0] as { message: string }).message).toContain('error_max_turns')
  })

  test('partial deltas are only produced for the delta types we model', () => {
    expect(
      normalizeClaudeEnvelope({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'tok' },
        },
      }),
    ).toEqual([{ type: 'agent_message', text: 'tok', delta: true }])

    expect(
      normalizeClaudeEnvelope({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'hm' },
        },
      }),
    ).toEqual([{ type: 'agent_thinking', text: 'hm', delta: true }])

    expect(
      normalizeClaudeEnvelope({
        type: 'stream_event',
        event: { type: 'message_start' },
      }),
    ).toEqual([])
    expect(
      normalizeClaudeEnvelope({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{' },
        },
      }),
    ).toEqual([])
  })

  test('a system envelope produces nothing but carries the session id', () => {
    const envelope = {
      type: 'system',
      subtype: 'init',
      session_id: 'abcdef12-3456-7890-abcd-ef1234567890',
    }
    expect(normalizeClaudeEnvelope(envelope)).toEqual([])
    expect(extractSessionId(envelope)).toBe('abcdef12-3456-7890-abcd-ef1234567890')
  })

  test('extractSessionId returns undefined when absent', () => {
    expect(extractSessionId({ type: 'result' })).toBeUndefined()
    expect(extractSessionId({ session_id: '' })).toBeUndefined()
    expect(extractSessionId(null)).toBeUndefined()
  })

  test('only a result envelope is turn-terminal', () => {
    expect(isTurnTerminal({ type: 'result' })).toBe(true)
    expect(isTurnTerminal({ type: 'assistant' })).toBe(false)
    expect(isTurnTerminal({ type: 'system' })).toBe(false)
    expect(isTurnTerminal(null)).toBe(false)
  })

  test('a malformed envelope degrades to no events', () => {
    for (const raw of [undefined, null, 42, 'text', [], {}, { type: 'brand_new' }]) {
      expect(normalizeClaudeEnvelope(raw)).toEqual([])
    }
  })

  test('an unknown content block is skipped without losing its siblings', () => {
    const events = assistant([
      { type: 'future_block', payload: 1 },
      { type: 'text', text: 'still here' },
    ])
    expect(types(events)).toEqual(['agent_message'])
  })
})
