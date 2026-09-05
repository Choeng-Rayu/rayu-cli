// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "../src/webview/App.js";
import { isHostMessage } from "../src/webview/protocol.js";
import { PanelViewModel } from "../src/webview/viewModel.js";

// Webview resilience against malformed host → webview messages.
//
// The webview's `window.addEventListener("message")` handler folds each inbound
// message into the view model and repaints. A THROW there is not a contained
// failure: it aborts the handler, the repaint never happens, and the panel is
// left frozen on stale content with no error shown — the user sees a hung agent.
//
// The host is our own code, so a malformed message is a bug rather than an
// attack, but a webview is a separate JS context reachable by any `postMessage`,
// and `isHostMessage` only validates the `type` discriminant — every other field
// is consumed unchecked. These tests pin that a wrong-shaped message degrades
// instead of bricking the panel.

/** Every host→webview message type, paired with a deliberately wrong payload. */
const MALFORMED_BY_TYPE: Record<string, unknown[]> = {
  restoreHistory: [{}, { items: null }, { items: "nope" }, { items: [null] }],
  addMessage: [{}, { item: null }, { item: "nope" }, { item: { kind: "???" } }],
  appendPartial: [{}, { itemId: null }, { itemId: "a", delta: null }],
  completeMessage: [{}, { itemId: null }],
  setGenerating: [{}, { generating: "yes" }],
  showPermissionRequest: [{}, { item: null }, { item: {} }],
  showToolAction: [{}, { item: null }, { item: {} }],
  updateToolStatus: [{}, { itemId: null }, { itemId: "a", status: null }],
  showUsage: [{}, { usage: null }, { usage: {}, totalCostUsd: "free" }],
  setModelInfo: [{}, { model: 42 }, { model: null, permissionMode: 7 }],
  setModelList: [{}, { models: null }, { models: "x" }, { models: [null] }],
  setMcpStatus: [{}, { servers: null }, { servers: "x" }, { servers: [null] }],
  showError: [{}, { message: null }, { message: 42 }],
  editApplied: [{}, { path: null }],
  editConflict: [{}, { paths: null }, { paths: "x", requestId: null }],
  insertPrompt: [{}, { text: null }, { text: 42 }],
};

describe("PanelViewModel resilience to malformed host messages", () => {
  it("covers every declared host message type", () => {
    // Keeps this suite honest if the core's union grows.
    for (const type of Object.keys(MALFORMED_BY_TYPE)) {
      expect(isHostMessage({ type }), `${type} should be a known type`).toBe(
        true,
      );
    }
  });

  it("never throws on a wrong-shaped payload for any message type", () => {
    for (const [type, payloads] of Object.entries(MALFORMED_BY_TYPE)) {
      for (const payload of payloads) {
        const model = new PanelViewModel();
        const message = { type, ...(payload as Record<string, unknown>) };
        expect(
          () => model.handle(message as never),
          `${type} with ${JSON.stringify(payload)} threw`,
        ).not.toThrow();
      }
    }
  });

  it("keeps rendering usable after a malformed message", () => {
    const model = new PanelViewModel();

    model.handle({ type: "addMessage", item: null } as never);
    // A good message after a bad one must still land.
    model.handle({
      type: "addMessage",
      item: { kind: "user", id: "u1", seq: 0, text: "hello" },
    } as never);

    const items = model.state.items;
    expect(items.some((item) => item.id === "u1")).toBe(true);
  });

  it("ignores messages whose type is not in the known set", () => {
    const model = new PanelViewModel();
    for (const message of [
      { type: "notAThing" },
      { type: "__proto__" },
      { type: "constructor" },
      { type: "toString" },
    ]) {
      expect(isHostMessage(message)).toBe(false);
      expect(() => model.handle(message as never)).not.toThrow();
    }
  });

  it("does not let a hostile message pollute Object.prototype", () => {
    const model = new PanelViewModel();
    const hostile = JSON.parse(
      '{"type":"addMessage","item":{"kind":"user","id":"x","seq":0,"text":"t","__proto__":{"polluted":"yes"}}}',
    );

    model.handle(hostile as never);

    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("survives a deeply nested payload without stack overflow", () => {
    const model = new PanelViewModel();
    let nested: Record<string, unknown> = { kind: "user", id: "d", seq: 0, text: "t" };
    for (let i = 0; i < 5_000; i += 1) {
      nested = { wrapped: nested };
    }

    expect(() =>
      model.handle({ type: "addMessage", item: nested } as never),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// React rendering resilience
//
// Folding a message without throwing is only half the guarantee. The App
// component reads the folded state and renders it — the header renders the MCP
// strip and model picker BEFORE the conversation, so a bad value there would
// skip the whole render, exactly the freeze this is meant to prevent. These
// tests drive the real React renderer via renderToStaticMarkup, so a throw
// inside any component is caught.
// ---------------------------------------------------------------------------

/** Items that are well-keyed but carry a malformed payload for their kind. */
const MALFORMED_ITEMS: Record<string, unknown>[] = [
  { kind: "usage", id: "u-null", seq: 1, usage: null, totalCostUsd: 0 },
  { kind: "usage", id: "u-cost", seq: 2, usage: {}, totalCostUsd: "free" },
  { kind: "usage", id: "u-missing", seq: 3 },
  { kind: "usage", id: "u-nan", seq: 4, usage: {}, totalCostUsd: Number.NaN },
  { kind: "notice", id: "n-null", seq: 5, level: "warn", message: null },
  // An unknown kind the renderer degrades to null via its default branch.
  { kind: "brand-new-kind", id: "x1", seq: 6 },
];

describe("App rendering resilience", () => {
  /** Render the App with the given view model's state, return the HTML string. */
  function renderApp(vm: PanelViewModel): string {
    return renderToStaticMarkup(
      createElement(App, {
        state: vm.state,
        post: () => undefined,
        consumePendingInput: () => null,
      }),
    );
  }

  it("renders the panel after an unrecognised message type", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "definitely_not_real" } as never);
    const html = renderApp(vm);
    expect(html).toContain("panel");
  });

  it("renders null for an unknown conversation item kind", () => {
    const vm = new PanelViewModel();
    vm.handle({
      type: "addMessage",
      item: { kind: "not_a_real_kind", id: "x", seq: 1 } as never,
    } as never);
    // Unknown kind renders nothing, but the transcript container is still present.
    const html = renderApp(vm);
    expect(html).toContain("transcript");
  });

  it("still renders a valid message after a malformed setMcpStatus (no frozen panel)", () => {
    const vm = new PanelViewModel();
    // The reported freeze: system/init without mcp_servers becomes setMcpStatus
    // with a non-array, which in the old dom.ts threw during the repaint and
    // silently left the panel frozen on stale content.
    vm.handle({ type: "setMcpStatus", servers: null } as never);
    vm.handle({
      type: "addMessage",
      item: { kind: "user", id: "u1", seq: 1, text: "still working" },
    } as never);
    const html = renderApp(vm);
    expect(html).toContain("still working");
  });

  it("renders a malformed usage payload without throwing", () => {
    const vm = new PanelViewModel();
    // Components use formatCost / formatTokens which guard non-finite values.
    vm.handle({ type: "showUsage", usage: null, totalCostUsd: "free" } as never);
    expect(() => renderApp(vm)).not.toThrow();
  });

  it("renders a malformed model list without throwing", () => {
    const vm = new PanelViewModel();
    // viewModel coerces non-arrays to [] so the header's model select loop is safe.
    vm.handle({ type: "setModelList", models: "not-an-array" } as never);
    expect(() => renderApp(vm)).not.toThrow();
  });

  it("renders every well-keyed but malformed item without throwing", () => {
    for (const item of MALFORMED_ITEMS) {
      const vm = new PanelViewModel();
      vm.handle({ type: "addMessage", item } as never);
      expect(
        () => renderApp(vm),
        `rendering ${JSON.stringify(item).slice(0, 70)} threw`,
      ).not.toThrow();
    }
  });

  it("isolates a malformed item so subsequent valid items still render", () => {
    const vm = new PanelViewModel();
    for (const item of MALFORMED_ITEMS) {
      vm.handle({ type: "addMessage", item } as never);
    }
    vm.handle({
      type: "addMessage",
      item: { kind: "user", id: "good", seq: 999, text: "still rendered" },
    } as never);
    const html = renderApp(vm);
    expect(html).toContain("still rendered");
  });

  it("renders malformed history without throwing (the persistent-freeze case)", () => {
    const vm = new PanelViewModel();
    // Exactly what restoreHistory does on every panel reopen.
    vm.handle({
      type: "restoreHistory",
      items: [
        { kind: "usage", id: "u1", seq: 1, usage: null, totalCostUsd: "free" },
        { kind: "user", id: "u2", seq: 2, text: "after the bad item" },
      ],
    } as never);
    const html = renderApp(vm);
    expect(html).toContain("after the bad item");
  });
});
