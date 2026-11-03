import { expect, test } from 'bun:test'
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
  ATTACHED_RUNTIME_CAPABILITIES,
  IPC_CAPABILITIES,
} from '../src/vscode/shared/attachChannels.js'

function noopCallbacks(): AttachmentCallbacks {
  return {
    onStreamStart() {}, onStreamDelta() {}, onStreamThinking() {}, onStreamEnd() {},
    onActivity() {}, onPermissionRequest() {}, onPermissionDismiss() {}, onClosed() {},
  }
}

async function withFixture(
  run: (target: {
    pid: number
    sessionId: string
    cwd: string
    startedAt: number
    ipcAddress: string
    ipcToken: string
  }) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'rayucode-caps-'))
  const old = process.env.RAYU_CONFIG_DIR
  process.env.RAYU_CONFIG_DIR = directory
  try {
    await startSessionIpc()
    const info = getSessionIpcInfo()!
    await run({
      pid: process.pid,
      sessionId: 'fixture-session',
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

/**
 * Exercises the SAME `registerIpcHandler(IPC_CAPABILITIES, ...)` call
 * `useRayucodeTaskBridge.ts` makes, without mounting React — this is the CLI-side
 * half of capability negotiation.
 */
test('a CLI that answers IPC_CAPABILITIES hands its real feature map to the attaching panel', async () => {
  await withFixture(async target => {
    const unregister = registerIpcHandler(IPC_CAPABILITIES, () => ATTACHED_RUNTIME_CAPABILITIES)
    let handle: Awaited<ReturnType<typeof attachToCliSession>> = null
    try {
      handle = await attachToCliSession(target, noopCallbacks())
      expect(handle).not.toBeNull()
      expect(handle!.capabilities).toEqual(ATTACHED_RUNTIME_CAPABILITIES)
      expect(handle!.capabilities!.features.sideQuestions).toBe(true)
      expect(handle!.capabilities!.features.conversationSnapshot).toBe(true)
    } finally {
      handle?.detach()
      unregister()
    }
  })
})

test('a CLI with no IPC_CAPABILITIES handler at all attaches with capabilities: null, not an error', async () => {
  // No `registerIpcHandler(IPC_CAPABILITIES, ...)` call — this reproduces exactly
  // what an older, already-installed CLI looks like: the request type is simply
  // unknown to it, so the server answers "unsupported request" and the attach must
  // still succeed with everything else (chat mirroring) intact.
  await withFixture(async target => {
    let handle: Awaited<ReturnType<typeof attachToCliSession>> = null
    try {
      handle = await attachToCliSession(target, noopCallbacks())
      expect(handle).not.toBeNull()
      expect(handle!.capabilities).toBeNull()
    } finally {
      handle?.detach()
    }
  })
})

test('a malformed IPC_CAPABILITIES response is treated as null rather than trusted', async () => {
  await withFixture(async target => {
    const unregister = registerIpcHandler(IPC_CAPABILITIES, () => ({ notTheRightShape: true }))
    let handle: Awaited<ReturnType<typeof attachToCliSession>> = null
    try {
      handle = await attachToCliSession(target, noopCallbacks())
      expect(handle).not.toBeNull()
      expect(handle!.capabilities).toBeNull()
    } finally {
      handle?.detach()
      unregister()
    }
  })
})
