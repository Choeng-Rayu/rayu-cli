/**
 * Legacy → current key aliases for ~/.rayu/config.json.
 *
 * The claude→rayu identifier rename (wave 4) renamed these persisted field
 * NAMES. Configs written by older versions still carry the old keys; the
 * normalizers below move them on load so no user loses settings, hints, or
 * onboarding state. Pure and reference-stable when nothing changes, so they
 * are safe to call on every config read.
 */

export const GLOBAL_IDENTIFIER_KEY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['claudeCodeFirstTokenDate', 'rayuCodeFirstTokenDate'],
  ['claudeAiMcpEverConnected', 'rayuAiMcpEverConnected'],
  ['claudeCodeHints', 'rayuCodeHints'],
  ['claudeInChromeDefaultEnabled', 'rayuInChromeDefaultEnabled'],
  ['hasCompletedClaudeInChromeOnboarding', 'hasCompletedRayuInChromeOnboarding'],
]

export const PROJECT_IDENTIFIER_KEY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['hasClaudeMdExternalIncludesApproved', 'hasRayuMdExternalIncludesApproved'],
  ['hasClaudeMdExternalIncludesWarningShown', 'hasRayuMdExternalIncludesWarningShown'],
]

function normalizeKeys<T extends object>(
  obj: T,
  aliases: ReadonlyArray<readonly [string, string]>,
): T {
  const record = obj as Record<string, unknown>
  const present = aliases.filter(([oldKey]) => record[oldKey] !== undefined)
  if (present.length === 0) return obj
  const next = { ...record }
  for (const [oldKey, newKey] of present) {
    if (next[newKey] === undefined) {
      next[newKey] = next[oldKey]
    }
    delete next[oldKey]
  }
  return next as T
}

/** Normalize one project's persisted keys (projects[<path>] entries). */
export function normalizeProjectConfigIdentifierKeys<T extends object>(project: T): T {
  return normalizeKeys(project, PROJECT_IDENTIFIER_KEY_ALIASES)
}

/**
 * Normalize a whole GlobalConfig: the global keys plus every project entry.
 * Returns the same reference when nothing changed.
 */
export function normalizeGlobalConfigIdentifierKeys<T extends object>(config: T): T {
  const normalized = normalizeKeys(config, GLOBAL_IDENTIFIER_KEY_ALIASES)
  const projects = (normalized as Record<string, unknown>).projects
  if (!projects || typeof projects !== 'object') return normalized
  const entries = Object.entries(projects as Record<string, object>)
  let changed = false
  const nextProjects: Record<string, object> = {}
  for (const [path, project] of entries) {
    const next = normalizeProjectConfigIdentifierKeys(project)
    if (next !== project) changed = true
    nextProjects[path] = next
  }
  if (!changed) return normalized
  return { ...normalized, projects: nextProjects } as T
}