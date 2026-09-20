import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getRayuAuthConfigDir } from '../utils/envUtils.js'
import type { EffortLevel } from '../utils/effort.js'
import type { PermissionMode } from '../types/permissions.js'

export interface RuntimeProductPreferences {
  effort?: EffortLevel
  thinkingEnabled?: boolean
  permissionMode?: PermissionMode
}

const FILE_NAME = 'rayucode-preferences.json'

function hasRayucodePreferenceProfile(): boolean {
  // The extension host identifies its isolated global-storage profile by directory;
  // the child additionally carries the product marker. A generic library/test process
  // has neither and must never read or mutate the terminal CLI's default config folder.
  return Boolean(process.env.RAYU_AUTH_CONFIG_DIR) || isRayucodeRuntime()
}

export function isRayucodeRuntime(): boolean {
  return process.env.RAYU_CLIENT_PRODUCT === 'rayucode'
}

export function getRayucodePreferencesPath(): string {
  return join(getRayuAuthConfigDir(), FILE_NAME)
}

function isEffort(value: unknown): value is EffortLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'max'
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    value === 'default' ||
    value === 'acceptEdits' ||
    value === 'bypassPermissions' ||
    value === 'plan' ||
    value === 'auto' ||
    value === 'bubble' ||
    value === 'delegate' ||
    value === 'dontAsk' ||
    value === 'fullManage' ||
    value === 'orchestrator'
  )
}

/** Read a bounded, validated product profile. Invalid or absent files mean defaults. */
export function readRayucodePreferences(): RuntimeProductPreferences {
  if (!hasRayucodePreferenceProfile()) return {}
  try {
    const parsed = JSON.parse(readFileSync(getRayucodePreferencesPath(), 'utf8')) as Record<string, unknown>
    return {
      ...(isEffort(parsed.effort) ? { effort: parsed.effort } : {}),
      ...(typeof parsed.thinkingEnabled === 'boolean'
        ? { thinkingEnabled: parsed.thinkingEnabled }
        : {}),
      ...(isPermissionMode(parsed.permissionMode)
        ? { permissionMode: parsed.permissionMode }
        : {}),
    }
  } catch {
    return {}
  }
}

/** Keep the CLI's existing value; Rayucode uses its own profile and Auto is undefined. */
export function initialEffortForProduct(
  cliValue: EffortLevel | undefined,
): EffortLevel | undefined {
  return isRayucodeRuntime() ? readRayucodePreferences().effort : cliValue
}

/** Rayucode defaults reasoning on, independently from the CLI's user setting. */
export function initialThinkingForProduct(cliValue: boolean): boolean {
  if (!isRayucodeRuntime()) return cliValue
  return readRayucodePreferences().thinkingEnabled ?? true
}

/**
 * Atomic product-profile update. `undefined` deletes a key, which is how Auto is
 * represented. This file contains preferences only and is never sent to the webview.
 */
export function updateRayucodePreferences(
  patch: Partial<Record<keyof RuntimeProductPreferences, RuntimeProductPreferences[keyof RuntimeProductPreferences] | undefined>>,
): { error: Error | null; value: RuntimeProductPreferences } {
  const current = readRayucodePreferences()
  if (!hasRayucodePreferenceProfile()) return { error: null, value: current }
  const next: RuntimeProductPreferences = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key as keyof RuntimeProductPreferences]
    else Object.assign(next, { [key]: value })
  }

  const path = getRayucodePreferencesPath()
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
    try { chmodSync(path, 0o600) } catch {}
    return { error: null, value: next }
  } catch (cause) {
    return {
      error: cause instanceof Error ? cause : new Error(String(cause)),
      value: current,
    }
  }
}
