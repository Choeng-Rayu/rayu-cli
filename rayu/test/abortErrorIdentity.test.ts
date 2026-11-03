/**
 * `isAbortError` recognises the API client's abort, whichever SDK entry it came from.
 *
 * `utils/errors.ts` imports `APIUserAbortError` from the SDK's narrow `error.js` entry
 * rather than the root, so the VS Code extension host does not bundle the whole API
 * client for one `instanceof` check. That is only correct while both entries export the
 * SAME class object — if they ever diverged (an SDK upgrade that stops re-exporting, or
 * a dual CJS/ESM copy), a user's Esc would stop being recognised as an abort and would
 * surface as an API error. This pins the identity the import change relies on.
 */
import { expect, test } from 'bun:test'
import { APIUserAbortError as FromRoot } from '@anthropic-ai/sdk/index.js'
import { APIUserAbortError as FromErrorEntry } from '@anthropic-ai/sdk/error.js'

import { AbortError, isAbortError } from '../src/utils/errors.js'

test('the root and narrow SDK entries export the same abort class', () => {
  expect(FromErrorEntry).toBe(FromRoot)
})

test('an abort thrown by the API client is recognised', () => {
  expect(isAbortError(new FromRoot())).toBe(true)
  expect(isAbortError(new AbortError('stopped'))).toBe(true)
  const dom = new Error('The operation was aborted')
  dom.name = 'AbortError'
  expect(isAbortError(dom)).toBe(true)
  expect(isAbortError(new Error('boom'))).toBe(false)
  expect(isAbortError('AbortError')).toBe(false)
})
