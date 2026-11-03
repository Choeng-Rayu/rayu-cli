/**
 * Run git with byte-exact output.
 *
 * `execFileNoThrow` decodes output as text, and callers trim it. That is right for
 * commands that print a SHA or a branch name, and wrong for file contents: a blob read
 * that way loses its trailing newline, corrupts non-UTF-8 bytes and binary files, and
 * would make a 3-way merge or a restore silently change files. This runner keeps stdout
 * as a Buffer and never strips anything.
 *
 * No shell is involved, so arguments are passed to git exactly as given on every
 * platform. Output is capped so a huge blob or diff cannot exhaust memory.
 */
import { spawn } from 'child_process'
import { gitExe } from '../git.js'

/** 64 MiB: far above any file an agent should be merging, well below memory limits. */
export const DEFAULT_GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const DEFAULT_GIT_TIMEOUT_MS = 120_000
const MAX_STDERR_CHARS = 4_000

export type GitBinaryOptions = {
  cwd: string
  /** Added to the inherited environment. */
  env?: Record<string, string>
  input?: Buffer | string
  maxOutputBytes?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export type GitBinaryResult = {
  code: number
  stdout: Buffer
  stderr: string
}

export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: GitBinaryResult,
  ) {
    super(`git ${args.slice(0, 3).join(' ')} failed (${result.code}): ${result.stderr.trim().slice(0, 500)}`)
    this.name = 'GitCommandError'
  }
}

/** Run git and resolve with its exit code and raw output. Rejects only if it cannot run. */
export function runGitBinary(args: readonly string[], options: GitBinaryOptions): Promise<GitBinaryResult> {
  const maxOutput = options.maxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES
  return new Promise((resolve, reject) => {
    const child = spawn(gitExe(), [...args], {
      cwd: options.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
      windowsHide: true,
      signal: options.signal,
    })
    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''
    let overflowed = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxOutput) {
        overflowed = true
        child.kill()
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString('utf8')
    })
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (overflowed || timedOut) {
        const why = overflowed ? `produced more than ${maxOutput} bytes of output` : 'timed out'
        reject(new Error(`git ${args[0] ?? ''} ${why}`))
        return
      }
      resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr })
    })
    child.stdin.on('error', () => {
      // git may exit before reading all of stdin; its exit code reports why.
    })
    child.stdin.end(options.input ?? '')
  })
}

/** Run git and return stdout, or throw GitCommandError on a non-zero exit. */
export async function runGitOrThrow(args: readonly string[], options: GitBinaryOptions): Promise<Buffer> {
  const result = await runGitBinary(args, options)
  if (result.code !== 0) throw new GitCommandError(args, result)
  return result.stdout
}

/** For commands that print one value (a SHA, a path): stdout without its final newline. */
export async function runGitLine(args: readonly string[], options: GitBinaryOptions): Promise<string> {
  return (await runGitOrThrow(args, options)).toString('utf8').replace(/\r?\n$/, '')
}
