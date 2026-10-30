/**
 * The Rayucode panel's turn line with what the Rayu gateway charged:
 * `✓ Completed in 5s · ↑ 1.2k input · ↓ 300 output · Credits: 443.76`.
 *
 * The figure travels engine → `result.rayu_credits` → `ControlClient` (zod-validated:
 * an unknown key would be STRIPPED here) → `ChatSession.completeTurn` →
 * `TurnCompletionEntry.credits` → `TurnEndEntry`. The session tests drive the REAL
 * `ChatSession` with a scripted fake engine, the pattern
 * `vscodeInformationalMessage.test.ts` uses, so the schema layer is exercised too.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import {
  creditsFromResultFrame,
  describeTurnCredits,
} from '../src/vscode/shared/turnProgress.js'
import type { TurnCompletionEntry } from '../src/vscode/shared/webviewProtocol.js'
import { TurnEndEntry } from '../src/vscode/webview/components/TranscriptEntryView.js'
import { sessionCallbacks, until } from './helpers/vscodeSession.js'

function completion(overrides: Partial<TurnCompletionEntry> = {}): TurnCompletionEntry {
  return {
    outcome: 'completed',
    durationMs: 5_000,
    usage: { inputTokens: 1_200, outputTokens: 300, inputEstimated: false, outputEstimated: false },
    ...overrides,
  }
}

describe('reading and describing the turn charge', () => {
  test('the result frame field is read only when it is a charge', () => {
    expect(creditsFromResultFrame({ type: 'result', rayu_credits: 443.76 })).toBe(443.76)
    expect(creditsFromResultFrame({ type: 'result', rayu_credits: 0 })).toBe(0)
    for (const value of [undefined, -1, Number.NaN, '443.76', null]) {
      expect(creditsFromResultFrame({ type: 'result', rayu_credits: value })).toBeUndefined()
    }
    expect(creditsFromResultFrame(undefined)).toBeUndefined()
  })

  test('a charged turn is described with the same label as the terminal', () => {
    expect(describeTurnCredits(completion({ credits: 443.76 }))?.text).toBe('Credits: 443.76')
    // The tooltip keeps the figure the label had to round away.
    const tiny = describeTurnCredits(completion({ credits: 0.000292 }))
    expect(tiny?.text).toBe('Credits: <0.01')
    expect(tiny?.title).toContain('0.000292')
  })

  test('a BYOK turn has no credits to describe', () => {
    expect(describeTurnCredits(completion())).toBeUndefined()
  })
})

describe('TurnEndEntry', () => {
  test('the completion line ends with the credits', () => {
    const html = renderToStaticMarkup(<TurnEndEntry completion={completion({ credits: 443.76 })} />)
    expect(html).toContain('Completed in 5s')
    expect(html).toContain('rc-turn-credits')
    // React escapes nothing here; the text node is exactly the label.
    expect(html.replace(/<[^>]+>/g, '')).toMatch(/output · Credits: 443\.76$/)
  })

  test('without a charge the line is unchanged', () => {
    const html = renderToStaticMarkup(<TurnEndEntry completion={completion()} />)
    expect(html).not.toContain('Credits')
    expect(html).not.toContain('rc-turn-credits')
  })
})

describe('the engine result frame reaches the completion', () => {
  let tempDir: string
  let fakeEngineScript: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rayucode-turn-credits-'))
    fakeEngineScript = join(tempDir, 'fakeEngine.cjs')
  })

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
  })

  /** A fake engine that settles every prompt with one `result` frame carrying `extra`. */
  function writeFakeEngine(extra: Record<string, unknown>): void {
    const result = {
      type: 'result', subtype: 'success', duration_ms: 5000, duration_api_ms: 4000,
      is_error: false, num_turns: 1, result: 'ok', stop_reason: 'end_turn',
      total_cost_usd: 0, usage: { input_tokens: 1200, output_tokens: 300,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, modelUsage: {},
      permission_denials: [], uuid: '00000000-0000-0000-0000-000000000077',
      session_id: 'test-session-id', ...extra,
    }
    writeFileSync(fakeEngineScript, `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') {
    process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: msg.request_id, response: {} },
    }) + '\\n');
    return;
  }
  if (msg.type === 'user') process.stdout.write(${JSON.stringify(JSON.stringify(result))} + '\\n');
});
`, { mode: 0o755 })
  }

  async function finishOneTurn(): Promise<TurnCompletionEntry[]> {
    const completions: TurnCompletionEntry[] = []
    const session = new (ChatSession as any)(
      { enginePath: fakeEngineScript, cwd: tempDir },
      sessionCallbacks({ onTurnCompleted: (_turnId, done) => completions.push(done) }),
    )
    try {
      await session.submitPrompt('hello')
      await until(() => completions.length > 0, 5_000)
      return completions
    } finally {
      session.dispose()
    }
  }

  test('rayu_credits survives frame validation and lands on the completion', async () => {
    writeFakeEngine({ rayu_credits: 443.76 })
    const [done] = await finishOneTurn()
    expect(done?.outcome).toBe('completed')
    expect(done?.credits).toBe(443.76)
  })

  test('an engine that reports no charge leaves credits absent', async () => {
    writeFakeEngine({})
    const [done] = await finishOneTurn()
    expect(done?.outcome).toBe('completed')
    expect(done && 'credits' in done).toBe(false)
  })
})
