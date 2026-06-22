// Shared installer core for `/install-skill` (user command) and the
// InstallSkill tool (AI-invocable). Installs a skill into the Rayu user skills
// directory (~/.rayu/skills/<name>/) from one of three source kinds:
//   - local directory path           e.g. ./my-skill  or  /abs/path/my-skill
//   - GitHub repo (optional subdir)   e.g. owner/repo, owner/repo/sub/dir,
//                                          github:owner/repo, https://github.com/owner/repo
//   - direct URL to a SKILL.md        e.g. https://example.com/path/SKILL.md
//
// Security: the skill name is sanitized to a single safe path segment (no
// traversal); files are copied into a freshly-resolved ~/.rayu/skills/<name>
// only. Skill contents are never executed at install time — only SKILL.md
// frontmatter is parsed for validation and display.
import { randomUUID } from 'crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { basename, isAbsolute, join, resolve, sep } from 'path'
import { clearCommandMemoizationCaches } from '../commands.js'
import { getRayuConfigHomeDir } from '../utils/envUtils.js'
import { isENOENT } from '../utils/errors.js'
import { execFileNoThrow } from '../utils/execFileNoThrow.js'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { logError } from '../utils/log.js'
import { clearSkillCaches } from './loadSkillsDir.js'

/** Outcome of a successful install. */
export type InstalledSkill = {
  name: string
  description: string
  path: string
  /** True when a skill of the same name already existed and was overwritten. */
  replaced: boolean
}

export class InstallSkillError extends Error {}

/** Resolved skill identity = a single safe path segment (no traversal). */
export function sanitizeSkillName(raw: string): string {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  if (!name || name === '.' || name === '..' || name.includes('/')) {
    throw new InstallSkillError(
      `Cannot derive a safe skill name from "${raw}".`,
    )
  }
  return name
}

/** Absolute path to the Rayu user skills directory (~/.rayu/skills). */
export function getUserSkillsDir(): string {
  return join(getRayuConfigHomeDir(), 'skills')
}

type SourceKind =
  | { type: 'local'; path: string }
  | { type: 'github'; owner: string; repo: string; subdir: string | null }
  | { type: 'skillmd-url'; url: string }

/**
 * Classify a source string. GitHub shorthand (`owner/repo[/sub]`) is only
 * matched when the path doesn't exist locally, so a local `owner/repo`-shaped
 * directory still wins.
 */
export function classifySource(rawSource: string, localExists: boolean): SourceKind {
  const source = rawSource.trim()
  if (!source) throw new InstallSkillError('No skill source provided.')

  // Explicit local path forms always resolve locally.
  if (source.startsWith('.') || source.startsWith('~') || isAbsolute(source)) {
    return { type: 'local', path: source }
  }

  // github.com URL → owner/repo[/subdir]
  const ghUrl = source.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:tree|blob)\/[^/]+\/(.+))?\/?$/i,
  )
  if (ghUrl) {
    return {
      type: 'github',
      owner: ghUrl[1],
      repo: ghUrl[2],
      subdir: ghUrl[3] ?? null,
    }
  }

  // github:owner/repo[/subdir]
  const ghScheme = source.match(/^github:([^/]+)\/([^/]+?)(?:\/(.+))?$/i)
  if (ghScheme) {
    return {
      type: 'github',
      owner: ghScheme[1],
      repo: ghScheme[2],
      subdir: ghScheme[3] ?? null,
    }
  }

  // Any other http(s) URL → treat as a direct SKILL.md (or raw file) URL.
  if (/^https?:\/\//i.test(source)) {
    return { type: 'skillmd-url', url: source }
  }

  // Bare `owner/repo[/subdir]` shorthand — only when it isn't a local dir.
  if (!localExists) {
    const shorthand = source.match(/^([^/\s]+)\/([^/\s]+)(?:\/(.+))?$/)
    if (shorthand) {
      return {
        type: 'github',
        owner: shorthand[1],
        repo: shorthand[2],
        subdir: shorthand[3] ?? null,
      }
    }
  }

  // Fall back to a local path (will fail later with a clear message if absent).
  return { type: 'local', path: source }
}

/** Find ALL skill directories (each directly containing a SKILL.md) reachable
 * from `root`. Priority:
 *   1. root/SKILL.md             → the source is itself one skill
 *   2. root/skills/<x>/SKILL.md  → a skills collection: install every skill
 *   3. recursive scan            → any SKILL.md dirs found (junk dirs skipped)
 * Throws InstallSkillError if none found. */
async function locateSkillDirs(root: string): Promise<string[]> {
  // 1. The source is itself a single skill.
  if (await fileExists(join(root, 'SKILL.md'))) return [root]

  // 2. Conventional collection layout: a top-level `skills/` directory holding
  //    one subdirectory per skill (e.g. ponytail). Install all of them.
  const skillsContainer = join(root, 'skills')
  if (await fileExists(skillsContainer)) {
    const collected = await collectSkillDirs(skillsContainer, 0, 4, [])
    if (collected.length > 0) return collected
  }

  // 3. Fallback: scan the whole tree for any SKILL.md dirs.
  const found = await collectSkillDirs(root, 0, 5, [])
  if (found.length > 0) return found

  throw new InstallSkillError(
    'No SKILL.md found. The source should contain a SKILL.md (a single skill), ' +
    'a "skills/" directory of skills, or you can point at a subdirectory: ' +
    'owner/repo/tree/main/path/to/skill',
  )
}

/** Collect every directory that DIRECTLY contains a SKILL.md, walking up to
 * `maxDepth` levels. A skill dir is treated as a leaf (its nested folders are
 * the skill's own assets, not separate skills). Hidden dirs (.git, .github,
 * agent-config dirs like .claude-plugin) and node_modules are skipped. */
async function collectSkillDirs(
  dir: string,
  depth: number,
  maxDepth: number,
  out: string[],
): Promise<string[]> {
  if (depth > maxDepth) return out
  if (await fileExists(join(dir, 'SKILL.md'))) {
    out.push(dir)
    return out
  }
  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    await collectSkillDirs(join(dir, e.name), depth + 1, maxDepth, out)
  }
  return out
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch (e) {
    if (isENOENT(e)) return false
    throw e
  }
}

/** Shallow-clone a GitHub repo into `dest`. Throws InstallSkillError on failure. */
async function cloneGitHub(
  owner: string,
  repo: string,
  dest: string,
): Promise<void> {
  const url = `https://github.com/${owner}/${repo}.git`
  const { code, stderr } = await execFileNoThrow('git', [
    'clone',
    '--depth',
    '1',
    url,
    dest,
  ])
  if (code !== 0) {
    throw new InstallSkillError(
      `git clone of ${owner}/${repo} failed: ${stderr.trim() || `exit ${code}`}`,
    )
  }
}

/**
 * Install all skills from the given source. A source may be a single skill or a
 * collection (e.g. a repo with a `skills/` directory). Returns one entry per
 * installed skill. Idempotency: if any target name already exists, requires
 * `overwrite: true` — checked up front so a batch never installs partially.
 */
export async function installSkillFromSource(
  rawSource: string,
  options: { overwrite?: boolean } = {},
): Promise<InstalledSkill[]> {
  const source = rawSource.trim()
  if (!source) throw new InstallSkillError('No skill source provided.')

  const localExists = await fileExists(expandHome(source))
  const kind = classifySource(source, localExists)

  // Stage everything under a temp dir so a failed/partial install never
  // touches ~/.rayu/skills. Cleaned up in finally.
  const staging = await mkdtemp(join(tmpdir(), 'rayu-skill-'))
  try {
    let scanRoot: string

    if (kind.type === 'local') {
      scanRoot = expandHome(kind.path)
    } else if (kind.type === 'github') {
      const cloneDir = join(staging, 'repo')
      await cloneGitHub(kind.owner, kind.repo, cloneDir)
      const root = kind.subdir ? join(cloneDir, kind.subdir) : cloneDir
      // Guard against a subdir that escapes the clone via `..`.
      if (!resolve(root).startsWith(resolve(cloneDir))) {
        throw new InstallSkillError('Invalid subdir in GitHub source.')
      }
      scanRoot = root
    } else {
      // Direct SKILL.md URL: download into a temp skill dir.
      const dlDir = join(staging, 'dl')
      await mkdir(dlDir, { recursive: true })
      const md = await downloadText(kind.url)
      await writeFile(join(dlDir, 'SKILL.md'), md, 'utf-8')
      scanRoot = dlDir
    }

    const skillDirs = await locateSkillDirs(scanRoot)
    const skillsRoot = getUserSkillsDir()

    // Plan every install: validate SKILL.md, derive a safe name + description,
    // resolve the destination and verify it cannot escape the skills root.
    type Planned = {
      skillDir: string
      name: string
      description: string
      dest: string
    }
    const planned: Planned[] = []
    const seenNames = new Set<string>()
    for (const skillDir of skillDirs) {
      const skillFile = join(skillDir, 'SKILL.md')
      let content: string
      try {
        content = await readFile(skillFile, { encoding: 'utf-8' })
      } catch {
        throw new InstallSkillError(`SKILL.md not readable at ${skillFile}.`)
      }
      const { frontmatter, content: markdown } = parseFrontmatter(
        content,
        skillFile,
      )
      const nameSource =
        (frontmatter.name != null ? String(frontmatter.name) : '') ||
        basename(skillDir)
      const name = sanitizeSkillName(nameSource)
      if (seenNames.has(name)) continue // de-dup within a single source
      seenNames.add(name)
      const description =
        (frontmatter.description != null
          ? String(frontmatter.description)
          : '') ||
        firstLine(markdown) ||
        'Installed skill'
      const dest = join(skillsRoot, name)
      if (!resolve(dest).startsWith(resolve(skillsRoot) + sep)) {
        throw new InstallSkillError(`Refusing to install outside ${skillsRoot}.`)
      }
      planned.push({ skillDir, name, description, dest })
    }

    // Reinstalling is always allowed: an existing skill of the same name is
    // overwritten in place and reported back via `replaced` so the caller can
    // tell the user. Each swap is atomic (copy to a temp sibling, then rename),
    // so a failure never leaves a half-written skill.
    await mkdir(skillsRoot, { recursive: true, mode: 0o700 })
    const installed: InstalledSkill[] = []
    for (const p of planned) {
      const replaced = await fileExists(p.dest)
      const tmpDest = join(skillsRoot, `.${p.name}.installing-${randomUUID()}`)
      await cp(p.skillDir, tmpDest, { recursive: true })
      await rm(p.dest, { recursive: true, force: true })
      await rename(tmpDest, p.dest)
      installed.push({
        name: p.name,
        description: p.description,
        path: p.dest,
        replaced,
      })
    }

    // Invalidate the memoized skill/command loaders so the new skills are
    // available immediately without restarting Rayu.
    clearSkillCaches()
    clearCommandMemoizationCaches()

    return installed
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(e => logError(e))
  }
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function firstLine(markdown: string): string {
  for (const line of markdown.split('\n')) {
    const t = line.replace(/^#+\s*/, '').trim()
    if (t) return t
  }
  return ''
}

/** Download a text resource (SKILL.md). Uses the global fetch (Bun/Node 18+). */
async function downloadText(url: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(url)
  } catch (e) {
    throw new InstallSkillError(`Failed to fetch ${url}: ${String(e)}`)
  }
  if (!res.ok) {
    throw new InstallSkillError(`Failed to fetch ${url}: HTTP ${res.status}`)
  }
  return res.text()
}
