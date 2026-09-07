/**
 * Bypass-class permission modes — the "full manage" bug.
 *
 * THE ROOT CAUSE, read from rayu/src
 * `utils/permissions/permissionSetup.ts` computes availability ONCE during startup:
 *
 *     isBypassPermissionsModeAvailable =
 *       (permissionMode === 'bypassPermissions' ||
 *        permissionMode === 'fullManage' ||
 *        allowDangerouslySkipPermissions) && !disabledByGate && !disabledBySettings
 *
 * and `cli/print.ts` rejects a `set_permission_mode` request for `bypassPermissions`
 * when it is false, with exactly the reported message: "Cannot set permission mode to
 * bypassPermissions because the session was not launched with
 * --dangerously-skip-permissions".
 *
 * So a session launched in `default` can NEVER be switched into a bypass-class mode.
 * Sending the request anyway is what surfaced that error. The only routes are to launch
 * with a bypass-class `--permission-mode`, or with `--dangerously-skip-permissions`.
 *
 * The flag is deliberately NOT used: `initialPermissionModeFromCLI` does
 * `if (dangerouslySkipPermissions) orderedModes.push('bypassPermissions')` FIRST in its
 * priority list, so it would force every session to START in full bypass rather than
 * merely making the mode reachable. `--permission-mode fullManage` grants the mode the
 * user asked for and satisfies the same gate. Verified against the built host: it
 * reports `permissionMode: fullManage` in `system/init`.
 */
import { describe, expect, it } from "vitest";

import { isBypassClassPermissionMode } from "../src/session/sessionManager.js";

describe("which modes are fixed at launch", () => {
  it("treats exactly the two gate-satisfying modes as bypass-class", () => {
    // These are the two values `isBypassPermissionsModeAvailable` tests for.
    expect(isBypassClassPermissionMode("bypassPermissions")).toBe(true);
    expect(isBypassClassPermissionMode("fullManage")).toBe(true);
  });

  it("leaves the freely-switchable modes alone", () => {
    // These change at runtime through set_permission_mode and must NOT trigger a
    // relaunch — restarting the conversation to switch to plan mode would be absurd.
    for (const mode of ["default", "plan", "acceptEdits", "dontAsk", "auto", "bubble"]) {
      expect(isBypassClassPermissionMode(mode), mode).toBe(false);
    }
  });

  it("does not match on a substring or different case", () => {
    // The value is compared against the engine's exact mode strings.
    expect(isBypassClassPermissionMode("bypass")).toBe(false);
    expect(isBypassClassPermissionMode("BypassPermissions")).toBe(false);
    expect(isBypassClassPermissionMode("")).toBe(false);
  });
});
