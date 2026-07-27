/**
 * Regression tests for the two `rayu update` failures that made it look
 * flaky ("sometimes works, sometimes not"):
 *
 *  1. Tag drift / stale registry metadata. `rayu update` resolved the target
 *     with `npm view …@latest --prefer-online`, then installed the mutable
 *     `@latest` tag again. The second resolution can come from npm's cached
 *     packument (the registry sends `cache-control: max-age=300`), so an
 *     update run shortly after a publish could reinstall the version the user
 *     already had, exit 0, and print "Successfully updated to <old version>".
 *     Fix: install a pinned exact version + --prefer-online, then verify the
 *     on-disk version actually changed.
 *
 *  2. A second installation shadowing the updated one on PATH (e.g. a sudo
 *     install under /usr/local/bin vs a user install under ~/.npm-global/bin).
 *     npm updates its own prefix and reports success, but the shell keeps
 *     launching the other copy.
 *
 * Everything asserted here is platform-parameterised so the win32 behaviour is
 * covered on Linux/macOS CI too.
 */
import { describe, expect, test } from 'bun:test'

import {
  buildPinnedSpec,
  buildShadowedInstallWarning,
  detectShadowedInstall,
  findExecutablesOnPath,
  getNpmGlobalBinDir,
  isSafeVersionToken,
  isSamePath,
} from '../src/utils/npmExec.js'
import { classifyUpdateOutcome } from '../src/cli/update.js'

const PKG = '@rayu-dev/rayu-cli'

describe('classifyUpdateOutcome', () => {
  test('reports the exact failure the old code printed as success', () => {
    // The real transcript: reported 1.4.481 available, npm exited 0, disk
    // stayed at 1.4.480. Old code printed "Successfully updated to 1.4.480".
    expect(classifyUpdateOutcome('1.4.480', '1.4.480', '1.4.481')).toBe(
      'unchanged',
    )
  })

  test('recognises a real upgrade', () => {
    expect(classifyUpdateOutcome('1.4.480', '1.4.482', '1.4.482')).toBe(
      'applied',
    )
  })

  test('accepts landing on a different version than requested', () => {
    // A newer version can publish between resolve and install; the version on
    // disk changed, so the update did apply — report what is actually there.
    expect(classifyUpdateOutcome('1.4.480', '1.4.483', '1.4.482')).toBe(
      'applied',
    )
  })

  test('already at the target is not a failure', () => {
    // Running build older than the copy in npm's prefix (e.g. a shadowed
    // install, or a previous update that PATH never picked up).
    expect(classifyUpdateOutcome('1.4.482', '1.4.482', '1.4.482')).toBe(
      'applied',
    )
  })

  test('never claims anything when the installed version is unreadable', () => {
    expect(classifyUpdateOutcome('1.4.480', null, '1.4.482')).toBe('unknown')
  })
})

describe('buildPinnedSpec', () => {
  test('pins the exact version instead of the mutable latest tag', () => {
    expect(buildPinnedSpec(PKG, '1.4.482')).toBe(`${PKG}@1.4.482`)
  })

  test('accepts real-world prerelease and build-metadata versions', () => {
    for (const version of [
      '1.4.482',
      '2.0.0-beta.1',
      '1.4.482+abc1234',
      '1.4.482-rc.1+sha.9f8e7d6',
    ]) {
      expect(isSafeVersionToken(version)).toBe(true)
      expect(buildPinnedSpec(PKG, version)).toBe(`${PKG}@${version}`)
    }
  })

  test('rejects anything that could break out into a shell command', () => {
    // execNpmSync builds a cmd.exe command string on win32, so a version
    // string coming off the network must never carry shell metacharacters.
    for (const hostile of [
      '1.4.482 && calc',
      '1.4.482"&calc',
      '1.4.482|whoami',
      '1.4.482;rm -rf /',
      '$(id)',
      '`id`',
      '1.4.482 --registry=http://evil',
      '',
      ' 1.4.482',
      'latest\n1.0.0',
      `1.${'9'.repeat(80)}`,
    ]) {
      expect(isSafeVersionToken(hostile)).toBe(false)
      expect(buildPinnedSpec(PKG, hostile)).toBeNull()
    }
  })
})

describe('getNpmGlobalBinDir', () => {
  test('unix nests bin shims under bin/', () => {
    expect(getNpmGlobalBinDir('/home/u/.npm-global', 'linux')).toBe(
      '/home/u/.npm-global/bin',
    )
    expect(getNpmGlobalBinDir('/opt/homebrew', 'darwin')).toBe(
      '/opt/homebrew/bin',
    )
  })

  test('windows puts them directly in the prefix', () => {
    expect(
      getNpmGlobalBinDir('C:\\Users\\u\\AppData\\Roaming\\npm', 'win32'),
    ).toBe('C:\\Users\\u\\AppData\\Roaming\\npm')
  })
})

describe('isSamePath', () => {
  test('ignores trailing separators', () => {
    expect(isSamePath('/usr/local/bin/', '/usr/local/bin', 'linux')).toBe(true)
  })

  test('is case-insensitive and separator-insensitive on windows only', () => {
    const a = 'C:\\Users\\U\\AppData\\Roaming\\npm'
    const b = 'c:/users/u/appdata/roaming/npm/'
    expect(isSamePath(a, b, 'win32')).toBe(true)
    expect(isSamePath('/A/bin', '/a/bin', 'linux')).toBe(false)
  })
})

describe('findExecutablesOnPath', () => {
  test('returns every match in PATH order (the shadowing case)', () => {
    const present = new Set([
      '/home/u/.npm-global/bin/rayu',
      '/usr/local/bin/rayu',
    ])
    expect(
      findExecutablesOnPath('rayu', {
        platform: 'linux',
        pathValue: '/home/u/.npm-global/bin:/usr/bin:/usr/local/bin',
        exists: p => present.has(p),
      }),
    ).toEqual(['/home/u/.npm-global/bin/rayu', '/usr/local/bin/rayu'])
  })

  test('tolerates empty and whitespace PATH segments', () => {
    expect(
      findExecutablesOnPath('rayu', {
        platform: 'linux',
        pathValue: ':: /usr/local/bin :',
        exists: p => p === '/usr/local/bin/rayu',
      }),
    ).toEqual(['/usr/local/bin/rayu'])
  })

  test('finds the npm shims windows actually executes, deduped', () => {
    const dir = 'C:\\Users\\u\\AppData\\Roaming\\npm'
    const present = new Set([
      `${dir}\\rayu`,
      `${dir}\\rayu.cmd`,
      `${dir}\\rayu.ps1`,
    ])
    const found = findExecutablesOnPath('rayu', {
      platform: 'win32',
      pathValue: `${dir};C:\\Windows\\System32`,
      pathExt: '.COM;.EXE;.BAT;.CMD',
      exists: p => present.has(p),
    })
    // .ps1 is not in the default PATHEXT but npm writes one, so it must still
    // be discovered — PowerShell is the shell that runs it.
    expect(found).toEqual([`${dir}\\rayu`, `${dir}\\rayu.cmd`, `${dir}\\rayu.ps1`])
  })

  test('returns nothing when PATH has no launcher at all', () => {
    expect(
      findExecutablesOnPath('rayu', {
        platform: 'linux',
        pathValue: '/usr/bin',
        exists: () => false,
      }),
    ).toEqual([])
  })
})

describe('detectShadowedInstall', () => {
  const npmBinDir = '/home/u/.npm-global/bin'

  test('stays silent when PATH resolves the copy npm just updated', () => {
    expect(
      detectShadowedInstall({
        platform: 'linux',
        npmBinDir,
        pathLookup: {
          pathValue: '/home/u/.npm-global/bin:/usr/local/bin',
          exists: p => p === `${npmBinDir}/rayu`,
        },
      }),
    ).toBeNull()
  })

  test('flags a root-owned /usr/local install that wins on PATH', () => {
    const present = new Set(['/usr/local/bin/rayu', `${npmBinDir}/rayu`])
    const warning = detectShadowedInstall({
      platform: 'linux',
      npmBinDir,
      pathLookup: {
        pathValue: '/usr/local/bin:/home/u/.npm-global/bin',
        exists: p => present.has(p),
      },
    })
    expect(warning).toContain('/usr/local/bin/rayu')
    expect(warning).toContain(npmBinDir)
    // The shadowing copy is root-owned, so the uninstall needs sudo — but only
    // for that copy, never for the user-prefix one we just updated.
    expect(warning).toContain(`sudo npm uninstall -g ${PKG}`)
    expect(warning).toContain('hash -r')
  })

  test('lists every launcher so the user can see the conflict', () => {
    const present = new Set([
      '/usr/local/bin/rayu',
      `${npmBinDir}/rayu`,
      '/opt/tools/rayu',
    ])
    const warning = detectShadowedInstall({
      platform: 'linux',
      npmBinDir,
      pathLookup: {
        pathValue: `/usr/local/bin:${npmBinDir}:/opt/tools`,
        exists: p => present.has(p),
      },
    })
    for (const p of present) expect(warning).toContain(p)
  })

  test('cannot decide without npm, and says nothing rather than guessing', () => {
    expect(
      detectShadowedInstall({
        platform: 'linux',
        npmBinDir: null,
        pathLookup: { pathValue: '/usr/local/bin', exists: () => true },
      }),
    ).toBeNull()
  })

  test('says nothing when PATH has no rayu (a different problem)', () => {
    expect(
      detectShadowedInstall({
        platform: 'linux',
        npmBinDir,
        pathLookup: { pathValue: '/usr/bin', exists: () => false },
      }),
    ).toBeNull()
  })
})

describe('buildShadowedInstallWarning', () => {
  test('never emits POSIX-only advice on windows', () => {
    const text = buildShadowedInstallWarning({
      activePath: 'C:\\Program Files\\nodejs\\rayu.cmd',
      npmBinDir: 'C:\\Users\\u\\AppData\\Roaming\\npm',
      platform: 'win32',
    })
    expect(text).not.toContain('sudo')
    expect(text).not.toContain('hash -r')
    expect(text).toContain('C:\\Program Files\\nodejs\\rayu.cmd')
    expect(text).toContain('NEW terminal')
  })

  test('does not tell macOS/Linux users to sudo-uninstall a user-owned copy', () => {
    const text = buildShadowedInstallWarning({
      activePath: '/home/u/.local/bin/rayu',
      npmBinDir: '/home/u/.npm-global/bin',
      platform: 'darwin',
    })
    expect(text).toContain(`npm uninstall -g ${PKG}`)
    expect(text).not.toContain('sudo npm uninstall')
  })
})
