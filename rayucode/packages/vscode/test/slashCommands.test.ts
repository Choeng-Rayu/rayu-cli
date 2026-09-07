/**
 * Task 17 — slash commands execute for real instead of being described in prose.
 *
 * The old behaviour: four commands hardcoded in `SLASH_COMMAND_INSTRUCTIONS`, each
 * prepending an English sentence and hoping the model complied, against ~98 real
 * commands in the engine's registry.
 *
 * The correction, and why it is not a straight swap: of the four commands VS Code
 * declares in package.json, only `review` exists in the engine. `explain`, `fix`
 * and `test` have no counterpart, so dispatching `/explain` would send the engine
 * an unknown command. The decision is therefore made against the list the engine
 * ANNOUNCES at runtime, not a hardcoded table — which also means the behaviour
 * self-corrects as the engine's registry changes.
 */
import { describe, expect, it } from "vitest";

import { buildPrompt } from "../src/chatParticipant.js";

/** A realistic slice of what the engine announces in `system/init`. */
const ANNOUNCED = ["review", "commit", "compact", "context", "cost", "help"];

describe("a command the engine owns is dispatched, not narrated", () => {
  it("sends /review with the user's text appended", () => {
    expect(buildPrompt({ prompt: "this function", command: "review" }, ANNOUNCED)).toBe(
      "/review this function",
    );
  });

  it("sends a bare /command when there is no extra text", () => {
    expect(buildPrompt({ prompt: "", command: "compact" }, ANNOUNCED)).toBe("/compact");
    expect(buildPrompt({ prompt: "   ", command: "cost" }, ANNOUNCED)).toBe("/cost");
  });

  it("does NOT prepend an English instruction for an engine command", () => {
    // The whole point: the engine executes its own command.
    const out = buildPrompt({ prompt: "x", command: "review" }, ANNOUNCED);
    expect(out).not.toContain("Review the following code");
    expect(out.startsWith("/review")).toBe(true);
  });

  it("accepts an announcement that already includes the leading slash", () => {
    // The engine announces bare names today, but a future format change to
    // "/review" must not silently fall back to prose.
    expect(buildPrompt({ prompt: "y", command: "review" }, ["/review"])).toBe("/review y");
  });
});

describe("a command the engine does NOT have still uses a prompt template", () => {
  it("explain, fix and test fall back to their instruction", () => {
    for (const command of ["explain", "fix", "test"]) {
      const out = buildPrompt({ prompt: "the code", command }, ANNOUNCED);
      expect(out, command).not.toContain(`/${command}`);
      expect(out, command).toContain("the code");
      // The template is present, i.e. the fallback really fired.
      expect(out.length, command).toBeGreaterThan("the code".length);
    }
  });

  it("review no longer has a hardcoded template, because the engine owns it", () => {
    // With nothing announced, review has neither a template nor a dispatch, so
    // only the user's text survives. That is the correct outcome: an engine that
    // does not announce `review` cannot run it.
    expect(buildPrompt({ prompt: "the code", command: "review" }, [])).toBe("the code");
  });

  it("an unknown command is ignored rather than invented", () => {
    expect(buildPrompt({ prompt: "hello", command: "notacommand" }, ANNOUNCED)).toBe(
      "hello",
    );
  });
});

describe("behaviour preserved from before Task 17", () => {
  it("no command at all just passes the text through", () => {
    expect(buildPrompt({ prompt: "hello" }, ANNOUNCED)).toBe("hello");
  });

  it("an empty request still produces something actionable", () => {
    expect(buildPrompt({ prompt: "" }, ANNOUNCED)).toBe(
      "Describe what you can help with in this workspace.",
    );
  });

  it("attached references are appended for engine and template commands alike", () => {
    const references = [
      { id: "vscode.file", value: { fsPath: "/w/a.ts", path: "/w/a.ts", scheme: "file" } },
    ];
    const dispatched = buildPrompt({ prompt: "x", command: "review", references }, ANNOUNCED);
    expect(dispatched).toContain("<attached-context>");
    expect(dispatched.startsWith("/review x")).toBe(true);

    const templated = buildPrompt({ prompt: "x", command: "fix", references }, ANNOUNCED);
    expect(templated).toContain("<attached-context>");
  });

  it("defaults to template-only when no announcement is supplied", () => {
    // Backwards compatible: the parameter is optional, so an old call site keeps
    // the previous behaviour instead of silently losing its command.
    const out = buildPrompt({ prompt: "the code", command: "fix" });
    expect(out).toContain("the code");
    expect(out).not.toContain("/fix");
  });
});
