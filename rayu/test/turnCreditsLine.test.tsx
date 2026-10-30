/**
 * The terminal's turn line with what the Rayu gateway charged:
 * `✻ Rayu worked for 5s · Credits: 443.76`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'

import { SystemTextMessage } from '../src/components/messages/SystemTextMessage.tsx'
import { AppStateProvider } from '../src/state/AppState.tsx'
import { getGlobalConfig, saveGlobalConfig } from '../src/utils/config.js'
import { createTurnDurationMessage } from '../src/utils/messages.ts'
import { renderToString } from '../src/utils/staticRender.tsx'

const originalShowTurnDuration = getGlobalConfig().showTurnDuration

afterEach(() => {
  saveGlobalConfig(config => ({ ...config, showTurnDuration: originalShowTurnDuration }))
})

async function line(message: ReturnType<typeof createTurnDurationMessage>): Promise<string> {
  const out = await renderToString(
    <AppStateProvider>
      <SystemTextMessage message={message} addMargin={false} verbose={false} />
    </AppStateProvider>,
    120,
  )
  return out.trim()
}

describe('createTurnDurationMessage', () => {
  test('carries the credits only when the turn was charged', () => {
    expect(createTurnDurationMessage(5_000, undefined, 3, 443.76).rayuCredits).toBe(443.76)
    expect(createTurnDurationMessage(5_000, undefined, 3, 0).rayuCredits).toBe(0)
    expect('rayuCredits' in createTurnDurationMessage(5_000, undefined, 3)).toBe(false)
  })
})

describe('turn line', () => {
  test('a charged turn ends with its credits', async () => {
    const text = await line(createTurnDurationMessage(5_000, undefined, 0, 443.76))
    expect(text).toMatch(/Rayu \S+ for 5s · Credits: 443\.76$/)
  })

  test('a turn the gateway did not charge keeps the plain line', async () => {
    const text = await line(createTurnDurationMessage(5_000, undefined, 0))
    expect(text).toMatch(/Rayu \S+ for 5s$/)
    expect(text).not.toContain('Credits')
  })

  test('a sub-second charged turn shows its credits without "worked for 0s"', async () => {
    const text = await line(createTurnDurationMessage(400, undefined, 0, 0.05))
    expect(text).toContain('Credits: 0.05')
    expect(text).not.toContain('for 0s')
  })

  test('credits stay visible when the duration line is turned off', async () => {
    saveGlobalConfig(config => ({ ...config, showTurnDuration: false }))
    const text = await line(createTurnDurationMessage(5_000, undefined, 0, 12.5))
    expect(text).toContain('Credits: 12.50')
    expect(text).not.toContain('Rayu')
    // ...and with nothing to say, there is still no line at all.
    expect(await line(createTurnDurationMessage(5_000, undefined, 0))).toBe('')
  })

  test('a token budget follows the credits with one separator', async () => {
    const text = await line(
      createTurnDurationMessage(5_000, { tokens: 1_000, limit: 4_000, nudges: 0 }, 0, 1.25),
    )
    expect(text).toMatch(/for 5s · Credits: 1\.25 · 1(\.0)?k \/ 4(\.0)?k \(25%\)$/)
  })
})
