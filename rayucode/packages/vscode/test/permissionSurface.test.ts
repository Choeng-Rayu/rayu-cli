// @vitest-environment jsdom
//
// The blocking-permission surface.
//
// The reported bug was not a broken button. Allow/Deny were wired correctly and
// were not hidden by CSS — but the card was an ordinary transcript entry, and the
// transcript only auto-scrolls when the user is already at the bottom. Scroll up
// at all and a request that STOPS THE AGENT rendered off-screen, leaving a
// spinner that never finished and no indication that a click was required.
//
// So the properties worth pinning are about reachability, not wiring:
//
//   - the pending request is derived from the transcript, so it cannot disagree
//     with it,
//   - it is rendered outside the scroll area,
//   - it disappears the moment it is resolved,
//   - and the card is scrolled to even when the user has scrolled away.

import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PERMISSION_MODES } from "@rayucode/core";

import { App } from "../src/webview/App.js";
import {
  SELECTABLE_PERMISSION_MODES,
  selectPermissionMode,
} from "../src/webview/protocol.js";
import { PanelViewModel } from "../src/webview/viewModel.js";
import type { WebviewToHostMessage } from "../src/webview/protocol.js";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** A permission request as the host pushes it. */
function permissionRequest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "permission_request",
    id: "p1",
    seq: 1,
    requestId: "r1",
    toolName: "Bash",
    input: { command: "rm -rf build" },
    command: "rm -rf build",
    ...overrides,
  };
}

/** A view model with one unresolved request pending. */
function modelWithPending(
  overrides: Record<string, unknown> = {},
): PanelViewModel {
  const model = new PanelViewModel();
  model.handle({
    type: "setModelInfo",
    model: "sonnet",
    permissionMode: "default",
  } as never);
  model.handle({
    type: "showPermissionRequest",
    item: permissionRequest(overrides),
  } as never);
  return model;
}

function markup(model: PanelViewModel, post: (m: WebviewToHostMessage) => void = () => {}): string {
  return renderToStaticMarkup(
    createElement(App, {
      state: model.state,
      post,
      consumePendingInput: () => null,
    }) as ReactNode,
  );
}

// ---------------------------------------------------------------------------
// Step 1 — the derived pending state
// ---------------------------------------------------------------------------

describe("pendingPermission (derived)", () => {
  it("is null with no requests", () => {
    expect(new PanelViewModel().state.pendingPermission).toBeNull();
  });

  it("is the request while it is unresolved", () => {
    const state = modelWithPending().state;
    expect(state.pendingPermission?.requestId).toBe("r1");
  });

  it("clears as soon as a resolution is merged in", () => {
    const model = modelWithPending();
    expect(model.state.pendingPermission).not.toBeNull();

    // The host re-sends the same item carrying its resolution.
    model.handle({
      type: "showPermissionRequest",
      item: permissionRequest({
        resolution: { behavior: "allow", updatedInput: {} },
      }),
    } as never);

    expect(model.state.pendingPermission).toBeNull();
    // ...and the record stays in the transcript.
    expect(model.state.items).toHaveLength(1);
  });

  it("is cleared by a denial as well as an approval", () => {
    const model = modelWithPending();
    model.handle({
      type: "showPermissionRequest",
      item: permissionRequest({
        resolution: { behavior: "deny", message: "no" },
      }),
    } as never);

    expect(model.state.pendingPermission).toBeNull();
  });

  it("returns the LOWEST-seq request when several are outstanding", () => {
    const model = new PanelViewModel();
    // Delivered out of order on purpose: the answer must follow `seq`, which is
    // the order the agent asked in, not arrival order.
    for (const [seq, requestId] of [
      [3, "third"],
      [1, "first"],
      [2, "second"],
    ] as const) {
      model.handle({
        type: "showPermissionRequest",
        item: permissionRequest({ id: `p${seq}`, seq, requestId }),
      } as never);
    }

    expect(model.state.pendingPermission?.requestId).toBe("first");
  });

  it("skips resolved requests to find the next outstanding one", () => {
    const model = new PanelViewModel();
    model.handle({
      type: "showPermissionRequest",
      item: permissionRequest({
        id: "p1",
        seq: 1,
        requestId: "done",
        resolution: { behavior: "allow", updatedInput: {} },
      }),
    } as never);
    model.handle({
      type: "showPermissionRequest",
      item: permissionRequest({ id: "p2", seq: 2, requestId: "next" }),
    } as never);

    expect(model.state.pendingPermission?.requestId).toBe("next");
  });
});

// ---------------------------------------------------------------------------
// Step 1 — the sticky bar
// ---------------------------------------------------------------------------

describe("PendingPermissionBar", () => {
  it("renders outside the transcript, in the composer", () => {
    const html = markup(modelWithPending());
    const transcriptEnd = html.indexOf('class="composer"');
    const barAt = html.indexOf("permission-bar");

    expect(barAt).toBeGreaterThan(-1);
    expect(transcriptEnd).toBeGreaterThan(-1);
    // The bar appears after the composer element opens, i.e. outside the
    // scrollable transcript — so no amount of scrolling can move it out of view.
    expect(barAt).toBeGreaterThan(transcriptEnd);
  });

  it("names the tool and shows what is being asked for", () => {
    const html = markup(modelWithPending());
    expect(html).toContain("Bash");
    expect(html).toContain("rm -rf build");
    expect(html).toContain("needs your approval");
  });

  it("announces itself as a live region, with no focus contract to break", () => {
    const html = markup(modelWithPending());
    // `alert` is announced on appearance and expects nothing of focus.
    expect(html).toContain('role="alert"');
    // NOT alertdialog: that promises focus has moved into it and is managed
    // there. Neither is true, and focusing "Allow" would put a destructive
    // command one stray Enter away.
    expect(html).not.toContain("alertdialog");
    expect(html).not.toContain("aria-modal");
    // The warning glyph is decorative; the adjacent text carries the meaning.
    expect(html).toContain('aria-hidden="true"');
  });

  it("announces the block exactly once, not on both surfaces", () => {
    const html = markup(modelWithPending());
    expect((html.match(/role="alert"/g) ?? []).length).toBe(1);
  });

  it("is absent once the request is resolved", () => {
    const model = modelWithPending();
    model.handle({
      type: "showPermissionRequest",
      item: permissionRequest({
        resolution: { behavior: "allow", updatedInput: {} },
      }),
    } as never);

    expect(markup(model)).not.toContain("permission-bar");
  });

  it("is absent when nothing is pending", () => {
    expect(markup(new PanelViewModel())).not.toContain("permission-bar");
  });

  it("falls back to the file path, then the tool name, for its summary", () => {
    const withPath = modelWithPending({
      toolName: "Write",
      command: undefined,
      input: { file_path: "src/app.ts", content: "x" },
    });
    expect(markup(withPath)).toContain("src/app.ts");

    const bare = modelWithPending({
      toolName: "SomeTool",
      command: undefined,
      input: {},
    });
    const html = markup(bare);
    expect(html).toContain("SomeTool");
  });

  it("tells the user the composer is blocked", () => {
    expect(markup(modelWithPending())).toContain("Waiting for your approval");
  });

  it("hides the tool-progress line while blocked, so the two cannot contradict", () => {
    const model = modelWithPending();
    model.handle({
      type: "toolProgress",
      toolName: "Bash",
      toolUseId: "t1",
      elapsedSeconds: 5,
    } as never);

    expect(markup(model)).not.toContain("tool-progress");
  });
});

// ---------------------------------------------------------------------------
// Step 3 — the redesigned card
// ---------------------------------------------------------------------------

describe("permission card", () => {
  it("marks an undecided card as blocking and alerts on it", () => {
    const html = markup(modelWithPending());
    expect(html).toContain("permission-blocking");
    // Conveyed by text, not by colour alone.
    expect(html).toContain("Needs approval");
  });

  it("marks a decided card as a record, not a call to action", () => {
    const model = modelWithPending();
    model.handle({
      type: "showPermissionRequest",
      item: permissionRequest({
        resolution: { behavior: "allow", updatedInput: {} },
      }),
    } as never);

    const html = markup(model);
    expect(html).toContain("permission-decided");
    expect(html).not.toContain("permission-blocking");
    expect(html).toContain("approved");
  });
});

// ---------------------------------------------------------------------------
// Step 2 — the forced scroll
//
// Needs a real client render: `useEffect` does not run under
// `renderToStaticMarkup`, so the SSR tests above cannot see this at all.
// ---------------------------------------------------------------------------

describe("scrolling to a blocked request", () => {
  /** Class names of the elements `scrollIntoView` was called on, in order. */
  let scrolled: string[];

  beforeEach(() => {
    scrolled = [];
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom does not implement scrollIntoView.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.className);
    } as typeof Element.prototype.scrollIntoView;
  });

  /** Mount App against a real container and return a re-render helper. */
  function mount(model: PanelViewModel) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (): void => {
      act(() => {
        root.render(
          createElement(App, {
            state: model.state,
            post: () => {},
            consumePendingInput: () => null,
          }) as ReactNode,
        );
      });
    };
    render();
    return { container, render };
  }

  it("scrolls the blocking card into view when a request arrives", () => {
    const model = new PanelViewModel();
    model.handle({
      type: "addMessage",
      item: { kind: "user", id: "u1", seq: 0, text: "do it" },
    } as never);
    const view = mount(model);
    scrolled.length = 0;

    model.handle({
      type: "showPermissionRequest",
      item: permissionRequest(),
    } as never);
    view.render();

    expect(
      scrolled.some((c) => c.includes("permission-blocking")),
      `expected a scroll to the blocking card, saw ${JSON.stringify(scrolled)}`,
    ).toBe(true);
  });

  it("does not re-scroll on unrelated updates while the SAME request is open", () => {
    const model = modelWithPending();
    const view = mount(model);
    scrolled.length = 0;

    // Assistant text continuing to stream must not keep yanking the view.
    for (const delta of ["a", "b", "c"]) {
      model.handle({
        type: "addMessage",
        item: { kind: "assistant", id: `a-${delta}`, seq: 2, text: delta },
      } as never);
      view.render();
    }

    expect(scrolled.filter((c) => c.includes("permission-blocking"))).toHaveLength(0);
  });

  it("scrolls again for a NEW request after the first is resolved", () => {
    const model = modelWithPending();
    const view = mount(model);

    model.handle({
      type: "showPermissionRequest",
      item: permissionRequest({
        resolution: { behavior: "allow", updatedInput: {} },
      }),
    } as never);
    view.render();
    scrolled.length = 0;

    model.handle({
      type: "showPermissionRequest",
      item: permissionRequest({ id: "p2", seq: 2, requestId: "r2" }),
    } as never);
    view.render();

    expect(scrolled.some((c) => c.includes("permission-blocking"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Which intent "Allow" carries
//
// For a file-edit tool the host must APPLY the edit (through VS Code's workspace
// edit API, so it is undoable and conflict-checked), which only happens for
// `approveEdit`. Posting `approvePermission` instead lets the agent proceed while
// the host silently skips the apply, the conflict check and the dirty-buffer
// review — and leaks the `pendingEdits` entry. So the intent is asserted per tool.
// ---------------------------------------------------------------------------

describe("Allow routing", () => {
  /** Click the first Allow button in a live render and return what was posted. */
  function clickAllow(model: PanelViewModel): WebviewToHostMessage[] {
    const posted: WebviewToHostMessage[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    act(() => {
      root.render(
        createElement(App, {
          state: model.state,
          post: (m: WebviewToHostMessage) => posted.push(m),
          consumePendingInput: () => null,
        }) as ReactNode,
      );
    });
    const button = container.querySelector<HTMLButtonElement>(".btn-allow");
    if (button === null) {
      throw new Error("no Allow button rendered");
    }
    act(() => {
      button.click();
    });
    return posted;
  }

  for (const toolName of ["Write", "Edit", "MultiEdit"]) {
    it(`posts approveEdit for ${toolName}, so the host applies it`, () => {
      const posted = clickAllow(
        modelWithPending({
          toolName,
          command: undefined,
          input: { file_path: "src/a.ts", content: "x" },
        }),
      );

      expect(posted).toEqual([{ type: "approveEdit", requestId: "r1" }]);
    });
  }

  for (const toolName of ["Bash", "Read", "WebFetch", "SomeMcpTool"]) {
    it(`posts approvePermission for ${toolName}`, () => {
      const posted = clickAllow(modelWithPending({ toolName }));

      expect(posted).toEqual([{ type: "approvePermission", requestId: "r1" }]);
    });
  }

  it("posts denyPermission for an edit tool as well", () => {
    // Denial is one path for every tool: there is nothing to apply.
    const model = modelWithPending({
      toolName: "Write",
      command: undefined,
      input: { file_path: "src/a.ts", content: "x" },
    });
    const posted: WebviewToHostMessage[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    act(() => {
      root.render(
        createElement(App, {
          state: model.state,
          post: (m: WebviewToHostMessage) => posted.push(m),
          consumePendingInput: () => null,
        }) as ReactNode,
      );
    });
    act(() => {
      container.querySelector<HTMLButtonElement>(".btn-deny")?.click();
    });

    expect(posted).toEqual([{ type: "denyPermission", requestId: "r1" }]);
  });

  it("offers the same intent in the bar as on the card", () => {
    // Both surfaces share `PermissionActions`, so they cannot diverge — pin it.
    const model = modelWithPending({
      toolName: "Edit",
      command: undefined,
      input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const posted: WebviewToHostMessage[] = [];
    act(() => {
      root.render(
        createElement(App, {
          state: model.state,
          post: (m: WebviewToHostMessage) => posted.push(m),
          consumePendingInput: () => null,
        }) as ReactNode,
      );
    });

    const allows = container.querySelectorAll<HTMLButtonElement>(".btn-allow");
    expect(allows.length).toBe(2); // one on the card, one in the bar
    act(() => {
      for (const b of allows) b.click();
    });

    // Identical intent from both. (The host resolves a request once, so the
    // second is rejected there rather than double-approving.)
    expect(posted).toEqual([
      { type: "approveEdit", requestId: "r1" },
      { type: "approveEdit", requestId: "r1" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Reopening the panel
// ---------------------------------------------------------------------------

describe("after a panel reopen", () => {
  it("brings the bar back for a request that is still unresolved", () => {
    // Closing the panel keeps the session alive; reopening replays history. If the
    // bar did not come back, the agent would be blocked with nothing on screen —
    // the original bug, reachable a second way.
    const model = new PanelViewModel();
    model.handle({
      type: "restoreHistory",
      items: [
        { kind: "user", id: "u1", seq: 0, text: "do it" },
        permissionRequest(),
      ],
    } as never);

    expect(model.state.pendingPermission?.requestId).toBe("r1");
    expect(markup(model)).toContain("permission-bar");
  });

  it("does not resurrect the bar for history that was already decided", () => {
    const model = new PanelViewModel();
    model.handle({
      type: "restoreHistory",
      items: [
        permissionRequest({
          resolution: { behavior: "allow", updatedInput: {} },
        }),
      ],
    } as never);

    expect(model.state.pendingPermission).toBeNull();
    expect(markup(model)).not.toContain("permission-bar");
  });
});

// ---------------------------------------------------------------------------
// Step 4 — the mode picker
// ---------------------------------------------------------------------------

describe("permission mode picker", () => {
  it("offers only modes the host will actually accept", () => {
    // The host validates against the wire schema and silently drops anything
    // else, so a typo here would produce a menu entry that does nothing. This
    // catches that at build time rather than in the UI.
    for (const mode of SELECTABLE_PERMISSION_MODES) {
      expect(
        PERMISSION_MODES as readonly string[],
        `${mode.value} is not a wire permission mode`,
      ).toContain(mode.value);
    }
  });

  it("orders the options least to most permissive", () => {
    expect(SELECTABLE_PERMISSION_MODES.map((m) => m.value)).toEqual([
      "plan",
      "default",
      "acceptEdits",
      "bypassPermissions",
    ]);
  });

  it("warns in the hint for the two modes that skip prompts", () => {
    const byValue = new Map(
      SELECTABLE_PERMISSION_MODES.map((m) => [m.value, m.hint]),
    );
    expect(byValue.get("acceptEdits")).toMatch(/without asking/i);
    expect(byValue.get("bypassPermissions")).toMatch(/no prompt/i);
  });

  it("renders a labelled picker showing the active mode", () => {
    const model = new PanelViewModel();
    model.handle({
      type: "setModelInfo",
      model: "sonnet",
      permissionMode: "acceptEdits",
    } as never);

    const html = markup(model);
    expect(html).toContain('id="mode-select"');
    // The risk tint is keyed off the active mode.
    expect(html).toContain("mode-acceptEdits");
    // Labelled for screen readers.
    expect(html).toContain('for="mode-select"');
  });

  it("still displays a mode that is in force but not offered", () => {
    // `rayucode.permissionMode` accepts modes the picker deliberately omits. The
    // picker must report the truth rather than silently showing a different mode.
    const model = new PanelViewModel();
    model.handle({
      type: "setModelInfo",
      model: "sonnet",
      permissionMode: "dontAsk",
    } as never);

    expect(markup(model)).toContain("dontAsk");
  });

  it("builds the host message with the selected mode", () => {
    expect(selectPermissionMode("plan")).toEqual({
      type: "selectPermissionMode",
      mode: "plan",
    });
  });
});
