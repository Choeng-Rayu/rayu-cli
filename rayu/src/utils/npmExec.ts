import { execFileSync } from 'node:child_process'
import { homedir } from 'os'

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
  const anyErr = err as NodeJS.ErrnoException & { stderr?: unknown; stdout?: unknown }
  const parts: string[] = []
  if (anyErr.code) parts.push(`code: ${anyErr.code}`)
  const stderrText =
    typeof anyErr.stderr === 'string'
      ? anyErr.stderr
      : Buffer.isBuffer(anyErr.stderr)
        ? anyErr.stderr.toString('utf8')
        : ''
  const trimmedStderr = stderrText.trim()
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
  const anyErr = err as NodeJS.ErrnoException & { stderr?: unknown }
  if (anyErr.code === 'EACCES' || anyErr.code === 'EPERM') return true
  const stderrText =
    typeof anyErr.stderr === 'string'
      ? anyErr.stderr
      : Buffer.isBuffer(anyErr.stderr)
        ? anyErr.stderr.toString('utf8')
        : ''
  return (
    /EACCES|permission denied/i.test(stderrText) ||
    /EACCES|permission denied/i.test(err.message)
  )
}
