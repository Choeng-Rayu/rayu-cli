import { expect, test } from 'bun:test'
import { isUserInitiatedAbort } from '../src/utils/abortController.ts'

// A genuine user interrupt (ESC/Ctrl+C → 'user-cancel', or queued-submit
// 'interrupt') should be labeled as user-initiated; system aborts (timeouts,
// sibling-error cascades, backgrounding) must NOT be — otherwise the user gets
// a phantom "Interrupted by user" they never triggered.
test('user cancel / interrupt / bare abort are user-initiated', () => {
  expect(isUserInitiatedAbort('user-cancel')).toBe(true)
  expect(isUserInitiatedAbort('interrupt')).toBe(true)
  expect(isUserInitiatedAbort(undefined)).toBe(true)
  expect(isUserInitiatedAbort(null)).toBe(true)
})

test('system aborts are NOT user-initiated', () => {
  expect(isUserInitiatedAbort('sibling_error')).toBe(false)
  expect(isUserInitiatedAbort('streaming_fallback')).toBe(false)
  expect(isUserInitiatedAbort('background')).toBe(false)
})

test('thrown abort reasons (timeouts) are NOT user-initiated', () => {
  expect(isUserInitiatedAbort(new Error('boom'))).toBe(false)
  expect(
    isUserInitiatedAbort(
      new DOMException('The operation timed out.', 'TimeoutError'),
    ),
  ).toBe(false)
})
