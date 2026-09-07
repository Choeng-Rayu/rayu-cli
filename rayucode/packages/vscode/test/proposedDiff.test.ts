/**
 * Proposed-edit diff — UI_PARITY.md flow 11.
 *
 * The properties worth pinning are the ones a reviewer relies on:
 *  - the right-hand side is served from MEMORY, so a preview leaves no temp file
 *    behind and cannot be mistaken for a real file by anything scanning the tree;
 *  - it is READ-ONLY by construction (a custom scheme has no save target), so a
 *    user cannot "fix" the proposal in the diff and believe it will be applied;
 *  - two proposals for the same file stay distinct;
 *  - opening a diff decides nothing.
 */
import { describe, expect, it, vi } from "vitest";

import {
  PROPOSED_SCHEME,
  ProposedEditContentProvider,
  showProposedDiff,
} from "../src/proposedDiff.js";

describe("the proposed content is served from memory", () => {
  it("returns the content registered for a key", () => {
    const provider = new ProposedEditContentProvider();
    const uri = provider.register("req-1:0", "the new content", "file.ts");
    expect(uri.scheme).toBe(PROPOSED_SCHEME);
    expect(provider.provideTextDocumentContent(uri)).toBe("the new content");
  });

  it("puts the file name in the path so the editor tab is readable", () => {
    const provider = new ProposedEditContentProvider();
    const uri = provider.register("req-1:0", "x", "sessionManager.ts");
    expect(uri.path).toContain("sessionManager.ts");
  });

  it("keeps two proposals for the same file distinct", () => {
    // Same file name, different requests — a shared key would make the second
    // preview show the first proposal's content.
    const provider = new ProposedEditContentProvider();
    const first = provider.register("req-1:0", "first", "same.ts");
    const second = provider.register("req-2:0", "second", "same.ts");
    expect(provider.provideTextDocumentContent(first)).toBe("first");
    expect(provider.provideTextDocumentContent(second)).toBe("second");
  });

  it("keeps multiple files within one request distinct", () => {
    const provider = new ProposedEditContentProvider();
    const a = provider.register("req-1:0", "a", "a.ts");
    const b = provider.register("req-1:1", "b", "b.ts");
    expect(provider.provideTextDocumentContent(a)).toBe("a");
    expect(provider.provideTextDocumentContent(b)).toBe("b");
  });

  it("returns empty rather than throwing for an unknown URI", () => {
    // VS Code can re-request content after a release (a restored editor, say).
    // Throwing there surfaces an error for something the user did not do.
    const provider = new ProposedEditContentProvider();
    const uri = provider.register("req-1:0", "x", "f.ts");
    provider.release("req-1:0");
    expect(provider.provideTextDocumentContent(uri)).toBe("");
  });

  it("releases content so a long session does not accumulate proposals", () => {
    const provider = new ProposedEditContentProvider();
    const uri = provider.register("req-1:0", "big", "f.ts");
    expect(provider.provideTextDocumentContent(uri)).toBe("big");
    provider.release("req-1:0");
    expect(provider.provideTextDocumentContent(uri)).toBe("");
  });
});

describe("showProposedDiff picks the right presentation", () => {
  it("diffs a modification against the file on disk", async () => {
    const provider = new ProposedEditContentProvider();
    const vscode = await import("vscode");
    const executeCommand = vi.spyOn(vscode.commands, "executeCommand");

    await showProposedDiff(
      provider,
      vscode.Uri.file("/workspace"),
      "req-1",
      { path: "src/a.ts", kind: "modify", newContent: "after" },
      0,
    );

    const call = executeCommand.mock.calls.find((c) => c[0] === "vscode.diff");
    expect(call, "a modification must open the diff editor").toBeDefined();
    // Left is the real file, right is the in-memory proposal.
    expect(String(call?.[1]).includes("src/a.ts")).toBe(true);
    expect(String(call?.[2]).startsWith(PROPOSED_SCHEME)).toBe(true);
    executeCommand.mockRestore();
  });

  it("shows a new file plainly instead of diffing it against nothing", async () => {
    // Diffing a create renders every line as an addition, which tells the reader
    // nothing they did not get from "this file is new".
    const provider = new ProposedEditContentProvider();
    const vscode = await import("vscode");
    const executeCommand = vi.spyOn(vscode.commands, "executeCommand");
    const showTextDocument = vi.spyOn(vscode.window, "showTextDocument");

    await showProposedDiff(
      provider,
      vscode.Uri.file("/workspace"),
      "req-1",
      { path: "src/new.ts", kind: "create", newContent: "brand new" },
      0,
    );

    expect(executeCommand.mock.calls.some((c) => c[0] === "vscode.diff")).toBe(false);
    expect(showTextDocument).toHaveBeenCalled();
    executeCommand.mockRestore();
    showTextDocument.mockRestore();
  });

  it("shows the proposal alone when there is no workspace to resolve against", async () => {
    // A relative path needs a root. Guessing one would diff against the wrong file.
    const provider = new ProposedEditContentProvider();
    const vscode = await import("vscode");
    const executeCommand = vi.spyOn(vscode.commands, "executeCommand");
    const showTextDocument = vi.spyOn(vscode.window, "showTextDocument");

    await showProposedDiff(
      provider,
      undefined,
      "req-1",
      { path: "src/a.ts", kind: "modify", newContent: "after" },
      0,
    );

    expect(executeCommand.mock.calls.some((c) => c[0] === "vscode.diff")).toBe(false);
    expect(showTextDocument).toHaveBeenCalled();
    executeCommand.mockRestore();
    showTextDocument.mockRestore();
  });
});
