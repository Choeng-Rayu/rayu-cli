/**
 * Deep-link sign-in — `vscode://rayucode.rayucode/auth`.
 *
 * The routing rules are the security boundary: ANY process on the machine can
 * open a `vscode://` URI, so an unsolicited or replayed callback must not be
 * acted on. Those rules are a pure function (`matchAuthUri`) precisely so they can
 * be tested exhaustively without a running editor.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  AUTH_URI_PATH,
  RayuUriAuthBroker,
  buildVscodeLoginUrl,
  matchAuthUri,
} from "../src/rayuUriAuth.js";
import { hasRayuSession } from "../src/rayuSession.js";

describe("buildVscodeLoginUrl", () => {
  it("targets /vscode-login with only the state", () => {
    const url = new URL(buildVscodeLoginUrl("https://rayucode.com", "abcdef123456"));
    expect(url.pathname).toBe("/vscode-login");
    expect(url.searchParams.get("state")).toBe("abcdef123456");
    // No port: the deep link replaces the loopback server entirely.
    expect(url.searchParams.get("port")).toBeNull();
  });

  it("tolerates a trailing slash on the base URL", () => {
    expect(buildVscodeLoginUrl("https://rayucode.com/", "s")).toContain(
      "https://rayucode.com/vscode-login",
    );
  });
});

describe("matchAuthUri — what a delivered URI is allowed to do", () => {
  const pending = "the-pending-state";

  it("accepts a matching callback", () => {
    expect(
      matchAuthUri({ path: AUTH_URI_PATH, query: `code=abc&state=${pending}` }, pending),
    ).toEqual({ kind: "code", code: "abc" });
  });

  it("ignores a URI for a different path", () => {
    // The extension may register other deep links later; this handler owns /auth.
    const out = matchAuthUri({ path: "/somethingElse", query: "" }, pending);
    expect(out.kind).toBe("ignored");
  });

  it("ignores a callback when nothing is waiting", () => {
    // A stale link from an abandoned attempt, or an unsolicited URI from another
    // process. Acting on it would exchange a code this extension never requested.
    const out = matchAuthUri(
      { path: AUTH_URI_PATH, query: "code=abc&state=whatever" },
      null,
    );
    expect(out.kind).toBe("ignored");
  });

  it("rejects a state mismatch rather than ignoring it", () => {
    // Distinct from "ignored": a wrong state on a live attempt is a signal, and
    // the sign-in should fail loudly rather than hang until the timeout.
    expect(
      matchAuthUri({ path: AUTH_URI_PATH, query: "code=abc&state=attacker" }, pending),
    ).toEqual({ kind: "state-mismatch" });
  });

  it("ignores a callback with no code", () => {
    const out = matchAuthUri({ path: AUTH_URI_PATH, query: `state=${pending}` }, pending);
    expect(out.kind).toBe("ignored");
  });

  it("ignores a callback with an empty code", () => {
    const out = matchAuthUri(
      { path: AUTH_URI_PATH, query: `code=&state=${pending}` },
      pending,
    );
    expect(out.kind).toBe("ignored");
  });
});

describe("the broker survives real usage patterns", () => {
  it("reports whether a sign-in is awaiting a callback", () => {
    const broker = new RayuUriAuthBroker();
    expect(broker.isAwaitingCallback).toBe(false);
  });

  it("refuses a concurrent sign-in instead of losing the first", () => {
    // Clicking the button twice is the normal response to a login that looks
    // stuck. The second attempt must not silently replace the first's state, or
    // the first callback would then fail its state comparison.
    const broker = new RayuUriAuthBroker();
    const never = new Promise<boolean>(() => {});
    void broker.signIn({ openExternal: () => never, timeoutMs: 50_000 });
    return expect(
      broker.signIn({ openExternal: () => true, timeoutMs: 1_000 }),
    ).rejects.toThrow(/already in progress/);
  });

  it("does not throw when handed an unrelated URI", () => {
    // VS Code dispatches URIs into this handler; throwing surfaces an unhelpful
    // error notification for something the user did not do.
    const broker = new RayuUriAuthBroker();
    expect(() => broker.handleUri({ path: "/nope", query: "" })).not.toThrow();
  });

  it("fails the pending sign-in on a state mismatch", async () => {
    const broker = new RayuUriAuthBroker();
    const attempt = broker.signIn({
      openExternal: () => true,
      timeoutMs: 5_000,
      env: { RAYU_WEB_URL: "http://localhost:3000" },
    });
    // Let openExternal resolve so the pending state is registered.
    await new Promise((r) => setTimeout(r, 10));
    broker.handleUri({ path: AUTH_URI_PATH, query: "code=x&state=wrong" });
    await expect(attempt).rejects.toThrow(/state mismatch/);
  });

  it("reports a browser that could not be opened", async () => {
    const broker = new RayuUriAuthBroker();
    await expect(
      broker.signIn({ openExternal: () => false, timeoutMs: 5_000 }),
    ).rejects.toThrow(/Could not open a browser/);
  });
});

describe("a completed sign-in writes the shared session", () => {
  let configDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "rayu-uri-auth-"));
    env = {
      RAYU_CONFIG_DIR: configDir,
      RAYU_API_URL: "http://127.0.0.1:65535/api",
      RAYU_WEB_URL: "http://127.0.0.1:65534",
    };
  });

  /** Drive one sign-in, delivering the URI the website would. */
  async function complete(token: unknown, ok = true): Promise<Error | null> {
    const broker = new RayuUriAuthBroker();
    let captured = "";
    const attempt = broker.signIn({
      env,
      timeoutMs: 5_000,
      openExternal: (url) => {
        captured = url;
        return true;
      },
      fetch: (async () =>
        ({
          ok,
          status: ok ? 200 : 401,
          json: async () => token,
        }) as unknown as Response) as unknown as typeof globalThis.fetch,
    });
    await new Promise((r) => setTimeout(r, 10));
    const state = new URL(captured).searchParams.get("state") ?? "";
    broker.handleUri({ path: AUTH_URI_PATH, query: `code=the-code&state=${state}` });
    try {
      await attempt;
      return null;
    } catch (e) {
      return e as Error;
    }
  }

  it("stores a valid session at 0600 that the CLI reader accepts", async () => {
    const error = await complete({
      accessToken: "access-abc",
      refreshToken: "refresh-def",
      expiresAt: Date.now() + 3_600_000,
      user: { id: "u1" },
    });
    expect(error).toBeNull();

    const path = join(configDir, "rayu-auth.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).accessToken).toBe("access-abc");
    // The parity requirement: signing in here signs in the CLI too.
    expect(hasRayuSession(env)).toBe(true);
  });

  it("a failed exchange leaves an existing session intact", async () => {
    writeFileSync(
      join(configDir, "rayu-auth.json"),
      JSON.stringify({
        accessToken: "existing",
        refreshToken: "existing-r",
        expiresAt: Date.now() + 3_600_000,
      }),
      { mode: 0o600 },
    );
    const error = await complete({}, false);
    expect(error?.message).toMatch(/Token exchange failed \(401\)/);
    expect(JSON.parse(readFileSync(join(configDir, "rayu-auth.json"), "utf8")).accessToken).toBe(
      "existing",
    );
  });

  it("a malformed response never overwrites a good session", async () => {
    // rayuSession's reader treats a missing accessToken as "signed out", so
    // writing junk would sign the user out of the CLI as well.
    writeFileSync(
      join(configDir, "rayu-auth.json"),
      JSON.stringify({
        accessToken: "existing",
        refreshToken: "existing-r",
        expiresAt: Date.now() + 3_600_000,
      }),
      { mode: 0o600 },
    );
    const error = await complete({ accessToken: "" });
    expect(error?.message).toMatch(/unusable session/);
    expect(hasRayuSession(env)).toBe(true);
  });
});

describe("the deep-link authority must match the published extension id", () => {
  /**
   * WHY THIS TEST EXISTS
   * `vscode://<publisher>.<name>/auth` is routed by VS Code to the extension with
   * that exact identifier. rayu-web hardcodes the authority (deliberately — a
   * caller-supplied target would make the page an open redirect carrying a valid
   * one-time code), so the constant there and this extension's identity have to
   * agree, and nothing at build time checks that they do.
   *
   * They did NOT agree: the page built `rayu-dev.rayucode` (no such extension) while the extension
   * publishes as `RayuCode.rayucode`. The URI was delivered to no extension, the
   * handler never fired, and sign-in only recovered by timing out into the slower
   * loopback flow — which is why login felt slow after a fresh install.
   */
  const EXPECTED_AUTHORITY = "rayucode.rayucode";

  it("matches <publisher>.<name> from package.json, lowercased", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { publisher: string; name: string };
    const identity = `${manifest.publisher}.${manifest.name}`.toLowerCase();
    expect(identity).toBe(EXPECTED_AUTHORITY);
  });

  it("is the authority rayu-web redirects to", () => {
    // Read the web constant directly, so a change on either side fails here
    // rather than silently breaking sign-in for every marketplace install.
    //
    // rayu-web is a SEPARATE repository, so treat its absence as "cannot check"
    // rather than a failure — a checkout without it is legitimate.
    const webFile = "/home/rayu/rayu/rayu-web/lib/vscodeLogin.ts";
    if (!existsSync(webFile)) return;
    const match = /const VSCODE_EXTENSION_ID = '([^']+)'/.exec(
      readFileSync(webFile, "utf8"),
    );
    expect(match?.[1]).toBe(EXPECTED_AUTHORITY);
  });
});
