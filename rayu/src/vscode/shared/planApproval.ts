/**
 * How an approved plan continues, as the editor offers it.
 *
 * In `shared/` because both sides need the same answer: the webview renders one button
 * per choice and the host turns the choice into the engine's permission response. A
 * second copy of the choice→mode table would let a button say one mode while the host
 * set another.
 *
 * ── WHY "ORCHESTRATE" SENDS NO MODE CHANGE ─────────────────────────────────────
 *
 * ExitPlanModeV2Tool.call performs the one plan→Orchestrator switch itself when the
 * approval left the session in plan mode (it also restores rules stripped while
 * planning). Orchestrator is an internal mode, so the SDK's `setMode` schema could not
 * carry it anyway: one invalid entry fails the whole update list. The other choices set
 * an external mode first, and the tool then leaves it alone and names it in its result.
 *
 * Dependency-free apart from `permissionModes.ts` (itself dependency-free), so it is
 * safe in the BROWSER bundle.
 */
import { permissionModeById } from './permissionModes.js'

/** The ways a local plan card can approve. "Keep planning" is a plain deny. */
export type PlanApprovalChoice =
  | 'approve-orchestrate'
  | 'approve-accept-edits'
  | 'approve-default'

/** Every answer a permission card can send to the host. */
export type PermissionDecisionKind =
  | 'allow-once'
  | 'allow-always'
  | 'deny'
  | PlanApprovalChoice

/** A mode the host may set on approval: external, so the SDK schema accepts it. */
export type PlanApprovalMode = 'default' | 'acceptEdits'

/** Least to most delegation, the order the card shows them in (primary last). */
export const PLAN_APPROVAL_CHOICES: readonly PlanApprovalChoice[] = [
  'approve-default',
  'approve-accept-edits',
  'approve-orchestrate',
]

const CHOICE_MODE: Readonly<Record<PlanApprovalChoice, PlanApprovalMode | null>> = {
  'approve-default': 'default',
  'approve-accept-edits': 'acceptEdits',
  'approve-orchestrate': null,
}

export function isPlanApprovalChoice(kind: string): kind is PlanApprovalChoice {
  return (PLAN_APPROVAL_CHOICES as readonly string[]).includes(kind)
}

/**
 * The session mode to set before the tool runs, or null when the tool's own rule
 * applies (a confirmed plan enters Orchestrator mode).
 */
export function planApprovalMode(choice: PlanApprovalChoice): PlanApprovalMode | null {
  return CHOICE_MODE[choice]
}

/** Button text and tooltip, named after the mode pill so the two always agree. */
export function planApprovalLabel(choice: PlanApprovalChoice): {
  label: string
  description: string
} {
  const mode = permissionModeById(planApprovalMode(choice) ?? 'orchestrator')
  return { label: `Approve · ${mode.label}`, description: mode.description }
}
