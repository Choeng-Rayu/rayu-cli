/**
 * The login-child protocol.
 *
 * Shared by the two ends of a one-off sign-in:
 *
 *   src/entrypoints/vscodeHost.ts        the child, which does the login
 *   src/vscode/host/auth/vscodeLogin.ts  the extension host, which spawns it
 *
 * ── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────────────────
 *
 * The obvious place for `LOGIN_FLAG` is beside the code that reads it, in
 * `vscodeHost.ts`. That would be a serious mistake: `vscodeHost.ts` has top-level
 * side effects — it calls `loadDotEnv()` and `void main()` at module scope — and its
 * graph is the entire engine. Importing a single constant from it would pull ~20 MB
 * into `extension.js` AND start the engine as a side effect of loading the extension.
 *
 * A dependency-free leaf module lets both sides share the contract with no coupling.
 * Nothing here may import anything.
 */

/**
 * Switches the engine bundle from "run the engine" to "perform a login and exit".
 *
 * A flag rather than a separate entrypoint, so `build:vscode` keeps emitting one
 * engine bundle instead of two nearly-identical ones.
 */
export const LOGIN_FLAG = '--rayucode-login'

/**
 * Frames the login child writes to stdout, one JSON object per line.
 *
 * The `rayucode_login_` prefix is deliberate. These currently share a stream with
 * nothing, but a distinct prefix means they can never be confused with engine
 * protocol frames if that ever changes.
 */
export type LoginFrame =
  /**
   * The child has started its loopback server and needs this URL opened.
   *
   * The child deliberately does NOT open it. Only the extension host can, because
   * `vscode.env.asExternalUri` is what makes a loopback callback reachable from a
   * local browser when the extension host is remote.
   */
  | { type: 'rayucode_login_url'; url: string }
  | { type: 'rayucode_login_result'; ok: true; displayName: string | null }
  | { type: 'rayucode_login_result'; ok: false; error: string }
