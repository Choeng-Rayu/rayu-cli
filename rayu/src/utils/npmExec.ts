import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

// On Windows, npm is installed as npm.cmd (a shell shim), not a directly
// executable PE binary. execFileSync spawns the file directly and cannot
// resolve/exec .cmd shims without going through a shell — without shell:true
// this throws "spawn npm ENOENT" on every Windows machine. shell:true routes
// the spawn through cmd.exe, which resolves npm.cmd via PATH correctly.
//
// Node deprecates (DEP0190) passing an `args` array together with
// `shell: true` to execFileSync/execFile/spawn, because the args are just
// concatenated into the shell command line, not escaped — the exact pattern
// this codebase's own win32 spawns avoid (see src/utils/editor.ts). So on
// win32 we build a single, manually-quoted command string instead of an args
// array. Callers only ever pass fixed internal literals (package names,
// npm subcommands, flags) here, never raw user/network input, so quoting
// each with double quotes is sufficient and safe.
export const IS_WINDOWS = process.platform === 'win32'

export function execNpmSync(
  npmArgs: string[],
  options: { timeout?: number; stdio: 'pipe' | 'inherit' | Array<'pipe' | 'ignore'> },
): string {
  if (IS_WINDOWS) {
    // Defense in depth: every current caller passes fixed internal literals
    // (verified — see callers in src/cli/update.ts and src/cli/uninstall.ts),
    // so this never fires today. But the naive `"${a}"` wrap below cannot
    // safely escape an embedded `"` (it would let the token break out of its
    // quotes into the surrounding cmd.exe command line) or shell
    // metacharacters like `&`/`|`/`^`. Rather than silently mis-quoting if a
    // future caller ever threads dynamic/user input through here, fail loudly
    // instead — MACRO.PACKAGE_URL and similar values are typed as plain
    // `string` (see globals.d.ts), so nothing at the type level would catch
    // this otherwise.
    for (const a of npmArgs) {
      if (a.includes('"')) {
        throw new Error(
          `execNpmSync: refusing to quote an argument containing a double quote on Windows (unsafe): ${JSON.stringify(a)}`,
        )
      }
    }
    const commandStr = `npm ${npmArgs.map(a => `"${a}"`).join(' ')}`
    return execFileSync(commandStr, [], {
      encoding: 'utf8',
      cwd: homedir(),
      shell: true,
      ...(options.timeout ? { timeout: options.timeout } : {}),
      stdio: options.stdio as never,
    }) as unknown as string
  }
  return execFileSync('npm', npmArgs, {
    encoding: 'utf8',
    cwd: homedir(),
    ...(options.timeout ? { timeout: options.timeout } : {}),
    stdio: options.stdio as never,
  }) as unknown as string
}

/** Pulls the stderr text off a thrown execFileSync error, as a plain string. */
function stderrOf(err: unknown): string {
  if (!(err instanceof Error)) return ''
  const anyErr = err as { stderr?: unknown }
  if (typeof anyErr.stderr === 'string') return anyErr.stderr
  if (Buffer.isBuffer(anyErr.stderr)) return anyErr.stderr.toString('utf8')
  return ''
}

/**
 * Best-effort extraction of a human-readable reason from a failed
 * execFileSync call. Node attaches `.stderr`/`.stdout` (Buffer|string) and
 * `.code` (string, e.g. 'EACCES'/'ENOENT') to the thrown error for spawn
 * failures. We surface whichever of these is present instead of silently
 * discarding the error, since a bare "failed" message with no cause is
 * undebuggable (e.g. can't distinguish "npm not on PATH" from "permission
 * denied" from "registry unreachable").
 */
export function describeNpmError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const anyErr = err as NodeJS.ErrnoException
  const parts: string[] = []
  if (anyErr.code) parts.push(`code: ${anyErr.code}`)
  const trimmedStderr = stderrOf(err).trim()
  if (trimmedStderr) {
    parts.push(trimmedStderr)
  } else if (err.message) {
    parts.push(err.message)
  }
  return parts.join('\n')
}

/**
 * Heuristic: does this failure look like an npm global-prefix permissions
 * error? There are two distinct shapes this can take:
 *   1. execFileSync itself fails to spawn (e.g. an unreadable cwd) — Node
 *      sets err.code to the errno string ('EACCES'/'EPERM') directly.
 *   2. npm spawns and runs fine, then fails *internally* while writing to a
 *      permission-denied global install dir (the common real-world case
 *      this guidance targets, e.g. a non-nvm/Homebrew Node install). Here
 *      err.code is undefined and err.status is npm's own non-zero exit
 *      code — the only signal is the "EACCES"/"permission denied" text
 *      npm printed to stderr, which is what the regex fallback below
 *      catches. Verified against a real npm EACCES failure: err.code was
 *      undefined, err.status was 243, and only the stderr regex matched.
 */
export function isLikelyEacces(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const anyErr = err as NodeJS.ErrnoException
  if (anyErr.code === 'EACCES' || anyErr.code === 'EPERM') return true
  const stderrText = stderrOf(err)
  return (
    /EACCES|permission denied/i.test(stderrText) ||
    /EACCES|permission denied/i.test(err.message)
  )
}

/**
 * Windows-only failure shape: npm could not replace a file because another
 * process is holding it open.
 *
 * This is THE reason `rayu update` fails on Windows but not on Linux/macOS.
 * `rayu update` reaches us through npm's global bin shims — `rayu.cmd` under
 * cmd.exe, `rayu.ps1` under PowerShell. `npm install -g` re-links bins on
 * every install, and npm's cmd-shim deletes `rayu`/`rayu.cmd`/`rayu.ps1`
 * before rewriting them. cmd.exe keeps the .cmd file it is executing open
 * WITHOUT FILE_SHARE_DELETE, so that delete fails with a sharing violation
 * (surfaced as EBUSY/EPERM) — usually *after* npm has already removed the old
 * package directory, which is why a failed `rayu update` can leave the `rayu`
 * command broken. POSIX lets you unlink a file that is open/executing, so the
 * same install is a no-op risk on Linux/macOS.
 *
 * PowerShell reads a .ps1 fully and closes the handle, so the PowerShell path
 * often succeeds where cmd.exe fails — hence "works sometimes" reports.
 *
 * Note: EPERM overlaps with isLikelyEacces(); on win32 check this first.
 */
export function isLikelyWindowsFileLock(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'EBUSY' || code === 'ETXTBSY') return true
  const haystack = `${stderrOf(err)}\n${err.message}`
  // npm surfaces these as either the raw errno or Windows' own wording.
  return (
    /\bEBUSY\b|\bETXTBSY\b/i.test(haystack) ||
    /\bEPERM\b/i.test(haystack) ||
    /operation not permitted/i.test(haystack) ||
    /being used by another process/i.test(haystack) ||
    /cannot access the file/i.test(haystack) ||
    /resource busy or locked/i.test(haystack)
  )
}

export type NpmAction = 'install' | 'uninstall'

/**
 * Platform-correct remediation text for a failed global npm operation.
 *
 * The previous guidance was POSIX-only (`sudo`, `mkdir -p`, `export PATH=…`),
 * which is noise for the cmd.exe/PowerShell users who hit these failures most
 * often — none of those commands exist there. Split by platform so each OS
 * gets instructions its shell can actually run.
 */
export function buildNpmRemediation(
  action: NpmAction,
  packageSpec: string,
  err: unknown,
  platform: string = process.platform,
): string {
  const isWin = platform === 'win32'
  const cmd = `npm ${action} -g ${packageSpec}`
  const lines: string[] = ['', 'Try manually:', `  ${cmd}`]

  if (isWin) {
    if (isLikelyWindowsFileLock(err)) {
      lines.push(
        '',
        'Windows could not replace the Rayu files because they are still in',
        'use. This happens when npm rewrites the "rayu" launcher while the',
        'terminal that started it (cmd.exe in particular) still holds it open.',
        '',
        'Fix it by running the command from a shell that is NOT running Rayu:',
        '  1. Close every terminal that has Rayu running',
        '  2. Open a new PowerShell or Command Prompt',
        `  3. Run: ${cmd}`,
        '',
        'If it still fails, an antivirus or a stray rayu.exe/node.exe may be',
        'holding the file. Check with:',
        '  tasklist | findstr /i rayu',
      )
    } else {
      lines.push(
        '',
        'If npm could not write to its global folder, run the command from an',
        'elevated (Administrator) terminal, or move npm\'s global prefix',
        'somewhere you own:',
        '  npm config set prefix %LOCALAPPDATA%\\npm-global',
        '  setx PATH "%LOCALAPPDATA%\\npm-global;%PATH%"',
        '  (then open a NEW terminal so the PATH change is picked up)',
      )
    }
    return lines.join('\n')
  }

  if (isLikelyEacces(err)) {
    lines.push(
      '',
      "This looks like a permissions error on npm's global install",
      'directory. If Node was installed via nvm, Homebrew, Volta, or fnm,',
      'do NOT use sudo — it installs into a root-owned path that will',
      'conflict with your user-owned Node version. Instead fix npm\'s',
      'global prefix, e.g.:',
      '  mkdir -p ~/.npm-global',
      '  npm config set prefix ~/.npm-global',
      '  export PATH=~/.npm-global/bin:$PATH   # add to your shell rc file',
      'Only use sudo if Node was installed system-wide (e.g. via apt/yum',
      'or the nodejs.org installer):',
      `  sudo ${cmd}`,
    )
  } else {
    lines.push('', 'Or with sudo if you have permission issues:', `  sudo ${cmd}`)
  }
  return lines.join('\n')
}

/**
 * The batch script used to finish a Windows update after this process exits.
 *
 * Exported (and pure) so the generated script can be asserted in tests without
 * spawning anything. `pid` is a number and `packageSpec` is an internal literal,
 * so neither can inject batch syntax; the double-quote guard mirrors
 * execNpmSync's.
 */
export function buildWindowsDeferredInstallScript(
  packageSpec: string,
  pid: number,
): string {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`buildWindowsDeferredInstallScript: invalid pid ${pid}`)
  }
  if (packageSpec.includes('"')) {
    throw new Error(
      `buildWindowsDeferredInstallScript: refusing to quote a spec containing a double quote: ${JSON.stringify(packageSpec)}`,
    )
  }
  // /FI "PID eq <pid>" makes the match exact; tasklist prints
  // "INFO: No tasks are running..." once the process is gone, so `find` on the
  // pid is a reliable "still alive?" probe. Capped at ~60s so a wedged parent
  // can't leave this window spinning forever.
  return [
    '@echo off',
    'title Rayu update',
    'echo Waiting for Rayu to exit...',
    'set /a _tries=0',
    ':wait',
    `tasklist /FI "PID eq ${pid}" /NH 2>nul | find "${pid}" >nul`,
    'if errorlevel 1 goto run',
    'set /a _tries+=1',
    'if %_tries% GEQ 60 goto run',
    'timeout /t 1 /nobreak >nul 2>&1 || ping -n 2 127.0.0.1 >nul',
    'goto wait',
    ':run',
    'echo Installing Rayu CLI...',
    'echo.',
    `call npm install -g "${packageSpec}"`,
    'if errorlevel 1 (',
    '  echo.',
    '  echo Update FAILED. Close all Rayu windows and run this in a new terminal:',
    `  echo     npm install -g ${packageSpec}`,
    '  echo If npm cannot write to its global folder, run that terminal as Administrator.',
    ') else (',
    '  echo.',
    '  echo Rayu CLI updated successfully.',
    ')',
    'echo.',
    'echo Press any key to close this window.',
    'pause >nul',
    '',
  ].join('\r\n')
}

/**
 * Windows fallback for a self-update that failed because our own launcher was
 * locked: write a batch script that waits for THIS process to exit and then
 * runs the install, and start it in its own console window.
 *
 * Detached + its own console on purpose — the whole point is that it outlives
 * us, and the user needs to see whether the retry worked. Returns false if the
 * helper could not be started (caller then falls back to printing manual
 * instructions).
 */
export function scheduleWindowsDeferredInstall(packageSpec: string): boolean {
  if (!IS_WINDOWS) return false
  try {
    const scriptPath = join(tmpdir(), `rayu-update-${process.pid}.cmd`)
    writeFileSync(
      scriptPath,
      buildWindowsDeferredInstallScript(packageSpec, process.pid),
      'utf8',
    )
    // `start "" <script>` gives the batch its own window; the empty title is
    // required so cmd.exe doesn't treat the script path as the window title.
    const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.unref()
    return true
  } catch {
    return false
  }
}
