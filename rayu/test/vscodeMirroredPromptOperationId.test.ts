import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  startSessionIpc,
  stopSessionIpc,
  getSessionIpcInfo,
} from '../src/ipc/sessionServer.js'
import { registerTelegramSessionHandlers } from '../src/telegram/telegramSessionHandlers.js'
import { attachToCliSession, type AttachmentCallbacks } from '../src/vscode/host/attach/cliAttachment.js'
import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import { sessionCallbacks } from './helpers/vscodeSession.js'

function noopCallbacks(): AttachmentCallbacks {
  return {
    onStreamStart() {}, onStreamDelta() {}, onStreamThinking() {}, onStreamEnd() {},
    onActivity() {}, onPermissionRequest() {}, onPermissionDismiss() {}, onClosed() {},
  }
}

/**
 * `submitPrompt`'s returned operationId is what lets `recordMirroredPrompt` tag its
 * FIFO entry with the SAME id the CLI acknowledged — this is the actual wire round
 * trip (real socket, real session server, real `registerTelegramSessionHandlers`
 * queue handler), not a mock of either side.
 */
test('submitPrompt resolves with a fresh operationId, and the CLI ack echoes the same one back', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rayucode-opid-'))
  const old = process.env.RAYU_CONFIG_DIR
  process.env.RAYU_CONFIG_DIR = directory
  let handle: Awaited<ReturnType<typeof attachToCliSession>> = null
  try {
    registerTelegramSessionHandlers()
    await startSessionIpc()
    const info = getSessionIpcInfo()!
    const target = {
      pid: process.pid,
      sessionId: 'fixture-session',
      cwd: directory,
      startedAt: Date.now(),
      ipcAddress: info.address,
      ipcToken: info.token,
    }
    handle = await attachToCliSession(target, noopCallbacks())
    expect(handle).not.toBeNull()

    const firstId = await handle!.submitPrompt('do the thing')
    const secondId = await handle!.submitPrompt('do the thing')

    // Same text, but each submission gets its OWN id — this is precisely the
    // property text-only matching could not guarantee.
    expect(typeof firstId).toBe('string')
    expect(firstId.length).toBeGreaterThan(0)
    expect(secondId).not.toBe(firstId)
  } finally {
    handle?.detach()
    await stopSessionIpc()
    if (old === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = old
    rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * `recordMirroredPrompt`'s FIFO entry now carries whatever operationId it was given —
 * this is the host-side half, independent of the wire transport above.
 */
test('recordMirroredPrompt tags its FIFO entry with the given operationId', () => {
  const session = new ChatSession({ enginePath: '/unused', cwd: tmpdir() }, sessionCallbacks())
  session.recordMirroredPrompt('hello', 'normal', 'op-aaa')
  session.recordMirroredPrompt('hello', 'normal', 'op-bbb')

  const pending = (session as any).mirroredPendingPrompts as Array<{
    text: string
    operationId?: string
  }>
  expect(pending).toEqual([
    { text: 'hello', operationId: 'op-aaa' },
    { text: 'hello', operationId: 'op-bbb' },
  ])
  session.dispose()
})

test('recordMirroredPrompt omits operationId entirely when none is given', () => {
  const session = new ChatSession({ enginePath: '/unused', cwd: tmpdir() }, sessionCallbacks())
  session.recordMirroredPrompt('hello')

  const pending = (session as any).mirroredPendingPrompts as Array<{
    text: string
    operationId?: string
  }>
  expect(pending).toEqual([{ text: 'hello' }])
  expect('operationId' in pending[0]!).toBe(false)
  session.dispose()
})
