/**
 * Tests for IPC_CONVERSATION_SNAPSHOT round trip (Task 12).
 *
 * Verifies:
 *  1. A CLI that has registered the handler returns a valid snapshot
 *  2. The snapshot payload has the expected shape (version + messages array)
 *  3. A CLI with no handler produces a graceful no-op (no crash, handle is still live)
 *  4. remoteActivity accumulates history that the snapshot returns
 */
import { expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  startSessionIpc,
  stopSessionIpc,
  getSessionIpcInfo,
  registerIpcHandler,
} from '../src/ipc/sessionServer.js'
import { attachToCliSession, type AttachmentCallbacks } from '../src/vscode/host/attach/cliAttachment.js'
import {
  IPC_CONVERSATION_SNAPSHOT,
  ATTACHED_RUNTIME_CAPABILITIES,
  IPC_CAPABILITIES,
} from '../src/vscode/shared/attachChannels.js'
import {
  remoteActivity,
  getActivityHistory,
  clearActivityHistory,
} from '../src/telegram/telegramRemoteBridge.js'

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

type Fixture = {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  ipcAddress: string
  ipcToken: string
}

async function withFixture(
  run: (target: Fixture) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'rayucode-conv-snap-'))
  const old = process.env.RAYU_CONFIG_DIR
  process.env.RAYU_CONFIG_DIR = directory
  try {
    await startSessionIpc()
    const info = getSessionIpcInfo()!
    await run({
      pid: process.pid,
      sessionId: 'fixture-conv',
      cwd: directory,
      startedAt: Date.now(),
      ipcAddress: info.address,
      ipcToken: info.token,
    })
  } finally {
    await stopSessionIpc()
    if (old === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = old
    rmSync(directory, { recursive: true, force: true })
  }
}

beforeEach(() => {
  clearActivityHistory()
})

afterEach(() => {
  clearActivityHistory()
})

test('remoteActivity accumulates messages in activity history', () => {
  const msg1 = { type: 'assistant', message: { role: 'assistant', content: 'Hello' } }
  const msg2 = { type: 'user', message: { role: 'user', content: 'Hi' } }

  remoteActivity([msg1])
  remoteActivity([msg2])

  const history = getActivityHistory()
  expect(history).toHaveLength(2)
  expect(history[0]).toEqual([msg1])
  expect(history[1]).toEqual([msg2])
})

test('clearActivityHistory resets the accumulator', () => {
  remoteActivity([{ type: 'assistant', message: { content: 'A' } }])
  expect(getActivityHistory()).toHaveLength(1)
  clearActivityHistory()
  expect(getActivityHistory()).toHaveLength(0)
})

test('IPC_CONVERSATION_SNAPSHOT handler returns version 1 with flat messages', async () => {
  await withFixture(async target => {
    // Pre-populate activity history with two batches
    const batch1 = [{ type: 'assistant', message: { role: 'assistant', content: 'Turn 1' } }]
    const batch2 = [{ type: 'user', message: { role: 'user', content: 'Turn 2 prompt' } }]
    remoteActivity(batch1)
    remoteActivity(batch2)

    // Register capabilities + conversation snapshot handler
    const unregisterCaps = registerIpcHandler(IPC_CAPABILITIES, () => ATTACHED_RUNTIME_CAPABILITIES)
    const unregisterSnapshot = registerIpcHandler(IPC_CONVERSATION_SNAPSHOT, () => ({
      version: 1,
      messages: getActivityHistory().flat(),
    }))

    let receivedMessages: unknown[] = []
    let handle: Awaited<ReturnType<typeof attachToCliSession>> = null
    try {
      handle = await attachToCliSession(target, {
        ...noopCallbacks(),
        onConversationSnapshot: messages => {
          receivedMessages = messages
        },
      })

      expect(handle).not.toBeNull()
      expect(handle!.capabilities?.features.conversationSnapshot).toBe(true)
      // Both batches flattened into one array
      expect(receivedMessages).toHaveLength(2)
      expect((receivedMessages[0] as { type: string }).type).toBe('assistant')
      expect((receivedMessages[1] as { type: string }).type).toBe('user')
    } finally {
      handle?.detach()
      unregisterCaps()
      unregisterSnapshot()
    }
  })
})

test('attachment succeeds even when CLI has no IPC_CONVERSATION_SNAPSHOT handler', async () => {
  await withFixture(async target => {
    let snapshotCalled = false
    let handle: Awaited<ReturnType<typeof attachToCliSession>> = null
    try {
      handle = await attachToCliSession(target, {
        ...noopCallbacks(),
        onConversationSnapshot: () => {
          snapshotCalled = true
        },
      })

      // Handle is live even without the snapshot
      expect(handle).not.toBeNull()
      // Callback was NOT called since the CLI returned null capabilities
      expect(snapshotCalled).toBe(false)
    } finally {
      handle?.detach()
    }
  })
})

test('IPC_CONVERSATION_SNAPSHOT is not requested when capabilities.conversationSnapshot is false', async () => {
  await withFixture(async target => {
    // Register capabilities that disable conversation snapshot
    const unregisterCaps = registerIpcHandler(IPC_CAPABILITIES, () => ({
      ...ATTACHED_RUNTIME_CAPABILITIES,
      features: { ...ATTACHED_RUNTIME_CAPABILITIES.features, conversationSnapshot: false },
    }))

    let snapshotCalled = false
    let handle: Awaited<ReturnType<typeof attachToCliSession>> = null
    try {
      handle = await attachToCliSession(target, {
        ...noopCallbacks(),
        onConversationSnapshot: () => {
          snapshotCalled = true
        },
      })

      expect(handle).not.toBeNull()
      expect(handle!.capabilities?.features.conversationSnapshot).toBe(false)
      expect(snapshotCalled).toBe(false)
    } finally {
      handle?.detach()
      unregisterCaps()
    }
  })
})
