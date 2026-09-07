/**
 * In-editor Rayu sign-in — RAYU_CORE_MIGRATION_PLAN.md Task 15.
 *
 * Removes the terminal step: the user signs in from the panel and the CLI is
 * signed in too, because both read the SAME `~/.rayu/rayu-auth.json`.
 *
 * WHY LOOPBACK AND NOT A `vscode://` UriHandler
 * The plan suggested `vscode.env.openExternal` plus a `UriHandler`. Only the first
 * half is possible today. The flow is driven by the Rayu website, and
 * `rayu/src/services/rayuAuth/rayuLogin.ts` shows what it actually does: the
 * browser is sent to `${RAYU_WEB_URL}/cli-login?port=<port>&state=<hex>` and the
 * site redirects to `http://127.0.0.1:<port>/callback?code=…&state=…`. It has no
 * knowledge of `vscode://` URIs, so registering a UriHandler alone would produce a
 * callback that never arrives. Changing the redirect target is a coordinated
 * website + backend release, not an extension change.
 *
 * So this reuses the CLI's proven loopback pattern exactly, step for step,
 * including binding to 127.0.0.1 (IPv4) rather than `localhost` — the CLI
 * documents that `localhost` resolving to `::1` causes ERR_CONNECTION_REFUSED on
 * IPv6-first systems, and the website redirects to the IPv4 literal.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *   - no second credential store (§2.3): one account, one machine, one file;
 *   - no use of any editor secret store. `EditorAdapter` used to carry a
 *     `getSecret`/`storeSecret` pair for this; it had zero production callers and
 *     has been deleted, because the shared file IS the store;
 *   - no credential injection into the engine's `initialize` — the spawned engine
 *     reads the file itself, and `SDKControlInitializeRequest` has no credential
 *     field.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  rayuApiBaseUrl,
  rayuWebBaseUrl,
  writeRayuSession,
  type RayuSessionStore,
} from "./rayuSession.js";

/** Matches the CLI's LOGIN_TIMEOUT_MS. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** The shape the backend's `/cli/token` returns. */
interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user?: unknown;
}

export interface RayuLoginResult {
  user: unknown;
}

/**
 * Build the website login URL. Byte-identical to the CLI's `buildCliLoginUrl`,
 * because the website parses these exact two parameters.
 *
 * Pure, so the URL contract is testable without opening a browser.
 */
export function buildCliLoginUrl(webBaseUrl: string, port: number, state: string): string {
  const u = new URL(`${webBaseUrl.replace(/\/$/, "")}/cli-login`);
  u.searchParams.set("port", String(port));
  u.searchParams.set("state", state);
  return u.toString();
}

/** Parse `code`/`state` out of the loopback callback. Mirrors the CLI. */
export function parseCallback(reqUrl: string): { code?: string; state?: string } {
  try {
    const u = new URL(reqUrl, "http://127.0.0.1");
    return {
      code: u.searchParams.get("code") ?? undefined,
      state: u.searchParams.get("state") ?? undefined,
    };
  } catch {
    return {};
  }
}

const SUCCESS_HTML =
  '<html><body style="font-family:sans-serif"><h3>Signed in to Rayu.</h3>' +
  "<p>You can close this tab and return to VS Code.</p></body></html>";

/**
 * Validate a `/cli/token` response before it is persisted.
 *
 * A malformed response must not overwrite a working session with a broken one:
 * `read()` in rayuSession.ts treats a missing accessToken as "not signed in", so
 * writing junk would silently sign the user out of the CLI as well.
 */
export function parseTokenResponse(value: unknown): RayuSessionStore | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Partial<TokenResponse>;
  if (typeof c.accessToken !== "string" || c.accessToken.length === 0) return null;
  if (typeof c.refreshToken !== "string") return null;
  return {
    accessToken: c.accessToken,
    refreshToken: c.refreshToken,
    expiresAt: typeof c.expiresAt === "number" ? c.expiresAt : 0,
    user: c.user,
  };
}

/** Injection seams, so the flow is testable without a browser or a real backend. */
export interface RayuLoginDeps {
  env?: NodeJS.ProcessEnv;
  /**
   * `vscode.env.openExternal` in production.
   *
   * Typed as PromiseLike, not Promise: VS Code returns a `Thenable`, which is
   * awaitable but not a Promise instance.
   */
  openExternal: (url: string) => PromiseLike<boolean> | boolean;
  fetch?: typeof globalThis.fetch;
  /** Redaction is the caller's job; this never receives a token. */
  log?: (message: string) => void;
  timeoutMs?: number;
}

/**
 * Run the interactive login and persist the session.
 *
 * Resolves with the signed-in user. Rejects on timeout, state mismatch, or a
 * failed token exchange — never silently, because a caller that believes it is
 * signed in will spawn an engine that is not.
 */
export async function loginRayu(deps: RayuLoginDeps): Promise<RayuLoginResult> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? ((): void => {});
  const state = randomBytes(16).toString("hex");

  return await new Promise<RayuLoginResult>((resolve, reject) => {
    const server = createServer();
    let settled = false;

    const timer = setTimeout(() => {
      finish(new Error("Rayu sign-in timed out (5 minutes)."));
    }, deps.timeoutMs ?? LOGIN_TIMEOUT_MS);

    function finish(err: Error | null, value?: RayuLoginResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve(value as RayuLoginResult);
    }

    server.on("error", (e) => finish(e instanceof Error ? e : new Error(String(e))));

    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      const { code, state: gotState } = parseCallback(req.url ?? "");

      // Favicon and other probes carry no code; ignore them rather than failing
      // the login, exactly as the CLI does.
      if (!code) {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (gotState !== state) {
        res.statusCode = 400;
        res.end("Invalid state parameter");
        finish(new Error("OAuth state mismatch (possible CSRF)."));
        return;
      }

      // Acknowledge the browser before the exchange, so a slow backend does not
      // leave the user staring at a hanging tab.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(SUCCESS_HTML);

      void (async (): Promise<void> => {
        try {
          const response = await doFetch(`${rayuApiBaseUrl(env)}/cli/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
          });
          if (!response.ok) {
            finish(new Error(`Token exchange failed (${response.status}).`));
            return;
          }
          const store = parseTokenResponse(await response.json());
          if (!store) {
            // Never overwrite a good session with an unusable one.
            finish(new Error("Token exchange returned an unusable session."));
            return;
          }
          writeRayuSession(store, env);
          log("rayu sign-in: session stored");
          finish(null, { user: store.user });
        } catch (e) {
          finish(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    });

    // 127.0.0.1 explicitly, matching the website's redirect target.
    server.listen(0, "127.0.0.1", () => {
      void (async (): Promise<void> => {
        try {
          const { port } = server.address() as AddressInfo;
          const url = buildCliLoginUrl(rayuWebBaseUrl(env), port, state);
          log(`rayu sign-in: awaiting callback on 127.0.0.1:${port}`);
          const opened = await deps.openExternal(url);
          if (opened === false) {
            finish(new Error("Could not open a browser for Rayu sign-in."));
          }
        } catch (e) {
          finish(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    });
  });
}
