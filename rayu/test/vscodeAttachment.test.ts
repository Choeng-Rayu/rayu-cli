import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSessionIpc, stopSessionIpc, getSessionIpcInfo, notifyIpcPeers } from '../src/ipc/sessionServer.js'
import { registerTelegramSessionHandlers, parsePromptPayload } from '../src/telegram/telegramSessionHandlers.js'
import { getRemotePermissionCallbacks, isRemotelyAttached, remoteStreamStart, remoteStreamDelta, remoteStreamEnd } from '../src/telegram/telegramRemoteBridge.js'
import { attachToCliSession, toAttachableView, type AttachmentCallbacks } from '../src/vscode/host/attach/cliAttachment.js'
import { until } from './helpers/vscodeSession.js'

test('two real IPC interfaces share events and resolve once; detaching one leaves the other attached', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rayucode-ipc-'))
  const old = process.env.RAYU_CONFIG_DIR
  process.env.RAYU_CONFIG_DIR = directory
  let first: Awaited<ReturnType<typeof attachToCliSession>> = null
  let second: Awaited<ReturnType<typeof attachToCliSession>> = null
  try {
    registerTelegramSessionHandlers()
    await startSessionIpc()
    const info = getSessionIpcInfo()!
    expect(info).not.toBeNull()
    const target = { pid: process.pid, sessionId: 'fixture-session', cwd: directory, startedAt: Date.now(), ipcAddress: info.address, ipcToken: info.token }
    expect(JSON.stringify(toAttachableView(target))).not.toContain(info.token)
    expect(parsePromptPayload({ value: 'hello', mode: 'prompt' })).toEqual({ value: 'hello', mode: 'prompt' })
    const events: string[][] = [[], []]
    const callbacks = (index: number): AttachmentCallbacks => ({
      onStreamStart: () => { events[index]!.push('start') },
      onStreamDelta: delta => { events[index]!.push(delta) },
      onStreamThinking() {}, onStreamEnd: () => { events[index]!.push('end') },
      onActivity() {}, onPermissionRequest: r => { events[index]!.push(`ask:${r.requestId}`) },
      onPermissionDismiss: id => { events[index]!.push(`dismiss:${id}`) }, onClosed() {},
    })
    first = await attachToCliSession(target, callbacks(0))
    second = await attachToCliSession(target, callbacks(1))
    expect(first).not.toBeNull(); expect(second).not.toBeNull()
    await until(isRemotelyAttached)
    remoteStreamStart(); remoteStreamDelta('hello '); remoteStreamDelta('world'); remoteStreamEnd()
    notifyIpcPeers('future:unknown', {})
    const permissions = getRemotePermissionCallbacks()!
    let decisions = 0
    permissions.onResponse('approval', () => { decisions++ })
    permissions.sendRequest('approval', 'Bash', { command: 'true' }, 'tool', 'run check')
    await until(() => events.every(e => e.includes('ask:approval')))
    first!.respondPermission('approval', { behavior: 'allow' })
    second!.respondPermission('approval', { behavior: 'deny', message: 'late' })
    await until(() => events.every(e => e.includes('dismiss:approval')))
    expect(decisions).toBe(1)
    expect(events[0]!.slice(0, 4)).toEqual(['start', 'hello ', 'world', 'end'])
    expect(events[1]).toEqual(events[0])
    first!.detach(); first = null
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(isRemotelyAttached()).toBe(true)
  } finally {
    first?.detach(); second?.detach()
    await stopSessionIpc()
    if (old === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = old
    rmSync(directory, { recursive: true, force: true })
  }
})
