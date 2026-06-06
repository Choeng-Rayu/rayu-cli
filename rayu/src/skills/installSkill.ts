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

/** Find the directory containing SKILL.md: prefer the root, else exactly one child. */
async function locateSkillDir(root: string): Promise<string> {
  if (await fileExists(join(root, 'SKILL.md'))) return root
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    throw new InstallSkillError(`Source directory not found: ${root}`)
  }
  const dirs = entries.filter(e => e.isDirectory())
  // Single top-level dir (typical of a cloned repo or unzipped archive).
  for (const d of dirs) {
    const candidate = join(root, d.name)
    if (await fileExists(join(candidate, 'SKILL.md'))) return candidate
  }
  throw new InstallSkillError(
    'No SKILL.md found at the source root or one level below it.',
  )
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
 * Install a skill from the given source. Idempotency: if the target name
 * already exists, requires `overwrite: true`.
 */
export async function installSkillFromSource(
  rawSource: string,
  options: { overwrite?: boolean } = {},
): Promise<InstalledSkill> {
  const source = rawSource.trim()
  if (!source) throw new InstallSkillError('No skill source provided.')

  const localExists = await fileExists(expandHome(source))
  const kind = classifySource(source, localExists)

  // Stage everything under a temp dir so a failed/partial install never
  // touches ~/.rayu/skills. Cleaned up in finally.
  const staging = await mkdtemp(join(tmpdir(), 'rayu-skill-'))
  try {
    let skillDir: string

    if (kind.type === 'local') {
      skillDir = await locateSkillDir(expandHome(kind.path))
    } else if (kind.type === 'github') {
      const cloneDir = join(staging, 'repo')
      await cloneGitHub(kind.owner, kind.repo, cloneDir)
      const root = kind.subdir ? join(cloneDir, kind.subdir) : cloneDir
      // Guard against a subdir that escapes the clone via `..`.
      if (!resolve(root).startsWith(resolve(cloneDir))) {
        throw new InstallSkillError('Invalid subdir in GitHub source.')
      }
      skillDir = await locateSkillDir(root)
    } else {
      // Direct SKILL.md URL: download into a temp skill dir.
      const dlDir = join(staging, 'dl')
      await mkdir(dlDir, { recursive: true })
      const md = await downloadText(kind.url)
      await writeFile(join(dlDir, 'SKILL.md'), md, 'utf-8')
      skillDir = dlDir
    }

    // Validate SKILL.md parses and extract identity for the install target.
    const skillFile = join(skillDir, 'SKILL.md')
    let content: string
    try {
      content = await readFile(skillFile, { encoding: 'utf-8' })
    } catch {
      throw new InstallSkillError(`SKILL.md not readable at ${skillFile}.`)
    }
    const { frontmatter, content: markdown } = parseFrontmatter(content, skillFile)

    const nameSource =
      (frontmatter.name != null ? String(frontmatter.name) : '') ||
      basename(skillDir)
    const name = sanitizeSkillName(nameSource)
    const description =
      (frontmatter.description != null ? String(frontmatter.description) : '') ||
      firstLine(markdown) ||
      'Installed skill'

    // Resolve the final destination inside ~/.rayu/skills and verify it
    // cannot escape that root (defense in depth on top of sanitizeSkillName).
    const skillsRoot = getUserSkillsDir()
    const dest = join(skillsRoot, name)
    if (!resolve(dest).startsWith(resolve(skillsRoot) + sep)) {
      throw new InstallSkillError(`Refusing to install outside ${skillsRoot}.`)
    }

    if ((await fileExists(dest)) && !options.overwrite) {
      throw new InstallSkillError(
        `A skill named "${name}" is already installed. Re-run with overwrite to replace it.`,
      )
    }

    // Copy the skill tree into a temp sibling, then atomically swap into place.
    await mkdir(skillsRoot, { recursive: true, mode: 0o700 })
    const tmpDest = join(skillsRoot, `.${name}.installing-${randomUUID()}`)
    await cp(skillDir, tmpDest, { recursive: true })
    await rm(dest, { recursive: true, force: true })
    await rename(tmpDest, dest)

    // Invalidate the memoized skill/command loaders so the new skill is
    // available immediately without restarting Rayu.
    clearSkillCaches()
    clearCommandMemoizationCaches()

    return { name, description, path: dest }
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
