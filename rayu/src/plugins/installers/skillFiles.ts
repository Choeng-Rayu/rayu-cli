/**
 * Installs / removes RAYU's host-side SKILL.md files.
 *
 * Both Claude Code and Codex discover skills the same way — a directory per
 * skill containing `SKILL.md`, under `<host home>/skills/` — so there is one
 * implementation for both.
 *
 * Removal only ever touches `<skillsDir>/<name>/SKILL.md` for names RAYU owns
 * (`HOST_SKILL_NAMES`), and only removes the containing directory when it is
 * left empty. A user who dropped their own files next to ours keeps them.
 */

import { readdir, rmdir, unlink } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { HOST_SKILLS, HOST_SKILL_NAMES } from '../skills/hostSkills.js'
import { readTextFileIfExists, writeTextFileAtomic } from './fileEdits.js'

/** Skill markdown is not secret and hosts may run as a different user's tool. */
const SKILL_FILE_MODE = 0o644

export type SkillInstallResult = {
  /** Skills newly written or updated. */
  written: string[]
  /** Skills already present with identical content. */
  unchanged: string[]
}

/** Writes every RAYU host skill into `skillsDir`, idempotently. */
export async function installHostSkills(
  skillsDir: string,
): Promise<SkillInstallResult> {
  const written: string[] = []
  const unchanged: string[] = []

  for (const skill of HOST_SKILLS) {
    const target = join(skillsDir, skill.name, 'SKILL.md')
    const existing = await readTextFileIfExists(target)
    if (existing === skill.content) {
      unchanged.push(skill.name)
      continue
    }
    await writeTextFileAtomic(target, skill.content, SKILL_FILE_MODE)
    written.push(skill.name)
  }

  return { written, unchanged }
}

/** Removes RAYU's host skills from `skillsDir`. Returns the names removed. */
export async function uninstallHostSkills(
  skillsDir: string,
): Promise<string[]> {
  const removed: string[] = []

  for (const name of HOST_SKILL_NAMES) {
    const dir = join(skillsDir, name)
    const file = join(dir, 'SKILL.md')
    try {
      await unlink(file)
      removed.push(name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logForDebugging(
          `[rayu-plugin] failed to remove ${file}: ${String(error)}`,
        )
      }
      continue
    }

    // Only reclaim the directory when RAYU's file was the only thing in it.
    // `rmdir` (not `rm`) is deliberate: it fails on a non-empty directory, so a
    // race that added a file between the readdir and here cannot delete it.
    try {
      const remaining = await readdir(dir)
      if (remaining.length === 0) {
        await rmdir(dir)
      }
    } catch (error) {
      logForDebugging(
        `[rayu-plugin] left ${dir} in place: ${String(error)}`,
      )
    }
  }

  return removed
}

/** Which RAYU host skills are currently installed in `skillsDir`. */
export async function listInstalledHostSkills(
  skillsDir: string,
): Promise<string[]> {
  const present: string[] = []
  for (const name of HOST_SKILL_NAMES) {
    const content = await readTextFileIfExists(join(skillsDir, name, 'SKILL.md'))
    if (content !== undefined) present.push(name)
  }
  return present
}
