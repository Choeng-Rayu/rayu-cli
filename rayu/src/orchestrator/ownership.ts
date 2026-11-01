/**
 * File ownership patterns in an Orchestrator contract: normalizing them, matching paths
 * against them, and deciding whether two of them can cover the same file.
 *
 * A pattern is a project-relative path (`src/types/user.ts`) or a glob
 * (`src/api/**`), always with forward slashes. The project root is the git root, or the
 * directory the run started in when the project is not in git. A path without glob
 * characters names one file; a directory is written with a trailing slash or `/**`.
 *
 * Overlap is decided from the patterns alone, so it also covers files no packet has
 * created yet. Two globs whose fixed leading directories are nested may overlap and are
 * reported as overlapping even when they happen not to (`src/a/*.ts` and
 * `src/a/*.css`): a false "overlap" makes the Orchestrator split or order the work,
 * while a missed one lets two workers write the same file.
 */
import picomatchModule from 'picomatch'

type Matcher = (path: string) => boolean
type PicomatchOptions = { dot?: boolean; nocase?: boolean }
type Picomatch = {
  (patterns: string | readonly string[], options?: PicomatchOptions): Matcher
  scan: (pattern: string) => { base: string; isGlob: boolean }
}
const picomatch = picomatchModule as unknown as Picomatch

/**
 * Whether paths that differ only in case are the same file here. True on Windows and
 * macOS, whose default file systems ignore case.
 */
export function defaultCaseInsensitivePaths(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

export type NormalizedPattern = { pattern: string; readFrom?: string } | { error: string }

/**
 * A pattern in its canonical form, or why it cannot be used.
 *
 * With `projectRoot`, an absolute path inside it is accepted and made relative to it:
 * the model sees absolute paths everywhere (tool results, `pwd`) and cannot know which
 * directory RAYU treats as the root, so rejecting them only costs a round trip. `readFrom`
 * names the original so the result can say what was done.
 */
export function normalizeOwnershipPattern(raw: string, projectRoot?: string): NormalizedPattern {
  let pattern = raw.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (!pattern) return { error: 'is empty' }
  if (pattern.startsWith('!')) return { error: 'cannot be a negation; list what the packet owns' }
  let readFrom: string | undefined
  if (pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern)) {
    if (!projectRoot) return { error: 'must be relative to the project root' }
    const inside = relativeToRoot(projectRoot, pattern)
    if (inside === null) return { error: `is outside the project root ${projectRoot}; paths are relative to it` }
    readFrom = raw.trim()
    pattern = inside
  } else if (pattern.startsWith('~')) {
    return { error: 'must be relative to the project root' }
  }
  while (pattern.startsWith('./')) pattern = pattern.slice(2)
  if (pattern.endsWith('/')) pattern = `${pattern}**`
  const segments = pattern.split('/')
  if (segments.includes('..')) return { error: 'cannot leave the project (contains "..")' }
  if (segments[0]?.toLowerCase() === '.git') return { error: 'cannot cover the .git directory' }
  return readFrom === undefined ? { pattern } : { pattern, readFrom }
}

/** `pattern` (absolute, forward slashes) relative to `root`, or null when it is not inside it. */
function relativeToRoot(root: string, pattern: string): string | null {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const same = (a: string, b: string) => (defaultCaseInsensitivePaths() ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (same(pattern.replace(/\/+$/, ''), base)) return '**'
  const prefix = `${base}/`
  if (!same(pattern.slice(0, prefix.length), prefix)) return null
  const rest = pattern.slice(prefix.length)
  return rest === '' ? '**' : rest
}

/** A repository-relative path as patterns are matched against it. */
export function normalizeRelativePath(path: string): string {
  let out = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (out.startsWith('./')) out = out.slice(2)
  return out
}

export function ownsPath(
  patterns: readonly string[],
  relativePath: string,
  caseInsensitive: boolean,
): boolean {
  if (patterns.length === 0) return false
  return picomatch(patterns, { dot: true, nocase: caseInsensitive })(normalizeRelativePath(relativePath))
}

/** True when `base` names `other` or a directory above it (`''` is above everything). */
function isAncestorOrSelf(base: string, other: string): boolean {
  return base === '' || other === base || other.startsWith(`${base}/`)
}

/** Whether some file could be matched by both patterns. Conservative for two globs. */
export function patternsOverlap(a: string, b: string, caseInsensitive: boolean): boolean {
  const [x, y] = caseInsensitive ? [a.toLowerCase(), b.toLowerCase()] : [a, b]
  if (x === y) return true
  const scanX = picomatch.scan(x)
  const scanY = picomatch.scan(y)
  if (!scanX.isGlob) return picomatch(y, { dot: true })(x)
  if (!scanY.isGlob) return picomatch(x, { dot: true })(y)
  return isAncestorOrSelf(scanX.base, scanY.base) || isAncestorOrSelf(scanY.base, scanX.base)
}

/** The first pair of patterns from the two lists that can cover the same file. */
export function firstOverlap(
  left: readonly string[],
  right: readonly string[],
  caseInsensitive: boolean,
): readonly [string, string] | null {
  for (const a of left) {
    for (const b of right) {
      if (patternsOverlap(a, b, caseInsensitive)) return [a, b]
    }
  }
  return null
}
