// Opt-in locale/stack profiles for the specialist swarm.
//
// Previously, Cambodia-specific rules (Bakong/KHQR, KHR/USD, Khmer) were
// HARDCODED into PA/DB/MOB prompts — biasing every project. They now live here
// as an opt-in profile, so the default swarm carries no locale bias.
//
// CONTENT (PROFILES map) is kept separate from ASSEMBLY (selectProfile /
// getProfileFragment) so Task-5 can move each fragment into a markdown file
// under built-in/agents/<name>/profiles/<profile>.md without touching logic.
import { loadRayuConfig } from '../../../utils/rayuConfig.js'
import { readShared } from '../swarmContext.js'

/** Per-agent prompt fragments for a profile (keyed by agentType prefix). */
export type ProfileFragments = Record<string, string>

export type Profile = {
  name: string
  /** Regex over shared.json constraints/goal that auto-selects this profile. */
  appliesWhen?: RegExp
  fragmentsByAgent: ProfileFragments
}

const CAMBODIA: Profile = {
  name: 'cambodia',
  appliesWhen: /\b(cambodia|khmer|bakong|khqr|\bKH\b|riel|KHR)\b/i,
  fragmentsByAgent: {
    'PA-AGENT': [
      '## Locale profile: Cambodia',
      '- Prefer locally-relevant choices: Bakong / KHQR for payments, KHR + USD dual currency, Khmer + English bilingual UI.',
    ].join('\n'),
    'DB-AGENT': [
      '## Locale profile: Cambodia',
      '- KHR/USD decimal precision (KHR: 0 decimals, USD: 2). Store money as integer minor units where possible.',
      '- Use utf8mb4 (or equivalent) so Khmer Unicode is stored correctly.',
    ].join('\n'),
    'MOB-AGENT': [
      '## Locale profile: Cambodia',
      '- Handle KHR/USD display and Khmer + English localization in the mobile UI.',
    ].join('\n'),
  },
}

const DEFAULT: Profile = {
  name: 'default',
  fragmentsByAgent: {}, // no locale bias
}

/** All known profiles, keyed by name. */
export const PROFILES: Record<string, Profile> = {
  default: DEFAULT,
  cambodia: CAMBODIA,
}

/** Look up a profile by name; falls back to the no-bias default. */
export function loadProfile(name: string | undefined): Profile {
  if (!name) return DEFAULT
  return PROFILES[name.toLowerCase()] ?? DEFAULT
}

/**
 * Select the active profile (assembly):
 *   1. explicit config (projectProfile) wins;
 *   2. else auto-detect from the shared brief's constraints/goal;
 *   3. else the no-bias default.
 */
export function selectProfile(): Profile {
  // 1. Explicit opt-in via config.
  try {
    const configured = loadRayuConfig().projectProfile
    if (configured) return loadProfile(configured)
  } catch {
    // ignore config errors — fall through to detection
  }
  // 2. Auto-detect from the shared brief.
  const shared = readShared()
  if (shared) {
    const haystack = [shared.goal, ...(shared.constraints ?? [])].join(' ')
    for (const profile of Object.values(PROFILES)) {
      if (profile.appliesWhen?.test(haystack)) return profile
    }
  }
  // 3. No locale bias.
  return DEFAULT
}

/** The selected profile's fragment for one agent, or null when none applies. */
export function getProfileFragment(agentType: string): string | null {
  return selectProfile().fragmentsByAgent[agentType] ?? null
}
