import { beforeEach, describe, expect, it } from "vitest";

import {
  EXPLAIN_COMMAND,
  FIX_COMMAND,
  INTENT_INSTRUCTIONS,
  REVIEW_COMMAND,
  RayucodeActionProvider,
  buildIntentReference,
  resolveIntentTarget,
} from "../src/codeActions.js";
import { Range, Uri, recorder, resetVscodeStub } from "./stubs/vscode.js";

// Selection code actions (R9.5 staging semantics).
//
// Each action stages a framed prompt rather than submitting it, so the user can
// refine the request before spending a turn. These tests pin: no actions on an
// empty selection, the three intents in order, the exact staged text (instruction
// + path:line-range + language-tagged fence), and the range-vs-selection
// resolution the commands use.

type Document = import("vscode").TextDocument;
type TextRange = import("vscode").Range;

/** A stand-in TextDocument exposing only what the provider/commands read. */
function makeDocument(path: string, languageId = "typescript"): Document {
  return {
    uri: Uri.file(path),
    languageId,
    getText: () => "selected text",
  } as unknown as Document;
}

/** A stand-in TextEditor with a fixed document + selection. */
function makeEditor(document: Document, selection: TextRange) {
  return { document, selection } as unknown as import("vscode").TextEditor;
}

beforeEach(() => {
  resetVscodeStub();
});

// ---------------------------------------------------------------------------
// provideCodeActions
// ---------------------------------------------------------------------------

describe("RayucodeActionProvider.provideCodeActions", () => {
  const provider = new RayucodeActionProvider();
  const document = makeDocument("/w/src/a.ts");

  it("returns no actions for an empty selection (nothing to ask about)", () => {
    const empty = new Range(3, 5, 3, 5) as unknown as TextRange;

    expect(provider.provideCodeActions(document, empty)).toEqual([]);
  });

  it("offers Explain, Fix and Review in that order for a non-empty selection", () => {
    const range = new Range(1, 0, 4, 10) as unknown as TextRange;

    const actions = provider.provideCodeActions(document, range);

    expect(actions.map((action) => action.title)).toEqual([
      "Rayucode: Explain selection",
      "Rayucode: Fix selection",
      "Rayucode: Review selection",
    ]);
    expect(actions.map((action) => action.command?.command)).toEqual([
      EXPLAIN_COMMAND,
      FIX_COMMAND,
      REVIEW_COMMAND,
    ]);
  });

  it("passes the document uri and range as command arguments", () => {
    const range = new Range(2, 0, 6, 3) as unknown as TextRange;

    const [explain] = provider.provideCodeActions(document, range);

    // Passed explicitly because the user's selection may move before the command
    // runs, or the lightbulb may target a different range.
    expect(explain?.command?.arguments).toEqual([document.uri, range]);
  });

  it("advertises its code action kinds so VS Code can filter without invoking it", () => {
    expect(RayucodeActionProvider.providedCodeActionKinds.length).toBeGreaterThan(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// buildIntentReference
// ---------------------------------------------------------------------------

describe("buildIntentReference", () => {
  it("prefixes the intent instruction, then cites path:line-range in a fence", () => {
    const reference = buildIntentReference(
      "explain",
      "/w/src/a.ts",
      10,
      14,
      "const x = 1;",
      "typescript",
    );

    expect(reference.startsWith(INTENT_INSTRUCTIONS.explain)).toBe(true);
    expect(reference).toContain("/w/src/a.ts:10-14");
    expect(reference).toContain("```typescript\nconst x = 1;\n```");
  });

  it("collapses a single-line range to one number", () => {
    const reference = buildIntentReference(
      "fix",
      "/w/a.py",
      7,
      7,
      "pass",
      "python",
    );

    expect(reference).toContain("/w/a.py:7\n");
    expect(reference).not.toContain("7-7");
  });

  it("uses an untagged fence when the language is unknown or plaintext", () => {
    expect(
      buildIntentReference("review", "/w/notes.txt", 1, 2, "x", "plaintext"),
    ).toContain("```\nx\n```");
    expect(buildIntentReference("review", "/w/notes", 1, 2, "x")).toContain(
      "```\nx\n```",
    );
  });

  it("uses a distinct instruction per intent", () => {
    const instructions = new Set([
      INTENT_INSTRUCTIONS.explain,
      INTENT_INSTRUCTIONS.fix,
      INTENT_INSTRUCTIONS.review,
    ]);

    expect(instructions.size).toBe(3);
    expect(INTENT_INSTRUCTIONS.fix.toLowerCase()).toContain("fix");
    expect(INTENT_INSTRUCTIONS.review.toLowerCase()).toContain("review");
  });
});

// ---------------------------------------------------------------------------
// resolveIntentTarget
// ---------------------------------------------------------------------------

describe("resolveIntentTarget", () => {
  it("prefers the explicit range from a code action over the live selection", () => {
    const document = makeDocument("/w/src/a.ts");
    const selection = new Range(0, 0, 0, 1) as unknown as TextRange;
    const editor = makeEditor(document, selection);
    const explicit = new Range(5, 0, 9, 4) as unknown as TextRange;

    const target = resolveIntentTarget(undefined, explicit, editor);

    expect(target?.range).toBe(explicit);
    expect(target?.document).toBe(document);
  });

  it("falls back to the active editor's selection when no range is given", () => {
    const document = makeDocument("/w/src/a.ts");
    const selection = new Range(2, 0, 3, 8) as unknown as TextRange;
    const editor = makeEditor(document, selection);

    const target = resolveIntentTarget(undefined, undefined, editor);

    expect(target?.range).toBe(selection);
  });

  it("matches the uri against the visible editors before the active one", () => {
    const active = makeDocument("/w/src/active.ts");
    const other = makeDocument("/w/src/other.ts");
    const activeEditor = makeEditor(
      active,
      new Range(0, 0, 0, 3) as unknown as TextRange,
    );
    const otherEditor = makeEditor(
      other,
      new Range(4, 0, 4, 9) as unknown as TextRange,
    );
    recorder.visibleTextEditors = [activeEditor, otherEditor];

    const target = resolveIntentTarget(other.uri, undefined, activeEditor);

    // The action was raised in `other`, so that document must be used.
    expect(target?.document).toBe(other);
    expect(target?.range).toBe(otherEditor.selection);
  });

  it("returns null when nothing is selected (the command is a no-op)", () => {
    const document = makeDocument("/w/src/a.ts");
    const empty = new Range(1, 1, 1, 1) as unknown as TextRange;

    expect(resolveIntentTarget(undefined, undefined, makeEditor(document, empty)))
      .toBeNull();
    expect(resolveIntentTarget(undefined, empty, makeEditor(document, empty)))
      .toBeNull();
  });

  it("returns null when there is no editor at all", () => {
    expect(resolveIntentTarget(undefined, undefined, undefined)).toBeNull();
  });
});
