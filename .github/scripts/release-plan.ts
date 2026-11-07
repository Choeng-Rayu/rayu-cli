// release-plan.ts — compute the next semver version and a CHANGELOG.md block
// from conventional commits, for the Rayu CLI auto-release workflow.
//
// The version lives ONLY in rayu/package.json (scripts/macroValues.ts reads
// pkg.version at build time). The CHANGELOG block is prepended to
// rayu/CHANGELOG.md and parsed at RUNTIME by rayu/src/utils/releaseNotes.ts
// (parseChangelog splits on /^## /gm, version = firstLine.split(' - ')[0],
// bullets = lines starting "- "), so the "## <semver> - <date> (Beta)" heading
// shape and the "- " bullets MUST be preserved exactly.
//
// Modes:
//   (default) / --dry-run : print planned version + block + summary, write nothing.
//   --apply               : write rayu/package.json version + prepend the block,
//                           then print machine-readable `version=vX.Y.Z` + `released=true`.
//   --force               : release even when no feat/fix/breaking commit is found.
//   --base <commit>       : override the base commit/range (for testing).
//   --no-npm              : skip the npm-registry check (offline / deterministic tests).
//
// If the computed version already exists on npm (e.g. package.json was published
// by hand but the git tag was never made), the patch is advanced past every
// published version, so we never create a tag/release for an already-shipped
// version. Best-effort: if the registry is unreachable the computed version is used.
//
// Run from the REPO ROOT (paths are relative to CWD). Git steps are resilient
// when CWD is not a git repo so the script can be tested on a scratch copy.
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

type Bump = 'major' | 'minor' | 'patch'

interface Categorised {
  breaking: string[]
  feat: string[]
  fix: string[]
}

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const force = args.includes('--force')
const baseIdx = args.indexOf('--base')
const baseOverride = baseIdx !== -1 ? args[baseIdx + 1] : undefined
const noNpm = args.includes('--no-npm')

const PKG_PATH = 'rayu/package.json'
const CHANGELOG_PATH = 'rayu/CHANGELOG.md'
const TAG_PREFIX = 'v'
// Conventional types that NEVER trigger a release and never appear as bullets.
const IGNORED = /^(chore|docs|test|ci|build|style|refactor|revert)(\(.+\))?:/
const MAX_BULLETS = 60

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

function fail(msg: string): never {
  console.error(`release-plan: ${msg}`)
  process.exit(1)
}

// --- current version -------------------------------------------------------
const pkgRaw = readFileSync(PKG_PATH, 'utf8')
const pkg = JSON.parse(pkgRaw) as { version?: string }
if (!pkg.version) fail(`${PKG_PATH} has no version field`)
const current = pkg.version.trim()
const m = current.match(/^(\d+)\.(\d+)\.(\d+)/)
if (!m) fail(`cannot parse semver from "${current}"`)
const cur = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }

// --- base commit / range ---------------------------------------------------
let base = baseOverride ?? undefined
if (!base) {
  base = git(['log', '--grep', '^release: ', '-1', '--format=%H']) ?? undefined
  if (!base) base = git(['describe', '--tags', '--abbrev=0', '--match', `${TAG_PREFIX}*`]) ?? undefined
  if (!base) base = 'HEAD~50'
}
const inGit = git(['rev-parse', '--is-inside-work-tree']) === 'true'
const range = inGit ? `${base}..HEAD` : undefined

// --- collect commits -------------------------------------------------------
let commits: { subject: string; body: string }[] = []
if (range) {
  const out = git(['log', range, '--no-merges', '--max-count=200', '--format=%s%x1f%b%x1e'])
  if (out) {
    commits = out
      .split('\x1e')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const i = r.indexOf('\x1f')
        const subject = (i === -1 ? r : r.slice(0, i)).trim()
        const body = (i === -1 ? '' : r.slice(i + 1)).trim()
        return { subject, body }
      })
      .filter((c) => !/^release:/.test(c.subject) && !/\[skip ci\]/.test(c.subject))
  }
}

// --- classify --------------------------------------------------------------
const classified: Categorised = { breaking: [], feat: [], fix: [] }
for (const c of commits) {
  if (IGNORED.test(c.subject)) continue
  const isBreaking = /^[a-z]+(\(.+\))?!:/.test(c.subject) || /^BREAKING[ -]CHANGE:/m.test(c.body)
  const type = c.subject.match(/^([a-z]+)(\(.+\))?!?:/)?.[1]
  const text = c.subject.replace(/^[a-z]+(\(.+\))?!?:\s*/, '').trim()
  if (!text) continue
  if (isBreaking) classified.breaking.push(text)
  else if (type === 'feat') classified.feat.push(text)
  else if (type === 'fix' || type === 'hotfix' || type === 'perf') classified.fix.push(text)
}

const hasBreaking = classified.breaking.length > 0
const hasFeat = classified.feat.length > 0
const hasFix = classified.fix.length > 0

if (!hasBreaking && !hasFeat && !hasFix && !force) {
  console.log('released=false')
  console.log(`# no feat/fix/breaking commits since ${base}; nothing to release`)
  process.exit(0)
}

// --- compute new version ---------------------------------------------------
const bump: Bump = hasBreaking ? 'major' : hasFeat ? 'minor' : 'patch'
let newVersion =
  bump === 'major'
    ? `${cur.major + 1}.0.0`
    : bump === 'minor'
      ? `${cur.major}.${cur.minor + 1}.0`
      : `${cur.major}.${cur.minor}.${cur.patch + 1}`

// --- idempotency: never re-release an existing tag -------------------------
const tagExists = (v: string) => Boolean(git(['ls-remote', '--tags', 'origin', `refs/tags/${TAG_PREFIX}${v}`]))
if (tagExists(newVersion)) {
  console.log('released=false')
  console.log(`# tag ${TAG_PREFIX}${newVersion} already exists on origin; nothing to do`)
  process.exit(0)
}

// --- drift guard: never target a version already published to npm ----------
// package.json can fall behind npm (published by hand, tag never made), which
// would otherwise produce a bogus tag/release for an existing version. Advance
// the patch past every published one. Best-effort — offline keeps the computed.
async function publishedVersions(): Promise<Set<string> | null> {
  if (noNpm) return null
  try {
    const res = await fetch('https://registry.npmjs.org/@rayu-dev%2Frayu-cli', {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const doc = (await res.json()) as { versions?: Record<string, unknown> }
    return new Set(Object.keys(doc.versions ?? {}))
  } catch {
    return null
  }
}
const published = await publishedVersions()
if (published) {
  const parse = (v: string): [number, number, number] | null => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const cmp = (a: [number, number, number], b: [number, number, number]) =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  let maxPub: [number, number, number] | null = null
  for (const v of published) {
    const p = parse(v)
    if (p && (!maxPub || cmp(p, maxPub) > 0)) maxPub = p
  }
  // The next version must be strictly greater than the highest published one —
  // npm's `latest` tag moves to whatever is published, so a lower version would
  // silently downgrade users. Also skip any version whose git tag already exists.
  let guard = 0
  while (guard++ < 200) {
    const candidate = parse(newVersion)!
    if ((!maxPub || cmp(candidate, maxPub) > 0) && !tagExists(newVersion)) break
    newVersion = `${candidate[0]}.${candidate[1]}.${candidate[2] + 1}`
  }
  if (guard > 1) console.error(`# advanced version past published/tagged releases -> ${newVersion}`)
}
const tag = `${TAG_PREFIX}${newVersion}`

// --- build the changelog block --------------------------------------------
const today = new Date().toISOString().slice(0, 10)
const seen = new Set<string>()
const bullet = (t: string) => {
  const key = t.toLowerCase()
  if (seen.has(key)) return null
  seen.add(key)
  return `- **${t}**`
}
const section = (title: string, items: string[]): string[] => {
  const lines = items.map(bullet).filter((x): x is string => Boolean(x)).slice(0, MAX_BULLETS)
  return lines.length ? [`### ${title}`, ...lines, ''] : []
}
const blockLines = [
  `## ${newVersion} - ${today} (Beta)`,
  '',
  ...section('Breaking', classified.breaking),
  ...section('Added', classified.feat),
  ...section('Fixed', classified.fix),
]
// Drop trailing blank lines, then exactly one separating blank before the next "## ".
while (blockLines.length && blockLines[blockLines.length - 1] === '') blockLines.pop()
const block = blockLines.join('\n')

// --- output ----------------------------------------------------------------
const summary = [
  `current=${current}`,
  `new=${newVersion}`,
  `bump=${bump}`,
  `breaking=${classified.breaking.length} feat=${classified.feat.length} fix=${classified.fix.length}`,
  `base=${base}`,
  `tag=${tag}`,
].join(' ')

if (!apply) {
  console.log(`# release-plan (dry-run)\n# ${summary}\n`)
  console.log(block)
  console.log(`\n# ${commits.length} commit(s) considered; no files written`)
  process.exit(0)
}

// --- apply: write package.json + prepend CHANGELOG -------------------------
const indentMatch = pkgRaw.match(/\n(\s+)"/)
const indent = indentMatch ? indentMatch[1] : '  '
pkg.version = newVersion
const trailingNewline = pkgRaw.endsWith('\n') ? '\n' : ''
writeFileSync(PKG_PATH, JSON.stringify(pkg, null, indent) + trailingNewline)

const changelog = readFileSync(CHANGELOG_PATH, 'utf8')
const idx = changelog.search(/^## /m)
const header = idx === -1 ? changelog.trimEnd() : changelog.slice(0, idx).trimEnd()
const rest = idx === -1 ? '' : changelog.slice(idx)
writeFileSync(CHANGELOG_PATH, `${header}\n\n${block}\n\n${rest}`)

console.log(`version=${tag}`)
console.log('released=true')
console.log(`# ${summary}`)
