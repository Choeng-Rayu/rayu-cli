import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PANEL_FOCUS_COMMAND,
  PANEL_VIEW_ID,
  RayucodePanelProvider,
} from "../src/panelViewProvider.js";
import { Uri, recorder, resetVscodeStub } from "./stubs/vscode.js";

// Activity Bar panel provider (R3.1, R12.2).
//
// A `WebviewView`'s lifetime belongs to the WORKBENCH, not to us: it exists only
// once revealed, and may be re-created underneath a live session. That makes the
// provider a small state machine with two entry paths that must meet in the
// middle — host-initiated (`showAgentPanel` → reveal → await resolve) and
// user-initiated (icon click → resolve → open session).
//
// These tests drive that state machine directly, standing in for the workbench by
// calling `resolveWebviewView` at the moments VS Code would. What they cannot
// verify — that the real workbench resolves the view at all — is covered by the
// extension-host integration suite.

type WebviewView = import("vscode").WebviewView;

/** A stand-in WebviewView recording posts and exposing its lifecycle hooks. */
function makeView() {
  const posted: unknown[] = [];
  let messageListener: ((message: unknown) => void) | undefined;
  let disposeListener: (() => void) | undefined;
  const state = {
    posted,
    html: "",
    options: undefined as unknown,
    showCalls: [] as (boolean | undefined)[],
    /** Simulate the user (or the agent UI) posting a message to the host. */
    emitMessage(message: unknown) {
      messageListener?.(message);
    },
    /** Simulate the workbench destroying the view. */
    destroy() {
      disposeListener?.();
    },
  };

  const view = {
    webview: {
      get options() {
        return state.options;
      },
      set options(value: unknown) {
        state.options = value;
      },
      get html() {
        return state.html;
      },
      set html(value: string) {
        state.html = value;
      },
      cspSource: "vscode-webview://stub",
      asWebviewUri: (uri: Uri) => uri,
      postMessage: (message: unknown) => {
        posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (listener: (message: unknown) => void) => {
        messageListener = listener;
        return { dispose: () => {} };
      },
    },
    show: (preserveFocus?: boolean) => {
      state.showCalls.push(preserveFocus);
    },
    onDidDispose: (listener: () => void) => {
      disposeListener = listener;
      return { dispose: () => {} };
    },
  } as unknown as WebviewView;

  return { view, state };
}

function makeProvider(sessionKey = "/w") {
  const logs: { channel: string; message: string }[] = [];
  const revealed: string[] = [];
  const provider = new RayucodePanelProvider({
    extensionUri: Uri.file("/ext") as unknown as import("vscode").Uri,
    sessionKeyProvider: () => sessionKey,
    onReveal: async (key) => {
      revealed.push(key);
    },
    log: (channel, message) => {
      logs.push({ channel, message });
    },
  });
  return { provider, logs, revealed };
}

beforeEach(() => {
  resetVscodeStub();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Contributed ids
// ---------------------------------------------------------------------------

describe("panel view ids", () => {
  it("derives the focus command from the contributed view id", () => {
    expect(PANEL_VIEW_ID).toBe("rayucode.panel");
    expect(PANEL_FOCUS_COMMAND).toBe("rayucode.panel.focus");
  });
});

// ---------------------------------------------------------------------------
// resolveWebviewView
// ---------------------------------------------------------------------------

describe("RayucodePanelProvider.resolveWebviewView", () => {
  it("installs the locked-down webview options and the panel HTML", () => {
    const { provider } = makeProvider();
    const { view, state } = makeView();

    provider.resolveWebviewView(view);

    expect(state.options).toMatchObject({ enableScripts: true });
    expect(state.html).toContain("<!DOCTYPE html>");
    // The strict CSP must survive the move from panel to view.
    expect(state.html).toContain("default-src 'none'");
    expect(state.html).toContain("script-src 'nonce-");
    expect(state.html).toContain("dist/webview.js");
  });

  it("opens the workspace session when the USER reveals the view (path B)", async () => {
    const { provider, revealed } = makeProvider("/w");
    const { view } = makeView();

    provider.resolveWebviewView(view);
    await Promise.resolve();

    expect(revealed).toEqual(["/w"]);
  });

  it("does not re-open the session when a handle is already bound", async () => {
    const { provider, revealed } = makeProvider("/w");
    const { view } = makeView();

    provider.resolveWebviewView(view);
    await Promise.resolve();
    await provider.resolveAgentPanel("/w");
    // The workbench re-creates the view (e.g. the side bar was moved).
    provider.resolveWebviewView(makeView().view);
    await Promise.resolve();

    expect(revealed).toEqual(["/w"]);
  });
});

// ---------------------------------------------------------------------------
// resolveAgentPanel
// ---------------------------------------------------------------------------

describe("RayucodePanelProvider.resolveAgentPanel", () => {
  it("declines a session key that is not this view's (so the adapter falls back)", async () => {
    const { provider } = makeProvider("/w");

    // e.g. the chat participant's own session key.
    expect(await provider.resolveAgentPanel("chat:/w")).toBeNull();
  });

  it("returns a handle bound to the already-resolved view", async () => {
    const { provider } = makeProvider("/w");
    const { view, state } = makeView();
    provider.resolveWebviewView(view);
    await Promise.resolve();

    const handle = await provider.resolveAgentPanel("/w");

    expect(handle?.sessionKey).toBe("/w");
    await handle!.postMessage({ type: "setGenerating", generating: true });
    expect(state.posted).toEqual([{ type: "setGenerating", generating: true }]);
  });

  it("reveals the view and awaits resolution when it does not exist yet (path A)", async () => {
    const { provider } = makeProvider("/w");
    const pending = provider.resolveAgentPanel("/w");
    await Promise.resolve();

    // Revealing the contributed view is what makes the workbench resolve it.
    expect(recorder.executedCommands.map((c) => c.command)).toContain(
      PANEL_FOCUS_COMMAND,
    );

    const { view } = makeView();
    provider.resolveWebviewView(view);
    const handle = await pending;

    expect(handle).not.toBeNull();
    expect(handle?.sessionKey).toBe("/w");
  });

  it("returns the SAME handle on re-resolution (no duplicate subscriptions)", async () => {
    const { provider } = makeProvider("/w");
    const { view } = makeView();
    provider.resolveWebviewView(view);
    await Promise.resolve();

    const first = await provider.resolveAgentPanel("/w");
    const second = await provider.resolveAgentPanel("/w");

    expect(second).toBe(first);
  });

  it("declines (rather than hanging) when the workbench never resolves the view", async () => {
    vi.useFakeTimers();
    const { provider, logs } = makeProvider("/w");

    const pending = provider.resolveAgentPanel("/w");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toBeNull();
    expect(
      logs.some((entry) => entry.message.includes("Timed out waiting")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------

describe("the panel view handle", () => {
  async function boundHandle(sessionKey = "/w") {
    const { provider } = makeProvider(sessionKey);
    const { view, state } = makeView();
    provider.resolveWebviewView(view);
    await Promise.resolve();
    const handle = await provider.resolveAgentPanel(sessionKey);
    expect(handle).not.toBeNull();
    return { provider, handle: handle!, state };
  }

  it("forwards inbound webview messages to the core's listeners", async () => {
    const { handle, state } = await boundHandle();
    const received: unknown[] = [];
    handle.onDidReceiveMessage((message) => received.push(message));

    state.emitMessage({ type: "submitPrompt", text: "hello" });

    expect(received).toEqual([{ type: "submitPrompt", text: "hello" }]);
  });

  it("stops forwarding after the listener is disposed", async () => {
    const { handle, state } = await boundHandle();
    const received: unknown[] = [];
    const subscription = handle.onDidReceiveMessage((m) => received.push(m));

    subscription.dispose();
    state.emitMessage({ type: "interrupt" });

    expect(received).toEqual([]);
  });

  it("reveals without stealing focus from the editor", async () => {
    const { handle, state } = await boundHandle();

    handle.reveal();

    expect(state.showCalls).toEqual([true]);
  });

  it("notifies dispose exactly once when the workbench destroys the view", async () => {
    const { handle, state } = await boundHandle();
    let disposals = 0;
    handle.onDidDispose(() => {
      disposals += 1;
    });

    state.destroy();
    state.destroy();

    expect(disposals).toBe(1);
  });

  it("drops posts once the view is gone instead of queueing stale traffic", async () => {
    const { handle, state } = await boundHandle();

    state.destroy();

    // The core re-sends a full `restoreHistory` on the next openSession, so a
    // dropped delta can never leave the panel permanently out of sync.
    expect(await handle.postMessage({ type: "setGenerating" })).toBe(false);
  });

  it("fires immediately for a listener added after disposal", async () => {
    const { handle, state } = await boundHandle();
    state.destroy();
    let fired = false;

    handle.onDidDispose(() => {
      fired = true;
    });

    expect(fired).toBe(true);
  });

  it("allows rebinding after the view is destroyed and re-created", async () => {
    const { provider, handle: first, state } = await boundHandle("/w");

    state.destroy();
    const replacement = makeView();
    provider.resolveWebviewView(replacement.view);
    await Promise.resolve();
    const second = await provider.resolveAgentPanel("/w");

    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    await second!.postMessage({ type: "restoreHistory", items: [] });
    expect(replacement.state.posted).toHaveLength(1);
  });

  it("detaches WITHOUT destroying the user's view on dispose", async () => {
    const { handle, state } = await boundHandle();
    let disposed = false;
    handle.onDidDispose(() => {
      disposed = true;
    });

    handle.dispose();

    expect(disposed).toBe(true);
    // The side bar view belongs to the user; we only detach from it.
    expect(state.html.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Provider disposal
// ---------------------------------------------------------------------------

describe("RayucodePanelProvider.dispose", () => {
  it("releases the bound handle and notifies the core", async () => {
    const { provider } = makeProvider("/w");
    const { view } = makeView();
    provider.resolveWebviewView(view);
    await Promise.resolve();
    const handle = await provider.resolveAgentPanel("/w");
    let disposed = false;
    handle!.onDidDispose(() => {
      disposed = true;
    });

    provider.dispose();

    expect(disposed).toBe(true);
  });

  it("cancels a pending reveal timeout so it cannot fire after teardown", async () => {
    vi.useFakeTimers();
    const { provider, logs } = makeProvider("/w");

    // A reveal is in flight (the workbench has not resolved the view yet).
    const pending = provider.resolveAgentPanel("/w");
    provider.dispose();
    // Well past the 10s reveal timeout.
    await vi.advanceTimersByTimeAsync(30_000);

    // The in-flight resolution settles instead of hanging…
    expect(await pending).toBeNull();
    // …and the timeout never fired, so nothing was logged to a channel that the
    // extension host has already closed.
    expect(
      logs.some((entry) => entry.message.includes("Timed out waiting")),
    ).toBe(false);
  });

  it("declines further resolution once disposed", async () => {
    const { provider } = makeProvider("/w");
    const { view } = makeView();
    provider.resolveWebviewView(view);
    await Promise.resolve();

    provider.dispose();

    expect(await provider.resolveAgentPanel("/w")).toBeNull();
  });

  it("ignores a view the workbench resolves after disposal", async () => {
    const { provider, revealed } = makeProvider("/w");

    provider.dispose();
    provider.resolveWebviewView(makeView().view);
    await Promise.resolve();

    // No session may be started once the extension is tearing down.
    expect(revealed).toEqual([]);
  });
});
