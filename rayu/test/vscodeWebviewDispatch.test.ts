/**
 * Every `WebviewToHostMessage` variant routes to its handler, scope-first.
 *
 * The dispatch table is the single switch over the webview→host union, and the whole point
 * of per-session tabs is that a handler acts on the surface that SENT the message, never on
 * a globally-active one. So each case asserts two things: the right handler method fired,
 * and the ORIGINATING `SurfaceScope` was passed as its first argument, with the message's
 * own payload fields following it unchanged.
 *
 * Exhaustiveness over the union is enforced at COMPILE time (the `never` check in
 * `dispatchWebviewMessage`), so there is deliberately no runtime "unknown message" case.
 *
 * Pure modules only: `webviewDispatch` imports nothing that pulls in `vscode`.
 */
import { describe, expect, test } from 'bun:test'

import {
  dispatchWebviewMessage,
  type ChatViewHandlers,
  type SurfaceScope,
} from '../src/vscode/host/panel/webviewDispatch.js'
import type {
  HostToWebviewMessage,
  ImageInputView,
  WebviewToHostMessage,
} from '../src/vscode/shared/webviewProtocol.js'

type HandlerName = keyof ChatViewHandlers

interface RecordedCall {
  method: HandlerName
  args: unknown[]
}

/** Every handler method, so the spy is exhaustive over `ChatViewHandlers`. */
const HANDLER_NAMES: readonly HandlerName[] = [
  'ready',
  'submitPrompt',
  'interrupt',
  'newSession',
  'switchSession',
  'closeSession',
  'renameSession',
  'openSessionPanel',
  'resumeSessionPanel',
  'permissionResponse',
  'questionResponse',
  'selectModelValue',
  'refreshModelCatalogue',
  'setEffort',
  'listAttachable',
  'attachToSession',
  'detachFromSession',
  'providerSetupOpen',
  'providerSetupValidate',
  'providerSetupSave',
  'telegramConnectOpen',
  'telegramConnectStartHosted',
  'telegramConnectStartByo',
  'telegramConnectUnlink',
  'cyclePermissionMode',
  'setPermissionMode',
  'reviewKeep',
  'reviewUndo',
  'openReviewDiff',
  'openFile',
  'openExternal',
  'signIn',
  'signOut',
  'openProviderSetup',
  'openTelegramConnect',
  'openSettings',
  'findFiles',
  'resolveContextPaths',
  'pickContextPaths',
  'requestToolOutput',
  'requestTaskOutput',
  'modelChooserChoice',
  'modelChooserTarget',
  'modelChooserRefresh',
  'modelChooserDismiss',
  'mcpToggle',
  'mcpReconnect',
  'mcpAuthenticate',
  'mcpPasteCallback',
  'mcpClearAuth',
  'getMcpStatus',
  'mcpElicitationResponse',
  'reloadPlugins',
  'installSkill',
  'listSessions',
  'resumeSession',
  'stopTask',
  'sendTaskMessage',
]

function spyHandlers(): { handlers: ChatViewHandlers; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const bag = {} as Record<HandlerName, (...args: unknown[]) => void>
  for (const name of HANDLER_NAMES) {
    bag[name] = (...args: unknown[]) => {
      calls.push({ method: name, args })
    }
  }
  return { handlers: bag as unknown as ChatViewHandlers, calls }
}

function makeScope(kind: 'sidebar' | 'panel' = 'panel'): {
  scope: SurfaceScope
  replies: HostToWebviewMessage[]
} {
  const replies: HostToWebviewMessage[] = []
  const scope: SurfaceScope = {
    kind,
    sessionKey: 'panel-1',
    reply: message => replies.push(message),
    resync: () => {},
  }
  return { scope, replies }
}

const IMAGES: ImageInputView[] = [
  { name: 'shot.png', mediaType: 'image/png', data: 'AAAA' },
]

interface RouteCase {
  name: string
  message: WebviewToHostMessage
  method: HandlerName
  /** Args AFTER the leading scope. Undefined entries are the optional fields the dispatch forwards. */
  payload: unknown[]
}

const CASES: RouteCase[] = [
  { name: 'ready', message: { type: 'ready' }, method: 'ready', payload: [] },
  {
    name: 'submitPrompt',
    message: { type: 'submitPrompt', text: 'hello', images: IMAGES, delivery: 'queue' },
    method: 'submitPrompt',
    payload: ['hello', IMAGES, 'queue'],
  },
  { name: 'interrupt', message: { type: 'interrupt' }, method: 'interrupt', payload: [] },
  { name: 'newSession', message: { type: 'newSession' }, method: 'newSession', payload: [] },
  {
    name: 'switchSession',
    message: { type: 'switchSession', key: 'panel-2' },
    method: 'switchSession',
    payload: ['panel-2'],
  },
  {
    name: 'openSessionPanel',
    message: { type: 'openSessionPanel', key: 'panel-3' },
    method: 'openSessionPanel',
    payload: ['panel-3'],
  },
  {
    name: 'resumeSessionPanel',
    message: { type: 'resumeSessionPanel', id: 'sess-9' },
    method: 'resumeSessionPanel',
    payload: ['sess-9'],
  },
  {
    name: 'closeSession',
    message: { type: 'closeSession', key: 'panel-4' },
    method: 'closeSession',
    payload: ['panel-4'],
  },
  {
    name: 'renameSession',
    message: { type: 'renameSession', key: 'panel-5', id: 'sess-5', title: 'Renamed' },
    method: 'renameSession',
    payload: ['panel-5', 'sess-5', 'Renamed'],
  },
  {
    name: 'permissionResponse',
    message: { type: 'permissionResponse', requestId: 'req-1', decision: 'allow-once' },
    method: 'permissionResponse',
    payload: ['req-1', 'allow-once'],
  },
  {
    name: 'questionResponse',
    message: {
      type: 'questionResponse',
      requestId: 'req-2',
      answers: { q: 'a' },
      notes: { q: 'n' },
    },
    method: 'questionResponse',
    payload: ['req-2', { q: 'a' }, { q: 'n' }],
  },
  {
    name: 'selectModelValue',
    message: { type: 'selectModelValue', value: 'gpt-4o' },
    method: 'selectModelValue',
    payload: ['gpt-4o'],
  },
  {
    name: 'refreshModelCatalogue',
    message: { type: 'refreshModelCatalogue' },
    method: 'refreshModelCatalogue',
    payload: [],
  },
  {
    name: 'setEffort',
    message: { type: 'setEffort', level: 'high' },
    method: 'setEffort',
    payload: ['high'],
  },
  { name: 'listAttachable', message: { type: 'listAttachable' }, method: 'listAttachable', payload: [] },
  {
    name: 'attachToSession',
    message: { type: 'attachToSession', pid: 4242 },
    method: 'attachToSession',
    payload: [4242],
  },
  {
    name: 'detachFromSession',
    message: { type: 'detachFromSession' },
    method: 'detachFromSession',
    payload: [],
  },
  {
    name: 'providerSetupOpen',
    message: { type: 'providerSetupOpen', open: true },
    method: 'providerSetupOpen',
    payload: [true],
  },
  {
    name: 'providerSetupValidate',
    message: {
      type: 'providerSetupValidate',
      providerId: 'openai',
      apiKey: 'sk-x',
      baseURL: 'https://api.example.com',
    },
    method: 'providerSetupValidate',
    payload: ['openai', 'sk-x', 'https://api.example.com'],
  },
  {
    name: 'providerSetupSave',
    message: {
      type: 'providerSetupSave',
      providerId: 'openai',
      apiKey: 'sk-x',
      baseURL: 'https://api.example.com',
      model: 'gpt-4o',
    },
    method: 'providerSetupSave',
    payload: ['openai', 'sk-x', 'https://api.example.com', 'gpt-4o'],
  },
  {
    name: 'telegramConnectOpen',
    message: { type: 'telegramConnectOpen', open: true },
    method: 'telegramConnectOpen',
    payload: [true],
  },
  {
    name: 'telegramConnectStartHosted',
    message: { type: 'telegramConnectStartHosted' },
    method: 'telegramConnectStartHosted',
    payload: [],
  },
  {
    name: 'telegramConnectStartByo',
    message: { type: 'telegramConnectStartByo', token: '123456789:ABCDef' },
    method: 'telegramConnectStartByo',
    payload: ['123456789:ABCDef'],
  },
  {
    name: 'telegramConnectUnlink',
    message: { type: 'telegramConnectUnlink' },
    method: 'telegramConnectUnlink',
    payload: [],
  },
  {
    name: 'cyclePermissionMode',
    message: { type: 'cyclePermissionMode' },
    method: 'cyclePermissionMode',
    payload: [],
  },
  {
    name: 'setPermissionMode',
    message: { type: 'setPermissionMode', modeId: 'plan' },
    method: 'setPermissionMode',
    payload: ['plan'],
  },
  {
    name: 'reviewKeep',
    message: { type: 'reviewKeep', path: 'src/a.ts' },
    method: 'reviewKeep',
    payload: ['src/a.ts'],
  },
  {
    name: 'reviewUndo',
    message: { type: 'reviewUndo', path: 'src/b.ts' },
    method: 'reviewUndo',
    payload: ['src/b.ts'],
  },
  {
    name: 'openReviewDiff',
    message: { type: 'openReviewDiff', path: 'src/c.ts' },
    method: 'openReviewDiff',
    payload: ['src/c.ts'],
  },
  {
    name: 'openFile',
    message: { type: 'openFile', path: 'src/d.ts' },
    method: 'openFile',
    payload: ['src/d.ts'],
  },
  {
    name: 'openExternal',
    message: { type: 'openExternal', url: 'https://rayu.dev' },
    method: 'openExternal',
    payload: ['https://rayu.dev'],
  },
  { name: 'signIn', message: { type: 'signIn' }, method: 'signIn', payload: [] },
  { name: 'signOut', message: { type: 'signOut' }, method: 'signOut', payload: [] },
  {
    name: 'openProviderSetup',
    message: { type: 'openProviderSetup' },
    method: 'openProviderSetup',
    payload: [],
  },
  {
    name: 'openTelegramConnect',
    message: { type: 'openTelegramConnect' },
    method: 'openTelegramConnect',
    payload: [],
  },
  {
    name: 'openSettings',
    message: { type: 'openSettings', section: 'about' },
    method: 'openSettings',
    payload: ['about'],
  },
  {
    name: 'findFiles',
    message: { type: 'findFiles', query: 'index' },
    method: 'findFiles',
    payload: ['index'],
  },
  {
    name: 'resolveContextPaths',
    message: { type: 'resolveContextPaths', requestId: 'r1', uriList: 'file:///a.ts' },
    method: 'resolveContextPaths',
    payload: ['r1', 'file:///a.ts'],
  },
  {
    name: 'pickContextPaths',
    message: { type: 'pickContextPaths', requestId: 'r2' },
    method: 'pickContextPaths',
    payload: ['r2'],
  },
  {
    name: 'requestToolOutput',
    message: { type: 'requestToolOutput', requestId: 'r3', entryId: 'entry-1' },
    method: 'requestToolOutput',
    payload: ['r3', 'entry-1'],
  },
  {
    name: 'requestTaskOutput',
    message: { type: 'requestTaskOutput', requestId: 'r4', taskKey: 'task-1' },
    method: 'requestTaskOutput',
    payload: ['r4', 'task-1'],
  },
  {
    name: 'modelChooserChoice',
    message: {
      type: 'modelChooserChoice',
      target: 'subagent',
      value: 'gpt-4o',
      agentType: 'Explore',
    },
    method: 'modelChooserChoice',
    payload: ['subagent', 'gpt-4o', 'Explore'],
  },
  {
    name: 'modelChooserTarget',
    message: { type: 'modelChooserTarget', agentType: 'Explore' },
    method: 'modelChooserTarget',
    payload: ['Explore'],
  },
  {
    name: 'modelChooserChoice (image generation)',
    message: {
      type: 'modelChooserChoice',
      target: 'image',
      value: 'rayu-wan2.7-image',
    },
    method: 'modelChooserChoice',
    payload: ['image', 'rayu-wan2.7-image', undefined],
  },
  {
    name: 'modelChooserRefresh',
    message: { type: 'modelChooserRefresh' },
    method: 'modelChooserRefresh',
    payload: [],
  },
  {
    name: 'modelChooserDismiss',
    message: { type: 'modelChooserDismiss' },
    method: 'modelChooserDismiss',
    payload: [],
  },
  {
    name: 'mcpToggle',
    message: { type: 'mcpToggle', serverName: 'filesystem', enabled: false },
    method: 'mcpToggle',
    payload: ['filesystem', false],
  },
  {
    name: 'mcpReconnect',
    message: { type: 'mcpReconnect', serverName: 'github' },
    method: 'mcpReconnect',
    payload: ['github'],
  },
  {
    name: 'mcpAuthenticate',
    message: { type: 'mcpAuthenticate', serverName: 'github' },
    method: 'mcpAuthenticate',
    payload: ['github'],
  },
  {
    name: 'mcpPasteCallback',
    message: { type: 'mcpPasteCallback', serverName: 'github' },
    method: 'mcpPasteCallback',
    payload: ['github'],
  },
  {
    name: 'mcpClearAuth',
    message: { type: 'mcpClearAuth', serverName: 'github' },
    method: 'mcpClearAuth',
    payload: ['github'],
  },
  { name: 'getMcpStatus', message: { type: 'getMcpStatus' }, method: 'getMcpStatus', payload: [] },
  {
    name: 'mcpElicitationResponse',
    message: {
      type: 'mcpElicitationResponse',
      requestId: 'e1',
      action: 'accept',
      content: { field: 'value' },
    },
    method: 'mcpElicitationResponse',
    payload: ['e1', 'accept', { field: 'value' }],
  },
  { name: 'reloadPlugins', message: { type: 'reloadPlugins' }, method: 'reloadPlugins', payload: [] },
  {
    name: 'installSkill',
    message: { type: 'installSkill', source: 'owner/repo', overwrite: true },
    method: 'installSkill',
    payload: ['owner/repo', true],
  },
  { name: 'listSessions', message: { type: 'listSessions' }, method: 'listSessions', payload: [] },
  {
    name: 'resumeSession',
    message: { type: 'resumeSession', id: 'sess-77' },
    method: 'resumeSession',
    payload: ['sess-77'],
  },
  {
    name: 'stopTask',
    message: { type: 'stopTask', sourceSessionId: 'src-1', taskId: 'task-9' },
    method: 'stopTask',
    payload: ['src-1', 'task-9'],
  },
  {
    name: 'sendTaskMessage',
    message: { type: 'sendTaskMessage', sourceSessionId: 'src-2', taskId: 'task-8', text: 'go' },
    method: 'sendTaskMessage',
    payload: ['src-2', 'task-8', 'go'],
  },
]

describe('dispatchWebviewMessage routes every webview message to its handler', () => {
  // One test per union variant: 52 today. Adding a variant to the union without a case in
  // the dispatch is a compile error, and adding one without a row here leaves it untested.
  test('the case table covers the whole handler surface', () => {
    const routed = new Set(CASES.map(c => c.method))
    for (const name of HANDLER_NAMES) {
      expect(routed.has(name), `${name} has no routing case`).toBe(true)
    }
  })

  for (const testCase of CASES) {
    test(`${testCase.name} → ${testCase.method}`, () => {
      const handlers = spyHandlers()
      const { scope } = makeScope('panel')

      dispatchWebviewMessage(testCase.message, scope, handlers.handlers)

      expect(handlers.calls).toHaveLength(1)
      const call = handlers.calls[0]!
      expect(call.method).toBe(testCase.method)
      // The scope the SENDER is bound to leads every call — never a globally-active one.
      expect(call.args[0]).toBe(scope)
      expect(call.args.slice(1)).toEqual(testCase.payload)
    })
  }

  test('the originating scope is forwarded, not another surface', () => {
    const handlers = spyHandlers()
    const sidebar = makeScope('sidebar').scope
    const panel = makeScope('panel').scope

    dispatchWebviewMessage({ type: 'interrupt' }, sidebar, handlers.handlers)
    dispatchWebviewMessage({ type: 'interrupt' }, panel, handlers.handlers)

    expect(handlers.calls.map(call => call.args[0])).toEqual([sidebar, panel])
  })
})
