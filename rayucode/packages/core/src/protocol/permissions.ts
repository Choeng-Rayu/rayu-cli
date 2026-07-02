// Permission protocol types.
//
// Grounded in the CLI's `PermissionModeSchema`, `PermissionUpdateSchema`, and
// `PermissionResultSchema` (`src/entrypoints/sdk/coreSchemas.ts`). These types
// back the permission flow: the active mode, the allow/deny payload the host
// returns, and the rule-update suggestions a permission request may carry.
//
// Type definitions only — the auto-approval policy and coordinator are added
// by later tasks.

/**
 * User-selectable policy controlling which tool-action categories require
 * explicit per-action approval (R5.4, R10.4). Mirrors the CLI's
 * `PermissionModeSchema` enum.
 *
 * - `default` — prompt for dangerous operations.
 * - `acceptEdits` — auto-accept file edits, still prompt for the rest.
 * - `bypassPermissions` — bypass all permission checks.
 * - `plan` — planning mode, no tool execution.
 * - `dontAsk` — never prompt; deny anything not pre-approved.
 */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk";

/** All permission modes, in schema order, for runtime iteration/validation. */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
] as const satisfies readonly PermissionMode[];

/** Runtime guard: is the given value a recognised {@link PermissionMode}? */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    (PERMISSION_MODES as readonly string[]).includes(value)
  );
}

/** Behaviour of a permission rule or decision. */
export type PermissionBehavior = "allow" | "deny" | "ask";

/** Where a permission update is persisted. */
export type PermissionUpdateDestination =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "session"
  | "cliArg";

/** A single tool rule value within a permission update. */
export interface PermissionRuleValue {
  toolName: string;
  ruleContent?: string;
}

/**
 * A suggested permission-rule change accompanying a permission request.
 * Mirrors the CLI's `PermissionUpdateSchema` discriminated union.
 */
export type PermissionUpdate =
  | {
      type: "addRules";
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "replaceRules";
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "removeRules";
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "setMode";
      mode: PermissionMode;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "addDirectories";
      directories: string[];
      destination: PermissionUpdateDestination;
    }
  | {
      type: "removeDirectories";
      directories: string[];
      destination: PermissionUpdateDestination;
    };

/**
 * The allow/deny payload the host returns inside a permission `control_response`
 * (R5.2, R5.3). Mirrors the CLI's `PermissionResultSchema`.
 *
 * - allow ⇒ optional `updatedInput` carries the exact input the user approved.
 * - deny ⇒ `message` carries the reason; `interrupt` optionally aborts the turn.
 */
export type PermissionToolOutput =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; toolUseID?: string }
  | { behavior: "deny"; message: string; interrupt?: boolean; toolUseID?: string };
