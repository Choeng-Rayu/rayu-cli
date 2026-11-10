import { randomBytes } from 'crypto'
import { constants as fsConstants } from 'fs'
import { access, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { logError } from '../../utils/log.js'

/** Terminal.app's preferences domain. */
export const TERMINAL_DOMAIN = 'com.apple.Terminal'

/**
 * The key map entry for Shift+Return in a Terminal.app profile: `$` marks
 * Shift, `000D` is the Unicode value of Return.
 */
export const SHIFT_RETURN_BINDING = '$000D'

/**
 * What Shift+Return sends once installed: ESC followed by CR.
 *
 * ESC CR is the sequence Rayu already reads as a newline — the same bytes the
 * VS Code keybindings.json and Alacritty installers emit. Terminal.app has no
 * extended-key protocol, so a plain Return arrives for Shift+Return unless the
 * profile key map sends something distinguishable.
 */
export const NEWLINE_SEQUENCE = '\x1b\r'

/** Where Terminal.app keeps its built-in key map (the bundle moved in macOS 11). */
const TERMINAL_BUNDLE_CANDIDATES = [
  '/System/Applications/Utilities/Terminal.app',
  '/Applications/Utilities/Terminal.app',
]

/**
 * Escape one profile name for use in a `plutil` key path.
 *
 * `.` separates path components, so a literal dot is escaped as `\.`. A
 * backslash cannot be spelled at all, and macOS 15's plutil aborts (SIGABRT)
 * on a component starting with `@`; both return null so the caller can skip
 * that profile instead of corrupting the preferences.
 */
export function keypathComponent(name: string): string | null {
  if (name === '' || name.startsWith('@') || name.includes('\\')) {
    return null
  }
  return name.replace(/\./g, '\\.')
}

export type KeyMapDecision =
  /** The profile has no key map of its own — seed it from the built-in map. */
  | { action: 'seed' }
  /** The profile has a key map without a Shift+Return entry. */
  | { action: 'insert' }
  /** Shift+Return already sends the newline sequence. */
  | { action: 'already' }
  /** Something else owns Shift+Return (or the map is not a dictionary). */
  | { action: 'conflict'; value: string }

/**
 * Decide what to do with one profile, given the plutil type of its
 * `keyMapBoundKeys` (null when absent) and of its `$000D` entry.
 *
 * Pure so the branching is testable without macOS tooling.
 */
export function decideKeyMapAction(
  mapKind: string | null,
  existing: { kind: string; value: string | null } | null,
): KeyMapDecision {
  if (mapKind === null) {
    return { action: 'seed' }
  }
  if (mapKind !== 'dictionary') {
    return { action: 'conflict', value: mapKind }
  }
  if (existing === null) {
    return { action: 'insert' }
  }
  if (existing.value === NEWLINE_SEQUENCE) {
    return { action: 'already' }
  }
  return { action: 'conflict', value: existing.value ?? existing.kind }
}

export type KeyMapResult = {
  /** Profiles that now send the newline sequence. */
  installed: string[]
  /** Profiles that already sent it. */
  already: string[]
  /** Profiles whose Shift+Return is bound to something else; left untouched. */
  conflicts: { profile: string; value: string }[]
  /** Profiles plutil cannot address by name; left untouched. */
  skipped: string[]
}

type RunResult = { code: number; stdout: string; stderr: string }

async function run(file: string, args: string[]): Promise<RunResult> {
  const { code, stdout, stderr } = await execFileNoThrow(file, args)
  return { code, stdout, stderr }
}

async function must(file: string, args: string[]): Promise<string> {
  const result = await run(file, args)
  if (result.code !== 0) {
    throw new Error(`${file} ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout
}

/** plutil type of `keypath`, or null when the key does not exist. */
async function typeOf(path: string, keypath: string): Promise<string | null> {
  const { code, stdout } = await run('/usr/bin/plutil', [
    '-type',
    keypath,
    path,
  ])
  if (code !== 0) {
    return null
  }
  const kind = stdout.trim()
  return kind === '' ? null : kind
}

/** Raw string value of `keypath`, or null when absent or not a string. */
async function stringOf(
  path: string,
  keypath: string,
): Promise<string | null> {
  const { code, stdout } = await run('/usr/bin/plutil', [
    '-extract',
    keypath,
    'raw',
    '-o',
    '-',
    path,
  ])
  if (code !== 0) {
    return null
  }
  // Do not trim CR — the value itself may end in one.
  return stdout.replace(/\n$/, '')
}

/**
 * Validate a converted built-in key map.
 *
 * Only a dictionary of string bindings can be inserted with `plutil -insert
 * -json`, and it must not already bind Shift+Return (inserting it again would
 * fail). Anything else is not a usable seed — returns null so the caller skips
 * the profile rather than writing a map that breaks its other keys.
 */
export function parseBuiltInKeyMap(json: string): string | null {
  try {
    const parsed: unknown = JSON.parse(json)
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      return null
    }
    const entries = Object.entries(parsed as Record<string, unknown>)
    if (entries.length === 0) {
      return null
    }
    if (!entries.every(([, value]) => typeof value === 'string')) {
      return null
    }
    if (Object.hasOwn(parsed, SHIFT_RETURN_BINDING)) {
      return null
    }
  } catch {
    return null
  }
  return json
}

/**
 * Terminal.app's built-in key map, as JSON.
 *
 * A profile's `keyMapBoundKeys` replaces the built-in map as a whole, so a
 * profile that has none must be seeded with this or it would lose F1–F20,
 * Shift+arrows and Option+arrows.
 */
async function readBuiltInKeyMap(): Promise<string | null> {
  for (const bundle of TERMINAL_BUNDLE_CANDIDATES) {
    const path = join(bundle, 'Contents', 'Resources', 'keyMappings.plist')
    try {
      await access(path, fsConstants.R_OK)
    } catch {
      continue
    }
    const result = await run('/usr/bin/plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      path,
    ])
    if (result.code !== 0) {
      continue
    }
    const validated = parseBuiltInKeyMap(result.stdout.trim())
    if (validated === null) {
      continue
    }
    return validated
  }
  return null
}

/**
 * Install Shift+Return → ESC CR into the key map of each Terminal.app profile.
 *
 * Goes through `defaults export` / `defaults import` (cfprefsd) rather than
 * editing the plist behind cfprefsd's back. Nothing is replaced: a profile
 * whose Shift+Return already sends something else is reported, not touched.
 *
 * Terminal.app reads its profiles at launch, so the caller must tell the user
 * to quit and reopen Terminal for the change to take effect.
 */
export async function installShiftReturnKeyMap(
  profiles: string[],
): Promise<KeyMapResult> {
  const result: KeyMapResult = {
    installed: [],
    already: [],
    conflicts: [],
    skipped: [],
  }
  const stamp = randomBytes(6).toString('hex')
  const exportPath = join(tmpdir(), `rayu-terminal-${stamp}.plist`)
  const verifyPath = join(tmpdir(), `rayu-terminal-${stamp}-verify.plist`)

  try {
    await must('defaults', ['export', TERMINAL_DOMAIN, exportPath])

    let builtIn: string | null = null
    for (const profile of profiles) {
      const component = keypathComponent(profile)
      if (component === null) {
        result.skipped.push(profile)
        logError(
          new Error(
            `Terminal.app profile "${profile}" cannot be addressed by plutil; ` +
              'add Shift+Return to its key map by hand in Settings › Profiles › Keyboard.',
          ),
        )
        continue
      }

      const profilePath = `Window Settings.${component}`
      const profileKind = await typeOf(exportPath, profilePath)
      // A profile name can be recorded in "Default Window Settings" before its
      // "Window Settings" entry exists (Terminal writes profiles at launch).
      // Report and move on instead of failing the whole setup — throwing here
      // would roll back the Option-as-Meta and bell changes via the caller's
      // backup-restore path.
      if (profileKind !== 'dictionary') {
        result.skipped.push(profile)
        logError(
          new Error(
            `Terminal.app profile "${profile}" has no saved settings entry; ` +
              'add Shift+Return to its key map by hand in Settings › Profiles › Keyboard.',
          ),
        )
        continue
      }

      const mapPath = `${profilePath}.keyMapBoundKeys`
      const mapKind = await typeOf(exportPath, mapPath)
      const bindingPath = `${mapPath}.${SHIFT_RETURN_BINDING}`
      const existingKind =
        mapKind === 'dictionary'
          ? await typeOf(exportPath, bindingPath)
          : null
      const existing =
        existingKind === null
          ? null
          : {
              kind: existingKind,
              value:
                existingKind === 'string'
                  ? await stringOf(exportPath, bindingPath)
                  : null,
            }

      const decision = decideKeyMapAction(mapKind, existing)
      switch (decision.action) {
        case 'already':
          result.already.push(profile)
          break
        case 'conflict':
          result.conflicts.push({ profile, value: decision.value })
          break
        case 'seed': {
          if (builtIn === null) {
            builtIn = await readBuiltInKeyMap()
          }
          if (builtIn === null) {
            // Seeding is mandatory here: a profile key map replaces the
            // built-in one wholesale, so inserting $000D alone would turn off
            // F1–F20, Shift+arrows and Option+arrows. Report and move on
            // rather than failing the whole setup and rolling back the
            // Option-as-Meta and bell changes that already succeeded.
            result.skipped.push(profile)
            logError(
              new Error(
                "Could not read Terminal.app's built-in key map " +
                  '(Contents/Resources/keyMappings.plist), so the Shift+Return ' +
                  `binding was not added to profile "${profile}"`,
              ),
            )
            continue
          }
          await must('/usr/bin/plutil', [
            '-insert',
            mapPath,
            '-json',
            builtIn,
            exportPath,
          ])
          await must('/usr/bin/plutil', [
            '-insert',
            bindingPath,
            '-string',
            NEWLINE_SEQUENCE,
            exportPath,
          ])
          result.installed.push(profile)
          break
        }
        case 'insert':
          await must('/usr/bin/plutil', [
            '-insert',
            bindingPath,
            '-string',
            NEWLINE_SEQUENCE,
            exportPath,
          ])
          result.installed.push(profile)
          break
      }
    }

    if (result.installed.length > 0) {
      await must('defaults', ['import', TERMINAL_DOMAIN, exportPath])

      // Read back through a fresh export: cfprefsd may normalise or reject
      // values, and a silent failure here would leave the footer claiming
      // Shift+Enter works when it does not.
      await must('defaults', ['export', TERMINAL_DOMAIN, verifyPath])
      for (const profile of result.installed) {
        const component = keypathComponent(profile)
        if (component === null) {
          continue
        }
        const value = await stringOf(
          verifyPath,
          `Window Settings.${component}.keyMapBoundKeys.${SHIFT_RETURN_BINDING}`,
        )
        if (value !== NEWLINE_SEQUENCE) {
          throw new Error(
            `Shift+Return was not saved for Terminal.app profile "${profile}"`,
          )
        }
      }
    }

    return result
  } finally {
    await rm(exportPath, { force: true })
    await rm(verifyPath, { force: true })
  }
}
