// Agent_Panel webview entry point (task 13.1).
//
// Runs inside the webview's browser-like context (NOT Node). It is the thin
// glue that connects three pure pieces:
//   - the host messaging channel (`acquireVsCodeApi`),
//   - the pure {@link PanelViewModel} (folds host messages into render state),
//   - the {@link PanelView} (paints the model + posts user intents back).
//
// Everything protocol- or ordering-related lives in the pure modules so it can
// be unit-tested in Node (task 13.2); this file only does I/O wiring and has no
// logic of its own.

import { PanelView } from "./dom.js";
import { isHostMessage } from "./protocol.js";
import type { WebviewToHostMessage } from "./protocol.js";
import { PanelViewModel } from "./viewModel.js";

/**
 * The minimal VS Code webview API surface. Provided by the host at runtime via
 * the global `acquireVsCodeApi()` (callable exactly once). Declared locally so
 * the webview module graph never imports `vscode`.
 */
interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const model = new PanelViewModel();
const root = document.getElementById("app") ?? document.body;
const view = new PanelView(root, (message: WebviewToHostMessage) => {
  vscode.postMessage(message);
});

// The whole module runs synchronously on load, so this listener is live within
// the first tick — before any host message (e.g. an immediate `restoreHistory`)
// can be dispatched, since those arrive only as async events.
window.addEventListener("message", (event: MessageEvent) => {
  const data: unknown = event.data;
  if (!isHostMessage(data)) {
    return;
  }
  model.handle(data);
  view.update(model);
});

// Paint the initial (empty) state.
view.update(model);
