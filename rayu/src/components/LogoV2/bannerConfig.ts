/**
 * Swappable banner registry.
 *
 * The first-launch / brand banner (currently "RAYU" in ANSI Shadow figlet
 * style) is defined here as data, not hardcoded inside each consumer
 * component. To change the banner text/colors later:
 *
 *   1. Add a new entry to `BANNERS` below (or edit an existing one).
 *   2. Point `ACTIVE_BANNER_ID` at it.
 *
 * `Clawd.tsx` and `WelcomeV2.tsx` both read from `getActiveBanner()` — no
 * component code needs to change when the banner design changes.
 */

/** A single colored row of a figlet-style ASCII banner. */
export type BannerLine = readonly [text: string, color: string]

export type BannerId = 'rayu'

export type BannerConfig = {
  /** Figlet-style ASCII art, one colored line per row. */
  lines: readonly BannerLine[]
}

const RAYU_BANNER_CLAWD: BannerConfig = {
  // "RAYU" in the ANSI Shadow figlet style, with a top-to-bottom green
  // gradient (matches the migrated brand color in theme.ts).
  lines: [
    ['██████╗  █████╗ ██╗   ██╗██╗   ██╗', '#c109ef'],
    ['██╔══██╗██╔══██╗╚██╗ ██╔╝██║   ██║', '#5bf58d'],
    ['██████╔╝███████║ ╚████╔╝ ██║   ██║', '#e8df3d'],
    ['██╔══██╗██╔══██║  ╚██╔╝  ██║   ██║', '#2257c9'],
    ['██║  ██║██║  ██║   ██║   ╚██████╔╝', '#43149b'],
    ['╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ', '#db5e71'],
  ],  
}

const RAYU_BANNER_WELCOME: BannerConfig = {
  lines: [
    ['██████╗  █████╗ ██╗   ██╗██╗   ██╗', '#cfff7c'],
    ['██╔══██╗██╔══██╗╚██╗ ██╔╝██║   ██║', '#5bf58d'],
    ['██████╔╝███████║ ╚████╔╝ ██║   ██║', '#22e0c9'],
    ['██╔══██╗██╔══██║  ╚██╔╝  ██║   ██║', '#22a0f2'],
    ['██║  ██║██║  ██║   ██║   ╚██████╔╝', '#64b815'],
    ['╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ', '#0e7a40'],
  ],
}

/** Registry of available banners, keyed by id. */
export const BANNERS: Record<BannerId, { clawd: BannerConfig; welcome: BannerConfig }> = {
  rayu: { clawd: RAYU_BANNER_CLAWD, welcome: RAYU_BANNER_WELCOME },
}

/** Change this to swap the active banner everywhere in one place. */
export const ACTIVE_BANNER_ID: BannerId = 'rayu'

/** Banner used by the compact `<Clawd />` mascot slot. */
export function getActiveClawdBanner(): BannerConfig {
  return BANNERS[ACTIVE_BANNER_ID].clawd
}

/** Banner used by the full first-launch `<WelcomeV2 />` screen. */
export function getActiveWelcomeBanner(): BannerConfig {
  return BANNERS[ACTIVE_BANNER_ID].welcome
}
