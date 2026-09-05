// Agent panel webview entry point (React).
//
// Runs inside the webview's browser-like context, NOT Node. It is thin glue
// between three pieces, exactly as the previous entry point was:
//
//   - the host messaging channel (`acquireVsCodeApi`),
//   - the pure {@link PanelViewModel}, which folds host messages by `seq`,
//   - the React tree, which paints the model and posts user intents back.
//
// All ordering and protocol logic stays in the pure model so it remains testable
// in Node. This file only does I/O wiring.

import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { App } from "./App.js";
import { isHostMessage } from "./protocol.js";
import type { WebviewToHostMessage } from "./protocol.js";
import { PanelViewModel } from "./viewModel.js";

/**
 * The minimal VS Code webview API surface, provided at runtime by the global
 * `acquireVsCodeApi()` (callable exactly once). Declared locally so the webview
 * module graph never imports `vscode`.
 */
interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();
const model = new PanelViewModel();

const container = document.getElementById("app") ?? document.body;
const root: Root = createRoot(container);

const post = (message: WebviewToHostMessage): void => {
  api.postMessage(message);
};

const consumePendingInput = (): string | null => model.consumePendingInput();

function render(): void {
  root.render(
    <StrictMode>
      <App
        state={model.state}
        post={post}
        consumePendingInput={consumePendingInput}
      />
    </StrictMode>,
  );
}

// Registered synchronously on load, so it is live within the first tick — before
// any host message (for example an immediate `restoreHistory`) can arrive.
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data;
  // Unrecognised payloads are ignored rather than trusted: the webview treats
  // everything arriving on this channel as untrusted input.
  if (!isHostMessage(message)) {
    return;
  }
  model.handle(message);
  render();
});

render();
