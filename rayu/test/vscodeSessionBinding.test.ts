import { expect, test } from 'bun:test'
import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import { chatReducer, initialChatState, type ChatState } from '../src/vscode/webview/state/reducer.js'
import { sessionCallbacks } from './helpers/vscodeSession.js'

test('session identity changes are published once and use the current working directory', () => {
  const ids: (string | null)[] = []
  const session = new ChatSession(
    { enginePath: '/nonexistent/engine.mjs', cwd: '/tmp/original', resumeSessionId: 'existing' },
    sessionCallbacks({ onSessionIdChanged: id => ids.push(id) }),
  )
  try {
    const receive = (session as unknown as {
      handleEngineMessage: (message: Record<string, unknown>) => void
    }).handleEngineMessage.bind(session)
    receive({ type: 'fixture', session_id: 'existing' })
    expect(ids).toEqual([])
    receive({ type: 'fixture', session_id: 'assigned' })
    receive({ type: 'fixture', session_id: 'assigned' })
    expect(ids).toEqual(['assigned'])
    session.newSession(undefined, '/tmp/next', { preserveModel: true })
    expect(ids).toEqual(['assigned', null])
    expect(session.workingDirectory).toBe('/tmp/next')
    session.newSession('resumed', undefined, { preserveModel: true })
    expect(ids).toEqual(['assigned', null, 'resumed'])
  } finally {
    session.dispose()
  }
})

test('binding updates preserve the transcript and reject another tab or a sidebar', () => {
  const panel: ChatState = {
    ...initialChatState,
    surface: 'panel', activeSessionKey: 'panel-a',
    surfaceBinding: { sessionKey: 'panel-a', cwd: '/tmp/a' },
    entries: [{ id: 'streaming', kind: 'assistant', text: 'partial', streaming: true }],
  }
  const binding = { sessionKey: 'panel-a', sessionId: 'engine-a', cwd: '/tmp/a', customTitle: 'Title' }
  const next = chatReducer(panel, { type: 'setSurfaceBinding', binding })
  expect(next.surfaceBinding).toEqual(binding)
  expect(next.entries).toBe(panel.entries)
  expect(next.activeSessionKey).toBe(panel.activeSessionKey)
  expect(chatReducer(next, { type: 'setSurfaceBinding', binding: { ...binding } })).toBe(next)
  expect(chatReducer(next, {
    type: 'setSurfaceBinding', binding: { ...binding, sessionKey: 'panel-b' },
  })).toBe(next)
  expect(chatReducer(initialChatState, { type: 'setSurfaceBinding', binding })).toBe(initialChatState)
  const cleared = chatReducer(next, {
    type: 'setSurfaceBinding', binding: { sessionKey: 'panel-a', cwd: '/tmp/a' },
  })
  expect(cleared.surfaceBinding?.sessionId).toBeUndefined()
  expect(cleared.surfaceBinding?.customTitle).toBeUndefined()
})
