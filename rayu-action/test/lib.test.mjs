import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertNoProtectedChanges,
  buildPrompt,
  extractRequestText,
} from '../src/lib.mjs'

test('extracts issue and comment text without executing it', () => {
  assert.equal(
    extractRequestText({
      comment: { body: '@rayu fix the parser' },
      issue: { body: 'The parser crashes.', title: 'Parser failure' },
    }),
    'Title: Parser failure\n\nIssue body:\nThe parser crashes.\n\nComment:\n@rayu fix the parser',
  )
})

test('builds a read-only review prompt', () => {
  const prompt = buildPrompt({
    context: {
      issueNumber: 42,
      pullRequest: { base: { ref: 'main' }, head: { ref: 'feature' } },
      requestText: '',
    },
    eventName: 'pull_request',
    mode: 'review',
    repository: 'owner/repo',
  })

  assert.match(prompt, /Do not edit files/)
  assert.match(prompt, /Pull request base: main; head: feature/)
})

test('rejects changes to workflow and action code', () => {
  assert.throws(
    () => assertNoProtectedChanges(['src/index.ts', '.github/workflows/release.yml']),
    /protected path/,
  )
  assert.throws(
    () => assertNoProtectedChanges(['rayu-action/src/index.mjs']),
    /protected path/,
  )
  assert.doesNotThrow(() => assertNoProtectedChanges(['src/index.ts']))
})
