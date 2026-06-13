import type { AppState } from '../state/AppStateStore.js'

/**
 * Session-wide collaborator-swarm mode helpers.
 *
 * swarmMode is a per-session AppState flag (init false; reset on /clear). When
 * true, the main agent behaves as the orchestrator (3-phase build flow,
 * delegating to specialist collaborators) and an indicator shows under the
 * input. Toggled by /collaborator_swarm (on) and /normal (off), and
 * auto-enabled when a plan is confirmed (ExitPlanMode approved).
 */
export function getSwarmMode(state: Pick<AppState, 'swarmMode'>): boolean {
  return state.swarmMode === true
}

/** A pure AppState updater that sets swarmMode. Use with setAppState. */
export function setSwarmModeUpdater(
  value: boolean,
): (prev: AppState) => AppState {
  return prev => (prev.swarmMode === value ? prev : { ...prev, swarmMode: value })
}
