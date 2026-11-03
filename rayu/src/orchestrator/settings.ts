/**
 * Orchestrator settings (`orchestrator` in settings.json) with their defaults applied.
 * The schema is in src/utils/settings/types.ts; the defaults in
 * src/constants/orchestrator.ts.
 */
import {
  ORCHESTRATOR_DEFAULT_MAX_PARALLEL_WRITERS,
  ORCHESTRATOR_DEFAULT_MAX_REPAIR_ROUNDS,
  ORCHESTRATOR_DEFAULT_VERIFICATION_GATE,
} from '../constants/orchestrator.js'
import { getInitialSettings } from '../utils/settings/settings.js'

export type OrchestratorSettings = {
  readonly verificationGate: 'hard' | 'soft'
  readonly maxRepairRounds: number
  readonly maxParallelWriters: number
  /** Required in every run, in addition to the contract's checks. */
  readonly checkCommands: readonly string[]
}

type RawOrchestratorSettings = {
  verificationGate?: 'hard' | 'soft'
  maxRepairRounds?: number
  maxParallelWriters?: number
  checkCommands?: readonly string[]
}

/** Defaults for anything unset. Pure, so it can be tested without settings files. */
export function resolveOrchestratorSettings(
  raw: RawOrchestratorSettings | undefined,
): OrchestratorSettings {
  return {
    verificationGate: raw?.verificationGate ?? ORCHESTRATOR_DEFAULT_VERIFICATION_GATE,
    maxRepairRounds: raw?.maxRepairRounds ?? ORCHESTRATOR_DEFAULT_MAX_REPAIR_ROUNDS,
    maxParallelWriters: raw?.maxParallelWriters ?? ORCHESTRATOR_DEFAULT_MAX_PARALLEL_WRITERS,
    checkCommands: (raw?.checkCommands ?? []).map(command => command.trim()).filter(Boolean),
  }
}

export function getOrchestratorSettings(): OrchestratorSettings {
  return resolveOrchestratorSettings(getInitialSettings().orchestrator)
}
