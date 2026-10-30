/**
 * The surface abstraction: the HTML every chat webview shares, the view type of an
 * editor session tab, and the `ChatSurface` contract the host pushes state through.
 *
 * ── ONE PLACE BUILDS THE HTML, SO ONE PLACE OWNS THE CSP ───────────────────────
 *
 * `renderWebviewHtml` is the single assembly point for both the sidebar view and each
 * editor panel. That matters because the CSP is a SECURITY boundary, not presentation:
 * the transcript renders MODEL OUTPUT and TOOL OUTPUT, so the policy has to be
 * identical everywhere. Duplicating the assembly would let a panel ship a weaker policy
 * than the sidebar, or reuse a nonce, defeating `default-src 'none'`.
 *
 * ── THE WEBVIEW IS A BROWSER, AND IS TREATED AS UNTRUSTED ──────────────────────
 *
 * 1. STRICT CSP WITH A PER-LOAD NONCE. `default-src 'none'` denies everything, then
 *    scripts are allowed only with a nonce generated fresh for this exact page load.
 *    A nonce cannot be guessed by content generated before the nonce existed.
 * 2. NO SECRETS CROSS THE BOUNDARY. The host holds the access token and never sends it.
 */
import { randomBytes } from 'node:crypto'

import * as vscode from 'vscode'

import type {
  ChatSurfaceKind,
  HostToWebviewMessage,
  WebviewState,
} from '../../shared/webviewProtocol.js'

/** Stable `viewType` for a per-session editor tab. Also the serializer registration key. */
export const SESSION_PANEL_VIEW_TYPE = 'rayucode.sessionChat'

/**
 * One place the host pushes state to: the sidebar view or one editor panel.
 *
 * A surface is always bound to exactly one session key (the sidebar's binding follows
 * `registry.activeSessionKey`), so callers do not pass a key to `post` — the surface
 * already knows whose state it renders.
 */
export interface ChatSurface {
  readonly kind: ChatSurfaceKind
  readonly isOpen: boolean
  post(message: HostToWebviewMessage): void
  postState(state: WebviewState): void
  reveal(): Promise<void>
  dispose(): void
}

/** Which React app a page mounts: the chat (sidebar and tabs) or the Settings tab. */
export type WebviewApp = 'chat' | 'settings'

/**
 * Panel/container HTML with a fresh nonce and the same CSP as the sidebar.
 *
 * The CSP is byte-identical in policy to the sidebar's current one — see the note in
 * the body for why each allowance is the narrowest that still works. Every page —
 * sidebar, session tabs, the Settings tab — is built here, so they cannot drift apart.
 */
export function renderWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  options: { app?: WebviewApp } = {},
): string {
  const app = options.app ?? 'chat'
  const nonce = createNonce()
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'webview.js'),
  )
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'webview.css'),
  )
  // VS Code's own icon font (staged by build-vscode.ts), so the panel's icons are the
  // editor's. `font-src` below already allows the webview's own resources.
  const codiconUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'codicon.css'),
  )
  // Staged as media/sprite-goose.png (see build-vscode.ts) — the animated
  // per-status avatar's source atlas. `webview.css` is a static file with no
  // access to `webview.asWebviewUri()`'s runtime resolution, so this cannot be
  // a plain `url()` inside it; the resolved URI is threaded in as a CSS custom
  // property via the inline style block below instead, which the CSP already
  // permits ('unsafe-inline' on style-src, added for VS Code's own injected
  // theme block — this reuses that same allowance, not a new one).
  const spriteUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'sprite-goose.png'),
  )

  // `default-src 'none'` first, then the narrowest possible allowances.
  // `style-src` needs 'unsafe-inline' because VS Code itself injects the theme
  // variable block inline; that is the editor's own style element, not content.
  // `img-src` has no `https:`: nothing in the panel loads a remote image, and a
  // remote image is the classic prompt-injection exfiltration channel (a URL whose
  // query string carries conversation data). The markdown sanitiser already drops
  // `<img>`; this keeps that true even if its allowlist ever regresses.
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${codiconUri}" rel="stylesheet" />
<link href="${styleUri}" rel="stylesheet" />
<style>:root { --rc-sprite-goose-url: url("${spriteUri}"); }</style>
<title>${app === 'settings' ? 'Rayucode Settings' : 'Rayucode'}</title>
</head>
<body>
<div id="root" data-app="${app}"></div>
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`
}

/**
 * A fresh nonce per page load.
 *
 * Regenerated on every `renderWebviewHtml` call rather than cached: a nonce reused
 * across loads could be embedded in content captured from an earlier one, which
 * defeats the point of having it. From the CSPRNG, not `Math.random()`, whose output
 * is predictable from earlier values — a guessable nonce is no nonce. Hex so the value
 * is safe inside both the CSP header and the attribute.
 */
function createNonce(): string {
  return randomBytes(16).toString('hex')
}
