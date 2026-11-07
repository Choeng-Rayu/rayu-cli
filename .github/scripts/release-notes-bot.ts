#!/usr/bin/env bun
/**
 * release-notes-bot — the deterministic half of .github/workflows/release-notes.yml.
 *
 * Two subcommands:
 *
 *   detect    Decide whether rayu/package.json carries a version that has no
 *             CHANGELOG.md entry yet. If it does, collect the commits and files
 *             since the last documented version, then write three files:
 *               /tmp/release-notes-context.md   — facts for the agent
 *               /tmp/release-notes-prompt.md    — the agent's instructions
 *               /tmp/release-notes-pr-body.md   — the pull-request description
 *             and set GitHub outputs: pending, version, base, branch, base_branch.
 *
 *   validate  Check what the agent produced: exactly one well-formed CHANGELOG
 *             entry for the pending version, and only documentation files
 *             touched (never package.json, workflows, or src).
 *
 * The version is owned by a human: this script never writes package.json, never
 * tags, and never publishes. It only reads rayu/package.json and decides
 * whether its version is already documented.
 *
 * Run from the repository root. Bun is the only runtime dependency.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const PKG_PATH = 'rayu/package.json'
const CHANGELOG_PATH = 'rayu/CHANGELOG.md'
const CONTEXT_PATH = '/tmp/release-notes-context.md'
const PROMPT_PATH = '/tmp/release-notes-prompt.md'
const PR_BODY_PATH = '/tmp/release-notes-pr-body.md'
const BASE_BRANCH = 'dev'
const MAX_COMMITS = 400

// Conventional types that never reach the changelog and never justify a docs
// edit. Kept in step with .github/scripts/release-plan.ts.
const IGNORED = /^(chore|docs|test|ci|build|style|refactor|revert)(\(.+\))?:/

// Source area → documentation that describes it. Used only as a hint list for
// the agent; the agent still reads the docs before editing.
const DOC_HINTS: { match: RegExp; docs: string[] }[] = [
  { match: /^rayu\/src\/commands\//, docs: ['documentations/07-slash-commands.md', 'documentations/06-cli-reference.md'] },
  { match: /^rayu\/src\/tools\//, docs: ['documentations/06-cli-reference.md', 'documentations/07-slash-commands.md'] },
  { match: /^rayu\/src\/skills\/bundled\//, docs: ['documentations/06-cli-reference.md'] },
  { match: /^rayu\/src\/services\/api\//, docs: ['documentations/03-providers.md', 'documentations/04-models.md'] },
  { match: /^rayu\/src\/telegram\//, docs: ['documentations/15-telegram-bot.md'] },
  { match: /^rayu\/src\/(utils\/settings|components\/.*Setup|commands\/config)/, docs: ['documentations/05-configuration.md'] },
  { match: /^rayu\/src\/.*(image|video)/i, docs: ['documentations/12-image-generation.md'] },
  { match: /^rayu\/src\/.*(mcp)/i, docs: ['documentations/08-mcp.md'] },
  { match: /^rayu\/src\/(cli\/update|utils\/(autoUpdater|installerUpdate|updateNotice)|components\/(AutoUpdater|UpdateAvailableNotice))/, docs: ['documentations/01-installation.md', 'documentations/13-binaries.md'] },
  { match: /^rayu\/(install\.sh|install\.ps1|scripts\/build-native)/, docs: ['documentations/01-installation.md', 'documentations/13-binaries.md'] },
  { match: /^rayu\/src\/services\/rayuAuth\/|^rayu\/src\/commands\/billing\//, docs: ['documentations/credits-and-limits.md'] },
  { match: /^rayu\/src\/graphify|graphify-out/, docs: ['documentations/11-knowledge-graph.md'] },
  { match: /^rayu\/src\/(coordinator|externalAgents)\//, docs: ['documentations/12-specialist-swarm.md'] },
  { match: /^rayu\/src\/vscode\/|^rayu\/scripts\/build-vscode/, docs: ['documentations/01-installation.md'] },
]

interface Commit {
  subject: string
  body: string
}

interface State {
  current: string
  documented: string | null
  base: string
  baseLabel: string
  commits: Commit[]
  changedFiles: string[]
}

const breaking: string[] = []
const feat: string[] = []
const fix: string[] = []
const other: string[] = []
const seen = new Set<string>()

function git(args: string[]): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return ''
  }
}

function fail(message: string): never {
  console.error(`release-notes-bot: ${message}`)
  process.exit(1)
}

function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT
  if (file) appendFileSync(file, `${name}=${value}\n`)
  console.log(`${name}=${value}`)
}

function summary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (file) appendFileSync(file, `${markdown}\n`)
}

function parseSemver(value: string): [number, number, number] | null {
  const m = value.trim().match(/^(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
}

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as { version?: string }
  if (!pkg.version || !parseSemver(pkg.version)) {
    fail(`${PKG_PATH} has no parsable version field`)
  }
  return pkg.version.trim()
}

function firstChangelogVersion(): string | null {
  const text = readFileSync(CHANGELOG_PATH, 'utf8')
  const m = text.match(/^##\s+(\S+)/m)
  return m ? m[1] : null
}

function classify(commits: Commit[]): void {
  for (const c of commits) {
    if (/^release:/.test(c.subject) || /\[skip ci\]/.test(c.subject)) continue
    const isBreaking =
      /^[a-z]+(\(.+\))?!:/.test(c.subject) || /^BREAKING[ -]CHANGE:/m.test(c.body)
    const type = c.subject.match(/^([a-z]+)(\(.+\))?!?:/)?.[1]
    const text = c.subject.replace(/^[a-z]+(\(.+\))?!?:\s*/, '').trim()
    if (!text) continue
    if (isBreaking) {
      if (!seen.has(`b:${text}`)) breaking.push(text)
      seen.add(`b:${text}`)
      continue
    }
    if (!IGNORED.test(c.subject) && (type === 'feat' || type === 'fix' || type === 'hotfix' || type === 'perf')) {
      if (seen.has(text.toLowerCase())) continue
      seen.add(text.toLowerCase())
      ;(type === 'feat' ? feat : fix).push(text)
      continue
    }
    if (!seen.has(`o:${text}`)) other.push(text)
    seen.add(`o:${text}`)
  }
}

/** Resolve the commit the last documented release ended at. */
function resolveBase(documented: string): { sha: string; label: string } {
  const tag = `v${documented}`
  const fromTag = git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`])
  if (fromTag) return { sha: fromTag, label: `tag ${tag}` }

  const releaseCommit = git([
    'log', '-1', '--format=%H', '--grep', `^release: ${documented}`,
  ])
  if (releaseCommit) return { sha: releaseCommit, label: `release commit ${releaseCommit.slice(0, 7)}` }

  const versionCommit = git([
    'log', '-1', '--format=%H', '-S', `"version": "${documented}"`, '--', PKG_PATH,
  ])
  if (versionCommit) return { sha: versionCommit, label: `package.json bump ${versionCommit.slice(0, 7)}` }

  const root = git(['rev-list', '--max-parents=0', 'HEAD'])
  const sha = root || 'HEAD~200'
  return { sha, label: `fallback base ${sha.slice(0, 7)}` }
}

function collectCommits(base: string): Commit[] {
  const out = git([
    'log', `${base}..HEAD`, '--no-merges', `--max-count=${MAX_COMMITS}`,
    '--format=%s%x1f%b%x1e',
  ])
  if (!out) return []
  return out
    .split('\x1e')
    .map(r => r.trim())
    .filter(Boolean)
    .map(r => {
      const i = r.indexOf('\x1f')
      return {
        subject: (i === -1 ? r : r.slice(0, i)).trim(),
        body: (i === -1 ? '' : r.slice(i + 1)).trim(),
      }
    })
    .filter(c => c.subject)
}

function loadState(version: string, documented: string): State {
  const { sha, label } = resolveBase(documented)
  const commits = collectCommits(sha)
  const changedFiles = git(['diff', '--name-only', `${sha}..HEAD`])
    .split('\n')
    .map(f => f.trim())
    .filter(Boolean)
  classify(commits)
  return { current: version, documented, base: sha, baseLabel: label, commits, changedFiles }
}

function docHints(changedFiles: string[]): string[] {
  const hits = new Set<string>()
  for (const file of changedFiles) {
    for (const hint of DOC_HINTS) {
      if (hint.match.test(file)) for (const doc of hint.docs) hits.add(doc)
    }
  }
  return [...hits].sort()
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max)}…` : single
}

function bulletSection(title: string, items: string[]): string[] {
  if (items.length === 0) return []
  return [`### ${title}`, ...items.map(i => `- ${i}`), '']
}

function writeContext(state: State, hints: string[], today: string): void {
  const lines = [
    '# Release notes context',
    '',
    `- Package: \`@rayu-dev/rayu-cli\``,
    `- Pending version: **${state.current}** (from \`${PKG_PATH}\`)`,
    `- Last documented version: **${state.documented}** (top of \`${CHANGELOG_PATH}\`)`,
    `- Commit range: \`${state.base.slice(0, 7)}..HEAD\` (${state.baseLabel}), ${state.commits.length} commit(s)`,
    `- Today: ${today}`,
    '',
    '## Commits since the last documented release',
    '',
    ...bulletSection('Breaking', breaking),
    ...bulletSection('Features', feat),
    ...bulletSection('Fixes', fix),
    ...bulletSection('Other (context only — not changelog bullets)', other.slice(0, 40)),
    '## Changed files',
    '',
    '```',
    ...state.changedFiles.slice(0, 300),
    '```',
    '',
    '## Documentation that likely describes the changed areas',
    '',
    ...(hints.length ? hints.map(h => `- \`${h}\``) : ['- (no obvious mapping — read the commits and judge)']),
    '',
  ]
  writeFileSync(CONTEXT_PATH, lines.join('\n'))
}

function writePrompt(state: State, today: string): void {
  const prompt = `You are updating the release notes and user documentation for @rayu-dev/rayu-cli ${state.current}.

Read /tmp/release-notes-context.md first. It lists the commits and changed files since the last documented release (${state.documented}).

## Task 1 — add the changelog entry

Prepend exactly one new entry to ${CHANGELOG_PATH}, directly under the file's header block and above the previous "## " heading:

\`\`\`
## ${state.current} - ${today} (Beta)
- **Short user-facing title** — one or two sentences explaining what changed for someone using Rayu.
\`\`\`

Rules (the CLI parses this file at runtime in rayu/src/utils/releaseNotes.ts):
- The heading must be exactly \`## ${state.current} - ${today} (Beta)\`.
- Every point must be a single \`- \` bullet. Do not add \`### Added\` / \`### Fixed\` subsections.
- Describe observable behaviour, not file names, function names, or commit hashes.
- Cover features and fixes that users can notice. Skip chores, docs, tests, CI, and pure refactors.
- Merge related commits into one bullet. Deduplicate. Aim for 3-12 bullets, most important first.
- Keep the existing entries untouched.

## Task 2 — update the documentation

Read the affected pages before editing. Update ${'`documentations/*.md`'} where this release genuinely changes behaviour: a new or changed command, tool, skill, provider, setting, install/update step, or troubleshooting entry. The context file lists likely pages.

- Edit only what the commits justify. Never invent features.
- If you add a new page, also add it to the page map in documentations/README.md.
- If nothing in the docs is affected, change no documentation and say so in your final message.
- Match the existing tone and structure of each page.

## Hard limits

- Do NOT edit rayu/package.json, anything under rayu/src/, .github/, or rayu-action/.
- Do NOT run git add, git commit, git push, or any GitHub command. The workflow publishes your edits.
- Do not modify or create files outside rayu/CHANGELOG.md, documentations/, docs/, or README.md.

Finish with a short list of the files you changed and why.`
  writeFileSync(PROMPT_PATH, prompt)
}

function writePrBody(state: State, hints: string[]): void {
  const featCount = feat.length + breaking.length
  const body = `## Release notes for v${state.current}

Generated by the \`release-notes\` workflow from **${state.commits.length} commit(s)** since the last documented release (${state.documented}).

### What this PR contains
- \`${CHANGELOG_PATH}\` — the new \`## ${state.current}\` entry. The CLI reads this file from \`main\` at runtime for its "What's new" screen.
- \`documentations/*.md\` — pages the bot updated for this release (if any).

### Commit summary
- ${breaking.length} breaking, ${feat.length} feature, ${fix.length} fix, ${other.length} other

### Documentation areas touched by the commits
${hints.length ? hints.map(h => `- \`${h}\``).join('\n') : '- none detected — the bot decides from the commits'}

### Before merging
- [ ] Changelog bullets describe user-visible changes only.
- [ ] Documentation matches the shipped behaviour.
- [ ] \`rayu/package.json\` still carries the version you intend to publish.
- [ ] Merge to \`dev\`, then merge \`dev\` → \`main\` so the runtime changelog fetch sees it.

### Publishing (manual, as designed)
\`\`\`bash
cd rayu
bun run build
npm publish --access public
\`\`\`

Range: \`${state.base.slice(0, 7)}..HEAD\`
`
  writeFileSync(PR_BODY_PATH, body)
}

function detect(): void {
  const current = readVersion()
  const documented = firstChangelogVersion()

  if (!documented) {
    fail(`${CHANGELOG_PATH} has no "## <version>" heading to compare against`)
  }
  if (compareSemver(current, documented) < 0) {
    fail(
      `rayu/package.json is ${current} but ${CHANGELOG_PATH} is already at ${documented}. ` +
        'Refusing to document a downgrade — bump the version or fix the changelog.',
    )
  }
  if (compareSemver(current, documented) === 0) {
    setOutput('pending', 'false')
    console.log(`# ${current} is already documented in ${CHANGELOG_PATH}; nothing to do`)
    summary(`### Release notes\n\n\`${current}\` is already documented — nothing to generate.`)
    return
  }

  const today = new Date().toISOString().slice(0, 10)
  const state = loadState(current, documented)
  const hints = docHints(state.changedFiles)

  writeContext(state, hints, today)
  writePrompt(state, today)
  writePrBody(state, hints)

  setOutput('pending', 'true')
  setOutput('version', current)
  setOutput('base', state.base)
  setOutput('branch', `bot/release-notes-v${current}`)
  setOutput('base_branch', BASE_BRANCH)

  const breakdown = `breaking=${breaking.length} feat=${feat.length} fix=${fix.length} other=${other.length}`
  console.log(`# pending release ${documented} -> ${current} (${state.commits.length} commits, ${breakdown})`)
  summary(
    [
      '### Release notes',
      '',
      `Pending version **${current}** (last documented: ${documented}).`,
      '',
      `- commits: ${state.commits.length} (${breakdown})`,
      `- base: \`${state.base.slice(0, 7)}\` (${state.baseLabel})`,
      `- doc candidates: ${hints.length ? hints.join(', ') : 'none'}`,
    ].join('\n'),
  )
}

function changedPaths(): string[] {
  let out: string
  try {
    // Deliberately not trimmed: porcelain lines start with two status columns,
    // and trimming would eat the first path's leading space.
    out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return []
  }
  return out
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      // "XY path" or "XY old -> new"
      const path = line.slice(3)
      const arrow = path.indexOf(' -> ')
      return (arrow === -1 ? path : path.slice(arrow + 4)).replace(/^"|"$/g, '')
    })
}

function changelogEntry(text: string, version: string): string | null {
  const sections = text.split(/^## /m)
  const entry = sections.find(s => s.trimStart().startsWith(version))
  return entry ?? null
}

function validate(baseOverride?: string): void {
  const current = readVersion()
  const text = readFileSync(CHANGELOG_PATH, 'utf8')

  // The pending entry is already at the top, so the previous release's base has
  // to come from the detect step. Without it the feature/docs warning is skipped.
  if (baseOverride) classify(collectCommits(baseOverride))

  // 1. Exactly one entry for this version.
  const occurrences = (text.match(new RegExp(`^## ${current.replace(/\./g, '\\.')}(\\s|$)`, 'gm')) ?? []).length
  if (occurrences !== 1) {
    fail(`expected exactly one "## ${current}" heading in ${CHANGELOG_PATH}, found ${occurrences}`)
  }

  // 2. It is the first (newest) entry.
  const documented = firstChangelogVersion()
  if (documented !== current) {
    fail(`top changelog entry is ${documented}, expected ${current} — the new entry must be first`)
  }

  // 3. The heading keeps the shape the runtime parser expects.
  const entry = changelogEntry(text, current)
  if (!entry) fail(`could not read the "## ${current}" entry`)
  const heading = entry.split('\n')[0].trim()
  if (!/^\d+\.\d+\.\d+ - \d{4}-\d{2}-\d{2}( \(Beta\))?$/.test(heading)) {
    fail(
      `changelog heading "${heading}" must look like "## ${current} - YYYY-MM-DD (Beta)"`,
    )
  }

  // 4. At least one bullet, and every bullet is a single "- " line.
  const body = entry.split('\n').slice(1)
  const bullets = body.filter(line => line.trim().startsWith('- '))
  if (bullets.length === 0) {
    fail(`the "## ${current}" entry has no "- " bullets`)
  }

  // 5. Nothing but documentation may change.
  const protectedPrefixes = ['rayu/package.json', '.github/', 'rayu-action/', 'rayu/src/', 'rayu/scripts/']
  const allowedPrefixes = ['rayu/CHANGELOG.md', 'CHANGELOG.md', 'documentations/', 'docs/', 'README.md', 'rayu/README.md']
  const paths = changedPaths()
  const violations = paths.filter(
    p => protectedPrefixes.some(x => p === x || p.startsWith(x)) ||
      !allowedPrefixes.some(x => p === x || p.startsWith(x)),
  )
  if (violations.length > 0) {
    fail(
      `the release-notes bot may only edit documentation, but these paths changed:\n  ${violations.join('\n  ')}`,
    )
  }

  const docsTouched = paths.some(p => p.startsWith('documentations/') || p.startsWith('docs/'))
  const hasFeatures = feat.length + breaking.length > 0
  if (hasFeatures && !docsTouched) {
    const message = 'this release has feature commits but no documentation page changed — review whether docs are stale'
    console.log(`::warning::${message}`)
    summary(`### ⚠ Documentation\n\n${message}.`)
  }

  console.log(`✓ ${CHANGELOG_PATH} has a valid "## ${current}" entry (${bullets.length} bullets)`)
  console.log(`✓ ${paths.length} file(s) changed, all documentation`)
  for (const p of paths) console.log(`  ${p}`)
  summary(
    [
      '### Generated notes',
      '',
      `- \`## ${current}\` (${bullets.length} bullets)`,
      `- ${paths.length} file(s) changed`,
      ...(hasFeatures && !docsTouched ? ['- ⚠ no documentation page changed'] : []),
    ].join('\n'),
  )
}

const command = process.argv[2]
if (command === 'detect') detect()
else if (command === 'validate') validate(process.argv[3])
else fail(`unknown subcommand "${command ?? ''}" (expected "detect" or "validate")`)
