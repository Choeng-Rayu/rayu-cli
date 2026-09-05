// Rayucode code actions & editor context menu.
//
// Turns "I want the agent to look at THIS" into one gesture. Selecting code and
// hitting the lightbulb (or right-clicking) offers Explain / Fix / Review, each of
// which stages the selection — framed by the matching instruction — into the
// Agent_Panel prompt input and reveals the panel.
//
// Deliberately, the action STAGES the prompt rather than submitting it: the user
// can add detail, or notice they selected the wrong range, before spending a turn.
// That mirrors the existing `rayucode.addSelectionToPrompt` behavior (R9.5).
//
// The provider itself contributes no editing logic — each action is a thin
// `vscode.CodeAction` carrying a `command`, so the same commands back both the
// lightbulb and the `editor/context` menu entries declared in the manifest.

import * as vscode from "vscode";

/** Command ids for the three selection intents (declared in the manifest). */
export const EXPLAIN_COMMAND = "rayucode.explainSelection";
export const FIX_COMMAND = "rayucode.fixSelection";
export const REVIEW_COMMAND = "rayucode.reviewSelection";

/** The intents a selection can be sent with. */
export type SelectionIntent = "explain" | "fix" | "review";

/** Instruction prepended to the staged prompt for each intent. */
export const INTENT_INSTRUCTIONS: Record<SelectionIntent, string> = {
  explain:
    "Explain this code: what it does, how it works, and anything surprising about it.",
  fix: "Find and fix the bugs in this code. Explain each fix you make.",
  review:
    "Review this code for correctness, security, performance, and readability issues.",
};

/** Lightbulb / context-menu title for each intent. */
const INTENT_TITLES: Record<SelectionIntent, string> = {
  explain: "Rayucode: Explain selection",
  fix: "Rayucode: Fix selection",
  review: "Rayucode: Review selection",
};

/** Command id for each intent. */
const INTENT_COMMANDS: Record<SelectionIntent, string> = {
  explain: EXPLAIN_COMMAND,
  fix: FIX_COMMAND,
  review: REVIEW_COMMAND,
};

/** The order actions appear in the lightbulb. */
const INTENT_ORDER: readonly SelectionIntent[] = ["explain", "fix", "review"];

/**
 * Offers the Rayucode selection actions on any non-empty selection.
 *
 * Registered for `{ scheme: 'file' }` documents of every language — the agent is
 * language-agnostic, so restricting the selector would only hide the feature.
 * With an EMPTY range no actions are returned, since there would be nothing to
 * send.
 */
export class RayucodeActionProvider implements vscode.CodeActionProvider {
  /** Advertised so VS Code can filter the lightbulb without invoking us. */
  static readonly providedCodeActionKinds: readonly vscode.CodeActionKind[] = [
    vscode.CodeActionKind.Empty,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] {
    if (range.isEmpty) {
      // Nothing selected ⇒ nothing to ask about.
      return [];
    }

    return INTENT_ORDER.map((intent) => {
      const action = new vscode.CodeAction(
        INTENT_TITLES[intent],
        vscode.CodeActionKind.Empty,
      );
      action.command = {
        command: INTENT_COMMANDS[intent],
        title: INTENT_TITLES[intent],
        // Pass the range explicitly: by the time the command runs the user's
        // selection may have moved (or the lightbulb may have been invoked from
        // a different range than the current selection).
        arguments: [document.uri, range],
      };
      return action;
    });
  }
}

/**
 * Build the prompt reference staged into the panel input for a selection intent.
 *
 * Shape: the instruction, then the file path + 1-based line range, then the
 * selected text in a fenced block tagged with the document's language id (so the
 * agent — and the panel's Markdown renderer — get syntax context).
 *
 * Pure and exported so the exact staged text is unit-testable.
 */
export function buildIntentReference(
  intent: SelectionIntent,
  filePath: string,
  startLine: number,
  endLine: number,
  selectedText: string,
  languageId?: string,
): string {
  const range = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
  const fence = languageId && languageId !== "plaintext" ? languageId : "";
  return `${INTENT_INSTRUCTIONS[intent]}\n\n${filePath}:${range}\n\`\`\`${fence}\n${selectedText}\n\`\`\`\n`;
}

/**
 * Resolve the range an intent command should act on: the explicit range passed by
 * a code action, else the active editor's current selection. Returns `null` when
 * there is nothing selected — the command is then a no-op (matching R9.5).
 */
export function resolveIntentTarget(
  uri: vscode.Uri | undefined,
  range: vscode.Range | undefined,
  activeEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): { document: vscode.TextDocument; range: vscode.Range } | null {
  // Prefer the editor whose document matches the action's uri; the code action
  // may have been raised in a different editor than the currently focused one.
  const editor =
    uri !== undefined
      ? (vscode.window.visibleTextEditors.find(
          (candidate) => candidate.document.uri.toString() === uri.toString(),
        ) ?? activeEditor)
      : activeEditor;

  if (!editor) {
    return null;
  }

  const target = range ?? editor.selection;
  if (target.isEmpty) {
    return null;
  }
  return { document: editor.document, range: target };
}
