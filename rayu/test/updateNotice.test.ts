/**
 * Tests for the passive "update available" notice.
 *
 * Two things are covered:
 *
 *  1. ensureLatestNpmVersion()'s single-flight/retry behaviour. Two callers now
 *     want this value (setup.ts pre-warms it, the banner awaits it), and without
 *     sharing the in-flight promise they would each issue a registry request.
 *     The fetcher is injected so these tests never touch the network.
 *
 *  2. shouldShowUpdateNotice()'s gating policy. The important asymmetry: Rayu
 *     ships with auto-updates OFF (getAutoUpdaterDisabledReason() ->
 *     `{type:'config'}`), and the pre-existing PackageManagerAutoUpdater bails
 *     out on isAutoUpdaterDisabled(), which is why no npm user was ever told a
 *     new version existed. The notice must therefore survive the `config`
 *     reason while still honouring an explicit `env` opt-out.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import {
  _resetLatestNpmVersionCacheForTesting,
  ensureLatestNpmVersion,
  getCachedLatestNpmVersionSync,
} from '../src/utils/autoUpdater.js'
import type { AutoUpdaterDisabledReason } from '../src/utils/config.js'
import type { InstallationType } from '../src/utils/doctorDiagnostic.js'
import {
  UPDATE_COMMAND,
  formatUpdateNotice,
  formatUpdateNoticeLines,
  isNewerVersion,
  shouldShowUpdateNotice,
  type UpdateNoticeInput,
} from '../src/utils/updateNotice.js'

afterEach(() => {
  _resetLatestNpmVersionCacheForTesting()
})

/** A fetcher that resolves `value` after a tick, counting its invocations. */
function countingFetcher(value: string | null) {
  const state = { calls: 0 }
  const fetch = async () => {
    state.calls++
    await Promise.resolve()
    return value
  }
  return { state, fetch }
}

describe('ensureLatestNpmVersion', () => {
  test('concurrent callers share one request', async () => {
    const { state, fetch } = countingFetcher('1.5.11')

    const results = await Promise.all([
      ensureLatestNpmVersion('latest', fetch),
      ensureLatestNpmVersion('latest', fetch),
      ensureLatestNpmVersion('latest', fetch),
    ])

    expect(state.calls).toBe(1)
    expect(results).toEqual(['1.5.11', '1.5.11', '1.5.11'])
  })

  test('returns the identical promise while a request is in flight', () => {
    const { fetch } = countingFetcher('1.5.11')
    // Same object identity is the strongest statement of "one request".
    expect(ensureLatestNpmVersion('latest', fetch)).toBe(
      ensureLatestNpmVersion('latest', fetch),
    )
  })

  test('a resolved version is cached and reused without re-fetching', async () => {
    const { state, fetch } = countingFetcher('1.5.11')

    expect(await ensureLatestNpmVersion('latest', fetch)).toBe('1.5.11')
    expect(await ensureLatestNpmVersion('latest', fetch)).toBe('1.5.11')

    expect(state.calls).toBe(1)
  })

  test('populates the sync accessor the render path reads', async () => {
    expect(getCachedLatestNpmVersionSync()).toBeNull()
    const { fetch } = countingFetcher('1.5.11')

    await ensureLatestNpmVersion('latest', fetch)

    expect(getCachedLatestNpmVersionSync()).toBe('1.5.11')
  })

  test('a failed lookup resolves null and does not poison the cache', async () => {
    const failing = countingFetcher(null)
    expect(await ensureLatestNpmVersion('latest', failing.fetch)).toBeNull()
    expect(getCachedLatestNpmVersionSync()).toBeNull()

    // A launch during a network blip must not disable the notice for the rest
    // of the session, so the next call has to retry rather than replay null.
    const succeeding = countingFetcher('1.5.11')
    expect(await ensureLatestNpmVersion('latest', succeeding.fetch)).toBe(
      '1.5.11',
    )
    expect(succeeding.state.calls).toBe(1)
  })
})

const BASE: UpdateNoticeInput = {
  currentVersion: '1.5.0',
  latestVersion: '1.5.11',
  installationType: 'npm-global',
  // Rayu's shipped default: auto-updates off via config, not via env.
  disabledReason: { type: 'config' },
  isNonInteractive: false,
  autoUpdatesEnabled: false,
}

describe('shouldShowUpdateNotice', () => {
  test('shows for a default npm install with a newer version published', () => {
    expect(shouldShowUpdateNotice(BASE)).toBe(true)
  })

  test('the shipped auto-updates-off default does NOT suppress it', () => {
    // The regression this whole feature exists to fix.
    expect(
      shouldShowUpdateNotice({ ...BASE, disabledReason: { type: 'config' } }),
    ).toBe(true)
    expect(shouldShowUpdateNotice({ ...BASE, disabledReason: null })).toBe(true)
  })

  test('an explicit env opt-out suppresses it', () => {
    expect(
      shouldShowUpdateNotice({
        ...BASE,
        disabledReason: { type: 'env', envVar: 'DISABLE_AUTOUPDATER' },
      }),
    ).toBe(false)
  })

  test('development builds and dev installs stay quiet', () => {
    expect(
      shouldShowUpdateNotice({
        ...BASE,
        disabledReason: { type: 'development' },
      }),
    ).toBe(false)
    expect(
      shouldShowUpdateNotice({ ...BASE, installationType: 'development' }),
    ).toBe(false)
  })

  test('package-manager installs are left to their own updater', () => {
    // `rayu update` is the wrong command for brew/winget/apk; that path already
    // prints the right one.
    expect(
      shouldShowUpdateNotice({ ...BASE, installationType: 'package-manager' }),
    ).toBe(false)
  })

  test('non-interactive sessions stay clean for pipelines', () => {
    expect(shouldShowUpdateNotice({ ...BASE, isNonInteractive: true })).toBe(
      false,
    )
  })

  test('no nag when auto-update is on and will do the work itself', () => {
    expect(
      shouldShowUpdateNotice({ ...BASE, autoUpdatesEnabled: true }),
    ).toBe(false)
  })

  test('still shows for the other real install types', () => {
    for (const installationType of [
      'npm-global',
      'npm-local',
      'native',
      'unknown',
    ] satisfies InstallationType[]) {
      expect(shouldShowUpdateNotice({ ...BASE, installationType })).toBe(true)
    }
  })

  test('every env opt-out reason shape is honoured', () => {
    for (const envVar of [
      'DISABLE_AUTOUPDATER',
      'CLAUDE_CODE_ESSENTIAL_TRAFFIC_ONLY',
    ]) {
      const reason: AutoUpdaterDisabledReason = { type: 'env', envVar }
      expect(shouldShowUpdateNotice({ ...BASE, disabledReason: reason })).toBe(
        false,
      )
    }
  })
})

describe('isNewerVersion', () => {
  test('true only when the published version is strictly newer', () => {
    expect(isNewerVersion('1.5.0', '1.5.11')).toBe(true)
    expect(isNewerVersion('1.4.482', '1.5.0')).toBe(true)
    // 1.5.11 > 1.5.1 numerically, not lexicographically.
    expect(isNewerVersion('1.5.1', '1.5.11')).toBe(true)
  })

  test('equal versions are not an update', () => {
    expect(isNewerVersion('1.5.11', '1.5.11')).toBe(false)
  })

  test('a local build ahead of the registry is not an update', () => {
    expect(isNewerVersion('1.6.0', '1.5.11')).toBe(false)
  })

  test('handles prereleases without claiming a downgrade is newer', () => {
    expect(isNewerVersion('1.5.11', '1.6.0-beta.1')).toBe(true)
    expect(isNewerVersion('1.6.0-beta.1', '1.5.11')).toBe(false)
  })

  test('unknown/absent latest version is not an update', () => {
    expect(isNewerVersion('1.5.0', null)).toBe(false)
    expect(isNewerVersion('1.5.0', '')).toBe(false)
    expect(isNewerVersion('', '1.5.11')).toBe(false)
  })

  test('never throws on unparsable input', () => {
    for (const [current, latest] of [
      ['not-a-version', '1.5.11'],
      ['1.5.0', 'not-a-version'],
      ['???', '???'],
    ]) {
      expect(() => isNewerVersion(current!, latest!)).not.toThrow()
      expect(isNewerVersion(current!, latest!)).toBe(false)
    }
  })

  test('shouldShowUpdateNotice inherits the same safety', () => {
    expect(
      shouldShowUpdateNotice({ ...BASE, latestVersion: 'not-a-version' }),
    ).toBe(false)
    expect(shouldShowUpdateNotice({ ...BASE, latestVersion: null })).toBe(false)
  })
})

describe('notice text', () => {
  test('one line carries version, command and changelog link', () => {
    const line = formatUpdateNotice('1.5.0', '1.5.11')
    expect(line).toBe(
      'Update available: v1.5.11 (current v1.5.0) · run rayu update · https://rayucode.com/changelog',
    )
  })

  test('leads with the new version so truncation stays useful', () => {
    // A narrow terminal truncates the tail, so "an update exists, and which
    // version" must come first.
    expect(formatUpdateNotice('1.5.0', '1.5.11').indexOf('1.5.11')).toBeLessThan(
      formatUpdateNotice('1.5.0', '1.5.11').indexOf('rayu update'),
    )
  })

  test('recommends rayu update, never a bare npm install', () => {
    // `npm i -g pkg@latest` can silently no-op on a stale registry packument —
    // the bug fixed in commit 7433227. `rayu update` pins the resolved exact
    // version and verifies the installed result.
    expect(UPDATE_COMMAND).toBe('rayu update')
    for (const text of [
      formatUpdateNotice('1.5.0', '1.5.11'),
      ...formatUpdateNoticeLines('1.5.0', '1.5.11'),
    ]) {
      expect(text).not.toContain('npm i -g')
      expect(text).not.toContain('npm install -g')
    }
  })

  test('panel form is short lines for the narrow welcome-box column', () => {
    const lines = formatUpdateNoticeLines('1.5.0', '1.5.11')
    expect(lines).toEqual([
      'v1.5.11 is available (current v1.5.0)',
      'Run rayu update',
      'https://rayucode.com/changelog',
    ])
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40)
  })

  test('both surfaces agree on command and link', () => {
    const line = formatUpdateNotice('1.5.0', '1.5.11')
    const panel = formatUpdateNoticeLines('1.5.0', '1.5.11').join(' ')
    for (const fragment of ['rayu update', 'https://rayucode.com/changelog']) {
      expect(line).toContain(fragment)
      expect(panel).toContain(fragment)
    }
  })
})
