// rayucode VS Code extension — host entry point (VSCode_Host).
//
// Activation wiring (task 14.2): on activate we construct the VS Code-specific
// EditorAdapter, inject it into the editor-agnostic core SessionManager, and
// register the contributed commands (declared by the manifest, task 14.1) so
// they are invocable from the command palette (R14.4). On deactivate we tear
// every spawned agent process down (R2.7).
//
// V1 additionally composes the surfaces around that core:
//
//   • RayucodePanelProvider — the Agent_Panel as a persistent Activity Bar view,
//     plugged into the adapter's panel-resolver chain so `showAgentPanel` binds
//     the sidebar instead of a floating editor panel.
//   • RayucodeStatusBar     — always-visible idle/generating state, fed by the
//     adapter's panel-message tap.
//   • @rayucode chat participant — the same agent inside the chat view.
//   • RayucodeActionProvider — Explain / Fix / Review on a selection.
//
// Every registration is INDEPENDENTLY isolated: a failure is logged and
// activation continues with the remaining features (R14.5), so a host missing the
// chat API (or a malformed contribution) can never leave the extension dead.
//
// The `vscode` runtime API is provided by the extension host and kept EXTERNAL
// by the esbuild bundle (esbuild.mjs); @rayucode/core is bundled in. The core
// never imports `vscode` — all editor operations flow through the VSCodeAdapter
// (R13.1, R13.4).

import * as vscode from "vscode";

import { AgentProcess, Redactor, SessionManager } from "@rayucode/core";

import { loadDotEnv } from "./dotEnv.js";

import { registerChatParticipant } from "./chatParticipant.js";
import { loginRayu } from "./rayuLogin.js";
import { RayuUriAuthBroker } from "./rayuUriAuth.js";
import {
  resolveLocalCommand,
  unavailableCommandMessage,
} from "./localCommands.js";
import { runProviderSetup } from "./providerSetup.js";
import {
  describeSetServersResult,
  parseServerSpec,
  validateServerName,
  withServerAdded,
  withServerRemoved,
  type McpServerSet,
} from "./mcpServers.js";
import { listSessions, sessionAge, sessionLabel } from "./sessionHistory.js";
import { rankMentionCandidates } from "./webview/mentions.js";
import {
  PROPOSED_SCHEME,
  ProposedEditContentProvider,
  showProposedDiff,
} from "./proposedDiff.js";
import { hasRayuSession, rayuAccountLabel } from "./rayuSession.js";
// Shared with the CLI: the provider config lives in ~/.rayu/config.json.
import { getActiveProvider, upsertProvider } from "@rayu-dev/rayu-cli/lib";
import {
  ADD_SELECTION_COMMAND,
  INTERRUPT_COMMAND,
  NEW_SESSION_COMMAND,
  ADD_MCP_SERVER_COMMAND,
  REMOVE_MCP_SERVER_COMMAND,
  RESUME_SESSION_COMMAND,
  SETUP_PROVIDER_COMMAND,
  SIGN_IN_COMMAND,
  OPEN_PANEL_COMMAND,
} from "./commands.js";
import {
  EXPLAIN_COMMAND,
  FIX_COMMAND,
  REVIEW_COMMAND,
  RayucodeActionProvider,
  buildIntentReference,
  resolveIntentTarget,
} from "./codeActions.js";
import type { SelectionIntent } from "./codeActions.js";
import { PANEL_VIEW_ID, RayucodePanelProvider } from "./panelViewProvider.js";
import { collectEnvironmentSecrets } from "./redactionSecrets.js";
import { RayucodeStatusBar } from "./statusBar.js";
import { VSCodeAdapter } from "./vscodeAdapter.js";
import { registerWebBridge, type WebBridgeRegistration } from "./webBridge.js";

/** Session key used when no workspace folder is open (single ad-hoc session). */
const DEFAULT_SESSION_KEY = "rayucode";

/**
 * The extension's public API, returned from {@link activate} and surfaced as the
 * extension's `exports`. It is intentionally small and exists mainly as a TEST
 * SEAM: the extension-host integration suites (tasks 12.3 / 14.3) read
 * `ext.exports.context` to obtain a real {@link vscode.ExtensionContext} (the
 * only way to reach a genuine `SecretStorage`) and `ext.exports.sessionManager`
 * to drive/observe the composed core.
 */
export interface RayucodeExtensionApi {
  readonly context: vscode.ExtensionContext;
  readonly sessionManager: SessionManager;
  /** The Activity Bar view provider, or `null` if its registration failed. */
  readonly panelProvider: RayucodePanelProvider | null;
  /** The status bar item, or `null` if its construction failed. */
  readonly statusBar: RayucodeStatusBar | null;
}

/**
 * Module-level handle to the live manager so {@link deactivate} (which receives
 * no arguments) can reach it to terminate every spawned agent process (R2.7).
 */
let activeManager: SessionManager | null = null;

/**
 * Extension activation entry point. VS Code invokes this on `onStartupFinished`
 * (so the Activity Bar view, status bar, and chat participant exist before the
 * user reaches for them) as well as on any contributed command.
 *
 * Constructs the {@link VSCodeAdapter} and the core {@link SessionManager}, then
 * registers every surface. Each registration is isolated: a failure is caught,
 * logged to the adapter's log channel, and activation CONTINUES with the
 * remaining features (R14.5).
 */
export function activate(context: vscode.ExtensionContext): RayucodeExtensionApi {
  const adapter = new VSCodeAdapter(context);

  // Load the optional developer .env from the extension directory.
  // Absent on production installs (.vscodeignore excludes **/.env); present
  // when a developer places a .env next to the extension source to point the
  // bundled engine at a local stack (RAYU_API_URL, RAYU_GATEWAY_URL, …).
  const extensionDir = context.extensionUri.fsPath;
  const dotEnv = loadDotEnv(extensionDir);
  const dotEnvKeys = Object.keys(dotEnv);
  if (dotEnvKeys.length > 0) {
    // Log KEY NAMES only — values are never logged, they may be secrets.
    adapter.log(
      "lifecycle",
      `.env loaded from ${extensionDir} — keys: ${dotEnvKeys.join(", ")}`,
    );
  }

  // Build the merged environment for the child process. .env keys win over
  // process.env so a developer can override individual vars without replacing
  // the entire environment.
  const childEnv: NodeJS.ProcessEnv =
    dotEnvKeys.length > 0 ? { ...process.env, ...dotEnv } : process.env;

  // R15.5: seed the redaction filter BEFORE the manager is built so every
  // string routed to the panel or the log channel passes through a redactor
  // that actually has secrets. The filter runs over childEnv so that any
  // credential in .env is also redacted from tool output and logs.
  const secrets = collectEnvironmentSecrets(childEnv);

  /*
   * Forward-declared so the SessionManager can be built with a tap that resolves the
   * bridge LAZILY.
   *
   * The two are mutually dependent — the bridge drives the manager, the manager feeds
   * the bridge — and the manager has to exist first because it owns the sessions. A
   * stable closure over this variable breaks the cycle without rebuilding the manager
   * on connect, which would discard every retained conversation (R12).
   */
  let webBridge: WebBridgeRegistration | null = null;

  // Serves the right-hand side of a proposed-edit diff from memory. Registered
  // before the SessionManager so the hook below always has a live provider.
  const proposedEdits = new ProposedEditContentProvider();
  context.subscriptions.push(
    proposedEdits,
    vscode.workspace.registerTextDocumentContentProvider(
      PROPOSED_SCHEME,
      proposedEdits,
    ),
  );

  const sessionManager = new SessionManager({
    adapter,
    redactor: new Redactor(secrets),
    // UI_PARITY flow 11: show a proposed edit in VS Code's own diff editor.
    // Opening a diff neither approves nor denies — the request stays pending.
    onPreviewEdit: async (requestId, plan) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      for (const [index, change] of plan.changes.entries()) {
        try {
          await showProposedDiff(proposedEdits, root, requestId, change, index);
        } catch (error) {
          adapter.log(
            "error",
            `Could not open a diff for ${change.path}: ${errorMessage(error)}`,
          );
        }
      }
    },
    // Who is signed in, so the panel can say so. Reads the shared credential store.
    authAccount: () => rayuAccountLabel(childEnv),
    // The panel's "Sign in" button.
    onSignIn: () => {
      void vscode.commands.executeCommand(SIGN_IN_COMMAND);
    },
    // Confirm before escalating to a bypass-class permission mode.
    //
    // Required because the engine fixes `isBypassPermissionsModeAvailable` at launch,
    // so reaching one of these modes means relaunching — which costs the current
    // conversation. Both consequences are stated rather than implied, and the default
    // button is Cancel.
    confirmPermissionEscalation: async (mode) => {
      const label = mode === "fullManage" ? "Full manage" : "Bypass all prompts";
      const choice = await vscode.window.showWarningMessage(
        `Switch to "${label}"?`,
        {
          modal: true,
          detail:
            `In this mode the agent edits files and runs commands WITHOUT asking first.\n\n` +
            `The session must restart to enable it, because Rayu decides this mode's ` +
            `availability when the engine starts. The current conversation will be cleared.`,
        },
        // A modal's dismissal returns undefined, which is treated as a refusal, so
        // there is no explicit Cancel item to get wrong.
        "Restart in this mode",
      );
      return choice === "Restart in this mode";
    },
    // Workspace file search for `@` mentions (UI_PARITY flow 20). Only the host can
    // enumerate workspace files, so core delegates it here.
    onSearchFiles: (sessionKey, query) => {
      void (async () => {
        try {
          // `**/*` with VS Code's own exclude handling, so node_modules and
          // .gitignore'd paths do not swamp the list. Capped because a large repo
          // would otherwise serialise tens of thousands of paths into the webview.
          const found = await vscode.workspace.findFiles(
            "**/*",
            "**/{node_modules,.git,dist,out,build,target}/**",
            2000,
          );
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const paths = found.map((uri) => {
            const full = uri.fsPath;
            // Workspace-relative: an absolute path is unreadable in a narrow panel
            // and is not what the agent needs to resolve the file either.
            return root !== undefined && full.startsWith(root)
              ? full.slice(root.length + 1)
              : full;
          });
          const ranked = rankMentionCandidates(query, paths);
          sessionManager.postFileMatches(sessionKey, ranked);
        } catch (error) {
          adapter.log("error", `File search failed: ${errorMessage(error)}`);
          sessionManager.postFileMatches(sessionKey, []);
        }
      })();
    },
    // BYOK wizard, reached from the provider badge in the input bar.
    onProviderSetup: () => {
      void vscode.commands.executeCommand(SETUP_PROVIDER_COMMAND);
    },
    // Open a file in the active editor.
    onOpenFile: (_sessionKey, filePath) => {
      void (async () => {
        try {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri;
          const fileUri = root
            ? (filePath.startsWith("/") ? vscode.Uri.file(filePath) : vscode.Uri.joinPath(root, filePath))
            : vscode.Uri.file(filePath);
          await vscode.window.showTextDocument(fileUri);
        } catch (error) {
          adapter.log("error", `Could not open file ${filePath}: ${errorMessage(error)}`);
        }
      })();
    },
    // View diff of a modified file against git HEAD or original.
    onOpenReviewDiff: (_sessionKey, filePath) => {
      void (async () => {
        try {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri;
          const fileUri = root
            ? (filePath.startsWith("/") ? vscode.Uri.file(filePath) : vscode.Uri.joinPath(root, filePath))
            : vscode.Uri.file(filePath);
          try {
            await vscode.commands.executeCommand("git.openChange", fileUri);
          } catch {
            await vscode.window.showTextDocument(fileUri);
          }
        } catch (error) {
          adapter.log("error", `Could not open review diff for ${filePath}: ${errorMessage(error)}`);
        }
      })();
    },
    // Serve the commands the engine cannot: every `local-jsx` command is filtered
    // out of the headless registry, so /login, /model, /permissions and friends
    // would otherwise be forwarded to an engine that has never heard of them and
    // silently do nothing. See localCommands.ts.
    interceptPrompt: (sessionKey, text) => {
      const action = resolveLocalCommand(text);
      if (!action) {
        // A command the engine does not announce is not in its headless registry:
        // it returns success having done nothing at all. Say so rather than let it
        // vanish, which is what "commands don't work" looked like.
        const unavailable = unavailableCommandMessage(
          text,
          sessionManager.getAnnouncedSlashCommands(sessionKey),
        );
        if (unavailable !== null) {
          void vscode.window.showWarningMessage(unavailable);
          return true;
        }
        return false;
      }
      switch (action.kind) {
        case "signIn":
          void vscode.commands.executeCommand(SIGN_IN_COMMAND);
          return true;
        case "openModelList":
          void sessionManager.requestModels(sessionKey);
          return true;
        case "setPermissionMode":
          void sessionManager.selectPermissionMode(sessionKey, action.mode);
          return true;
        case "newSession":
          void sessionManager.newSession(sessionKey);
          return true;
        case "showMcp":
          // Status is already in the panel header; refresh it so the row is current.
          void sessionManager.refreshMcpStatus(sessionKey);
          return true;
        case "notice":
          void vscode.window.showInformationMessage(action.message);
          return true;
      }
    },
    // The active provider, read through the shared library built from rayu/src —
    // the same getActiveProvider() the CLI's model picker uses, so the panel and
    // the CLI cannot disagree about which backend is answering.
    activeProvider: () => {
      try {
        const provider = getActiveProvider();
        // `label` is set only for user-defined providers; built-ins take their name
        // from the preset, so `id` is the reliable display value.
        return provider ? { id: provider.label ?? provider.id, kind: provider.kind } : null;
      } catch {
        // A missing or malformed ~/.rayu/config.json must not break the panel.
        return null;
      }
    },
    // Refuse a prompt when there is no Rayu session, before an engine is
    // spawned. The engine refuses too (rayu/src/cli/print.ts), which is the
    // authoritative gate — this one exists so the user gets an immediate,
    // actionable notice instead of a round-trip that returns an engine warning.
    // The message names the command so the fix is one palette entry away.
    authGate: () =>
      hasRayuSession(childEnv)
        ? null
        : "Sign in to Rayu to use the agent. Run “Rayucode: Sign in to Rayu” from the Command Palette.",
    // The engine and its build-info.json ship inside the VSIX. Derive the
    // directory from the extension URI rather than relying on __dirname, so it
    // does not depend on how the bundle was produced.
    engineDistDir: vscode.Uri.joinPath(context.extensionUri, "dist").fsPath,
    // Pass the merged environment into every spawned engine process so .env
    // overrides (e.g. RAYU_API_URL=http://localhost:4000/api) take effect.
    agentProcessFactory: (o) =>
      new AgentProcess({ enginePath: o.enginePath, cwd: o.cwd, adapter: o.adapter, env: childEnv }),
    // Mirror the panel to the Rayu web studio when the bridge is connected. A no-op
    // while it is not, which is the default.
    onPanelMessage: (sessionKey, message) =>
      webBridge?.observePanelMessage(sessionKey, message),
  });
  // Log the COUNT only; the values are needles, never diagnostics.
  adapter.log(
    "lifecycle",
    `Redaction filter active with ${secrets.length} credential value(s) from the environment.`,
  );
  activeManager = sessionManager;

  // --- Activity Bar sidebar ------------------------------------------------
  // Registered FIRST so the resolver is in place before any command can trigger
  // `showAgentPanel` (which would otherwise fall back to a floating panel).
  const panelProvider = registerPanelView(context, adapter, sessionManager);

  // --- Status bar ----------------------------------------------------------
  const statusBar = registerStatusBar(context, adapter);

  // --- Commands ------------------------------------------------------------

  // R14.4: registering openPanel makes it invocable from the command palette.
  registerCommandSafely(adapter, OPEN_PANEL_COMMAND, () =>
    sessionManager.openSession(sessionKeyForActiveWorkspace()),
  );

  // R9.5: insert a reference to the active selection (when one exists) into the
  // Agent_Panel prompt input.
  registerCommandSafely(adapter, ADD_SELECTION_COMMAND, () =>
    runAddSelectionToPrompt(sessionManager),
  );

  // R3.6: interrupt the in-progress turn (also the status bar's click action).
  registerCommandSafely(adapter, INTERRUPT_COMMAND, () =>
    runInterrupt(sessionManager),
  );

  // R12.4: discard the current conversation and start a fresh session.
  registerCommandSafely(adapter, NEW_SESSION_COMMAND, () =>
    sessionManager.newSession(sessionKeyForActiveWorkspace()),
  );

  // The deep-link sign-in broker. Registered ONCE — VS Code allows one URI
  // handler per extension, so a per-attempt registration would break the second
  // attempt, which is exactly what a user does when a login looks stuck.
  const uriAuth = new RayuUriAuthBroker((message) =>
    adapter.log("lifecycle", message),
  );
  // Registration is guarded because VS Code allows ONE handler per extension and
  // throws "Protocol handler already registered for extension" on a second
  // attempt. A single window can activate more than once — the integration suite
  // does exactly that, and R14.5 requires a registration failure not to abort
  // activation. Losing the deep link degrades to the loopback sign-in, which is
  // the fallback that already exists; aborting activation would lose the panel.
  try {
    context.subscriptions.push(
      vscode.window.registerUriHandler({
        handleUri: (uri) => uriAuth.handleUri({ path: uri.path, query: uri.query }),
      }),
    );
  } catch (error) {
    adapter.log(
      "lifecycle",
      `deep-link sign-in unavailable: ${errorMessage(error)}. ` +
        "Sign-in will use the loopback flow.",
    );
  }

  // Task 15: in-editor sign-in. Writes the same ~/.rayu/rayu-auth.json the CLI
  // reads, so this also signs in `rayu` in a terminal. The result is reported
  // explicitly — a silent failure would leave the user believing they are signed
  // in and then spawning an engine that is not.
  /**
   * The MCP servers this panel has added, which is exactly the "dynamically managed"
   * set `mcp_set_servers` replaces.
   *
   * Tracked here because the request REPLACES rather than merges: sending only the
   * server being added would disconnect all the others. Servers from `.mcp.json` or
   * settings are outside this set and cannot be affected by it.
   */
  let dynamicMcpServers: McpServerSet = {};

  // Resume a previous session (UI_PARITY flow 15). The transcript list is read from
  // disk because the control protocol cannot enumerate sessions at all.
  registerCommandSafely(adapter, RESUME_SESSION_COMMAND, async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspace === undefined) {
      void vscode.window.showWarningMessage(
        "Open a folder to browse its session history.",
      );
      return;
    }

    const sessions = await listSessions(workspace);
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage(
        "No previous sessions for this workspace yet.",
      );
      return;
    }

    const chosen = await vscode.window.showQuickPick(
      sessions.map((summary) => ({
        label: sessionLabel(summary),
        description: sessionAge(summary),
        // The id is what actually resumes; showing it aids a bug report.
        detail: summary.sessionId,
        summary,
      })),
      {
        title: "Resume a previous session",
        placeHolder: "This replaces the current conversation in the panel",
        matchOnDetail: true,
      },
    );
    if (!chosen) return;

    const key = sessionManager.sessionKeys()[0];
    if (key === undefined) {
      void vscode.window.showWarningMessage(
        "Open the Rayucode panel before resuming a session.",
      );
      return;
    }
    await sessionManager.resumeSession(key, chosen.summary.sessionId);
  });

  // Add a dynamically managed MCP server (UI_PARITY flow 14).
  registerCommandSafely(adapter, ADD_MCP_SERVER_COMMAND, async () => {
    const key = sessionManager.sessionKeys()[0];
    if (key === undefined) {
      void vscode.window.showWarningMessage(
        "Open the Rayucode panel before managing MCP servers.",
      );
      return;
    }

    const name = await vscode.window.showInputBox({
      title: "MCP server name",
      prompt: "Letters, numbers, dashes and underscores",
      ignoreFocusOut: true,
      validateInput: (value) => validateServerName(value, dynamicMcpServers),
    });
    if (name === undefined) return;
    const nameError = validateServerName(name, dynamicMcpServers);
    if (nameError !== null) {
      void vscode.window.showWarningMessage(nameError);
      return;
    }

    const commandLine = await vscode.window.showInputBox({
      title: `Command or URL for ${name.trim()}`,
      prompt: "e.g. npx -y @modelcontextprotocol/server-filesystem /path, or https://…",
      ignoreFocusOut: true,
    });
    if (commandLine === undefined) return;
    const spec = parseServerSpec(commandLine);
    if (spec === null) {
      void vscode.window.showWarningMessage("A command or URL is required.");
      return;
    }

    // mcp_set_servers REPLACES the dynamic set, so the whole desired set is sent.
    const desired = withServerAdded(dynamicMcpServers, name, spec);
    const result = await sessionManager.setMcpServers(key, desired);
    if (result === null) {
      void vscode.window.showWarningMessage(
        "The engine did not accept the server change.",
      );
      return;
    }
    // Only adopt the new set once the engine has accepted it, or the tracked state
    // would drift from reality after a failure.
    dynamicMcpServers = desired;
    void vscode.window.showInformationMessage(describeSetServersResult(result));
  });

  // Remove a dynamically managed MCP server (UI_PARITY flow 14).
  registerCommandSafely(adapter, REMOVE_MCP_SERVER_COMMAND, async () => {
    const key = sessionManager.sessionKeys()[0];
    const names = Object.keys(dynamicMcpServers);
    if (key === undefined || names.length === 0) {
      void vscode.window.showInformationMessage(
        "No panel-added MCP servers to remove. Servers from .mcp.json or settings are managed there.",
      );
      return;
    }

    const chosen = await vscode.window.showQuickPick(names, {
      title: "Remove an MCP server",
      placeHolder: "Only servers added from the panel are listed",
    });
    if (chosen === undefined) return;

    const desired = withServerRemoved(dynamicMcpServers, chosen);
    const result = await sessionManager.setMcpServers(key, desired);
    if (result === null) {
      void vscode.window.showWarningMessage(
        "The engine did not accept the server change.",
      );
      return;
    }
    dynamicMcpServers = desired;
    void vscode.window.showInformationMessage(describeSetServersResult(result));
  });

  // Provider setup / BYOK (UI_PARITY flow 19). The wizard's logic lives in
  // providerSetup.ts with its VS Code interactions injected, so the decision
  // rules are unit-testable; this is only the wiring.
  registerCommandSafely(adapter, SETUP_PROVIDER_COMMAND, async () => {
    await runProviderSetup({
      isSignedIn: () => hasRayuSession(),
      offerSignIn: () => {
        void vscode.commands.executeCommand(SIGN_IN_COMMAND);
      },
      pickPreset: async (presets) => {
        const chosen = await vscode.window.showQuickPick(
          presets.map((preset) => ({
            label: preset.label,
            detail: preset.detail,
            preset,
          })),
          {
            title: "Add or switch AI provider",
            placeHolder: "Your key is stored in ~/.rayu/config.json and shared with the CLI",
          },
        );
        return chosen?.preset;
      },
      promptApiKey: (preset) =>
        Promise.resolve(
          vscode.window.showInputBox({
            title: `${preset.label} API key`,
            prompt: `Get one at ${preset.keyHint}`,
            // Never echo a credential into the UI or a screen share.
            password: true,
            ignoreFocusOut: true,
          }),
        ),
      promptModel: (preset) =>
        Promise.resolve(
          vscode.window.showInputBox({
            title: `${preset.label} model`,
            prompt: "Leave as-is to accept the default",
            value: preset.defaultModel ?? "",
            ignoreFocusOut: true,
          }),
        ),
      // The shared writer from rayu/src — same file and validation as the CLI.
      saveProvider: (record) => {
        upsertProvider(record as Parameters<typeof upsertProvider>[0], true);
      },
      info: (message) => {
        void vscode.window.showInformationMessage(message);
      },
      warn: (message) => {
        void vscode.window.showWarningMessage(message);
      },
      refreshModels: () => {
        for (const key of sessionManager.sessionKeys()) {
          // The badge first: it reads config directly, so it updates even if the
          // engine is not running and cannot answer a models request.
          sessionManager.publishProvider(key);
          void sessionManager.requestModels(key);
        }
      },
    });
  });

  registerCommandSafely(adapter, SIGN_IN_COMMAND, async () => {
    if (hasRayuSession()) {
      const again = await vscode.window.showInformationMessage(
        "Already signed in to Rayu.",
        "Sign in again",
      );
      if (again !== "Sign in again") return;
    }
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Signing in to Rayu — complete the login in your browser…",
          cancellable: false,
        },
        async () => {
          const openExternal = (url: string) =>
            vscode.env.openExternal(vscode.Uri.parse(url));
          // Only progress lines reach the channel; neither module logs a token.
          const log = (message: string) => adapter.log("lifecycle", message);
          try {
            // Preferred: the vscode:// deep link. No local HTTP server, no port
            // to bind, no firewall prompt.
            await uriAuth.signIn({ openExternal, log });
          } catch (error) {
            // Fall back to the CLI's loopback flow. The deep link cannot arrive
            // in a Remote-SSH or container window, where the browser runs on a
            // different machine than the extension host — there the loopback
            // server, which listens where the browser can reach it, is the only
            // route. Rethrown failures from the fallback are the ones reported.
            log(
              `deep-link sign-in unavailable (${errorMessage(error)}); falling back to loopback`,
            );
            await loginRayu({ openExternal, log });
          }
        },
      );
      // Tell every panel who is signed in, and RESTART the engine.
      //
      // The restart is not cosmetic. With no credentials the engine emits the auth-gate
      // error and exits WITHOUT ever sending `system/init`, so the panel has no model,
      // no command catalog and a dead process. Signing in changed the credential store
      // but nothing restarted the engine, so the panel looked exactly as before — which
      // is why signing in appeared to do nothing at all.
      sessionManager.publishAuthStatusEverywhere();
      for (const key of sessionManager.sessionKeys()) {
        // newSession() rather than openSession(): the previous process is gone, and a
        // fresh session also clears the transcript containing the refusal message.
        await sessionManager.newSession(key);
      }
      void vscode.window.showInformationMessage(
        "Signed in to Rayu. The `rayu` CLI is signed in too — it shares this session.",
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      adapter.log("error", `rayu sign-in failed: ${reason}`);
      void vscode.window.showErrorMessage(`Rayu sign-in failed: ${reason}`);
    }
  });

  // Selection intents backing both the lightbulb and the editor context menu.
  for (const [commandId, intent] of [
    [EXPLAIN_COMMAND, "explain"],
    [FIX_COMMAND, "fix"],
    [REVIEW_COMMAND, "review"],
  ] as [string, SelectionIntent][]) {
    registerCommandSafely(adapter, commandId, (...args) =>
      runSelectionIntent(sessionManager, intent, args),
    );
  }

  // --- Code actions --------------------------------------------------------
  registerCodeActions(context, adapter);

  // --- Chat participant ----------------------------------------------------
  registerChatParticipantSafely(context, adapter, sessionManager);

  // --- Web Bridge ----------------------------------------------------------
  // Remote control from the rayu-web studio. OPT-IN: registering the commands does
  // not connect anything. See webBridge.ts for why that is a security decision.
  try {
    webBridge = registerWebBridge({
      adapter,
      sessionManager,
      env: childEnv,
      activeSessionKey: () => sessionKeyForActiveWorkspace(),
    });
    context.subscriptions.push({ dispose: () => webBridge?.dispose() });
  } catch (error) {
    adapter.log(
      "error",
      `Failed to register the web bridge: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { context, sessionManager, panelProvider, statusBar };
}

/**
 * Extension deactivation hook. VS Code invokes this on window/extension
 * shutdown. Terminates every spawned `AgentProcess` and closes all sessions via
 * the core's `disposeAll()` — which denies any pending permission requests
 * before terminating each child and resolves only after the children have
 * exited (R2.7, and R5.5 on the close path). Awaited so VS Code lets the
 * teardown complete during shutdown.
 */
export async function deactivate(): Promise<void> {
  const manager = activeManager;
  activeManager = null;
  await manager?.disposeAll();
}

// ---------------------------------------------------------------------------
// Surface registration
// ---------------------------------------------------------------------------

/**
 * Register the Activity Bar webview view and plug it into the adapter's panel
 * resolver chain, so a session for the active workspace binds the SIDEBAR rather
 * than a floating editor panel. Returns `null` (and logs) on failure, in which
 * case `showAgentPanel` transparently falls back to the floating panel.
 */
function registerPanelView(
  context: vscode.ExtensionContext,
  adapter: VSCodeAdapter,
  sessionManager: SessionManager,
): RayucodePanelProvider | null {
  try {
    const provider = new RayucodePanelProvider({
      extensionUri: context.extensionUri,
      sessionKeyProvider: sessionKeyForActiveWorkspace,
      onReveal: (sessionKey) => sessionManager.openSession(sessionKey),
      log: (channel, message) => adapter.log(channel, message),
    });

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(PANEL_VIEW_ID, provider, {
        // History lives in the host (R12.2); retaining context keeps the view's
        // DOM (scroll position, half-typed prompt) across side bar hide/show.
        webviewOptions: { retainContextWhenHidden: true },
      }),
      adapter.registerAgentPanelResolver((sessionKey) =>
        provider.resolveAgentPanel(sessionKey),
      ),
      { dispose: () => provider.dispose() },
    );
    return provider;
  } catch (error) {
    adapter.log(
      "error",
      `Failed to register the rayucode Activity Bar view: ${errorMessage(error)}`,
    );
    return null;
  }
}

/**
 * Create the status bar item and feed it the host → panel message stream, so it
 * mirrors exactly the state the panel shows.
 */
function registerStatusBar(
  context: vscode.ExtensionContext,
  adapter: VSCodeAdapter,
): RayucodeStatusBar | null {
  try {
    const statusBar = new RayucodeStatusBar(context);
    context.subscriptions.push(
      adapter.onPanelMessage((_sessionKey, message) => {
        statusBar.handlePanelMessage(message);
      }),
      { dispose: () => statusBar.dispose() },
    );
    return statusBar;
  } catch (error) {
    adapter.log(
      "error",
      `Failed to create the rayucode status bar item: ${errorMessage(error)}`,
    );
    return null;
  }
}

/** Register the selection code-action provider for all file documents. */
function registerCodeActions(
  context: vscode.ExtensionContext,
  adapter: VSCodeAdapter,
): void {
  try {
    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(
        // The agent is language-agnostic; restricting the selector would only
        // hide the feature for some file types.
        { scheme: "file" },
        new RayucodeActionProvider(),
        {
          providedCodeActionKinds: [
            ...RayucodeActionProvider.providedCodeActionKinds,
          ],
        },
      ),
    );
  } catch (error) {
    adapter.log(
      "error",
      `Failed to register rayucode code actions: ${errorMessage(error)}`,
    );
  }
}

/** Register the `@rayucode` chat participant, tolerating hosts without chat. */
function registerChatParticipantSafely(
  context: vscode.ExtensionContext,
  adapter: VSCodeAdapter,
  sessionManager: SessionManager,
): void {
  try {
    registerChatParticipant({
      context,
      sessionManager,
      adapter,
      workspaceSessionKey: sessionKeyForActiveWorkspace,
    });
  } catch (error) {
    adapter.log(
      "error",
      `Failed to register the @rayucode chat participant: ${errorMessage(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

/**
 * Register a command through the adapter, isolating registration failures
 * (R14.5). The adapter binds the returned disposable to `context.subscriptions`
 * for lifecycle cleanup, so we do not track it again here. The command callback
 * is wrapped so an async failure during INVOCATION is logged rather than
 * surfacing as an unhandled promise rejection.
 */
function registerCommandSafely(
  adapter: VSCodeAdapter,
  id: string,
  run: (...args: unknown[]) => void | Promise<void>,
): void {
  try {
    adapter.registerCommand(id, (...args: unknown[]) =>
      // Return the promise so the host awaits completion on invocation; the
      // catch keeps a failed invocation from becoming an unhandled rejection
      // and routes the reason to the log channel instead.
      Promise.resolve()
        .then(() => run(...args))
        .catch((error: unknown) => {
          adapter.log("error", `Command ${id} failed: ${errorMessage(error)}`);
        }),
    );
  } catch (error) {
    // R14.5: a registration failure must not abort activation. Log it and let
    // the remaining commands register.
    adapter.log(
      "error",
      `Failed to register command ${id}: ${errorMessage(error)}`,
    );
  }
}

/**
 * Handle the interrupt command (R3.6). Reachable from the command palette and
 * from a status bar click, so it may fire when no session has been started —
 * `SessionManager.interrupt` throws for an unknown key, which would surface as a
 * spurious error in the log channel. With nothing running there is nothing to
 * interrupt, so that case is a deliberate no-op.
 */
async function runInterrupt(sessionManager: SessionManager): Promise<void> {
  const sessionKey = sessionKeyForActiveWorkspace();
  try {
    await sessionManager.interrupt(sessionKey);
  } catch {
    // No live session for this workspace: nothing to interrupt.
  }
}

/**
 * Handle the add-selection-to-prompt command (R9.5). Only acts when the active
 * editor has a NON-empty selection; builds a reference citing the file path and
 * the selected text and asks the core to insert it into the panel input (opening
 * the panel first if needed).
 */
async function runAddSelectionToPrompt(
  sessionManager: SessionManager,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    // R9.5 is conditioned on "while a text selection exists"; with none, the
    // command is a no-op.
    return;
  }

  const { document, selection } = editor;
  const reference = buildSelectionReference(
    document.uri.fsPath,
    selection.start.line + 1,
    selection.end.line + 1,
    document.getText(selection),
  );

  await sessionManager.addSelectionToPrompt(
    sessionKeyForActiveWorkspace(),
    reference,
  );
}

/**
 * Handle an Explain / Fix / Review selection intent. Stages the instruction plus
 * the selected code into the panel prompt input (opening the panel if needed)
 * WITHOUT submitting, so the user can refine it first. A no-op when nothing is
 * selected, matching the add-selection command.
 *
 * `args` come from either the code action (`[uri, range]`) or a bare context-menu
 * invocation (`[uri]` or empty), so both are handled.
 */
async function runSelectionIntent(
  sessionManager: SessionManager,
  intent: SelectionIntent,
  args: unknown[],
): Promise<void> {
  const uri = args[0] instanceof vscode.Uri ? args[0] : undefined;
  const range = args[1] instanceof vscode.Range ? args[1] : undefined;

  const target = resolveIntentTarget(uri, range);
  if (!target) {
    return;
  }

  const reference = buildIntentReference(
    intent,
    target.document.uri.fsPath,
    target.range.start.line + 1,
    target.range.end.line + 1,
    target.document.getText(target.range),
    target.document.languageId,
  );

  await sessionManager.addSelectionToPrompt(
    sessionKeyForActiveWorkspace(),
    reference,
  );
}

/**
 * Build the prompt-input reference for a selection: the file path + line range
 * followed by the selected text in a fenced block (R9.5). The webview appends
 * this to the textarea verbatim without submitting.
 */
function buildSelectionReference(
  filePath: string,
  startLine: number,
  endLine: number,
  selectedText: string,
): string {
  const range = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
  return `${filePath}:${range}\n\`\`\`\n${selectedText}\n\`\`\`\n`;
}

/**
 * Derive a stable per-workspace session key: the first workspace folder's
 * filesystem path, or a constant when no folder is open (so an ad-hoc session
 * still has a consistent key). Every command uses the SAME key so a selection
 * lands in the panel the open-panel command shows.
 */
function sessionKeyForActiveWorkspace(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? folder.uri.fsPath : DEFAULT_SESSION_KEY;
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
