/**
 * The Settings tab's Rayucode-only rows: choices kept in Rayucode's own profile
 * (`rayucode-preferences.json`, see src/runtime/productPreferences.ts) rather than in the
 * files the terminal CLI reads.
 *
 * Read and written here in the extension host, with no engine child: the profile is one
 * small JSON file, and the module that owns it is already in this bundle (the chat reads
 * it for the remembered permission mode). The permission mode is the SAME value the chat
 * remembers, so changing it in either place changes both.
 */
import type { PermissionMode } from '../../../types/permissions.js'
import {
  readRayucodePreferences,
  updateRayucodePreferences,
  type RuntimeProductPreferences,
} from '../../../runtime/productPreferences.js'
import { permissionModeById } from '../../shared/permissionModes.js'
import type { SharedSettingsOutcome } from './sharedSettings.js'

export interface RayucodeSettingsValues {
  /** One of the modes the editor offers (`PERMISSION_MODES`). */
  permissionMode: string
  promptSuggestionEnabled: boolean
}

export function readRayucodeSettings(): RayucodeSettingsValues {
  const preferences = readRayucodePreferences()
  return {
    // Through the editor's own mapping, so an old `bypassPermissions` shows as Full Manage.
    permissionMode: permissionModeById(preferences.permissionMode ?? 'default').id,
    promptSuggestionEnabled: preferences.promptSuggestionEnabled !== false,
  }
}

/** Save one already-validated Rayucode-only value. */
export function writeRayucodeSetting(key: string, value: boolean | string): SharedSettingsOutcome<true> {
  const patch = preferencePatch(key, value)
  if (!patch) return { ok: false, error: 'That setting cannot be changed here.' }
  const stored = updateRayucodePreferences(patch)
  return stored.error
    ? { ok: false, error: `Could not save the setting: ${stored.error.message}` }
    : { ok: true, value: true }
}

function preferencePatch(key: string, value: boolean | string): Partial<RuntimeProductPreferences> | null {
  switch (key) {
    case 'permissionMode':
      return typeof value === 'string' ? { permissionMode: value as PermissionMode } : null
    case 'promptSuggestionEnabled':
      // Only the opt-out is stored; `undefined` removes the key, and on is the default.
      return typeof value === 'boolean' ? { promptSuggestionEnabled: value ? undefined : false } : null
    default:
      return null
  }
}
