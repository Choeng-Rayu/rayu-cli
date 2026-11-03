/**
 * Rayu in VS Code's Accounts menu.
 *
 * The session shape is asserted precisely because it is NOT a credential: `sessionFor`
 * must always hand VS Code the placeholder token, whatever the user object holds.
 */
import { describe, expect, test } from 'bun:test'

const {
  RAYU_AUTH_PROVIDER_ID,
  RAYU_AUTH_PROVIDER_LABEL,
  PLACEHOLDER_ACCESS_TOKEN,
  accountLabel,
  diffSessions,
  sessionFor,
} = await import('../src/vscode/host/auth/authProviderCore.js')

import type { AccountUser } from '../src/vscode/host/auth/authProviderCore.js'

const USER: AccountUser = { id: 42, email: 'fixture@example.test', displayName: 'Fixture User' }

describe('sessionFor', () => {
  test('is keyed by the Rayu id and always carries the placeholder token', () => {
    const session = sessionFor(USER)
    expect(session.id).toBe('rayu-42')
    expect(session.account).toEqual({ id: '42', label: 'Fixture User' })
    expect(session.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
    expect(session.scopes).toEqual([])
  })

  test('a user object that happens to hold an accessToken never leaks it', () => {
    const withToken = { ...USER, accessToken: 'rayu_jwt_secret' } as AccountUser & { accessToken: string }
    const session = sessionFor(withToken)
    expect(session.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN)
    expect(JSON.stringify(session)).not.toContain('rayu_jwt_secret')
  })
})

describe('the provider identity', () => {
  test('matches the id and label contributed in the manifest', () => {
    expect(RAYU_AUTH_PROVIDER_ID).toBe('rayu')
    expect(RAYU_AUTH_PROVIDER_LABEL).toBe('Rayu')
  })
})

describe('accountLabel', () => {
  test('prefers the display name, then the email, then a generic label', () => {
    expect(accountLabel(USER)).toBe('Fixture User')
    expect(accountLabel({ id: 1, email: 'a@b.test', displayName: null })).toBe('a@b.test')
    expect(accountLabel({ id: 1, email: null, displayName: null })).toBe('Rayu account')
  })

  test('trims surrounding whitespace and ignores a blank display name', () => {
    expect(accountLabel({ id: 1, email: 'a@b.test', displayName: '  Padded  ' })).toBe('Padded')
    expect(accountLabel({ id: 1, email: ' a@b.test ', displayName: '   ' })).toBe('a@b.test')
  })
})

describe('diffSessions', () => {
  const alice = sessionFor(USER)
  const bob = sessionFor({ id: 43, email: 'bob@example.test', displayName: 'Bob' })

  test('nothing to nothing is no event', () => {
    expect(diffSessions(null, null)).toBeNull()
  })

  test('signing in is an addition, signing out a removal', () => {
    expect(diffSessions(null, alice)).toEqual({ added: [alice], removed: [], changed: [] })
    expect(diffSessions(alice, null)).toEqual({ added: [], removed: [alice], changed: [] })
  })

  test('an unchanged session produces no event', () => {
    expect(diffSessions(alice, sessionFor({ ...USER }))).toBeNull()
  })

  test('a renamed account is a change on the same id', () => {
    const renamed = sessionFor({ ...USER, displayName: 'Renamed' })
    expect(diffSessions(alice, renamed)).toEqual({ added: [], removed: [], changed: [renamed] })
  })

  test('a different account is a removal plus an addition', () => {
    expect(diffSessions(alice, bob)).toEqual({ added: [bob], removed: [alice], changed: [] })
  })
})
