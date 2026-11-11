/**
 * Legacy → current key aliases for settings files.
 *
 * The claude→rayu identifier rename (wave 4) renamed these settings keys.
 * Users' settings.json files on disk are NEVER rewritten — instead every parse
 * normalizes the legacy keys in memory, so both old and new keys keep working
 * forever (non-destructive dual-read).
 */
export const SETTINGS_IDENTIFIER_KEY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['claudeMdExcludes', 'rayuMdExcludes'],
  ['claudeMcpEnabled', 'rayuMcpEnabled'],
  ['claudeSkillsEnabled', 'rayuSkillsEnabled'],
]

/**
 * Normalize legacy keys on a freshly parsed settings object, in place.
 * Call immediately before SettingsSchema().safeParse. No-op for non-objects.
 */
export function normalizeLegacySettingsIdentifierKeys(data: unknown): void {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return
  const record = data as Record<string, unknown>
  for (const [oldKey, newKey] of SETTINGS_IDENTIFIER_KEY_ALIASES) {
    if (record[oldKey] === undefined) continue
    if (record[newKey] === undefined) {
      record[newKey] = record[oldKey]
    }
    delete record[oldKey]
  }
}