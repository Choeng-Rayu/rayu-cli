// Synthesizer conflict pass — a cheap, deterministic check the orchestrator can
// run after the swarm finishes, to catch the classic case where SEC-AGENT
// mandates one thing and BE/DB-AGENT did another on the same topic. It does NOT
// auto-resolve; it surfaces conflicts so the orchestrator (and the user) can
// decide — authority order remains SEC > PA > DB > BE.
import { readDomainSection } from './swarmContext.js'

export type SwarmSections = { SEC?: string; BE?: string; DB?: string }

export type Conflict = {
  topic: string
  /** Which domains disagree, e.g. ['SEC', 'BE']. */
  between: string[]
  detail: string
}

type Rule = {
  topic: string
  /** What SEC mandates (the secure choice). */
  secExpects: RegExp
  /** The insecure/contradictory choice if it appears in BE/DB. */
  conflictsWith: RegExp
  detail: string
}

// High-signal, low-false-positive rules. Each fires only when SEC explicitly
// mandates the secure option AND an implementer text contains the insecure one.
const RULES: Rule[] = [
  {
    topic: 'password hashing',
    secExpects: /\b(bcrypt|argon2|scrypt|pbkdf2)\b/i,
    conflictsWith: /\b(md5|sha-?1|plain[\s-]?text|base64)\b/i,
    detail:
      'SEC-AGENT mandates a strong password hash (bcrypt/argon2/scrypt/pbkdf2) but an implementer references a weak/insecure one (md5/sha1/plaintext/base64).',
  },
  {
    topic: 'auth token storage',
    secExpects: /\bhttp[\s-]?only\b|\bhttponly\b/i,
    conflictsWith: /\blocal[\s-]?storage\b|\bsessionstorage\b/i,
    detail:
      'SEC-AGENT requires tokens in httpOnly cookies but an implementer stores them in localStorage/sessionStorage (XSS-exposed).',
  },
]

/**
 * Detect contradictions between SEC and BE/DB section texts. Pure.
 */
export function detectSwarmConflicts(sections: SwarmSections): Conflict[] {
  const sec = sections.SEC ?? ''
  if (!sec.trim()) return []
  const conflicts: Conflict[] = []
  for (const rule of RULES) {
    if (!rule.secExpects.test(sec)) continue
    for (const domain of ['BE', 'DB'] as const) {
      const text = sections[domain]
      if (text && rule.conflictsWith.test(text)) {
        conflicts.push({
          topic: rule.topic,
          between: ['SEC', domain],
          detail: rule.detail,
        })
      }
    }
  }
  return conflicts
}

/** Read the SEC/BE/DB sections from .rayu/swarm and run the detector. */
export function findSwarmConflicts(): Conflict[] {
  return detectSwarmConflicts({
    SEC: readDomainSection('SEC'),
    BE: readDomainSection('BE'),
    DB: readDomainSection('DB'),
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
    'Resolve by authority (SEC decisions are final on security) — do not silently keep the weaker choice.',
  )
  return lines.join('\n')
}
