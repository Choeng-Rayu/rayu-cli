/**
 * Showing WHO is signed in — and whether anyone is.
 *
 * THE BUG THIS FIXES
 * On first launch the panel showed only "Model Loading…" and signing in appeared to
 * change nothing. Two causes, both verified against the built engine:
 *
 *  1. With NO credentials the engine emits the auth-gate error as its FIRST frame and
 *     exits 1 — it never sends `system/init`. Since the model, command catalog and
 *     permission mode all arrive in that frame, the panel received nothing and sat on
 *     its placeholder. Reproduced directly: stdin prompt with an empty RAYU_CONFIG_DIR
 *     produces one `result/error_during_execution` frame and `exit: 1`.
 *  2. Sign-in wrote the credential store and showed a notification, but nothing
 *     restarted the engine — so the dead process stayed dead and the panel stayed
 *     exactly as it was.
 *
 * The panel also had no auth indicator of any kind, so there was no way to tell.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasRayuSession, rayuAccountLabel } from "../src/rayuSession.js";

let dir: string;
let env: NodeJS.ProcessEnv;

function writeSession(user: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "rayu-auth.json"),
    JSON.stringify({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 3_600_000,
      user,
    }),
    { mode: 0o600 },
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rayu-auth-"));
  env = { ...process.env, RAYU_CONFIG_DIR: dir };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("naming the signed-in account", () => {
  it("returns null when signed out, so the panel can offer sign-in", () => {
    expect(rayuAccountLabel(env)).toBeNull();
    expect(hasRayuSession(env)).toBe(false);
  });

  it("prefers the display name", () => {
    writeSession({ id: 1, displayName: "Rayu Dev", email: "dev@rayucode.com", role: "user" });
    expect(rayuAccountLabel(env)).toEqual({ account: "Rayu Dev" });
  });

  it("falls back to the email", () => {
    writeSession({ id: 1, displayName: null, email: "dev@rayucode.com", role: "user" });
    expect(rayuAccountLabel(env)).toEqual({ account: "dev@rayucode.com" });
  });

  it("ignores a blank display name rather than showing empty space", () => {
    writeSession({ id: 1, displayName: "   ", email: "dev@rayucode.com", role: "user" });
    expect(rayuAccountLabel(env)).toEqual({ account: "dev@rayucode.com" });
  });

  it("still reports SIGNED IN when the account has no name at all", () => {
    // "Signed in as someone we cannot name" is still signed in. Reporting it as signed
    // out would be worse: it would offer a sign-in the user has already completed.
    writeSession({ id: 1, displayName: null, email: null, role: "user" });
    expect(rayuAccountLabel(env)).toEqual({ account: null });
    expect(rayuAccountLabel(env)).not.toBeNull();
  });

  it("does not throw on a malformed session file", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rayu-auth.json"), "{ not json");
    expect(() => rayuAccountLabel(env)).not.toThrow();
    expect(rayuAccountLabel(env)).toBeNull();
  });

  it("does not throw when the user object is missing", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "rayu-auth.json"),
      JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 1000 }),
    );
    expect(() => rayuAccountLabel(env)).not.toThrow();
  });
});
