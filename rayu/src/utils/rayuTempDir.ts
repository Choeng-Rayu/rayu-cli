/**
 * The ONE owner of Rayu's temporary namespace.
 *
 * Every temporary path the engine writes — task output, shell cwd probes,
 * sandbox scratch space, auto-mode dumps, prompt-cache diffs, speculation
 * overlays, bundled-skill extraction, debug logs — derives from here.
 *
 * Before this module existed the same directory was computed three different
 * ways: a memoized `getClaudeTempDir()` in utils/permissions/filesystem.ts, an
 * inline re-derivation in utils/Shell.ts, and raw `join(tmpdir(), 'claude', …)`
 * call sites. That is the root cause of RayuCode writing into Claude Code's
 * `/tmp/claude-{uid}` directory — the namespace itself was never rebranded.
 *
 * `RAYU_CODE_TMPDIR` is Rayu's knob. `CLAUDE_CODE_TMPDIR` is still honoured as
 * a fallback so existing environments, and sandboxed child processes that are
 * handed the old variable, keep resolving to the same directory.
 */
import { chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import memoize from 'lodash-es/memoize.js'

import { getFsImplementation } from './fsOperations.js'
import { getPlatform } from './platform.js'

/**
 * Per-user namespace name.
 *
 * On Unix: `rayu-{uid}` so two users sharing /tmp cannot collide.
 * On Windows: `rayu` (tmpdir() is already per-user).
 */
export function getRayuTempDirName(): string {
  if (getPlatform() === 'windows') {
    return 'rayu'
  }
  const uid = process.getuid?.() ?? 0
  return `rayu-${uid}`
}

/**
 * Rayu's temp root with symlinks resolved and a trailing separator.
 *
 * On Unix the base is `/tmp` (not `os.tmpdir()`) to keep one predictable root
 * per machine; `RAYU_CODE_TMPDIR` overrides it. On macOS `/tmp` resolves to
 * `/private/tmp`, which matters because the resolved form is used as a
 * permission-allowlist key.
 *
 * Memoized: called per-tool from permission checks and per-turn from the Bash
 * prompt. The inputs are fixed at startup and the realpath of the system temp
 * directory does not change mid-session.
 */
export const getRayuTempDir = memoize(function getRayuTempDir(): string {
  const baseTmpDir =
    process.env.RAYU_CODE_TMPDIR ||
    process.env.CLAUDE_CODE_TMPDIR ||
    (getPlatform() === 'windows' ? tmpdir() : '/tmp')

  let resolvedBaseTmpDir = baseTmpDir
  const fs = getFsImplementation()
  try {
    resolvedBaseTmpDir = fs.realpathSync(baseTmpDir)
  } catch {
    // If resolution fails, use the original path
  }

  return join(resolvedBaseTmpDir, getRayuTempDirName()) + sep
})

/**
 * Create the temp root owner-only (0o700) and return it.
 *
 * Deliberately NOT memoized: `mkdir` is cheap and idempotent, and re-checking
 * every time keeps the invariant even if the root is removed mid-session. A
 * recursive child `mkdir` would otherwise recreate it with the process umask
 * (typically 0o775), exposing tool output to other local users.
 */
export async function ensureRayuTempDir(): Promise<string> {
  const dir = getRayuTempDir()
  await getFsImplementation().mkdir(dir, { mode: 0o700 })
  try {
    // Tighten a root left behind by an older build, or recreated by hand.
    // eslint-disable-next-line custom-rules/no-sync-fs -- one chmod, not a hot path
    chmodSync(dir, 0o700)
  } catch {
    // Best effort: a directory we do not own cannot be tightened.
  }
  return dir
}

/** Test helper — clears the memoized root. */
export function _resetRayuTempDirForTest(): void {
  getRayuTempDir.cache.clear?.()
}
