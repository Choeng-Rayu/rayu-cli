/**
 * Tests for IPC_RUNTIME_SNAPSHOT round trip (Task 15).
 *
 * Verifies:
 *  1. Runtime snapshot is returned on attach when capabilities.runtimeSnapshot is true
 *  2. Snapshot has the expected shape (version, sessionId, timestamp)
 *  3. IPC_RUNTIME_STATE_CHANGED push notification is delivered via onRuntimeStateChanged
 *  4. When capabilities.runtimeSnapshot is false, onRuntimeSnapshot is not called
 */
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  startSessionIpc,
  stopSessionIpc,
  getSessionIpcInfo,
  registerIpcHandler,
  notifyIpcPeers,
} from '../src/ipc/sessionServer.js'
import { attachToCliSession, type AttachmentCallbacks } from '../src/vscode/host/attach/cliAttachment.js'
import {
  IPC_CAPABILITIES,
  IPC_RUNTIME_SNAPSHOT,
  IPC_RUNTIME_STATE_CHANGED,
  ATTACHED_RUNTIME_CAPABILITIES,
} from '../src/vscode/shared/attachChannels.js'
import type { RuntimeStateSnapshot } from '../src/vscode/shared/attachProtocol.js'

function noopCallbacks(): AttachmentCallbacks {
  return {
    onStreamStart() {},
    onStreamDelta() {},
    onStreamThinking() {},
    onStreamEnd() {},
    onActivity() {},
    onPermissionRequest() {},
    onPermissionDismiss() {},
    onClosed() {},
  }
}

async function withFixture(
  run: (target: {
    pid: number; sessionId: string; cwd: string;
    startedAt: number; ipcAddress: string; ipcToken: string
  }) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'rayucode-runtime-snap-'))
  const old = process.env.RAYU_CONFIG_DIR
  process.env.RAYU_CONFIG_DIR = directory
  try {
    await startSessionIpc()
    const info = getSessionIpcInfo()!
    await run({
      pid: process.pid, sessionId: 'fixture-snap', cwd: directory,
      startedAt: Date.now(), ipcAddress: info.address, ipcToken: info.token,
    })
  } finally {
    await stopSessionIpc()
    if (old === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = old
    rmSync(directory, { recursive: true, force: true })
  }
}

const SAMPLE_SNAPSHOT: RuntimeStateSnapshot = {
  version: 1,
  sessionId: 'test-session',
  timestamp: Date.now(),
  model: { id: 'claude-3-5-sonnet', providerId: 'anthropic', displayName: 'Claude 3.5 Sonnet', supportsThinking: true },
  permissions: { mode: 'ask', pendingCount: 0 },
  thinking: { enabled: false, currentlyThinking: false },
  effort: null,
  taskList: null,
}

test('onRuntimeSnapshot is called with initial snapshot on attach', async () => {
  await withFixture(async target => {
    const unregisterCaps = registerIpcHandler(IPC_CAPABILITIES, () => ATTACHED_RUNTIME_CAPABILITIES)
    const unregisterSnap = registerIpcHandler(IPC_RUNTIME_SNAPSHOT, () => SAMPLE_SNAPSHOT)

    let receivedSnapshot: RuntimeStateSnapshot | null = null
    let handle: Awaited<ReturnType<typeof attachToCliSession>> = null
    try {
      handle = await attachToCliSession(target, {
        ...noopCallbacks(),
        onRuntimeSnapshot: snapshot => { receivedSnapshot = snapshot },
      })

      expect(handle).not.toBeNull()
      expect(handle!.capabilities?.features.runtimeSnapshot).toBe(true)
      expect(receivedSnapshot).not.toBeNull()
      expect(receivedSnapshot!.version).toBe(1)
      expect(receivedSnapshot!.sessionId).toBe('test-session')
      expect(receivedSnapshot!.model?.id).toBe('claude-3-5-sonnet')
    } finally {
      handle?.detach()
      unregisterCaps()
      unregisterSnap()
    }
  })
})

test('onRuntimeStateChanged fires when CLI pushes IPC_RUNTIME_STATE_CHANGED', async () => {
  await withFixture(async target => {
    const unregisterCaps = registerIpcHandler(IPC_CAPABILITIES, () => ATTACHED_RUNTIME_CAPABILITIES)
    const unregisterSnap = registerIpcHandler(IPC_RUNTIME_SNAPSHOT, () => SAMPLE_SNAPSHOT)

    const stateChanges: RuntimeStateSnapshot[] = []
    let handle: Awaited<ReturnType<typeof attachToCliSession>> = null
    try {
      handle = await attachToCliSession(target, {
        ...noopCallbacks(),
        onRuntimeSnapshot: () => {},
        onRuntimeStateChanged: s => stateChanges.push(s),
      })
      expect(handle).not.toBeNull()

      const updatedSnapshot: RuntimeStateSnapshot = {
        ...SAMPLE_SNAPSHOT,
        timestamp: Date.now(),
        thinking: { enabled: true, currentlyThinking: true },
      }
      notifyIpcPeers(IPC_RUNTIME_STATE_CHANGED, updatedSnapshot)

      // Give the notification a tick to propagate
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(stateChanges).toHaveLength(1)
      expect(stateChanges[0]!.thinking?.enabled).toBe(true)
    } finally {
      handle?.detach()
      unregisterCaps()
      unregisterSnap()
    }
  })
})

test('onRuntimeSnapshot is not called when capabilities.runtimeSnapshot is false', async () => {
  await withFixture(async target => {
    const unregisterCaps = registerIpcHandler(IPC_CAPABILITIES, () => ({
      ...ATTACHED_RUNTIME_CAPABILITIES,
      features: { ...ATTACHED_RUNTIME_CAPABILITIES.features, runtimeSnapshot: false },
    }))

    let called = false
    let handle: Awaited<ReturnType<typeof attachToCliSession>> = null
    try {
      handle = await attachToCliSession(target, {
        ...noopCallbacks(),
        onRuntimeSnapshot: () => { called = true },
      })
      expect(handle).not.toBeNull()
      expect(called).toBe(false)
    } finally {
      handle?.detach()
      unregisterCaps()
    }
  })
})

test('RuntimeStateSnapshot required fields are present and typed correctly', () => {
  const snapshot: RuntimeStateSnapshot = {
    version: 1,
    sessionId: 'abc',
    timestamp: Date.now(),
  }
  expect(snapshot.version).toBe(1)
  expect(typeof snapshot.sessionId).toBe('string')
  expect(typeof snapshot.timestamp).toBe('number')
  // Optional fields are absent
  expect(snapshot.model).toBeUndefined()
  expect(snapshot.mcp).toBeUndefined()
})
