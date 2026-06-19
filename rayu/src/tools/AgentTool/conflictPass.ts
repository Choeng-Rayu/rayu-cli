// Synthesizer conflict pass — a cheap, deterministic check the orchestrator can
// run after the swarm finishes, to catch the classic case where the security
// collaborator mandates one thing and an implementer (backend/frontend/mobile)
// did another on the same topic. It does NOT auto-resolve; it surfaces conflicts
// so the orchestrator (and the user) can decide — security decisions are final.
import { readDomainSection } from './swarmContext.js'

/** Implementer domains whose section text a security mandate can conflict with. */
const IMPLEMENTER_DOMAINS = ['BACKEND', 'FRONTEND', 'MOBILE'] as const
type ImplementerDomain = (typeof IMPLEMENTER_DOMAINS)[number]

export type SwarmSections = {
  SECURITY?: string
} & Partial<Record<ImplementerDomain, string>>

export type Conflict = {
  topic: string
  /** Which domains disagree, e.g. ['SECURITY', 'BACKEND']. */
  between: string[]
  detail: string
}

type Rule = {
  topic: string
  /** What SECURITY mandates (the secure choice). */
  secExpects: RegExp
  /** The insecure/contradictory choice if it appears in an implementer section. */
  conflictsWith: RegExp
  detail: string
}

// High-signal, low-false-positive rules. Each fires only when SECURITY explicitly
// mandates the secure option AND an implementer text contains the insecure one.
const RULES: Rule[] = [
  {
    topic: 'password hashing',
    secExpects: /\b(bcrypt|argon2|scrypt|pbkdf2)\b/i,
    conflictsWith: /\b(md5|sha-?1|plain[\s-]?text|base64)\b/i,
    detail:
      'The security collaborator mandates a strong password hash (bcrypt/argon2/scrypt/pbkdf2) but an implementer references a weak/insecure one (md5/sha1/plaintext/base64).',
  },
  {
    topic: 'auth token storage',
    secExpects: /\bhttp[\s-]?only\b|\bhttponly\b/i,
    conflictsWith: /\blocal[\s-]?storage\b|\bsessionstorage\b/i,
    detail:
      'The security collaborator requires tokens in httpOnly cookies but an implementer stores them in localStorage/sessionStorage (XSS-exposed).',
  },
]

/**
 * Detect contradictions between the SECURITY section and the implementer
 * (backend/frontend/mobile) section texts. Pure.
 */
export function detectSwarmConflicts(sections: SwarmSections): Conflict[] {
  const sec = sections.SECURITY ?? ''
  if (!sec.trim()) return []
  const conflicts: Conflict[] = []
  for (const rule of RULES) {
    if (!rule.secExpects.test(sec)) continue
    for (const domain of IMPLEMENTER_DOMAINS) {
      const text = sections[domain]
      if (text && rule.conflictsWith.test(text)) {
        conflicts.push({
          topic: rule.topic,
          between: ['SECURITY', domain],
          detail: rule.detail,
        })
      }
    }
  }
  return conflicts
}

/** Read the SECURITY + implementer sections from .rayu/swarm and run the detector. */
export function findSwarmConflicts(): Conflict[] {
  return detectSwarmConflicts({
    SECURITY: readDomainSection('SECURITY'),
    BACKEND: readDomainSection('BACKEND'),
    FRONTEND: readDomainSection('FRONTEND'),
    MOBILE: readDomainSection('MOBILE'),
  })
}

/** Render conflicts as a short user-facing block, or '' when there are none. */
export function formatConflicts(conflicts: Conflict[]): string {
  if (conflicts.length === 0) return ''
  const lines = ['⚠️ Swarm conflict check — review before shipping:']
  for (const c of conflicts) {
    lines.push(`- [${c.between.join(' ↔ ')}] ${c.topic}: ${c.detail}`)
  }
  lines.push(
    'Resolve by authority (security decisions are final) — do not silently keep the weaker choice.',
  )
  return lines.join('\n')
}
