/**
 * Permission modes as the editor presents them.
 *
 * In `shared/` because BOTH sides need it: the host owns the cycle and talks to the
 * engine, and the webview needs a starting value before the first `init` arrives.
 * Duplicating the default in the reducer would let the pill show one mode while the
 * host enforced another.
 *
 * Dependency-free except for a type import, so it is safe in the BROWSER bundle — and
 * so the cycle logic can be tested without stubbing the editor API, which is the
 * difference between a real test and one that only proves the stub works.
 */
import type { PermissionModeView } from './webviewProtocol.js'
export type { PermissionModeView }

/**
 * The modes offered, in cycle order.
 *
 * A SUBSET of the protocol's enum, and the omissions are deliberate. The schema also
 * accepts `dontAsk`, `bypassPermissions`, plus the internal `auto` and `bubble`;
 * those are not offered. Rayucode presents the CLI's Full Manage mode instead
 * of a duplicate Full access entry. Orchestrator remains a separate choice and
 * uses Full Manage's execution semantics while adding the delegation-only role.
 *
 * Ordered least to most permissive, so Shift+Tab escalates predictably instead of
 * jumping between unrelated behaviours.
 */
export const PERMISSION_MODES: readonly PermissionModeView[] = [
  {
    id: 'default',
    label: 'Ask',
    description: 'Ask before running tools that change anything.',
  },
  {
    id: 'acceptEdits',
    label: 'Auto-edit',
    description: 'Apply file edits without asking. Still asks for commands.',
  },
  {
    id: 'plan',
    label: 'Plan',
    description: 'Read and analyse only. No edits, no commands.',
  },
  {
    id: 'fullManage',
    label: 'Full Manage',
    description: 'Run all non-interactive tools without asking.',
  },
  {
    id: 'orchestrator',
    label: 'Orchestrator',
    description: 'Full access for delegated workers; the main agent only coordinates.',
  },
]

/** The mode the panel starts in, matching the engine's own default. */
export const DEFAULT_PERMISSION_MODE = PERMISSION_MODES[0] as PermissionModeView

/**
 * Step to the next mode, wrapping.
 *
 * An unrecognised id — an internal engine mode, or a value from a newer engine —
 * restarts the cycle rather than throwing or sticking, so the control always does
 * something predictable.
 */
export function nextPermissionMode(current: string): PermissionModeView {
  const index = PERMISSION_MODES.findIndex(m => m.id === current)
  // -1 + 1 === 0, so an unknown mode lands on the first entry.
  return PERMISSION_MODES[(index + 1) % PERMISSION_MODES.length] as PermissionModeView
}

/** Resolve an id to its view, falling back to the default for anything unknown. */
export function permissionModeById(id: string): PermissionModeView {
  // Migrate the old Rayucode label/value to the single full-control mode now
  // exposed by the editor. The CLI still owns both protocol identifiers.
  if (id === 'bypassPermissions') {
    return PERMISSION_MODES.find(m => m.id === 'fullManage') ?? DEFAULT_PERMISSION_MODE
  }
  return PERMISSION_MODES.find(m => m.id === id) ?? DEFAULT_PERMISSION_MODE
}
