/**
 * Which host→webview messages belong to the whole window, and which to one session.
 *
 * `GLOBAL_MESSAGE_TYPES` is the single list both delivery paths consult, so getting its
 * membership right is the difference between a panel receiving ITS session's state and a
 * panel receiving whichever session happens to be globally active. This pins the list
 * exactly, and pins the per-session types (including `init`, which is deliberately NOT a
 * broadcast) to `false`.
 *
 * Pure module: no `vscode` import, so this runs under `bun test` directly.
 */
import { describe, expect, test } from 'bun:test'

import {
  GLOBAL_MESSAGE_TYPES,
  isGlobalMessage,
} from '../src/vscode/host/panel/surfaceRouting.js'
import type { HostToWebviewMessage } from '../src/vscode/shared/webviewProtocol.js'

const GLOBAL_TYPES = [
  'setSessions',
  'setLiveSessions',
  'setIdeContext',
  'setProviderSetup',
  'setModelChooser',
] as const satisfies readonly HostToWebviewMessage['type'][]

/** A representative set of per-session pushes, spanning several message families. */
const PER_SESSION_TYPES = [
  'init',
  'addMessage',
  'appendPartial',
  'completeMessage',
  'turnState',
  'setModelInfo',
  'setAttachment',
  'setSurfaceBinding',
  'setModelCatalogue',
  'setInferenceSettings',
  'setPermissionMode',
  'showPermissionRequest',
  'dismissPermissionRequest',
  'showError',
  'setContextUsage',
  'setTurnProgress',
  'turnCompleted',
  'updateThinking',
  'replaceTaskState',
  'appendToolOutput',
  'upsertTaskState',
  'toolOutputResolved',
  'taskOutputResolved',
  'setSessionStatus',
  'openTaskCenter',
  'insertPrompt',
] as const satisfies readonly HostToWebviewMessage['type'][]

describe('GLOBAL_MESSAGE_TYPES', () => {
  test('contains exactly the window-wide message types', () => {
    expect(GLOBAL_MESSAGE_TYPES.size).toBe(GLOBAL_TYPES.length)
    expect([...GLOBAL_MESSAGE_TYPES].sort()).toEqual([...GLOBAL_TYPES].sort())
  })

  test('isGlobalMessage is true for globals', () => {
    for (const type of GLOBAL_TYPES) {
      expect(isGlobalMessage(type), `${type} must be global`).toBe(true)
    }
  })

  test('isGlobalMessage is false for representative per-session types', () => {
    for (const type of PER_SESSION_TYPES) {
      expect(isGlobalMessage(type), `${type} must be per-session`).toBe(false)
    }
    // `init` is the one that would cause the most damage as a broadcast: a panel would
    // receive the ACTIVE session's snapshot instead of its own.
    expect(isGlobalMessage('init')).toBe(false)
  })
})
