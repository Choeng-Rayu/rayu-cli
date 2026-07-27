/**
 * Regression tests for the Windows `rayu update` path.
 *
 * These cover the pure helpers only — the failure they guard against (npm
 * failing to replace the running `rayu.cmd`/`rayu.ps1` launcher) can't be
 * reproduced on Linux/macOS CI, so the classification, the remediation text
 * and the deferred-install script are asserted directly instead.
 */
import { describe, expect, test } from 'bun:test'

import {
  buildNpmRemediation,
  buildWindowsDeferredInstallScript,
  describeNpmError,
  isLikelyEacces,
  isLikelyWindowsFileLock,
} from '../src/utils/npmExec.js'
import { isStaleWindowsExecutable } from '../src/utils/nativeInstaller/installer.js'

/** Shape of what execFileSync throws when npm itself exits non-zero. */
function npmExitError(stderr: string, status = 1): Error {
  const err = new Error(`Command failed: npm install -g pkg`) as Error & {
    status: number
    stderr: string
  }
  err.status = status
  err.stderr = stderr
  return err
}

describe('isLikelyWindowsFileLock', () => {
  test('detects npm EBUSY on the global bin shim', () => {
    expect(
      isLikelyWindowsFileLock(
        npmExitError(
          "npm error code EBUSY\nnpm error syscall unlink\nnpm error path C:\\Users\\x\\AppData\\Roaming\\npm\\rayu.cmd\nnpm error errno -4082\nnpm error EBUSY: resource busy or locked, unlink 'C:\\Users\\x\\AppData\\Roaming\\npm\\rayu.cmd'",
        ),
      ),
    ).toBe(true)
  })

  test('detects npm EPERM on the global bin shim', () => {
    expect(
      isLikelyWindowsFileLock(
        npmExitError(
          "npm error code EPERM\nnpm error EPERM: operation not permitted, unlink 'C:\\Users\\x\\AppData\\Roaming\\npm\\rayu.ps1'",
        ),
      ),
    ).toBe(true)
  })

  test("detects Windows' own wording", () => {
    expect(
      isLikelyWindowsFileLock(
        npmExitError(
          'The process cannot access the file because it is being used by another process.',
        ),
      ),
    ).toBe(true)
  })

  test('picks up errno codes set directly on the error', () => {
    const err = new Error('spawn failed') as Error & { code: string }
    err.code = 'EBUSY'
    expect(isLikelyWindowsFileLock(err)).toBe(true)
  })

  test('does not fire on unrelated npm failures', () => {
    expect(
      isLikelyWindowsFileLock(
        npmExitError('npm error code E404\nnpm error 404 Not Found - GET ...'),
      ),
    ).toBe(false)
    expect(isLikelyWindowsFileLock(npmExitError('network timeout'))).toBe(false)
    expect(isLikelyWindowsFileLock(undefined)).toBe(false)
    expect(isLikelyWindowsFileLock('not an error')).toBe(false)
  })

  test('a POSIX EACCES prefix error is not misread as a file lock', () => {
    const err = npmExitError(
      "npm error code EACCES\nnpm error Error: EACCES: permission denied, access '/usr/lib/node_modules'",
    )
    expect(isLikelyEacces(err)).toBe(true)
    expect(isLikelyWindowsFileLock(err)).toBe(false)
  })
})

describe('buildNpmRemediation', () => {
  const spec = '@rayu-dev/rayu-cli@latest'

  test('never suggests sudo or POSIX shell syntax on Windows', () => {
    for (const err of [
      npmExitError('npm error code EBUSY\nnpm error EBUSY: resource busy or locked'),
      npmExitError('npm error code EACCES\nnpm error permission denied'),
      npmExitError('npm error code E404'),
    ]) {
      const text = buildNpmRemediation('install', spec, err, 'win32')
      expect(text).not.toContain('sudo')
      expect(text).not.toContain('export PATH')
      expect(text).not.toContain('mkdir -p')
      expect(text).toContain(`npm install -g ${spec}`)
    }
  })

  test('explains the locked-launcher case on Windows', () => {
    const text = buildNpmRemediation(
      'install',
      spec,
      npmExitError('npm error EBUSY: resource busy or locked, unlink rayu.cmd'),
      'win32',
    )
    expect(text).toContain('still in')
    expect(text).toContain('Close every terminal')
    expect(text).toContain('tasklist')
  })

  test('gives Windows-native prefix guidance for non-lock failures', () => {
    const text = buildNpmRemediation(
      'install',
      spec,
      npmExitError('npm error code E404'),
      'win32',
    )
    expect(text).toContain('npm config set prefix %LOCALAPPDATA%')
    expect(text).toContain('setx PATH')
    expect(text).toContain('Administrator')
  })

  test('keeps the nvm-safe POSIX guidance on linux/macOS', () => {
    const text = buildNpmRemediation(
      'install',
      spec,
      npmExitError('npm error EACCES: permission denied'),
      'linux',
    )
    expect(text).toContain('do NOT use sudo')
    expect(text).toContain('npm config set prefix ~/.npm-global')
    expect(text).toContain(`sudo npm install -g ${spec}`)
  })

  test('uses the uninstall verb when asked', () => {
    const text = buildNpmRemediation(
      'uninstall',
      '@rayu-dev/rayu-cli',
      npmExitError('boom'),
      'darwin',
    )
    expect(text).toContain('npm uninstall -g @rayu-dev/rayu-cli')
    expect(text).not.toContain('npm install -g')
  })
})

describe('buildWindowsDeferredInstallScript', () => {
  const spec = '@rayu-dev/rayu-cli@latest'

  test('waits for the given pid before installing', () => {
    const script = buildWindowsDeferredInstallScript(spec, 4242)
    const waitIdx = script.indexOf('tasklist /FI "PID eq 4242"')
    const installIdx = script.indexOf('npm install -g')
    expect(waitIdx).toBeGreaterThan(-1)
    expect(installIdx).toBeGreaterThan(waitIdx)
    expect(script).toContain(':wait')
    expect(script).toContain(':run')
  })

  test('is a CRLF batch file that keeps its window open', () => {
    const script = buildWindowsDeferredInstallScript(spec, 1)
    expect(script.startsWith('@echo off\r\n')).toBe(true)
    expect(script).toContain('pause >nul')
  })

  test('bounds the wait loop so it cannot spin forever', () => {
    expect(buildWindowsDeferredInstallScript(spec, 1)).toContain(
      'if %_tries% GEQ 60 goto run',
    )
  })

  test('rejects inputs it cannot safely quote', () => {
    expect(() => buildWindowsDeferredInstallScript('pkg"&calc', 1)).toThrow()
    expect(() => buildWindowsDeferredInstallScript(spec, 0)).toThrow()
    expect(() => buildWindowsDeferredInstallScript(spec, 1.5)).toThrow()
  })
})

describe('isStaleWindowsExecutable', () => {
  // updateSymlink() renames the running binary to `<binary>.old.<timestamp>`
  // before copying the new one in. The cleanup pass must match that name.
  test('matches the names updateSymlink actually produces', () => {
    expect(isStaleWindowsExecutable('rayu.exe.old.1700000000000', 'rayu.exe')).toBe(
      true,
    )
  })

  test('no longer looks for the pre-rebrand claude.exe name', () => {
    expect(isStaleWindowsExecutable('claude.exe.old.123', 'rayu.exe')).toBe(false)
  })

  test('leaves the live binary and unrelated files alone', () => {
    expect(isStaleWindowsExecutable('rayu.exe', 'rayu.exe')).toBe(false)
    expect(isStaleWindowsExecutable('rayu.exe.old', 'rayu.exe')).toBe(false)
    expect(isStaleWindowsExecutable('rayu.exe.old.abc', 'rayu.exe')).toBe(false)
    expect(isStaleWindowsExecutable('myrayu.exe.old.1', 'rayu.exe')).toBe(false)
  })

  test('the "." in the binary name is not treated as a wildcard', () => {
    expect(isStaleWindowsExecutable('rayuXexe.old.1', 'rayu.exe')).toBe(false)
  })
})

describe('describeNpmError', () => {
  test('surfaces the errno code and npm stderr', () => {
    const out = describeNpmError(npmExitError('npm error EBUSY: resource busy'))
    expect(out).toContain('npm error EBUSY: resource busy')
  })

  test('falls back to the message when stderr is empty', () => {
    expect(describeNpmError(new Error('spawn npm ENOENT'))).toContain(
      'spawn npm ENOENT',
    )
  })
})
