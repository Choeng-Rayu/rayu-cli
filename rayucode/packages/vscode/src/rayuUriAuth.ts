/**
 * VS Code deep-link sign-in — the `vscode://rayucode.rayucode/auth` half of the
 * flow. RAYU_CORE_MIGRATION_PLAN Task 6.
 *
 * WHY A BROKER AND NOT A HANDLER PER SIGN-IN
 * `vscode.window.registerUriHandler` allows ONE handler per extension. A second
 * registration replaces or throws depending on version, so a design that
 * registered per sign-in attempt would break the moment a user started a second
 * attempt — the common case, since the first thing people do when a login seems
 * stuck is click the button again. The handler is therefore registered once at
 * activation, and hands the callback to whichever request is waiting.
 *
 * WHY THIS EXISTS ALONGSIDE THE LOOPBACK FLOW
 * `rayuLogin.ts` implements the CLI's loopback flow, which the extension inherited
 * because the website only knew how to redirect to `http://127.0.0.1:<port>`. With
 * `/vscode-login` added to rayu-web, the deep link is now the better path: no
 * local HTTP server, no port to bind, and no firewall prompt. The loopback flow
 * stays as the fallback for windows where the extension host cannot receive a URI
 * — a Remote-SSH or container window, where the browser runs on a different
 * machine than the extension host.
 *
 * SECURITY
 * The `state` is compared before the code is used, so a URI arriving from
 * anywhere other than the flow this extension started is discarded. Any process
 * on the machine can open a `vscode://` URI, which is exactly why the comparison
 * is not optional.
 */
import { randomBytes } from "node:crypto";

import { parseTokenResponse } from "./rayuLogin.js";
import {
  rayuApiBaseUrl,
  rayuWebBaseUrl,
  writeRayuSession,
  type RayuSessionStore,
} from "./rayuSession.js";

/** Matches the CLI's LOGIN_TIMEOUT_MS and rayuLogin.ts. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** The path the website redirects to. Must match `buildVscodeRedirect` in rayu-web. */
export const AUTH_URI_PATH = "/auth";

/** A URI as delivered by VS Code, reduced to what this module needs. */
export interface IncomingAuthUri {
  path: string;
  /** Raw `a=b&c=d`, i.e. `vscode.Uri.query`. */
  query: string;
}

/** The outcome of matching an incoming URI against the waiting request. */
export type UriMatch =
  | { kind: "ignored"; reason: string }
  | { kind: "state-mismatch" }
  | { kind: "code"; code: string };

/**
 * Decide what an incoming URI means for a pending sign-in.
 *
 * Pure and exported so the routing rules are testable without a running editor —
 * they are the security boundary, not incidental plumbing.
 */
export function matchAuthUri(
  uri: IncomingAuthUri,
  pendingState: string | null,
): UriMatch {
  if (uri.path !== AUTH_URI_PATH) {
    return { kind: "ignored", reason: `unexpected path ${uri.path}` };
  }
  if (pendingState === null) {
    // Nothing is waiting: either a stale link from an abandoned attempt, or an
    // unsolicited URI from another process. Both are ignored rather than acted on.
    return { kind: "ignored", reason: "no sign-in is in progress" };
  }
  const params = new URLSearchParams(uri.query);
  const code = params.get("code");
  const state = params.get("state");
  if (!code) {
    return { kind: "ignored", reason: "no code in the callback" };
  }
  if (state !== pendingState) {
    return { kind: "state-mismatch" };
  }
  return { kind: "code", code };
}

/** Build the URL the browser is sent to. Mirrors rayu-web's expected query. */
export function buildVscodeLoginUrl(webBaseUrl: string, state: string): string {
  const u = new URL(`${webBaseUrl.replace(/\/$/, "")}/vscode-login`);
  u.searchParams.set("state", state);
  return u.toString();
}

export interface UriSignInDeps {
  env?: NodeJS.ProcessEnv;
  /** `vscode.env.openExternal`. Returns a Thenable, not a Promise. */
  openExternal: (url: string) => PromiseLike<boolean> | boolean;
  fetch?: typeof globalThis.fetch;
  /** Never receives a token — redaction is not this module's job because it never has one to leak. */
  log?: (message: string) => void;
  timeoutMs?: number;
}

/**
 * Registered once at activation; routes a delivered URI to the waiting sign-in.
 *
 * `handleUri` is deliberately tolerant: an unmatched URI is logged and dropped
 * rather than throwing, because throwing inside VS Code's URI dispatch surfaces
 * as an unhelpful error notification for something the user did not do.
 */
export class RayuUriAuthBroker {
  private pendingState: string | null = null;
  private deliver: ((code: string) => void) | null = null;
  private failWith: ((error: Error) => void) | null = null;

  constructor(private readonly log: (message: string) => void = () => {}) {}

  /** True while a sign-in is awaiting its callback. */
  get isAwaitingCallback(): boolean {
    return this.pendingState !== null;
  }

  /** Called from `vscode.window.registerUriHandler`. */
  handleUri(uri: IncomingAuthUri): void {
    const outcome = matchAuthUri(uri, this.pendingState);
    switch (outcome.kind) {
      case "ignored":
        this.log(`auth uri ignored: ${outcome.reason}`);
        return;
      case "state-mismatch":
        this.log("auth uri rejected: state mismatch");
        this.failWith?.(new Error("OAuth state mismatch (possible CSRF)."));
        this.clear();
        return;
      case "code":
        this.log("auth uri accepted");
        this.deliver?.(outcome.code);
        this.clear();
        return;
    }
  }

  /**
   * Run one sign-in: open the browser, wait for the callback, exchange the code,
   * persist the session.
   *
   * Rejects rather than resolving quietly on every failure path. A caller that
   * believes it is signed in will spawn an engine that is not, and the user then
   * sees the engine's refusal instead of a sign-in error.
   */
  async signIn(deps: UriSignInDeps): Promise<{ user: unknown }> {
    if (this.pendingState !== null) {
      throw new Error("A Rayu sign-in is already in progress.");
    }
    const env = deps.env ?? process.env;
    const doFetch = deps.fetch ?? globalThis.fetch;
    const log = deps.log ?? this.log;
    const state = randomBytes(16).toString("hex");

    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clear()
        reject(new Error('Rayu sign-in timed out (5 minutes).'))
      }, deps.timeoutMs ?? LOGIN_TIMEOUT_MS)

      const finish = (outcome: { code: string } | { error: Error }): void => {
        clearTimeout(timer)
        if ("error" in outcome) reject(outcome.error)
        else resolve(outcome.code)
      }

      this.pendingState = state;
      this.deliver = (delivered) => finish({ code: delivered });
      this.failWith = (error) => finish({ error });

      void (async () => {
        try {
          const url = buildVscodeLoginUrl(rayuWebBaseUrl(env), state);
          log("rayu sign-in: awaiting the vscode:// callback");
          const opened = await deps.openExternal(url);
          if (opened === false) {
            this.clear();
            finish({ error: new Error("Could not open a browser for Rayu sign-in.") });
          }
        } catch (error) {
          this.clear();
          finish({
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      })();
    });

    const store = await this.exchange(code, env, doFetch);
    writeRayuSession(store, env);
    log("rayu sign-in: session stored");
    return { user: store.user };
  }

  /** Redeem the one-time code at the VS Code-specific endpoint. */
  private async exchange(
    code: string,
    env: NodeJS.ProcessEnv,
    doFetch: typeof globalThis.fetch,
  ): Promise<RayuSessionStore> {
    // /vscode/token, not /cli/token: the backend binds each code to the client
    // that requested it, so presenting a vscode code at the CLI endpoint (or the
    // reverse) is refused AND destroys the code.
    const response = await doFetch(`${rayuApiBaseUrl(env)}/vscode/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!response.ok) {
      throw new Error(`Token exchange failed (${response.status}).`);
    }
    const store = parseTokenResponse(await response.json());
    if (!store) {
      // Never overwrite a working session with an unusable one: rayuSession's
      // reader treats a missing accessToken as "signed out", so writing junk
      // would sign the user out of the CLI too.
      throw new Error("Token exchange returned an unusable session.");
    }
    return store;
  }

  private clear(): void {
    this.pendingState = null;
    this.deliver = null;
    this.failWith = null;
  }
}
