// Web Bridge registration for the VS Code host.
//
// Composes the editor-agnostic `WebBridgeController` from @rayucode/core with the two
// things only the host can supply: a Rayu access token, and the notion of "the active
// session". Kept out of extension.ts so activation stays a list of independently
// isolated registrations (R14.5) — a bridge that cannot connect must never stop the
// panel, the status bar or the chat participant from working.
//
// OPT-IN, AND THAT IS A SECURITY DECISION, NOT A PREFERENCE. Connecting means a
// browser tab can send prompts to this machine and approve tool calls on it. Nobody
// gets that by upgrading an extension. The connection is off until the user runs
// `rayucode.connectWebBridge`, and it drops on window close because the controller is
// disposed with the extension.

import * as vscode from "vscode";

import type { PanelOutboundMessage, SessionManager } from "@rayucode/core";
import { WebBridgeController } from "@rayucode/core";
import {
  resolveHostname,
  resolveMachineId,
  type WebBridgeConnectionState,
} from "@rayu-dev/web-bridge-client";

import type { VSCodeAdapter } from "./vscodeAdapter.js";
import {
  getValidRayuAccessToken,
  hasRayuSession,
  rayuApiBaseUrl,
} from "./rayuSession.js";

/** Command ids, contributed by the manifest. */
export const CONNECT_WEB_BRIDGE_COMMAND = "rayucode.connectWebBridge";
export const DISCONNECT_WEB_BRIDGE_COMMAND = "rayucode.disconnectWebBridge";

export interface WebBridgeRegistration {
  /** The live controller, or null while disconnected. */
  current(): WebBridgeController | null;
  /** Hand this to `SessionManagerOptions.onPanelMessage`. */
  observePanelMessage: (sessionKey: string, message: PanelOutboundMessage) => void;
  dispose(): void;
}

export interface RegisterWebBridgeOptions {
  adapter: VSCodeAdapter;
  sessionManager: SessionManager;
  /** The merged child environment, so `.env` overrides reach the bridge too. */
  env: NodeJS.ProcessEnv;
  /** Resolves the session a browser prompt should be routed to. */
  activeSessionKey: () => string | null;
  /** Reflects connection state in the status bar, when there is one. */
  onConnectionChange?: (state: WebBridgeConnectionState) => void;
}

/**
 * Register the connect/disconnect commands and return the panel-message tap.
 *
 * The tap is returned as a STABLE function that forwards to whatever controller is
 * live, so `SessionManager` can be constructed with it before any connection exists.
 * Wiring it the other way round would need the manager to be rebuilt on connect,
 * which would discard every retained session.
 */
export function registerWebBridge(
  options: RegisterWebBridgeOptions,
): WebBridgeRegistration {
  const { adapter, sessionManager, env } = options;
  let controller: WebBridgeController | null = null;

  const log = (message: string): void => adapter.log("lifecycle", message);

  const connect = async (): Promise<void> => {
    if (controller) {
      void vscode.window.showInformationMessage(
        "rayucode is already connected to the Rayu web studio.",
      );
      return;
    }

    // Checked before constructing anything so the failure is a sentence the user can
    // act on, rather than a socket that quietly never connects.
    if (!hasRayuSession(env)) {
      const action = await vscode.window.showWarningMessage(
        "Sign in to Rayu first: run `rayu` in a terminal and complete the login, then connect again.",
        "Open Terminal",
      );
      if (action === "Open Terminal") vscode.window.createTerminal("rayu").show();
      return;
    }

    const next = new WebBridgeController({
      client: {
        apiBaseUrl: rayuApiBaseUrl(env),
        getToken: () => getValidRayuAccessToken(env),
        hello: {
          machineId: resolveMachineId(env.RAYU_CONFIG_DIR || undefined),
          hostname: resolveHostname(),
          // The workspace root is what makes two entries in the studio's picker
          // distinguishable; a bare hostname would show "macbook-pro" three times.
          cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
          pid: process.pid,
          // Names the WORKER, not the machine. Without it a browser cannot tell this
          // apart from the rayu CLI running in a terminal on the same host — and the
          // two behave differently, so the user has to be able to choose.
          sessionLabel: sessionLabel(),
        },
        log,
      },
      host: sessionManager,
      activeSessionKey: options.activeSessionKey,
      onConnectionChange: options.onConnectionChange,
      log,
    });

    const started = await next.attach();
    if (!started) {
      next.dispose();
      void vscode.window.showErrorMessage(
        "Could not connect to the Rayu web studio. Check that you are signed in and that the Rayu API is reachable.",
      );
      return;
    }

    controller = next;
    log("web bridge connected");
    void vscode.window.showInformationMessage(
      "rayucode is now controllable from the Rayu web studio.",
    );
  };

  const disconnect = (): void => {
    if (!controller) return;
    controller.dispose();
    controller = null;
    log("web bridge disconnected");
    void vscode.window.showInformationMessage(
      "rayucode disconnected from the Rayu web studio.",
    );
  };

  // Registered through the adapter so both land in the extension's subscriptions and
  // are torn down with it.
  safely(adapter, CONNECT_WEB_BRIDGE_COMMAND, () => void connect());
  safely(adapter, DISCONNECT_WEB_BRIDGE_COMMAND, () => disconnect());

  return {
    current: () => controller,
    observePanelMessage: (sessionKey, message) => {
      controller?.observePanelMessage(sessionKey, message);
    },
    dispose: () => {
      controller?.dispose();
      controller = null;
    },
  };
}

/** A label that identifies this worker in the studio's session picker. */
function sessionLabel(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.name;
  return folder ? `VS Code — ${folder}` : "VS Code";
}

/** Register a command, isolating a failure so activation continues (R14.5). */
function safely(
  adapter: VSCodeAdapter,
  id: string,
  handler: () => void,
): void {
  try {
    adapter.registerCommand(id, () => {
      handler();
    });
  } catch (error) {
    adapter.log(
      "error",
      `Failed to register ${id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
