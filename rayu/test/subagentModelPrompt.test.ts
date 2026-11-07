import { expect, test } from 'bun:test'
import { shouldPromptForSubagentModel } from '../src/tools/AgentTool/subagentModelPrompt.js'

const clear = {
  toolSpecifiedModel: undefined as string | undefined,
  hasExistingSelection: false,
  isNonInteractiveSession: false,
  hasSetToolJSX: true,
  isSubThread: false,
  hasDeclinedThisSession: false,
}

test('prompts when every guard is clear', () => {
  expect(shouldPromptForSubagentModel(clear)).toBe(true)
})

test('does not prompt when the tool specified a model', () => {
  expect(
    shouldPromptForSubagentModel({ ...clear, toolSpecifiedModel: 'sonnet' }),
  ).toBe(false)
})

test('does not prompt when a selection already exists', () => {
  expect(
    shouldPromptForSubagentModel({ ...clear, hasExistingSelection: true }),
  ).toBe(false)
})

test('does not prompt in a non-interactive session', () => {
  expect(
    shouldPromptForSubagentModel({ ...clear, isNonInteractiveSession: true }),
  ).toBe(false)
})

test('does not prompt when setToolJSX is unavailable', () => {
  expect(
    shouldPromptForSubagentModel({ ...clear, hasSetToolJSX: false }),
  ).toBe(false)
})

test('does not prompt from a sub-thread', () => {
  expect(shouldPromptForSubagentModel({ ...clear, isSubThread: true })).toBe(
    false,
  )
})

test('does not prompt when the user declined this session', () => {
  expect(
    shouldPromptForSubagentModel({ ...clear, hasDeclinedThisSession: true }),
  ).toBe(false)
})
