/**
 * In-editor sign-in — RAYU_CORE_MIGRATION_PLAN.md Task 15.
 *
 * The security properties are the point of this file, not the happy path:
 *   - the session lands in the SAME file the CLI reads, at mode 0600;
 *   - a CSRF-style state mismatch is rejected;
 *   - a malformed token response never overwrites a working session;
 *   - no token reaches the log channel.
 *
 * The flow is the CLI's, step for step (see src/rayuLogin.ts for why a
 * `vscode://` UriHandler cannot work here): loopback server on 127.0.0.1, browser
 * to `/cli-login?port=&state=`, callback with `code`, exchange at `/cli/token`.
 */
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCliLoginUrl,
  loginRayu,
  parseCallback,
  parseTokenResponse,
} from "../src/rayuLogin.js";
import { hasRayuSession, rayuSessionPath } from "../src/rayuSession.js";

let configDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "rayu-signin-"));
  env = {
    RAYU_CONFIG_DIR: configDir,
    RAYU_API_URL: "http://127.0.0.1:65535/api",
    RAYU_WEB_URL: "http://127.0.0.1:65534",
  };
});

afterEach(() => {
  // The temp dir is disposable; nothing to unwind.
});

/**
 * Drive one full login: capture the URL the browser would open, hit the loopback
 * callback, and return the promise's outcome.
 */
async function runLogin(options: {
  token?: unknown;
  ok?: boolean;
  /** Override the state sent back, to simulate CSRF. */
  tamperState?: (real: string) => string;
  log?: (m: string) => void;
}): Promise<{ result: unknown; error: Error | null }> {
  let capturedUrl = "";
  const promise = loginRayu({
    env,
    timeoutMs: 10_000,
    log: options.log,
    openExternal: async (url) => {
      capturedUrl = url;
      const parsed = new URL(url);
      const port = parsed.searchParams.get("port");
      const realState = parsed.searchParams.get("state") ?? "";
      const state = options.tamperState ? options.tamperState(realState) : realState;
      // Hit the loopback callback exactly as the website would.
      await fetch(`http://127.0.0.1:${port}/callback?code=test-code&state=${state}`).catch(
        () => undefined,
      );
      return true;
    },
    fetch: (async () =>
      ({
        ok: options.ok ?? true,
        status: options.ok === false ? 401 : 200,
        json: async () =>
          options.token ?? {
            accessToken: "access-abc",
            refreshToken: "refresh-def",
            expiresAt: Date.now() + 3_600_000,
            user: { id: "u1", email: "user@example.com" },
          },
      }) as unknown as Response) as unknown as typeof globalThis.fetch,
  });

  try {
    const result = await promise;
    expect(capturedUrl).not.toBe("");
    return { result, error: null };
  } catch (e) {
    return { result: null, error: e as Error };
  }
}

describe("the login URL matches the contract the website parses", () => {
  it("carries exactly port and state on /cli-login", () => {
    const url = new URL(buildCliLoginUrl("https://rayucode.com", 51234, "deadbeef"));
    expect(url.pathname).toBe("/cli-login");
    expect(url.searchParams.get("port")).toBe("51234");
    expect(url.searchParams.get("state")).toBe("deadbeef");
  });

  it("tolerates a trailing slash on the base URL", () => {
    expect(buildCliLoginUrl("https://rayucode.com/", 1, "s")).toContain(
      "https://rayucode.com/cli-login",
    );
  });
});

describe("callback parsing", () => {
  it("extracts code and state", () => {
    expect(parseCallback("/callback?code=abc&state=xyz")).toEqual({
      code: "abc",
      state: "xyz",
    });
  });

  it("returns nothing for a probe with no code, e.g. /favicon.ico", () => {
    expect(parseCallback("/favicon.ico")).toEqual({ code: undefined, state: undefined });
  });
});

describe("token responses are validated before being persisted", () => {
  it("accepts a complete response", () => {
    expect(
      parseTokenResponse({ accessToken: "a", refreshToken: "r", expiresAt: 123 }),
    ).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 123, user: undefined });
  });

  it.each([
    ["null", null],
    ["a string", "nope"],
    ["missing accessToken", { refreshToken: "r" }],
    ["empty accessToken", { accessToken: "", refreshToken: "r" }],
    ["missing refreshToken", { accessToken: "a" }],
    ["non-string accessToken", { accessToken: 1, refreshToken: "r" }],
  ])("rejects %s", (_label, value) => {
    expect(parseTokenResponse(value)).toBeNull();
  });

  it("defaults a missing expiresAt to 0 so the next call refreshes", () => {
    expect(parseTokenResponse({ accessToken: "a", refreshToken: "r" })?.expiresAt).toBe(0);
  });
});

describe("a successful sign-in writes the session the CLI reads", () => {
  it("stores it at the shared path with mode 0600", async () => {
    const { error } = await runLogin({});
    expect(error).toBeNull();

    const path = rayuSessionPath(env);
    expect(path).toBe(join(configDir, "rayu-auth.json"));
    expect(existsSync(path)).toBe(true);

    // 0600. A refresh must never loosen what the CLI set.
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.accessToken).toBe("access-abc");
    expect(stored.refreshToken).toBe("refresh-def");

    // And the CLI's own reader accepts it — the actual parity requirement.
    expect(hasRayuSession(env)).toBe(true);
  });

  it("does not write a token into the log channel", async () => {
    const lines: string[] = [];
    const { error } = await runLogin({ log: (m) => lines.push(m) });
    expect(error).toBeNull();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain("access-abc");
      expect(line).not.toContain("refresh-def");
      expect(line).not.toContain("test-code");
    }
  });
});

describe("failures do not corrupt an existing session", () => {
  /** A good session already on disk, as if the CLI had written it. */
  function seedGoodSession(): void {
    writeFileSync(
      join(configDir, "rayu-auth.json"),
      JSON.stringify({
        accessToken: "existing-access",
        refreshToken: "existing-refresh",
        expiresAt: Date.now() + 3_600_000,
      }),
      { mode: 0o600 },
    );
  }

  it("a state mismatch is rejected and nothing is written", async () => {
    seedGoodSession();
    const { error } = await runLogin({ tamperState: () => "attacker-state" });
    expect(error?.message).toContain("state mismatch");
    // The pre-existing session survives untouched.
    expect(JSON.parse(readFileSync(join(configDir, "rayu-auth.json"), "utf8")).accessToken).toBe(
      "existing-access",
    );
  });

  it("a non-OK token exchange leaves the old session in place", async () => {
    seedGoodSession();
    const { error } = await runLogin({ ok: false });
    expect(error?.message).toContain("Token exchange failed (401)");
    expect(JSON.parse(readFileSync(join(configDir, "rayu-auth.json"), "utf8")).accessToken).toBe(
      "existing-access",
    );
  });

  it("a malformed token response leaves the old session in place", async () => {
    // The dangerous case: writing junk would make `read()` return null and
    // silently sign the user out of the CLI as well.
    seedGoodSession();
    const { error } = await runLogin({ token: { accessToken: "" } });
    expect(error?.message).toContain("unusable session");
    expect(hasRayuSession(env)).toBe(true);
    expect(JSON.parse(readFileSync(join(configDir, "rayu-auth.json"), "utf8")).accessToken).toBe(
      "existing-access",
    );
  });

  it("reports rather than resolving silently, so no caller assumes success", async () => {
    const { result, error } = await runLogin({ ok: false });
    expect(result).toBeNull();
    expect(error).toBeInstanceOf(Error);
    expect(hasRayuSession(env)).toBe(false);
  });
});
