/**
 * Session history browser — UI_PARITY flow 15.
 *
 * The control protocol cannot enumerate sessions — its 23 request subtypes cover
 * initialize, permissions, MCP, models, settings and interrupts, with no "list
 * sessions" — and the CLI's `/resume` is `local-jsx` so it cannot run headlessly. The
 * panel therefore reads `~/.rayu/projects/<sanitised-cwd>/<uuid>.jsonl` directly, the
 * same files the CLI reads.
 *
 * These tests exercise the real reader against real files in a temp RAYU config home,
 * because the value of this flow is entirely in whether it can find and read what the
 * engine actually wrote.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionAge, sessionLabel, type SessionSummary } from "../src/sessionHistory.js";

describe("session labels", () => {
  const base: SessionSummary = {
    sessionId: "id",
    firstPrompt: "Fix the parser",
    modifiedAt: 0,
    sizeBytes: 10,
  };

  it("uses the first prompt as the title", () => {
    expect(sessionLabel(base)).toBe("Fix the parser");
  });

  it("collapses a multi-line prompt to one line", () => {
    // A pasted prompt would otherwise make one entry taller than the picker.
    expect(sessionLabel({ ...base, firstPrompt: "line one\n\nline two" })).toBe(
      "line one line two",
    );
  });

  it("truncates a long prompt", () => {
    const label = sessionLabel({ ...base, firstPrompt: "x".repeat(200) });
    expect(label.length).toBeLessThanOrEqual(72);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("session age", () => {
  const at = (msAgo: number): SessionSummary => ({
    sessionId: "id",
    firstPrompt: "p",
    modifiedAt: 1_000_000_000_000 - msAgo,
    sizeBytes: 1,
  });
  const now = 1_000_000_000_000;

  it("reads as a relative age, which is what people remember", () => {
    expect(sessionAge(at(5_000), now)).toBe("just now");
    expect(sessionAge(at(120_000), now)).toBe("2 minutes ago");
    expect(sessionAge(at(3 * 3_600_000), now)).toBe("3 hours ago");
    expect(sessionAge(at(2 * 86_400_000), now)).toBe("2 days ago");
    expect(sessionAge(at(60 * 86_400_000), now)).toBe("2 months ago");
  });

  it("uses the singular correctly", () => {
    expect(sessionAge(at(60_000), now)).toBe("1 minute ago");
    expect(sessionAge(at(3_600_000), now)).toBe("1 hour ago");
  });

  it("never reports a negative age from clock skew", () => {
    expect(sessionAge(at(-10_000), now)).toBe("just now");
  });
});

describe("reading real transcript files", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rayu-history-"));
    process.env["RAYU_CONFIG_DIR"] = home;
  });

  afterEach(() => {
    delete process.env["RAYU_CONFIG_DIR"];
    rmSync(home, { recursive: true, force: true });
  });

  it("returns an empty list when nothing has run in the workspace", async () => {
    // Normal for a new workspace; it must not be an error.
    const { listSessions } = await import("../src/sessionHistory.js");
    expect(await listSessions("/nonexistent/workspace")).toEqual([]);
  });

  it("finds sessions, newest first, and skips non-session files", async () => {
    const { listSessions } = await import("../src/sessionHistory.js");
    const { getProjectDir } = await import("@rayu-dev/rayu-cli/lib");
    const workspace = "/tmp/some-workspace";
    const dir = getProjectDir(workspace);
    mkdirSync(dir, { recursive: true });

    const older = "11111111-1111-4111-8111-111111111111";
    const newer = "22222222-2222-4222-8222-222222222222";
    const line = (text: string) =>
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: text },
      })}\n`;
    writeFileSync(join(dir, `${older}.jsonl`), line("the older prompt"));
    writeFileSync(join(dir, `${newer}.jsonl`), line("the newer prompt"));
    // Neither of these is a resumable session.
    writeFileSync(join(dir, "not-a-uuid.jsonl"), line("ignored"));
    writeFileSync(join(dir, `${older}.txt`), "ignored");
    // An empty transcript would restore a blank conversation.
    writeFileSync(join(dir, `33333333-3333-4333-8333-333333333333.jsonl`), "");

    const sessions = await listSessions(workspace);
    const ids = sessions.map((s) => s.sessionId);
    expect(ids).toContain(older);
    expect(ids).toContain(newer);
    expect(ids).toHaveLength(2);
    // Newest first.
    expect(sessions[0]?.modifiedAt).toBeGreaterThanOrEqual(
      sessions[1]?.modifiedAt ?? 0,
    );
  });

  it("respects the limit", async () => {
    const { listSessions } = await import("../src/sessionHistory.js");
    const { getProjectDir } = await import("@rayu-dev/rayu-cli/lib");
    const workspace = "/tmp/limited-workspace";
    const dir = getProjectDir(workspace);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(
        join(dir, `4444444${i}-4444-4444-8444-444444444444.jsonl`),
        `${JSON.stringify({ type: "user", message: { role: "user", content: `p${i}` } })}\n`,
      );
    }
    expect(await listSessions(workspace, 2)).toHaveLength(2);
  });
});
