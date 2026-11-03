/**
 * Web Bridge protocol parity — rayu-cli's copy of the wire protocol vs rayu-backend's.
 *
 * `src/webBridge/client/protocol.ts` is a deliberate COPY of
 * rayu-backend/src/web-bridge/web-bridge.types.ts (see its header for why). Drift is
 * silent at runtime — an event that arrives and is ignored — so it has to be caught here.
 *
 * Two layers. The literal assertions always run and make a rename on THIS side loud.
 * The cross-check imports the backend's own file (it is plain constants, no imports)
 * when the backend is checked out alongside — the monorepo layout, or RAYU_BACKEND_DIR
 * — and catches drift on EITHER side. It is skipped, not failed, when the backend is
 * absent, so a CLI-only checkout still runs green.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import * as cli from '../src/webBridge/client/protocol.js'

const BACKEND_TYPES = resolve(
  process.env.RAYU_BACKEND_DIR ?? resolve(import.meta.dir, '../../../rayucode/rayu-backend'),
  'src/web-bridge/web-bridge.types.ts',
)

describe('protocol constants (literal)', () => {
  test('addressing', () => {
    // Under /api/ because the production proxy routes only /api/* to the backend.
    expect(cli.WEB_BRIDGE_WS_PATH).toBe('/api/rayu-ws')
    expect(cli.CLI_NAMESPACE).toBe('/cli-bridge')
    expect(cli.BROWSER_NAMESPACE).toBe('/web-bridge')
  })

  test('events the CLI sends', () => {
    expect(cli.CLI_EVENT).toEqual({
      CLI_HELLO: 'cli_hello',
      STREAM_DELTA: 'stream_delta',
      STREAM_END: 'stream_end',
      TOOL_CALL: 'tool_call',
      ACTIVITY: 'activity',
      PLAN_REQUEST: 'plan_request',
      QUESTION_REQUEST: 'question_request',
      CANCEL_REQUEST: 'cancel_request',
      INTERRUPT_ACK: 'interrupt_ack',
    })
  })

  test('commands the CLI receives', () => {
    expect(cli.CLI_COMMAND).toEqual({
      HELLO_ACK: 'hello_ack',
      PROMPT: 'prompt',
      DECISION: 'bridge_decision',
      TOOL_DECISION: 'tool_decision',
      INTERRUPT: 'interrupt',
      PLAN_DECISION: 'plan_decision',
      QUESTION_ANSWER: 'question_answer',
      TOKEN_EXPIRED: 'token_expired',
      BRIDGE_ERROR: 'bridge_error',
    })
  })
})

describe.skipIf(!existsSync(BACKEND_TYPES))('protocol constants (vs rayu-backend)', () => {
  test('every shared constant matches the backend definition', async () => {
    const backend = (await import(BACKEND_TYPES)) as Record<string, unknown>
    for (const name of [
      'WEB_BRIDGE_WS_PATH',
      'CLI_NAMESPACE',
      'BROWSER_NAMESPACE',
      'CLI_EVENT',
      'CLI_COMMAND',
      'MAX_PROMPT_CHARS',
      'MAX_DELTA_CHARS',
      'MAX_TEXT_CHARS',
      'MAX_TOOL_INPUT_CHARS',
    ]) {
      expect({ name, value: (cli as Record<string, unknown>)[name] }).toEqual({
        name,
        value: backend[name],
      })
    }
  })
})
