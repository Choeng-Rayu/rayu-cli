import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RayucodeStatusBar } from "../src/statusBar.js";
import { StatusBarAlignment, recorder, resetVscodeStub } from "./stubs/vscode.js";

// Status bar state (R3.5-adjacent: agent state must be visible even when the
// panel is hidden).
//
// The item's whole job is to mirror the agent state the panel shows, derived from
// the SAME `PanelOutboundMessage` stream. These tests pin the three states, the
// click target for each (idle → open panel, generating → interrupt), and the
// message folding — including that an unknown message can never disturb it.

/** A stand-in ExtensionContext exposing only the `subscriptions` array. */
function makeContext(): { subscriptions: { dispose(): void }[] } {
  return { subscriptions: [] };
}

function makeStatusBar(): RayucodeStatusBar {
  return new RayucodeStatusBar(
    makeContext() as unknown as import("vscode").ExtensionContext,
  );
}

/** The stub item the status bar most recently created. */
function currentItem() {
  const item = recorder.statusBarItems.at(-1);
  expect(item, "expected a status bar item to have been created").toBeDefined();
  return item!;
}

beforeEach(() => {
  resetVscodeStub();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("RayucodeStatusBar construction", () => {
  it("creates a right-aligned, visible item that starts idle", () => {
    const statusBar = makeStatusBar();

    const item = currentItem();
    expect(item.alignment).toBe(StatusBarAlignment.Right);
    expect(item.shown).toBe(true);
    expect(statusBar.currentState).toBe("idle");
    expect(item.text).toBe("$(sparkle) Rayu");
    expect(item.command).toBe("rayucode.openPanel");
  });

  it("registers the item on the context so it is disposed with the extension", () => {
    const context = makeContext();
    new RayucodeStatusBar(
      context as unknown as import("vscode").ExtensionContext,
    );

    expect(context.subscriptions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

describe("RayucodeStatusBar states", () => {
  it("shows a spinner and offers Interrupt while generating", () => {
    const statusBar = makeStatusBar();

    statusBar.setGenerating();

    expect(statusBar.currentState).toBe("generating");
    expect(statusBar.text).toBe("$(sync~spin) Rayu — Generating");
    // Clicking mid-turn must interrupt, not open a second panel.
    expect(currentItem().command).toBe("rayucode.interrupt");
    expect(currentItem().tooltip).toContain("interrupt");
  });

  it("returns to idle from generating", () => {
    const statusBar = makeStatusBar();

    statusBar.setGenerating();
    statusBar.setIdle();

    expect(statusBar.currentState).toBe("idle");
    expect(statusBar.text).toBe("$(sparkle) Rayu");
    expect(currentItem().command).toBe("rayucode.openPanel");
    expect(currentItem().backgroundColor).toBeUndefined();
  });

  it("shows a warning-styled error that auto-reverts to idle", () => {
    const statusBar = makeStatusBar();

    statusBar.setError();

    expect(statusBar.currentState).toBe("error");
    expect(statusBar.text).toBe("$(warning) Rayu");
    expect(currentItem().backgroundColor).toBeDefined();

    // Transient: a stale warning must not stick around forever.
    vi.advanceTimersByTime(5_000);
    expect(statusBar.currentState).toBe("idle");
    expect(currentItem().backgroundColor).toBeUndefined();
  });

  it("cancels a pending error revert when a new turn starts", () => {
    const statusBar = makeStatusBar();

    statusBar.setError();
    statusBar.setGenerating();
    // The error's revert timer must not clobber the generating state.
    vi.advanceTimersByTime(10_000);

    expect(statusBar.currentState).toBe("generating");
  });
});

// ---------------------------------------------------------------------------
// Panel message folding
// ---------------------------------------------------------------------------

describe("RayucodeStatusBar.handlePanelMessage", () => {
  it("enters generating on setGenerating:true and idles on false", () => {
    const statusBar = makeStatusBar();

    statusBar.handlePanelMessage({ type: "setGenerating", generating: true });
    expect(statusBar.currentState).toBe("generating");

    statusBar.handlePanelMessage({ type: "setGenerating", generating: false });
    expect(statusBar.currentState).toBe("idle");
  });

  it("enters the error state on showError", () => {
    const statusBar = makeStatusBar();

    statusBar.handlePanelMessage({
      type: "showError",
      message: "the agent exited unexpectedly",
    });

    expect(statusBar.currentState).toBe("error");
  });

  it("ignores unrelated and malformed messages", () => {
    const statusBar = makeStatusBar();
    statusBar.setGenerating();

    for (const message of [
      { type: "appendPartial", itemId: "a", delta: "hi" },
      { type: "showUsage", usage: {} },
      { type: "somethingBrandNew" },
      { notAType: true },
      null,
      undefined,
      "setGenerating",
      42,
    ]) {
      statusBar.handlePanelMessage(message);
    }

    // Still exactly where it was: unknown traffic must never move the item.
    expect(statusBar.currentState).toBe("generating");
  });

  it("treats a missing `generating` field as not generating", () => {
    const statusBar = makeStatusBar();
    statusBar.setGenerating();

    statusBar.handlePanelMessage({ type: "setGenerating" });

    expect(statusBar.currentState).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

describe("RayucodeStatusBar.dispose", () => {
  it("disposes the item and clears any pending timer", () => {
    const statusBar = makeStatusBar();
    statusBar.setError();

    statusBar.dispose();

    expect(currentItem().disposed).toBe(true);
    // No timer may fire against a disposed item.
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    expect(statusBar.currentState).toBe("error");
  });
});
