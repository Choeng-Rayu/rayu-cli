/**
 * When a conversation restarts after a Telegram link: at once when idle, otherwise a
 * moment after its turn ends, and never once it closed, stopped, or got a new engine.
 *
 * The settle timer is captured, so each test decides exactly when it fires.
 */
import { describe, expect, test } from 'bun:test'

import {
  TelegramLinkRestarts,
  type LinkRestartTarget,
} from '../src/vscode/host/integrations/telegramLinkRestart.js'

interface Engine { id: number }

const engineA: Engine = { id: 1 }
const engineB: Engine = { id: 2 }

function harness() {
  const conversations = new Map<string, LinkRestartTarget<Engine>>()
  const restarted: string[] = []
  const scheduled: Array<() => void> = []
  const restarts = new TelegramLinkRestarts<Engine>({
    lookup: key => conversations.get(key) ?? null,
    restart: key => { restarted.push(key) },
    schedule: settle => { scheduled.push(settle) },
  })
  const set = (key: string, isTurnRunning: boolean, engine: Engine | null = engineA): void => {
    conversations.set(key, { isTurnRunning, engine })
  }
  /** Fire every settle timer started so far. */
  const settle = (): void => {
    for (const run of scheduled.splice(0)) run()
  }
  return { restarts, restarted, scheduled, conversations, set, settle }
}

describe('a link while the conversation is idle', () => {
  test('restarts it at once', () => {
    const h = harness()
    h.set('panel-1', false)
    h.restarts.requestRestart('panel-1')
    expect(h.restarted).toEqual(['panel-1'])
    expect(h.restarts.isWaiting('panel-1')).toBe(false)
  })

  test('restarts it even before an engine has started', () => {
    const h = harness()
    h.set('panel-1', false, null)
    h.restarts.requestRestart('panel-1')
    expect(h.restarted).toEqual(['panel-1'])
  })

  test('does nothing for a conversation that has closed', () => {
    const h = harness()
    h.restarts.requestRestart('panel-1')
    expect(h.restarted).toEqual([])
    expect(h.restarts.isWaiting('panel-1')).toBe(false)
  })
})

describe('a link while a turn runs', () => {
  test('restarts once, after the turn ends and its writes have settled', () => {
    const h = harness()
    h.set('panel-1', true)
    h.restarts.requestRestart('panel-1')
    expect(h.restarted).toEqual([])
    expect(h.restarts.isWaiting('panel-1')).toBe(true)

    h.set('panel-1', false)
    h.restarts.turnEnded('panel-1')
    // Not from inside the turn-state callback: only when the timer fires.
    expect(h.restarted).toEqual([])
    h.settle()
    expect(h.restarted).toEqual(['panel-1'])
    expect(h.restarts.isWaiting('panel-1')).toBe(false)

    h.restarts.turnEnded('panel-1')
    h.settle()
    expect(h.restarted).toEqual(['panel-1'])
  })

  test('waits for the next turn when one began before the timer fired', () => {
    const h = harness()
    h.set('panel-1', true)
    h.restarts.requestRestart('panel-1')
    h.restarts.turnEnded('panel-1')
    h.set('panel-1', true)
    h.settle()
    expect(h.restarted).toEqual([])
    expect(h.restarts.isWaiting('panel-1')).toBe(true)

    h.set('panel-1', false)
    h.restarts.turnEnded('panel-1')
    h.settle()
    expect(h.restarted).toEqual(['panel-1'])
  })

  test('two turns ending before the timer fires still restart once', () => {
    const h = harness()
    h.set('panel-1', true)
    h.restarts.requestRestart('panel-1')
    h.restarts.turnEnded('panel-1')
    h.restarts.turnEnded('panel-1')
    h.set('panel-1', false)
    h.settle()
    expect(h.restarted).toEqual(['panel-1'])
  })

  test('is dropped when the engine was replaced, since the new one reads the link', () => {
    const h = harness()
    h.set('panel-1', true, engineA)
    h.restarts.requestRestart('panel-1')
    h.set('panel-1', false, engineB)
    h.restarts.turnEnded('panel-1')
    h.settle()
    expect(h.restarted).toEqual([])
    expect(h.restarts.isWaiting('panel-1')).toBe(false)
  })

  test('is dropped when the engine stopped', () => {
    const h = harness()
    h.set('panel-1', true, engineA)
    h.restarts.requestRestart('panel-1')
    // The exit handler ends the turn while its engine is still recorded, then clears it.
    h.restarts.turnEnded('panel-1')
    h.set('panel-1', false, null)
    h.settle()
    expect(h.restarted).toEqual([])
    expect(h.restarts.isWaiting('panel-1')).toBe(false)
  })

  test('is dropped when the conversation closed', () => {
    const h = harness()
    h.set('panel-1', true)
    h.restarts.requestRestart('panel-1')
    h.restarts.turnEnded('panel-1')
    h.conversations.delete('panel-1')
    h.settle()
    expect(h.restarted).toEqual([])
    expect(h.restarts.isWaiting('panel-1')).toBe(false)
  })

  test('a link while the engine is still starting restarts the engine the turn ends with', () => {
    // The starting engine may have read telegram.json before the link was written.
    const h = harness()
    h.set('panel-1', true, null)
    h.restarts.requestRestart('panel-1')
    expect(h.restarts.isWaiting('panel-1')).toBe(true)
    h.set('panel-1', false, engineA)
    h.restarts.turnEnded('panel-1')
    h.settle()
    expect(h.restarted).toEqual(['panel-1'])
  })

  test('a start that failed leaves nothing to restart', () => {
    const h = harness()
    h.set('panel-1', true, null)
    h.restarts.requestRestart('panel-1')
    h.set('panel-1', false, null)
    h.restarts.turnEnded('panel-1')
    h.settle()
    expect(h.restarted).toEqual([])
    expect(h.restarts.isWaiting('panel-1')).toBe(false)
  })

  test('a second link while waiting still restarts only once', () => {
    const h = harness()
    h.set('panel-1', true)
    h.restarts.requestRestart('panel-1')
    h.restarts.requestRestart('panel-1')
    h.set('panel-1', false)
    h.restarts.turnEnded('panel-1')
    h.settle()
    expect(h.restarted).toEqual(['panel-1'])
  })

  test('a link once the conversation is idle again restarts at once and clears the wait', () => {
    const h = harness()
    h.set('panel-1', true)
    h.restarts.requestRestart('panel-1')
    h.set('panel-1', false)
    h.restarts.requestRestart('panel-1')
    expect(h.restarted).toEqual(['panel-1'])
    h.restarts.turnEnded('panel-1')
    h.settle()
    expect(h.restarted).toEqual(['panel-1'])
  })
})

describe('conversations are kept apart', () => {
  test('only the conversation that asked is restarted', () => {
    const h = harness()
    h.set('panel-1', true)
    h.set('panel-2', false)
    h.restarts.requestRestart('panel-1')
    h.restarts.turnEnded('panel-2')
    h.settle()
    expect(h.restarted).toEqual([])
    h.set('panel-1', false)
    h.restarts.turnEnded('panel-1')
    h.settle()
    expect(h.restarted).toEqual(['panel-1'])
  })

  test('a turn ending where nothing waits starts no timer', () => {
    const h = harness()
    h.set('panel-1', false)
    h.restarts.turnEnded('panel-1')
    expect(h.scheduled).toEqual([])
    expect(h.restarted).toEqual([])
  })
})
