/**
 * Safe host-config editing primitives.
 *
 * Host config files (`~/.claude.json`, `~/.codex/config.toml`, `.mcp.json`) are
 * owned by the user and by another agent's CLI. Every write here therefore:
 *
 *   1. reads the file as-is (missing file is not an error),
 *   2. copies it to a timestamped backup under the RAYU config home before the
 *      first modification, and
 *   3. writes via temp-file + `rename`, so a crash mid-write cannot truncate the
 *      user's config.
 *
 * Nothing in this module merges or interprets content — that belongs to the
 * per-host installers, which know the schema.
 */

import { existsSync } from 'fs'
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { getRayuConfigHomeDir } from '../../utils/envUtils.js'
import { HOST_BACKUP_DIR } from './constants.js'

/** Directory pre-install backups are written to. */
export function getHostBackupDir(): string {
  return join(getRayuConfigHomeDir(), HOST_BACKUP_DIR)
}

/** Reads a text file, returning `undefined` when it does not exist. */
export async function readTextFileIfExists(
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Copies an existing file into the backup dir, returning the backup path.
 * Returns `undefined` when there was nothing to back up.
 */
export async function backupFile(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined
  const dir = getHostBackupDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(dir, `${basename(path)}.${stamp}.bak`)
  await copyFile(path, target)
  return target
}

/**
 * Writes `content` to `path` atomically, creating parent directories.
 *
 * `mode` defaults to 0o600 because these files can carry MCP credentials for
 * other servers the user has configured; a world-readable rewrite of a
 * previously private file would be a regression. Existing permissions are
 * intentionally not preserved-and-widened.
 */
export async function writeTextFileAtomic(
  path: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${basename(path)}.rayu-${process.pid}.tmp`)
  try {
    await writeFile(tmp, content, { encoding: 'utf8', mode })
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

/** Detects the indentation an existing JSON document uses, defaulting to 2. */
export function detectJsonIndent(source: string | undefined): number {
  if (!source) return 2
  const match = source.match(/\n(\s+)"/)
  if (!match?.[1]) return 2
  // Tabs are represented as a single indent step by JSON.stringify(…, '\t');
  // callers only need spaces, so collapse tabs to 2 to avoid a mixed file.
  return match[1].includes('\t') ? 2 : match[1].length
}

/** Serializes a JSON document with a trailing newline, matching host output. */
export function serializeJson(value: unknown, indent: number): string {
  return `${JSON.stringify(value, null, indent)}\n`
}
