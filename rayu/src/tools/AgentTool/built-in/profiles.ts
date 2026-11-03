// Opt-in locale profiles for the Orchestrator planner.
//
// Previously, Cambodia-specific rules (Bakong/KHQR, KHR/USD, Khmer) were
// HARDCODED into specialist prompts — biasing every project. They now live here
// as an opt-in profile, so the default Orchestrator plan has no locale bias.
//
// CONTENT (PROFILES map) is kept separate from ASSEMBLY (selectProfile /
// getProfileFragment) so Task-5 can move each fragment into a markdown file
// under built-in/agents/<name>/profiles/<profile>.md without touching logic.
import { loadRayuConfig } from '../../../utils/rayuConfig.js'

/** Per-agent prompt fragments for a profile (keyed by agentType prefix). */
export type ProfileFragments = Record<string, string>

export type Profile = {
  name: string
  fragmentsByAgent: ProfileFragments
}

const CAMBODIA: Profile = {
  name: 'cambodia',
  fragmentsByAgent: {
    planner: [
      '## Locale profile: Cambodia',
      '- Prefer locally-relevant choices: Bakong / KHQR for payments, KHR + USD dual currency, Khmer + English bilingual UI.',
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
 * Select the explicitly configured profile, otherwise use the no-bias default.
 */
export function selectProfile(): Profile {
  try {
    const configured = loadRayuConfig().projectProfile
    if (configured) return loadProfile(configured)
  } catch {
    // ignore config errors — fall through to the default
  }
  return DEFAULT
}

/** The selected profile's fragment for one agent, or null when none applies. */
export function getProfileFragment(agentType: string): string | null {
  return selectProfile().fragmentsByAgent[agentType] ?? null
}
