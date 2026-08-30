/**
 * Find running agent-CLI processes.
 *
 * Discovery needs this because the strongest providers are the ones RAYU can
 * detect *without* a control channel. A running `claude` has no socket and no
 * port, so the only evidence it exists is a process in the table plus a recently
 * written transcript. Without a process probe, RAYU would have to infer "probably
 * running" from file mtimes alone, which is a much weaker claim to show a user.
 *
 * ## Deliberately narrow
 *
 * This reads process *names and command lines only* — never memory, never
 * environment, never arguments belonging to other users' processes beyond what
 * the OS already exposes. It exists to answer "is there an `opencode` running in
 * this directory?", not to inventory the machine.
 *
 * ## Platform behaviour
 *
 *   - **Linux**: reads `/proc/<pid>/cmdline` directly. No subprocess, no shell,
 *     and unreadable entries (other users, exited between readdir and read) are
 *     skipped rather than failed on.
 *   - **macOS / BSD**: one `ps` invocation.
 *   - **Windows**: returns `[]`. Enumerating processes there needs PowerShell,
 *     which costs hundreds of milliseconds on a path that runs during discovery.
 *     Discovery degrades to config-and-transcript evidence, which is stated in
 *     the result rather than hidden.
 */

import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { getPlatform } from '../../utils/platform.js'

export type ScannedProcess = {
  readonly pid: number
  /** Full command line, space-joined. */
  readonly command: string
  /** Best-effort executable basename, for matching. */
  readonly name: string
}

/** True when process scanning is possible on this platform. */
export function isProcessScanSupported(): boolean {
  return getPlatform() !== 'windows'
}

/** Basename of the first cmdline token, lowercased. */
function commandName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const withoutPath = first.split(/[/\\]/).pop() ?? first
  return withoutPath.toLowerCase()
}

async function scanLinux(): Promise<ScannedProcess[]> {
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch (e) {
    logForDebugging(`[processScan] /proc unreadable: ${errorMessage(e)}`)
    return []
  }

  const results: ScannedProcess[] = []
  await Promise.all(
    entries.map(async entry => {
      // Only numeric entries are pids; /proc also holds many non-process files.
      if (!/^\d+$/.test(entry)) return
      const pid = Number.parseInt(entry, 10)
      try {
        const raw = await readFile(join('/proc', entry, 'cmdline'), 'utf-8')
        // cmdline is NUL-separated with a trailing NUL.
        const command = raw.replace(/\0+$/, '').split('\0').join(' ').trim()
        if (command.length === 0) return // Kernel thread.
        results.push({ pid, command, name: commandName(command) })
      } catch {
        // Owned by another user, or exited between readdir and read.
      }
    }),
  )
  return results
}

async function scanPosix(): Promise<ScannedProcess[]> {
  const result = await execFileNoThrowWithCwd(
    'ps',
    ['-Ao', 'pid=,command='],
    { timeout: 3000 },
  )
  if (result.code !== 0 || !result.stdout) return []
  const processes: ScannedProcess[] = []
  for (const line of result.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!match) continue
    const pid = Number.parseInt(match[1]!, 10)
    const command = match[2]!.trim()
    if (command.length === 0) continue
    processes.push({ pid, command, name: commandName(command) })
  }
  return processes
}

/**
 * Every visible process. `[]` on Windows and on any failure — callers treat an
 * empty scan as "no evidence", never as "nothing is running".
 */
export async function scanProcesses(): Promise<ScannedProcess[]> {
  try {
    return getPlatform() === 'linux' || getPlatform() === 'wsl'
      ? await scanLinux()
      : isProcessScanSupported()
        ? await scanPosix()
        : []
  } catch (e) {
    logForDebugging(`[processScan] scan failed: ${errorMessage(e)}`)
    return []
  }
}

/**
 * Processes that look like a given CLI.
 *
 * Matches the executable basename exactly, or the name as a whole word elsewhere
 * in the command line (covers `node /path/to/claude` and `bun run opencode`).
 * A substring match would be wrong: searching for `codex` must not match
 * `codex-something-else`, and searching for `claude` must not match a grep for
 * the word "claude".
 *
 * `excludePid` defaults to this process so RAYU never reports itself.
 */
export async function findProcessesNamed(
  name: string,
  options: { excludePid?: number; processes?: readonly ScannedProcess[] } = {},
): Promise<ScannedProcess[]> {
  const target = name.toLowerCase()
  const excludePid = options.excludePid ?? process.pid
  const processes = options.processes ?? (await scanProcesses())
  const wholeWord = new RegExp(`(?:^|[\\s/\\\\])${escapeRegex(target)}(?:\\s|$)`, 'i')

  return processes.filter(candidate => {
    if (candidate.pid === excludePid) return false
    if (candidate.name === target) return true
    // Strip a leading interpreter so `node /usr/bin/claude -p` matches `claude`.
    return wholeWord.test(candidate.command)
  })
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
