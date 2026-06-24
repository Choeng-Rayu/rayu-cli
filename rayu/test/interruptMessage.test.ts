import { describe, expect, test } from 'bun:test'
import { isUserAbortRenderedMessage } from '../src/query/interruptMessage.ts'
import { ERROR_MESSAGE_USER_ABORT } from '../src/services/compact/compact.ts'

// Regression guard for the duplicate "Interrupted · What should Rayu do
// instead?" bug: pressing Esc early (during the API request) makes the
// streaming layer yield a synthetic assistant API-error message whose content
// is ERROR_MESSAGE_USER_ABORT. AssistantTextMessage renders that as
// <InterruptedByUser />. The query loop must detect this and NOT also emit
// createUserInterruptionMessage, otherwise the same line renders twice.
describe('isUserAbortRenderedMessage', () => {
  const abortMsg = (text: string, isApiError = true) => ({
    isApiErrorMessage: isApiError,
    message: { content: [{ type: 'text', text }] },
  })

  test('true for the synthetic user-abort API-error assistant message', () => {
    expect(isUserAbortRenderedMessage(abortMsg(ERROR_MESSAGE_USER_ABORT))).toBe(true)
  })

  test('false when the abort text is present but not flagged as an API error', () => {
    expect(isUserAbortRenderedMessage(abortMsg(ERROR_MESSAGE_USER_ABORT, false))).toBe(false)
  })

  test('false for a different API error (does not over-suppress)', () => {
    expect(isUserAbortRenderedMessage(abortMsg('API Error: Overloaded'))).toBe(false)
  })

  test('false for a normal assistant text message', () => {
    expect(
      isUserAbortRenderedMessage({
        isApiErrorMessage: false,
        message: { content: [{ type: 'text', text: 'Here is the answer.' }] },
      }),
    ).toBe(false)
  })

  test('false for undefined / missing content', () => {
    expect(isUserAbortRenderedMessage(undefined)).toBe(false)
    expect(isUserAbortRenderedMessage({ isApiErrorMessage: true })).toBe(false)
    expect(
      isUserAbortRenderedMessage({ isApiErrorMessage: true, message: { content: [] } }),
    ).toBe(false)
  })
})
