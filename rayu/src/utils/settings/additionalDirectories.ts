/**
 * Persisting an extra working directory (`permissions.additionalDirectories`) into one of
 * the editable settings files — the engine half of the editor's `/add-dir`.
 *
 * It stays thin on purpose: the schema, merge and write all belong to
 * `updateSettingsForSource`, which the CLI's own `/add-dir` and the settings UI already
 * use. What this adds is choosing the source and skipping a directory that is already
 * listed, so repeated adds do not grow the file without bound.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { EditableSettingSource } from './constants.js'
import {
  getSettingsFilePathForSource,
  getSettingsForSource,
  updateSettingsForSource,
} from './settings.js'
import type { SettingsJson } from './types.js'

/** Where the editor lets a user persist an additional directory. */
export type AdditionalDirectorySettingSource = 'user' | 'project' | 'local'

const SETTINGS_SOURCE: Record<AdditionalDirectorySettingSource, EditableSettingSource> = {
  user: 'userSettings',
  project: 'projectSettings',
  local: 'localSettings',
}

/**
 * The source's current permissions.
 *
 * `updateSettingsForSource` REPLACES arrays with the one it is given, so losing an
 * existing entry means deleting a directory the user added. When schema validation fails
 * for an unrelated field, `getSettingsForSource` returns null; read the raw file then,
 * the same lenient fallback the permission-rule loader uses.
 */
function readPermissions(
  source: EditableSettingSource,
): NonNullable<SettingsJson['permissions']> {
  const validated = getSettingsForSource(source)
  if (validated) return validated.permissions ?? {}
  const filePath = getSettingsFilePathForSource(source)
  if (!filePath) return {}
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as {
      permissions?: NonNullable<SettingsJson['permissions']>
    }
    return raw.permissions ?? {}
  } catch {
    return {}
  }
}

/**
 * Add `directory` to `source`'s `permissions.additionalDirectories`, unless it is already
 * there (compared as an absolute path, so `./src` and `/work/project/src` are the same).
 *
 * Returns true when the file now lists the directory or already did. A validation or
 * write failure reports false; `updateSettingsForSource` has already logged the reason.
 */
export function addAdditionalDirectory(
  source: AdditionalDirectorySettingSource,
  directory: string,
): boolean {
  const trimmed = directory.trim()
  if (!trimmed) return false

  const settingsSource = SETTINGS_SOURCE[source]
  if (!settingsSource) return false

  const settings = getSettingsForSource(settingsSource) ?? {}
  const permissions = readPermissions(settingsSource)
  const existing = permissions.additionalDirectories ?? []
  const normalized = new Set(existing.map(entry => resolve(entry)))
  if (normalized.has(resolve(trimmed))) return true

  const updated = {
    ...settings,
    permissions: {
      ...permissions,
      additionalDirectories: [...existing, trimmed],
    },
  }
  const { error } = updateSettingsForSource(settingsSource, updated)
  return error === null
}
