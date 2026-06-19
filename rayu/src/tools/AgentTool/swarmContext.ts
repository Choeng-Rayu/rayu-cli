// Tiered swarm context — the shared "project brief" + per-domain artifact that
// lets each collaborator receive a small shared header plus ONLY its dependency
// sections, instead of the orchestrator hand-copying everything into every
// prompt. Cuts tokens, keeps collaborators aligned on one goal, and (because the
// injected block is deterministic) is friendly to per-agent prompt caching.
//
// Storage (.rayu/swarm/, project-local):
//   shared.json     — written ONCE by the planner (goal/stack/flow/constraints/needs).
//                     Read-only afterward; injected into ALL collaborators.
//   <DOMAIN>.md     — one file per collaborator (FRONTEND/BACKEND/SECURITY/
//                     DEPLOY/MOBILE), each written ONLY by its owning collaborator.
//                     Per-file ownership avoids the concurrent-write race a single
//                     shared file would have when a parallel wave runs at once.
//
// Selection is STATIC (DOMAIN_DEPENDENCIES) — deterministic, zero-latency, no
// embeddings. RAG is intentionally left as an interface seam (ContextRetriever)
// for the future; the current implementation just reads sections from disk.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getCwd } from '../../utils/cwd.js'

/** A disjoint unit of work within a domain that ONE `builder` owns and builds in
 *  parallel with the others. `area` is the non-overlapping file area it may touch
 *  (glob(s)/paths) — disjoint areas are what make parallel writes safe. */
export type SwarmSlice = {
  name: string
  task?: string
  area?: string
}

/** The small shared brief every collaborator receives (kept < ~500 tokens). */
export type SwarmShared = {
  goal: string
  stack: string
  flow: string
  constraints: string[]
  /** Collaborators the planner declared this task needs (collaborator agentTypes,
   *  e.g. ['frontend','backend','security']; legacy short tokens fe/be/db/sec/
   *  mob/do also accepted). Drives which collaborators the orchestrator spawns.
   *  Empty/absent → all. */
  needs?: string[]
  /** Per-domain parallel work breakdown: collaborator agentType → the disjoint
   *  slices it should fan out as parallel `builder`s. Planner-decided. */
  slices?: Record<string, SwarmSlice[]>
  /** Soft cap on concurrent builders per wave (planner hint). The resolved cap
   *  also honors RAYU_SWARM_MAX_PARALLEL — see getSwarmMaxParallel(). */
  cap?: number
}

/**
 * Which sections each agent reads: always the shared brief plus the upstream
 * domains it depends on. 'shared' refers to shared.json; the rest are
 * <DOMAIN>.md files (the uppercase domain of the owning collaborator's
 * agentType). Keyed by the planner + the Tier-2 collaborator agentTypes
 * (frontend/backend/mobile/security/deploy). The data layer is part of backend.
 */
export const DOMAIN_DEPENDENCIES: Record<string, string[]> = {
  // The planner writes the shared brief and reads only the brief.
  planner: ['shared'],
  // Tier-2 Collaborators (keyed by agentType → <DOMAIN>.md). Each reads the
  // shared brief plus the upstream collaborator sections it depends on, and
  // writes its own <DOMAIN>.md section so the swarm stays aligned.
  backend: ['shared', 'SECURITY'],
  frontend: ['shared', 'BACKEND', 'SECURITY'],
  mobile: ['shared', 'BACKEND', 'SECURITY', 'FRONTEND'],
  security: ['shared', 'BACKEND'],
  deploy: ['shared', 'BACKEND', 'FRONTEND'],
}

// Token budgeting. We estimate ~4 chars/token (good enough for a guardrail).
const CHARS_PER_TOKEN = 4
const PER_SECTION_TOKEN_CAP = 1500
const TOTAL_TOKEN_CAP = 6000

/** Approximate token count of a string (chars / 4). */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Truncate text to at most `maxTokens` (approx), appending a marker if cut. */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, maxTokens) * CHARS_PER_TOKEN
  if (text.length <= maxChars) return text
  if (maxChars === 0) return ''
  return text.slice(0, maxChars).trimEnd() + '\n…[truncated]'
}

/** The project-local swarm directory: <cwd>/.rayu/swarm/. */
export function getSwarmDir(): string {
  return join(getCwd(), '.rayu', 'swarm')
}

/** Path to the shared brief artifact (shared.json). */
export function getSharedPath(): string {
  return join(getSwarmDir(), 'shared.json')
}

/**
 * Path to a domain section file. Accepts either a domain prefix ('BE') or a
 * full agent type ('BE-AGENT'); both map to <swarm>/BE.md.
 */
export function getDomainPath(domain: string): string {
  return join(getSwarmDir(), `${normalizeDomain(domain)}.md`)
}

/** 'BE-AGENT' -> 'BE'; 'be' -> 'BE'; 'BE' -> 'BE'. */
function normalizeDomain(domain: string): string {
  return domain.trim().toUpperCase().replace(/-AGENT$/, '')
}

/**
 * Map a `needs` token to a collaborator agentType. Accepts the collaborator
 * names directly (frontend/backend/security/deploy/mobile) and the legacy short
 * tokens (fe/be/db/sec/mob/do) for back-compat. The data layer folds into
 * backend (db → backend); there is no separate database collaborator.
 */
const NEED_TO_COLLABORATOR: Record<string, string> = {
  fe: 'frontend',
  frontend: 'frontend',
  be: 'backend',
  backend: 'backend',
  db: 'backend',
  data: 'backend',
  sec: 'security',
  security: 'security',
  mob: 'mobile',
  mobile: 'mobile',
  do: 'deploy',
  devops: 'deploy',
  deploy: 'deploy',
}

/** Normalize a `needs` token to a collaborator agentType (see NEED_TO_COLLABORATOR). */
export function normalizeNeed(token: string): string {
  const t = token.trim().toLowerCase().replace(/-agent$/, '')
  return NEED_TO_COLLABORATOR[t] ?? t
}

/**
 * Pick which collaborators to spawn from the planner's declared `needs`. Pure.
 * - no/empty needs → the full list (back-compat: spawn everything);
 * - otherwise → the declared subset mapped to collaborator agentTypes,
 *   intersected with the known collaborators (order follows allAgentTypes).
 * The planner runs first as a subagent (not a collaborator), so it is not part
 * of this selection.
 */
export function selectAgentsByNeeds(
  needs: string[] | undefined,
  allAgentTypes: string[],
): string[] {
  if (!needs || needs.length === 0) return allAgentTypes
  const wanted = new Set(needs.map(normalizeNeed))
  return allAgentTypes.filter(t => wanted.has(t))
}

/** Declared needs from the shared brief (domain tokens), or undefined. */
export function readNeeds(): string[] | undefined {
  return readShared()?.needs
}

/** Default soft cap on concurrent builders per wave (overridable). */
export const DEFAULT_SWARM_MAX_PARALLEL = 5

/**
 * The resolved soft cap on concurrent WRITERS (builders) per wave:
 * RAYU_SWARM_MAX_PARALLEL env → the planner's shared.json "cap" → default (5).
 * Read-only research is unbounded; this governs parallel writers only, to avoid
 * file-area conflicts and provider rate limits. >cap slices ⇒ successive waves.
 */
export function getSwarmMaxParallel(): number {
  const env = parseInt(process.env.RAYU_SWARM_MAX_PARALLEL || '', 10)
  if (!isNaN(env) && env > 0) return env
  const cap = readShared()?.cap
  return cap && cap > 0 ? cap : DEFAULT_SWARM_MAX_PARALLEL
}

/** The planner's parallel slice plan for a collaborator domain (agentType), or []. */
export function getSlicesForDomain(domain: string): SwarmSlice[] {
  const slices = readShared()?.slices
  if (!slices) return []
  return slices[domain] ?? slices[normalizeNeed(domain)] ?? []
}

/** Parse the planner's per-domain slice plan defensively (drops malformed entries). */
function parseSlices(raw: unknown): Record<string, SwarmSlice[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, SwarmSlice[]> = {}
  for (const [domain, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    const slices: SwarmSlice[] = []
    for (const item of list) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as { name?: unknown }).name === 'string'
      ) {
        const s = item as { name: string; task?: unknown; area?: unknown }
        slices.push({
          name: s.name,
          ...(typeof s.task === 'string' ? { task: s.task } : {}),
          ...(typeof s.area === 'string' ? { area: s.area } : {}),
        })
      }
    }
    if (slices.length > 0) out[domain] = slices
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Read and parse the shared brief; undefined if missing or invalid. */
export function readShared(): SwarmShared | undefined {
  const p = getSharedPath()
  if (!existsSync(p)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<SwarmShared>
    if (!parsed || typeof parsed !== 'object') return undefined
    const slices = parseSlices((parsed as { slices?: unknown }).slices)
    return {
      goal: typeof parsed.goal === 'string' ? parsed.goal : '',
      stack: typeof parsed.stack === 'string' ? parsed.stack : '',
      flow: typeof parsed.flow === 'string' ? parsed.flow : '',
      constraints: Array.isArray(parsed.constraints)
        ? parsed.constraints.filter((c): c is string => typeof c === 'string')
        : [],
      ...(Array.isArray(parsed.needs)
        ? {
            needs: parsed.needs.filter(
              (n): n is string => typeof n === 'string',
            ),
          }
        : {}),
      ...(slices ? { slices } : {}),
      ...(typeof parsed.cap === 'number' && parsed.cap > 0
        ? { cap: parsed.cap }
        : {}),
    }
  } catch {
    return undefined
  }
}

/** Read a single domain section file's text; undefined if missing/empty. */
export function readDomainSection(domain: string): string | undefined {
  const p = getDomainPath(domain)
  if (!existsSync(p)) return undefined
  try {
    const text = readFileSync(p, 'utf8').trim()
    return text.length > 0 ? text : undefined
  } catch {
    return undefined
  }
}

/** Overwrite a domain section file, creating the swarm dir if needed. */
export function writeDomainSection(domain: string, content: string): void {
  const p = getDomainPath(domain)
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content.endsWith('\n') ? content : content + '\n', 'utf8')
  } catch {
    // Best-effort persistence — never throw into the agent-completion path.
  }
}

/**
 * Persist a domain section ONLY if the owning agent didn't already write one
 * (non-clobbering fallback). This is the code-level guarantee that the swarm
 * shared memory is populated even when an agent forgets to Write its section
 * itself. Token-capped so a verbose final report can't blow the section
 * budget. Returns true if it wrote.
 */
export function persistDomainSectionIfEmpty(
  agentType: string,
  content: string,
): boolean {
  // Agent already wrote a (concise) section — keep theirs, don't clobber.
  if (readDomainSection(agentType) !== undefined) return false
  const trimmed = (content ?? '').trim()
  if (trimmed.length === 0) return false
  writeDomainSection(agentType, truncateToTokens(trimmed, PER_SECTION_TOKEN_CAP))
  return true
}

/** Format the shared brief as a compact text block. */
function formatShared(shared: SwarmShared): string {
  const lines = ['## Shared Project Brief']
  if (shared.goal) lines.push(`- Goal: ${shared.goal}`)
  if (shared.stack) lines.push(`- Stack: ${shared.stack}`)
  if (shared.flow) lines.push(`- Flow: ${shared.flow}`)
  if (shared.constraints.length > 0)
    lines.push(`- Constraints: ${shared.constraints.join('; ')}`)
  if (shared.needs && shared.needs.length > 0)
    lines.push(`- Needed collaborators: ${shared.needs.join(', ')}`)
  if (shared.slices) {
    const overview = Object.entries(shared.slices)
      .map(([d, s]) => `${d}×${s.length}`)
      .join(', ')
    if (overview) lines.push(`- Parallel slices: ${overview}`)
  }
  if (shared.cap && shared.cap > 0)
    lines.push(`- Max parallel builders/wave: ${shared.cap}`)
  return lines.join('\n')
}

/**
 * Assemble the SWARM CONTEXT block for a given agent type: the shared brief
 * plus ONLY the dependency domain sections in DOMAIN_DEPENDENCIES, each
 * token-budgeted, with an overall cap. Returns '' when nothing exists yet
 * (e.g. the very first planner spawn) so callers can inject nothing.
 */
export function assembleContext(agentType: string): string {
  const deps = DOMAIN_DEPENDENCIES[agentType] ?? ['shared']
  const blocks: string[] = []

  for (const dep of deps) {
    if (dep === 'shared') {
      const shared = readShared()
      if (shared) blocks.push(formatShared(shared))
      continue
    }
    // Don't inject the agent's own section back into itself.
    if (normalizeDomain(dep) === normalizeDomain(agentType)) continue
    const section = readDomainSection(dep)
    if (section) {
      blocks.push(
        `## Context from ${normalizeDomain(dep)}-AGENT\n` +
          truncateToTokens(section, PER_SECTION_TOKEN_CAP),
      )
    }
  }

  if (blocks.length === 0) return ''

  const header =
    '# SWARM CONTEXT (read this — do not re-derive what is already decided)'
  const body = blocks.join('\n\n')
  return truncateToTokens(`${header}\n\n${body}`, TOTAL_TOKEN_CAP)
}

/**
 * Deferred-RAG seam. Today retrieval is a plain section read; this interface
 * lets a future implementation swap in embeddings/keyword retrieval without
 * touching the specialists. `query` and `maxTokens` are honored by truncation.
 */
export interface ContextRetriever {
  retrieve(domain: string, query: string, maxTokens: number): string
}

export const staticRetriever: ContextRetriever = {
  retrieve(domain, _query, maxTokens) {
    const section = readDomainSection(domain) ?? ''
    return truncateToTokens(section, maxTokens)
  },
}
