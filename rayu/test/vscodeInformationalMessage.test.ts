/**
 * The `'informational'` system message — `createSystemMessage()` in
 * `utils/messages.ts` — reaching the Rayucode panel.
 *
 * ── THE BUG THIS GUARDS ─────────────────────────────────────────────────────────
 *
 * `createSystemMessage()` is the ONE general-purpose notice constructor, used
 * identically by the interactive REPL and the headless query loop — including
 * the "your image was silently dropped because this model is text-only" warning
 * drained from `drainImageDropNotices()` in query.ts, and any other one-off
 * informational/warning/error notice.
 *
 * It had NO matching wire schema at all: `SDKMessageSchema`'s union (in
 * `src/protocol/coreSchemas.ts`) listed every other system subtype
 * (`init`, `compact_boundary`, `status`, `post_turn_summary`, `api_retry`, …) but
 * never `'informational'`. Every `{ type: 'system', subtype: 'informational' }`
 * frame therefore failed `StdoutMessageSchema().safeParse()` in
 * `ControlClient.handleFrame()` — and since it is a one-way narration frame (not
 * a control envelope), the failure path is `onUnknownFrame?.()` followed by a
 * silent `return`. The frame never reached `sessionHandle.ts`'s
 * `handleSystemMessage`, so a warning the engine had already composed with
 * clear, specific wording (e.g. "the model is text-only, your image was not
 * sent, run /model to switch") never reached the panel. The user saw nothing at
 * all — indistinguishable from Rayucode losing the attachment silently, rather
 * than the model correctly and deliberately declining to accept it.
 *
 * `SDKInformationalMessageSchema` (new) closes the gap at the schema layer;
 * `sessionHandle.ts`'s new `case 'informational':` renders it as a transcript
 * notice, mapping the engine's `level` ('info' | 'warning' | 'error') onto the
 * transcript's `severity`.
 *
 * ── WHY THIS TEST USES A SCRIPTED FAKE ENGINE, NOT THE REAL ONE ────────────────
 *
 * This exercises the REAL `ChatSession` / `ControlClient` / schema-validation
 * code — the exact layer that dropped the frame — driving it with a scripted
 * child process that emits the frame directly, the same pattern
 * `vscodeE2ePackaging.test.ts` already uses. No real engine, no provider, no
 * network call, no cost: the fake engine is a ~15-line Node script that echoes
 * back a canned NDJSON frame.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import { sessionCallbacks, until } from './helpers/vscodeSession.js'

describe('the informational system message reaches the panel', () => {
  let tempDir: string
  let fakeEngineScript: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rayucode-informational-'))
    fakeEngineScript = join(tempDir, 'fakeEngine.cjs')
  })

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
  })

  /** Writes a fake engine that answers every control_request generically (success,
   *  empty payload — enough for ChatSession's initialize handshake to complete),
   *  and, on receiving a `user` frame, replies with exactly the informational
   *  system frame under test, then a minimal successful result so the turn
   *  settles cleanly. */
  function writeFakeEngine(informationalFrame: Record<string, unknown>): void {
    const scriptContent = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.type === 'control_request') {
    // Generic success reply — ChatSession.start() sends 'initialize' before it
    // will send anything else, and later sessions may poll get_settings/
    // get_context_usage; an empty {} response is enough to unblock all of them
    // for this test, which only cares about the 'user' -> 'informational' path.
    process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: msg.request_id, response: {} },
    }) + '\\n');
    return;
  }

  if (msg.type === 'user') {
    process.stdout.write(${JSON.stringify(JSON.stringify(informationalFrame))} + '\\n');
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', duration_ms: 1, duration_api_ms: 1,
      is_error: false, num_turns: 1, result: 'ok', stop_reason: 'end_turn',
      total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, modelUsage: {},
      permission_denials: [], uuid: '00000000-0000-0000-0000-000000000099',
      session_id: 'test-session-id',
    }) + '\\n');
  }
});
`
    writeFileSync(fakeEngineScript, scriptContent, { mode: 0o755 })
  }

  test('a text-only-model image-drop warning renders as a warning notice', async () => {
    // The exact shape `createSystemMessage(notice, 'warning')` produces (see
    // utils/messages.ts) for the real notice `imageDroppedWarning()` composes.
    writeFakeEngine({
      type: 'system',
      subtype: 'informational',
      content:
        'The model "longcat-2" is text-only and cannot accept image input. ' +
        'Your image was not sent — the text was sent on its own. ' +
        'This is a limitation of the model, not of Rayu.',
      level: 'warning',
      isMeta: false,
      timestamp: new Date().toISOString(),
      uuid: '00000000-0000-0000-0000-000000000042',
    })

    const notices: Array<{ text: string; severity: string }> = []
    const session = new (ChatSession as any)(
      { enginePath: fakeEngineScript, cwd: tempDir },
      sessionCallbacks({
        onEntry: entry => {
          if (entry.kind === 'notice') notices.push({ text: entry.text, severity: entry.severity })
        },
      }),
    )

    try {
      await session.submitPrompt('@rayucode/AGENTS.md do you see my image?')
      await until(() => notices.length > 0, 5_000)

      expect(notices).toHaveLength(1)
      expect(notices[0]!.text).toContain('longcat-2')
      expect(notices[0]!.text).toContain('text-only')
      expect(notices[0]!.text).toContain('Your image was not sent')
      expect(notices[0]!.severity).toBe('warning')
    } finally {
      session.dispose()
    }
  })

  test('an error-level informational notice maps to error severity', async () => {
    writeFakeEngine({
      type: 'system',
      subtype: 'informational',
      content: 'Something failed hard.',
      level: 'error',
      isMeta: false,
      timestamp: new Date().toISOString(),
      uuid: '00000000-0000-0000-0000-000000000043',
    })

    const notices: Array<{ text: string; severity: string }> = []
    const session = new (ChatSession as any)(
      { enginePath: fakeEngineScript, cwd: tempDir },
      sessionCallbacks({
        onEntry: entry => {
          if (entry.kind === 'notice') notices.push({ text: entry.text, severity: entry.severity })
        },
      }),
    )

    try {
      await session.submitPrompt('trigger')
      await until(() => notices.length > 0, 5_000)
      expect(notices[0]!.severity).toBe('error')
    } finally {
      session.dispose()
    }
  })

  test('a plain info-level notice maps to info severity', async () => {
    writeFakeEngine({
      type: 'system',
      subtype: 'informational',
      content: 'Just so you know.',
      level: 'info',
      isMeta: false,
      timestamp: new Date().toISOString(),
      uuid: '00000000-0000-0000-0000-000000000044',
    })

    const notices: Array<{ text: string; severity: string }> = []
    const session = new (ChatSession as any)(
      { enginePath: fakeEngineScript, cwd: tempDir },
      sessionCallbacks({
        onEntry: entry => {
          if (entry.kind === 'notice') notices.push({ text: entry.text, severity: entry.severity })
        },
      }),
    )

    try {
      await session.submitPrompt('trigger')
      await until(() => notices.length > 0, 5_000)
      expect(notices[0]!.severity).toBe('info')
    } finally {
      session.dispose()
    }
  })

  test('empty content is dropped rather than rendered as a blank notice', async () => {
    writeFakeEngine({
      type: 'system',
      subtype: 'informational',
      content: '   ',
      level: 'info',
      isMeta: false,
      timestamp: new Date().toISOString(),
      uuid: '00000000-0000-0000-0000-000000000045',
    })

    let sawNotice = false
    const session = new (ChatSession as any)(
      { enginePath: fakeEngineScript, cwd: tempDir },
      sessionCallbacks({
        onEntry: entry => {
          if (entry.kind === 'notice') sawNotice = true
        },
      }),
    )

    try {
      await session.submitPrompt('trigger')
      // Give the frame time to arrive and NOT produce a notice.
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(sawNotice).toBe(false)
    } finally {
      session.dispose()
    }
  })
})
