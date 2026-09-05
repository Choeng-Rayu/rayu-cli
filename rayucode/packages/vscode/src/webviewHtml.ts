// Agent_Panel webview HTML shell (shared by every panel surface).
//
// Extracted from `vscodeAdapter.ts` so the TWO panel surfaces render byte-for-byte
// identical documents against the SAME strict CSP:
//
//   1. the floating `vscode.WebviewPanel`  (VSCodeAdapter.showAgentPanel), and
//   2. the Activity Bar `vscode.WebviewView` (RayucodePanelProvider).
//
// Keeping one renderer means a CSP or asset-path change can never drift between
// the two surfaces. This module touches only `vscode.Uri` / `vscode.Webview`
// (no session, protocol, or DOM logic).

import * as vscode from "vscode";

/**
 * Render the Agent_Panel HTML shell. The actual UI is the bundled webview
 * front-end (`dist/webview.js` + `dist/webview.css`, built by esbuild.mjs);
 * this document only loads them under a strict, no-remote-content CSP:
 *
 *   - `default-src 'none'` — nothing loads unless explicitly allowed below.
 *   - `script-src 'nonce-…'` — ONLY the one bundled script bearing this
 *     request's nonce may execute; no inline handlers, no remote scripts.
 *   - `style-src ${cspSource}` — only the host-served stylesheet (no inline
 *     styles, so no 'unsafe-inline').
 *   - `img-src/font-src` — host-served (+ data: images) only.
 *
 * Both asset URIs are produced with {@link vscode.Webview.asWebviewUri} so they
 * resolve through the webview's locked-down resource origin (the surface's
 * `localResourceRoots` is the extension root), and no remote content is ever
 * referenced (R3.1 panel surface; supports the panel's sanitized rendering).
 */
export function renderPanelHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const nonce = makeNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.js"),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.css"),
  );

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri.toString()}" />
    <title>rayucode</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
  </body>
</html>`;
}

/**
 * The webview options every Agent_Panel surface is created with. Scripts are
 * enabled (the panel IS the bundled front-end) and resource loading is confined
 * to the extension directory, so the strict CSP above has nothing else to allow.
 */
export function panelWebviewOptions(
  extensionUri: vscode.Uri,
): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [extensionUri],
  };
}

/** Generate a CSP nonce for the bundled webview script (task 13.1). */
export function makeNonce(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}
