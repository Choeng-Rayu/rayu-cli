// Tiered swarm context — the shared "project brief" + per-domain artifact that
// lets each specialist receive a small shared header plus ONLY its dependency
// sections, instead of the orchestrator hand-copying everything into every
// prompt. Cuts tokens, keeps specialists aligned on one goal, and (because the
// injected block is deterministic) is friendly to per-agent prompt caching.
//
// Storage (.rayu/swarm/, project-local):
//   shared.json     — written ONCE by PA-AGENT (goal/stack/flow/constraints).
//                     Read-only afterward; injected into ALL specialists.
//   <AGENT>.md      — one file per domain (PA/DB/BE/SEC/FE/MOB/DO), each written
//                     ONLY by its owning specialist. Per-file ownership avoids
//                     the concurrent-write race a single shared file would have
//                     when a parallel wave runs multiple specialists at once.
//
// Selection is STATIC (DOMAIN_DEPENDENCIES) — deterministic, zero-latency, no
// embeddings. RAG is intentionally left as an interface seam (ContextRetriever)
// for the future; the current implementation just reads sections from disk.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getCwd } from '../../utils/cwd.js'

/** The small shared brief every specialist receives (kept < ~500 tokens). */
export type SwarmShared = {
  goal: string
  stack: string
  flow: string
  constraints: string[]
  /** Specialists PA declared this task needs (domain tokens, e.g. ['be','db']).
   *  Drives which specialists the orchestrator spawns. Empty/absent → all. */
  needs?: string[]
}

/**
 * Which sections each specialist reads: always its own shared brief plus the
 * upstream domains it depends on. 'shared' refers to shared.json; the rest are
 * <DOMAIN>.md files keyed by the domain prefix (PA/DB/BE/SEC/FE/MOB/DO).
 */
export const DOMAIN_DEPENDENCIES: Record<string, string[]> = {
  'PA-AGENT': ['shared'],
  'DB-AGENT': ['shared', 'PA'],
  'BE-AGENT': ['shared', 'PA', 'DB', 'SEC'],
  'SEC-AGENT': ['shared', 'PA', 'DB'],
  'FE-AGENT': ['shared', 'PA', 'BE', 'SEC'],
  'MOB-AGENT': ['shared', 'PA', 'BE', 'SEC', 'FE'],
  'DO-AGENT': ['shared', 'PA', 'BE', 'DB'],
  // Tier-2 Collaborators (keyed by their agentType → <DOMAIN>.md). They read the
  // shared brief plus the upstream collaborator sections they depend on, and
  // write their own <DOMAIN>.md section so the swarm stays aligned.
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

/** Normalize a domain token/agent type to a full agent type: 'be' -> 'BE-AGENT'. */
export function normalizeAgentType(token: string): string {
  return `${normalizeDomain(token)}-AGENT`
}

/**
 * Pick which specialists to spawn from PA's declared `needs`. Pure.
 * - no/empty needs → the full list (back-compat: spawn everything);
 * - otherwise → the declared subset, intersected with the known agents, with
 *   PA-AGENT always included (it's the planner and writes the shared brief).
 */
export function selectAgentsByNeeds(
  needs: string[] | undefined,
  allAgentTypes: string[],
): string[] {
  if (!needs || needs.length === 0) return allAgentTypes
  const wanted = new Set(needs.map(normalizeAgentType))
  wanted.add('PA-AGENT')
  return allAgentTypes.filter(t => wanted.has(t))
}

/** Declared needs from the shared brief (domain tokens), or undefined. */
export function readNeeds(): string[] | undefined {
  return readShared()?.needs
}

/** Read and parse the shared brief; undefined if missing or invalid. */
export function readShared(): SwarmShared | undefined {
  const p = getSharedPath()
  if (!existsSync(p)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<SwarmShared>
    if (!parsed || typeof parsed !== 'object') return undefined
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

/** Format the shared brief as a compact text block. */
function formatShared(shared: SwarmShared): string {
  const lines = ['## Shared Project Brief']
  if (shared.goal) lines.push(`- Goal: ${shared.goal}`)
  if (shared.stack) lines.push(`- Stack: ${shared.stack}`)
  if (shared.flow) lines.push(`- Flow: ${shared.flow}`)
  if (shared.constraints.length > 0)
    lines.push(`- Constraints: ${shared.constraints.join('; ')}`)
  if (shared.needs && shared.needs.length > 0)
    lines.push(`- Needed specialists: ${shared.needs.join(', ')}`)
  return lines.join('\n')
}

/**
 * Assemble the SWARM CONTEXT block for a given agent type: the shared brief
 * plus ONLY the dependency domain sections in DOMAIN_DEPENDENCIES, each
 * token-budgeted, with an overall cap. Returns '' when nothing exists yet
 * (e.g. the very first PA-AGENT spawn) so callers can inject nothing.
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
