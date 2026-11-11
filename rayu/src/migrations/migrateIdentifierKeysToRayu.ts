import { saveGlobalConfig } from '../utils/config.js'
import { normalizeGlobalConfigIdentifierKeys } from '../utils/configIdentifierKeys.js'

/**
 * Migration: rewrite legacy claude-named keys in ~/.rayu/config.json to their
 * rayu names (global fields and every projects[<path>] entry).
 *
 * In-memory reads are already normalized by migrateConfigFields; this persists
 * the change once so the on-disk file matches the current schema. No-op when
 * nothing changed — saveGlobalConfig skips the write for an unchanged config.
 */
export function migrateIdentifierKeysToRayu(): void {
  saveGlobalConfig(prev => normalizeGlobalConfigIdentifierKeys(prev))
}