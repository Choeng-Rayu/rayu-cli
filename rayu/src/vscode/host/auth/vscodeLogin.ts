/**
 * Signing in from the editor.
 *
 * The extension's login transport reuses the shared Rayu login implementation. The
 * credential it produces is independent: the login writes through
 * `rayuSession.ts` to the Rayucode authentication profile selected by the extension.
 * It does not change the terminal CLI's account session.
 *
 * ── WHY LOGIN RUNS IN A CHILD PROCESS ──────────────────────────────────────────
 *
 * `loginRayu()` is the CLI's login: a 127.0.0.1 loopback server, the `/cli/token`
 * exchange, the CSRF `state` check, the entitlements warm-up, the API-key/OAuth
 * mutual exclusion, and activating the hosted provider. All of that is exactly the
 * behaviour we want without duplicating authentication logic in the editor.
 *
 * But importing it here is not an option. Measured with the project's own build
 * config: `loginRayu`'s graph costs 19.7 MB and drags in React, because
 * `utils/browser.ts` → `execFileNoThrow.ts` → `utils/log.ts` reaches the Anthropic
 * SDK and the terminal UI. Twenty megabytes of unrenderable React in the extension
 * host, to open a URL. The session reader this module's sibling uses is 448 KB by
 * comparison.
 *
 * So the engine bundle — which already contains all of it — is spawned with
 * `--rayucode-login`, does the work, and reports back over stdout. One-off,
 * user-initiated, off the startup path.
 *
 * ── WHAT STAYS IN THE EDITOR ───────────────────────────────────────────────────
 *
 * Opening the browser, and only that. `vscode.env.asExternalUri` on a
 * `http://127.0.0.1:<port>` URI asks VS Code to set up port forwarding, which is
 * what makes the callback reachable from a LOCAL browser when the extension host is
 * REMOTE. A child process shelling out to `xdg-open` would open a browser on the
 * wrong machine. This is why the URL has to come back out to the host at all.
 *
 * The remote case still has a limit: the redirect target is baked into the login URL
 * by the website, so a setup where the site cannot reach the forwarded port fails.
 * The durable fix is a `vscode://` URI handler with PKCE, which needs a `redirect`
 * parameter on the rayu-web login page. Until then this reports a clear timeout
 * rather than hanging.
 */
import { spawn } from 'node:child_process'

import * as vscode from 'vscode'

import { LOGIN_FLAG } from '../../shared/loginProtocol.js'
import { NdjsonReader } from '../engine/ndjsonReader.js'

/** The website's own login timeout is 5 minutes; allow a little more than that. */
const LOGIN_TIMEOUT_MS = 6 * 60 * 1000

export interface SignInOutcome {
  ok: boolean
  /** Present on success, when the account carries one. */
  displayName?: string | null
  /** Present on failure — already user-facing. */
  error?: string
}

export interface SignInOptions {
  /** Absolute path to the bundled `engine.mjs`. */
  enginePath: string
  /** Working directory for the child. Any real directory will do. */
  cwd: string
}

/**
 * Run an interactive sign-in.
 *
 * Progress is shown in the notification area rather than blocking the panel: the
 * browser round-trip takes as long as the user takes to click, and a frozen UI
 * would look like a hang.
 */
export async function signInFromEditor(
  options: SignInOptions,
): Promise<SignInOutcome> {
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Rayu: waiting for browser sign-in…',
      cancellable: true,
    },
    async (_progress, token) => await runLoginChild(options, token),
  )
}

function runLoginChild(
  options: SignInOptions,
  token: vscode.CancellationToken,
): Promise<SignInOutcome> {
  return new Promise<SignInOutcome>(resolve => {
    let settled = false
    let stderrTail = ''

    const child = spawn(process.execPath, [options.enginePath, LOGIN_FLAG], {
      cwd: options.cwd,
      env: {
        ...process.env,
        // The extension host's execPath is the Electron binary, not Node. This is
        // what makes it behave as the Node it embeds, with no dependency on a
        // `node` being present on the user's PATH.
        ELECTRON_RUN_AS_NODE: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    function finish(outcome: SignInOutcome): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
      resolve(outcome)
    }

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error:
          'the browser sign-in timed out. If this workspace is remote, the login ' +
          'page may not be able to reach the forwarded callback port.',
      })
    }, LOGIN_TIMEOUT_MS)
    timer.unref?.()

    token.onCancellationRequested(() => {
      finish({ ok: false, error: 'sign-in was cancelled' })
    })

    const reader = new NdjsonReader({
      onFrame: frame => {
        const parsed = frame as Record<string, unknown>
        if (parsed.type === 'rayucode_login_url' && typeof parsed.url === 'string') {
          void openLoginUrl(parsed.url)
          return
        }
        if (parsed.type === 'rayucode_login_result') {
          finish(
            parsed.ok === true
              ? {
                  ok: true,
                  displayName:
                    typeof parsed.displayName === 'string' ? parsed.displayName : null,
                }
              : {
                  ok: false,
                  error:
                    typeof parsed.error === 'string' ? parsed.error : 'unknown error',
                },
          )
        }
      },
      onError: error => {
        finish({ ok: false, error: `login channel error: ${error.message}` })
      },
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => reader.push(chunk))
    child.stdout.on('end', () => reader.end())

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2_000)
    })

    child.on('error', err => {
      finish({ ok: false, error: `could not start the login helper: ${err.message}` })
    })

    // Exiting without a result frame means the helper died. Reporting the stderr
    // tail is the difference between an actionable error and "sign-in failed".
    child.on('close', code => {
      finish({
        ok: false,
        error:
          `the login helper exited (code ${code}) without completing.` +
          (stderrTail.trim() ? ` ${stderrTail.trim().slice(-400)}` : ''),
      })
    })
  })
}

/**
 * Hand the login URL to the editor.
 *
 * `asExternalUri` is what makes this work over Remote-SSH and in browser-based
 * editors. Passing the raw URL to `openExternal` would open a URL pointing at the
 * REMOTE machine's loopback, which the local browser cannot reach.
 *
 * Failure surfaces with a copy action, so the user can open it manually instead of
 * being left with a spinner and no explanation.
 */
async function openLoginUrl(url: string): Promise<void> {
  try {
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(url))
    const opened = await vscode.env.openExternal(external)
    if (!opened) throw new Error('the editor declined to open the URL')
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    const COPY = 'Copy sign-in link'
    const choice = await vscode.window.showWarningMessage(
      `Rayu could not open your browser (${detail}). Open the sign-in link manually.`,
      COPY,
    )
    if (choice === COPY) await vscode.env.clipboard.writeText(url)
  }
}
