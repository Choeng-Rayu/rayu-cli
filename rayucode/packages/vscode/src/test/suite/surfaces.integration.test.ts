// Extension-host integration tests for the V1 surfaces — Activity Bar view,
// status bar, code actions, chat participant, and the adapter's panel-resolver /
// message-tap seams.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ Requires a real VS Code extension host (a display or virtual framebuffer),
// launched by @vscode/test-cli / @vscode/test-electron. Run with:
//
//     npm run test:integration          # in packages/vscode
//
// The vitest run EXCLUDES this directory (vitest.config.ts) and the production
// `tsc` typecheck excludes it too (tsconfig.json); type-check it with
// tsconfig.test.json where @types/mocha is available.
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THESE AND NOT MORE UNIT TESTS
// The vitest suite covers each module's logic against a stubbed `vscode`. What it
// CANNOT prove is that the manifest contributions and the real API line up: that
// the contributed view id is registerable, that `rayucode.panel.focus` genuinely
// exists, that the code action provider is consulted by the real lightbulb
// pipeline, and that `vscode.chat.createChatParticipant` accepts our declared id.
// Each of those fails only inside a live editor, which is exactly what this suite
// provides.

import * as assert from "node:assert/strict";

import * as vscode from "vscode";

import { RayucodeActionProvider } from "../../codeActions.js";
import { PANEL_FOCUS_COMMAND, PANEL_VIEW_ID } from "../../panelViewProvider.js";
import { RayucodeStatusBar } from "../../statusBar.js";
import { VSCodeAdapter } from "../../vscodeAdapter.js";
import { activate, deactivate } from "../../extension.js";
import type { RayucodeExtensionApi } from "../../extension.js";

/**
 * A minimal stand-in ExtensionContext. `extensionUri` points at the PACKAGE root
 * (not the compiled out/ directory) so the webview asset URIs and the icon paths
 * resolve the same way they do in production.
 */
function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [] as vscode.Disposable[],
    extensionUri: vscode.Uri.file(packageRoot()),
  } as unknown as vscode.ExtensionContext;
}

/** The packages/vscode directory (this file compiles to out/test/suite/). */
function packageRoot(): string {
  return vscode.Uri.joinPath(vscode.Uri.file(__dirname), "..", "..", "..")
    .fsPath;
}

function firstWorkspaceFolder(): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "integration tests require an open workspace folder");
  return folder;
}

/** Dispose everything an activation registered. */
function disposeAll(context: vscode.ExtensionContext): void {
  for (const disposable of context.subscriptions.splice(0)) {
    try {
      disposable.dispose();
    } catch {
      /* best-effort cleanup */
    }
  }
}

suite("rayucode V1 surfaces (integration)", () => {
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  // --------------------------------------------------------------------------
  // The published extension, driven through the real workbench
  // --------------------------------------------------------------------------

  suite("published extension", () => {
    test("activates from its manifest and exposes the composed surfaces", async () => {
      const ext = resolveExtensionUnderTest();
      const api = (ext.isActive
        ? ext.exports
        : await ext.activate()) as RayucodeExtensionApi;

      assert.ok(ext.isActive, "the extension should be active");
      assert.ok(api.sessionManager, "expected a composed SessionManager");
      assert.ok(api.panelProvider, "expected the Activity Bar view provider");
      assert.ok(api.statusBar, "expected the status bar item");
    });

    test("revealing the Activity Bar view makes the workbench resolve it and open the session", async () => {
      // Own the activation rather than reusing the published extension's: an
      // earlier suite disposes the real context's subscriptions (to clean up its
      // own adapter), which takes the published view registration with it. A
      // fresh activate() re-registers the contributed view id, so this test does
      // not depend on any other suite's teardown.
      const api = activateExtension();
      try {
        const provider = api.panelProvider;
        assert.ok(provider, "expected the Activity Bar view provider");

        // Replace openSession BEFORE revealing so the reveal never spawns a real
        // `rayu` process; this test is about view resolution, not the agent.
        const opened: string[] = [];
        (
          api.sessionManager as unknown as {
            openSession: (key: string) => Promise<void>;
          }
        ).openSession = async (key) => {
          opened.push(key);
        };

        // The real workbench command synthesized from `contributes.views`.
        await vscode.commands.executeCommand(PANEL_FOCUS_COMMAND);

        // The workbench resolves the view asynchronously. A user-initiated reveal
        // is "path B": the provider starts the workspace session itself, so the
        // recorded key is the observable proof that `resolveWebviewView` ran.
        const sessionKey = firstWorkspaceFolder().uri.fsPath;
        await waitFor(
          async () => opened.length,
          (count) => count > 0,
        );
        assert.deepEqual(
          opened,
          [sessionKey],
          "expected the resolved view to open the workspace session exactly once",
        );

        // With the view bound, the core's showAgentPanel now gets a live handle
        // for this session instead of a floating panel.
        const handle = await provider!.resolveAgentPanel(sessionKey);
        assert.ok(handle, "expected a handle bound to the resolved view");
        assert.equal(handle!.sessionKey, sessionKey);
        assert.equal(
          await handle!.postMessage({
            type: "setGenerating",
            generating: false,
          }),
          true,
          "the resolved surface should be a live message channel",
        );
      } finally {
        await deactivate();
        disposeAll(api.context);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Activity Bar view
  // --------------------------------------------------------------------------

  suite("Activity Bar view", () => {
    test("the contributed view's focus command exists in the real host", async () => {
      // Proves the manifest `contributes.views` entry took effect: VS Code
      // synthesizes `<viewId>.focus` only for a view it actually knows about.
      const commands = await vscode.commands.getCommands(true);
      assert.ok(
        commands.includes(PANEL_FOCUS_COMMAND),
        `expected the host to expose ${PANEL_FOCUS_COMMAND}`,
      );
    });

    test("the view id is registerable as a webview view provider", () => {
      const context = makeContext();
      let registered: vscode.Disposable | undefined;

      // A duplicate/unknown view type throws here, so a clean call is the check.
      assert.doesNotThrow(() => {
        registered = vscode.window.registerWebviewViewProvider(
          `${PANEL_VIEW_ID}.itest`,
          {
            resolveWebviewView: () => {
              /* never resolved in this test */
            },
          },
        );
      });
      registered?.dispose();
      disposeAll(context);
    });
  });

  // --------------------------------------------------------------------------
  // Adapter seams: panel resolver + message tap
  // --------------------------------------------------------------------------

  suite("VSCodeAdapter panel seams", () => {
    test("a registered resolver claims showAgentPanel instead of a floating panel", async () => {
      const context = makeContext();
      const adapter = new VSCodeAdapter(context);
      let asked: string | undefined;
      const sink = {
        sessionKey: "itest-session",
        reveal: () => {},
        postMessage: () => true,
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        onDidDispose: () => ({ dispose: () => {} }),
        dispose: () => {},
      };

      const registration = adapter.registerAgentPanelResolver((key) => {
        asked = key;
        return key === "itest-session" ? sink : null;
      });

      const handle = await adapter.showAgentPanel("itest-session");

      assert.equal(asked, "itest-session");
      assert.equal(handle.sessionKey, "itest-session");
      registration.dispose();
      disposeAll(context);
    });

    test("a resolver that throws falls through to the floating panel", async () => {
      const context = makeContext();
      const adapter = new VSCodeAdapter(context);
      const registration = adapter.registerAgentPanelResolver(() => {
        throw new Error("resolver exploded");
      });

      // A misbehaving resolver must never break panel opening.
      const handle = await adapter.showAgentPanel("itest-fallback");
      assert.equal(handle.sessionKey, "itest-fallback");

      handle.dispose();
      registration.dispose();
      disposeAll(context);
    });

    test("onPanelMessage observes every message posted to any surface", async () => {
      const context = makeContext();
      const adapter = new VSCodeAdapter(context);
      const observed: { key: string; message: unknown }[] = [];
      const posted: unknown[] = [];
      const sink = {
        sessionKey: "itest-tap",
        reveal: () => {},
        postMessage: (message: unknown) => {
          posted.push(message);
          return true;
        },
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        onDidDispose: () => ({ dispose: () => {} }),
        dispose: () => {},
      };
      const resolverReg = adapter.registerAgentPanelResolver((key) =>
        key === "itest-tap" ? sink : null,
      );
      const tapReg = adapter.onPanelMessage((key, message) => {
        observed.push({ key, message });
      });

      const handle = await adapter.showAgentPanel("itest-tap");
      await handle.postMessage({ type: "setGenerating", generating: true });

      assert.equal(observed.length, 1);
      assert.equal(observed[0]?.key, "itest-tap");
      assert.deepEqual(observed[0]?.message, {
        type: "setGenerating",
        generating: true,
      });
      // Observation is passive: the message still reached the panel.
      assert.deepEqual(posted, [{ type: "setGenerating", generating: true }]);

      tapReg.dispose();
      resolverReg.dispose();
      disposeAll(context);
    });

    test("logging after the output channel is disposed does not throw", () => {
      const context = makeContext();
      const adapter = new VSCodeAdapter(context);

      // Simulates deactivate (or a test teardown) closing the channel while a
      // timer / in-flight promise can still reach the log sink.
      disposeAll(context);

      // A diagnostic sink must never throw into its caller.
      assert.doesNotThrow(() => {
        adapter.log("error", "late log after channel disposal");
        adapter.log("lifecycle", "and another");
      });
    });

    test("an observer that throws does not break the panel channel", async () => {
      const context = makeContext();
      const adapter = new VSCodeAdapter(context);
      const posted: unknown[] = [];
      const sink = {
        sessionKey: "itest-throw",
        reveal: () => {},
        postMessage: (message: unknown) => {
          posted.push(message);
          return true;
        },
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        onDidDispose: () => ({ dispose: () => {} }),
        dispose: () => {},
      };
      const resolverReg = adapter.registerAgentPanelResolver((key) =>
        key === "itest-throw" ? sink : null,
      );
      const tapReg = adapter.onPanelMessage(() => {
        throw new Error("observer exploded");
      });

      const handle = await adapter.showAgentPanel("itest-throw");
      await handle.postMessage({ type: "showError", message: "x" });

      assert.deepEqual(posted, [{ type: "showError", message: "x" }]);

      tapReg.dispose();
      resolverReg.dispose();
      disposeAll(context);
    });
  });

  // --------------------------------------------------------------------------
  // Status bar
  // --------------------------------------------------------------------------

  suite("status bar", () => {
    test("renders idle/generating states against the real StatusBarItem API", () => {
      const context = makeContext();
      const statusBar = new RayucodeStatusBar(context);

      assert.equal(statusBar.currentState, "idle");
      assert.equal(statusBar.text, "$(sparkle) Rayu");

      statusBar.setGenerating();
      assert.equal(statusBar.currentState, "generating");
      assert.match(statusBar.text, /sync~spin/);

      statusBar.setIdle();
      assert.equal(statusBar.currentState, "idle");

      statusBar.dispose();
      disposeAll(context);
    });

    test("its click targets are commands the host actually knows", async () => {
      // Activate explicitly: a status bar item pointing at an unregistered
      // command silently does nothing, and relying on the host having already
      // auto-activated the dev extension would make this order-dependent.
      const api = activateExtension();
      try {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(
          commands.includes("rayucode.openPanel"),
          "the idle click target must be a registered command",
        );
        assert.ok(
          commands.includes("rayucode.interrupt"),
          "the generating click target must be a registered command",
        );
      } finally {
        await deactivate();
        disposeAll(api.context);
      }
    });

    test("tracks generating state end-to-end through the adapter tap", async () => {
      const context = makeContext();
      const adapter = new VSCodeAdapter(context);
      const statusBar = new RayucodeStatusBar(context);
      const sink = {
        sessionKey: "itest-status",
        reveal: () => {},
        postMessage: () => true,
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        onDidDispose: () => ({ dispose: () => {} }),
        dispose: () => {},
      };
      const resolverReg = adapter.registerAgentPanelResolver((key) =>
        key === "itest-status" ? sink : null,
      );
      const tapReg = adapter.onPanelMessage((_key, message) => {
        statusBar.handlePanelMessage(message);
      });

      const handle = await adapter.showAgentPanel("itest-status");
      await handle.postMessage({ type: "setGenerating", generating: true });
      assert.equal(statusBar.currentState, "generating");

      await handle.postMessage({ type: "setGenerating", generating: false });
      assert.equal(statusBar.currentState, "idle");

      tapReg.dispose();
      resolverReg.dispose();
      statusBar.dispose();
      disposeAll(context);
    });
  });

  // --------------------------------------------------------------------------
  // Code actions
  // --------------------------------------------------------------------------

  suite("code actions", () => {
    test("the real lightbulb pipeline surfaces the three intents for a selection", async () => {
      const folder = firstWorkspaceFolder();
      const fileUri = vscode.Uri.joinPath(folder.uri, "sample.ts");
      const document = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(document);

      const registration = vscode.languages.registerCodeActionsProvider(
        { scheme: "file" },
        new RayucodeActionProvider(),
        {
          providedCodeActionKinds: [
            ...RayucodeActionProvider.providedCodeActionKinds,
          ],
        },
      );

      try {
        const range = new vscode.Range(
          new vscode.Position(0, 0),
          new vscode.Position(3, 10),
        );
        // Goes through the host's real code-action resolution, which merges every
        // registered provider.
        const actions = await executeCodeActionProvider(fileUri, range);

        const titles = (actions ?? []).map((action) => action.title);
        for (const expected of [
          "Rayucode: Explain selection",
          "Rayucode: Fix selection",
          "Rayucode: Review selection",
        ]) {
          assert.ok(
            titles.includes(expected),
            `expected the lightbulb to offer "${expected}", got: ${titles.join(", ")}`,
          );
        }
      } finally {
        registration.dispose();
      }
    });

    test("offers nothing for an empty range", async () => {
      const folder = firstWorkspaceFolder();
      const fileUri = vscode.Uri.joinPath(folder.uri, "sample.ts");
      const document = await vscode.workspace.openTextDocument(fileUri);

      const provider = new RayucodeActionProvider();
      const empty = new vscode.Range(
        new vscode.Position(1, 4),
        new vscode.Position(1, 4),
      );

      assert.deepEqual(provider.provideCodeActions(document, empty), []);
    });

    test("every intent command is registered by activation", async () => {
      const api = activateExtension();
      try {
        const commands = await vscode.commands.getCommands(true);
        for (const command of [
          "rayucode.explainSelection",
          "rayucode.fixSelection",
          "rayucode.reviewSelection",
        ]) {
          assert.ok(
            commands.includes(command),
            `${command} should be registered`,
          );
        }
      } finally {
        await deactivate();
        disposeAll(api.context);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Chat participant
  // --------------------------------------------------------------------------

  suite("chat participant", () => {
    test("the host exposes the chat API this build targets", () => {
      // engines.vscode is ^1.100.0, where `vscode.chat` is stable.
      assert.equal(
        typeof vscode.chat?.createChatParticipant,
        "function",
        "expected a host with the stable chat participant API",
      );
    });

    test("activation registers @rayucode without disturbing the other surfaces", async () => {
      const api = activateExtension();
      try {
        // The chat participant is registered on a best-effort basis, so the
        // observable guarantee is that activation completed and still produced
        // the rest of the composition.
        assert.ok(api.sessionManager, "expected a composed SessionManager");
        assert.ok(api.statusBar, "expected a status bar item");
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes("rayucode.openPanel"));
      } finally {
        await deactivate();
        disposeAll(api.context);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Activation composition
  // --------------------------------------------------------------------------

  suite("activation composition", () => {
    test("activate wires the panel provider, status bar and commands together", async () => {
      const api = activateExtension();
      try {
        assert.ok(api.panelProvider, "expected the Activity Bar view provider");
        assert.ok(api.statusBar, "expected the status bar item");
        assert.equal(api.statusBar?.currentState, "idle");

        const commands = await vscode.commands.getCommands(true);
        for (const command of [
          "rayucode.openPanel",
          "rayucode.addSelectionToPrompt",
          "rayucode.interrupt",
          "rayucode.newSession",
        ]) {
          assert.ok(
            commands.includes(command),
            `${command} should be registered`,
          );
        }
      } finally {
        await deactivate();
        disposeAll(api.context);
      }
    });

    test("activation seeds the redaction filter so it is not dead code (R15.5)", () => {
      // The bug this guards: `new SessionManager({ adapter })` with no `redactor`
      // falls back to an EMPTY Redactor, whose `hasSecrets` is false, so
      // `redactDeep` returns early and every credential echoed by a tool is
      // rendered verbatim into the panel and written to the log channel.
      const key = "sk-ant-api03-ITEST-KEY-1234567890abcdef";
      const previous = process.env["ANTHROPIC_API_KEY"];
      process.env["ANTHROPIC_API_KEY"] = key;

      let api: RayucodeExtensionApi | undefined;
      try {
        api = activateExtension();
        const manager = api.sessionManager as unknown as {
          redactDeep<T>(value: T): T;
        };

        // The shape a `Bash` tool running `env` would produce.
        const redacted = manager.redactDeep({
          type: "showToolAction",
          item: { output: `ANTHROPIC_API_KEY=${key}` },
        });

        const serialized = JSON.stringify(redacted);
        assert.ok(
          !serialized.includes(key),
          "the credential must not survive the redaction filter",
        );
        assert.ok(
          serialized.includes("[REDACTED]"),
          "the credential should have been replaced by the placeholder",
        );
      } finally {
        if (previous === undefined) {
          delete process.env["ANTHROPIC_API_KEY"];
        } else {
          process.env["ANTHROPIC_API_KEY"] = previous;
        }
        if (api) {
          disposeAll(api.context);
        }
      }
    });

    test("interrupt with no live session is a silent no-op", async () => {
      const api = activateExtension();
      try {
        // Reachable from the palette and from a status bar click before any
        // session exists; it must not throw or report an error.
        await assert.doesNotReject(
          Promise.resolve(
            vscode.commands.executeCommand("rayucode.interrupt"),
          ),
        );
      } finally {
        await deactivate();
        disposeAll(api.context);
      }
    });

    test("the panel provider declines the chat participant's session key", async () => {
      const api = activateExtension();
      try {
        const provider = api.panelProvider;
        assert.ok(provider);
        // The chat session must never be bound to the sidebar view, or the two
        // conversations would interleave into one surface.
        assert.equal(
          await provider!.resolveAgentPanel(
            `chat:${firstWorkspaceFolder().uri.fsPath}`,
          ),
          null,
        );
      } finally {
        await deactivate();
        disposeAll(api.context);
      }
    });
  });

});

/**
 * The extension under test, loaded by the harness from
 * `extensionDevelopmentPath` (the package root).
 */
function resolveExtensionUnderTest(): vscode.Extension<unknown> {
  const ext =
    vscode.extensions.getExtension("rayu-dev.rayucode") ??
    vscode.extensions.all.find(
      (candidate) =>
        candidate.id.endsWith(".rayucode") ||
        (candidate.packageJSON as { name?: string } | undefined)?.name ===
          "rayucode",
    );
  assert.ok(ext, "expected the rayucode extension to be loaded by the host");
  return ext!;
}

/** Poll `produce` until `accept` is satisfied or the deadline elapses. */
async function waitFor<T>(
  produce: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await produce();
  while (!accept(value) && Date.now() < deadline) {
    await delay(100);
    value = await produce();
  }
  return value;
}

/** Activate with a fresh controlled context; returns the public API object. */
function activateExtension(): RayucodeExtensionApi {
  return activate(makeContext());
}

/**
 * Run the host's aggregate code-action resolution, retrying a transient
 * cancellation.
 *
 * `vscode.executeCodeActionProvider` fans out to EVERY registered provider
 * (including the built-in language services). The host cancels the whole batch if
 * a slower provider is still warming up or a newer request supersedes this one,
 * which surfaces as a `Canceled` rejection unrelated to the provider under test.
 * Only that cancellation is retried — a resolved-but-wrong result still fails the
 * caller's assertion.
 */
async function executeCodeActionProvider(
  uri: vscode.Uri,
  range: vscode.Range,
  attempts = 5,
): Promise<vscode.CodeAction[] | undefined> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider",
        uri,
        range,
      );
    } catch (error) {
      if (!isCanceled(error)) {
        throw error;
      }
      lastError = error;
      await delay(250);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "code action resolution kept cancelling"));
}

function isCanceled(error: unknown): boolean {
  const name = (error as { name?: unknown } | undefined)?.name;
  const message = (error as { message?: unknown } | undefined)?.message;
  return (
    name === "Canceled" ||
    name === "CodeExpectedError" ||
    (typeof message === "string" && /^cancell?ed$/i.test(message.trim()))
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
