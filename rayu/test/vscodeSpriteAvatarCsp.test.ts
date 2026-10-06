/**
 * The animated per-status avatar's sprite asset is CSP-compliant end to end.
 *
 * ── WHY THIS IS WORTH A TEST, NOT JUST A REVIEW ────────────────────────────────
 *
 * `chatViewProvider.ts`'s `render()` is `private`, and every other assertion so
 * far about it (CSS hygiene, VSIX contents in `test/vscodeBundles.test.ts`) is
 * indirect — none of them render the ACTUAL HTML the panel would load and check
 * it against the ACTUAL Content-Security-Policy header on the SAME string. A
 * webview whose img-src forgot `webview.cspSource`, or whose sprite URI used a
 * scheme the policy does not list, would look correct in isolated review and
 * still silently fail to display a single pixel in a real editor — exactly the
 * kind of gap a static read cannot catch and a real render can.
 *
 * This drives `ChatViewProvider.resolveWebviewView()` — the one path that calls
 * `render()` — through a minimal mock of `vscode.WebviewView`/`vscode.Uri` that
 * implements only what that path touches, and inspects the real returned HTML
 * string.
 */
import { describe, expect, mock, test } from 'bun:test'

class FakeUri {
  constructor(
    public readonly fsPath: string,
    public readonly scheme: string = 'file',
  ) {}
  toString(): string {
    return this.scheme === 'file' ? `file://${this.fsPath}` : this.fsPath
  }
  static file(path: string): FakeUri {
    return new FakeUri(path)
  }
  static joinPath(base: FakeUri, ...segments: string[]): FakeUri {
    return new FakeUri([base.fsPath, ...segments].join('/'), base.scheme)
  }
}

mock.module('vscode', () => ({
  Uri: FakeUri,
  window: {
    showQuickPick: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
  },
  workspace: {
    workspaceFolders: [],
  },
}))

const { ChatViewProvider } = await import('../src/vscode/host/panel/chatViewProvider.js')

/** A webview whose `asWebviewUri`/`cspSource` mirror VS Code's real conversion closely
 *  enough for this test: a `vscode-webview://<authority>/<path>` URI, and a matching
 *  `cspSource` scheme+authority — the two things a real CSP check depends on agreeing. */
function fakeWebview(): {
  webview: { html: string; options: unknown; asWebviewUri: (u: FakeUri) => FakeUri; cspSource: string; onDidReceiveMessage: (cb: unknown) => { dispose(): void } }
  onDidDispose: (cb: unknown) => void
} {
  const webview = {
    html: '',
    options: undefined as unknown,
    cspSource: 'vscode-webview://abc123',
    asWebviewUri: (uri: FakeUri) =>
      new FakeUri(`vscode-webview://abc123${uri.fsPath}`, 'webview') as unknown as FakeUri,
    onDidReceiveMessage: (_cb: unknown) => ({ dispose() {} }),
  }
  return { webview, onDidDispose: (_cb: unknown) => {} }
}

describe('the sprite avatar asset survives the real CSP the panel serves', () => {
  test('render() emits an img-src that covers the injected sprite URI scheme', () => {
    const extensionUri = FakeUri.file('/fake/extension/root')
    const provider = new ChatViewProvider(
      extensionUri as never,
      () => ({}) as never,
      {} as never,
    )

    const view = fakeWebview()
    provider.resolveWebviewView(view as never)

    const html = view.webview.html
    expect(html.length).toBeGreaterThan(0)

    // The CSP header itself, extracted from the meta tag exactly as a browser would read it.
    const cspMatch = html.match(/Content-Security-Policy" content="([^"]+)"/)
    expect(cspMatch, 'render() must emit a CSP meta tag').not.toBeNull()
    const csp = cspMatch![1]!

    // The custom property carrying the resolved sprite URI, exactly as SpriteAvatar.tsx
    // reads it via var(--rc-sprite-goose-url).
    const spriteVarMatch = html.match(/--rc-sprite-goose-url:\s*url\("([^"]+)"\)/)
    expect(spriteVarMatch, 'render() must set --rc-sprite-goose-url').not.toBeNull()
    const spriteUri = spriteVarMatch![1]!

    // The actual compliance check: the URI's own scheme+authority must be covered by
    // img-src. This is the exact failure mode a real editor would hit silently — a CSP
    // that lists the wrong source shows a broken image with no console error a casual
    // click-through would notice.
    const imgSrcMatch = csp.match(/img-src ([^;]+)/)
    expect(imgSrcMatch, 'CSP must declare img-src').not.toBeNull()
    const imgSrc = imgSrcMatch![1]!
    expect(imgSrc).toContain('vscode-webview://abc123')
    expect(spriteUri.startsWith('vscode-webview://abc123')).toBe(true)

    // The sprite path itself must point at media/sprite-goose.png — the exact file
    // build-vscode.ts stages — not some other name that would 404 inside the packaged
    // extension even though the CSP itself was satisfied.
    expect(spriteUri).toContain('/media/sprite-goose.png')
  })

  test('render() still emits its existing script/style CSP allowances unchanged', () => {
    // A regression guard specifically for "the sprite addition broke something already
    // working" — the nonce-gated script-src and the style-src that already carries
    // 'unsafe-inline' for the sprite var's own inline <style> tag.
    const extensionUri = FakeUri.file('/fake/extension/root')
    const provider = new ChatViewProvider(extensionUri as never, () => ({}) as never, {} as never)
    const view = fakeWebview()
    provider.resolveWebviewView(view as never)
    const html = view.webview.html

    expect(html).toMatch(/script-src 'nonce-[A-Za-z0-9]+'/)
    expect(html).toContain("style-src vscode-webview://abc123 'unsafe-inline'")
    // The nonce on the <script> tag must be the SAME nonce the CSP allows — a mismatch
    // would silently block the entire webview script from ever running.
    const cspNonce = html.match(/script-src 'nonce-([A-Za-z0-9]+)'/)?.[1]
    const scriptNonce = html.match(/<script nonce="([A-Za-z0-9]+)"/)?.[1]
    expect(cspNonce).toBeTruthy()
    expect(cspNonce).toBe(scriptNonce)
  })

  test('render() allows no remote images and a fresh unguessable nonce per load', () => {
    // A remote image is the classic prompt-injection exfiltration channel: a URL whose
    // query string carries conversation data, fetched the moment it renders.
    const extensionUri = FakeUri.file('/fake/extension/root')
    const provider = new ChatViewProvider(extensionUri as never, () => ({}) as never, {} as never)
    const first = fakeWebview()
    const second = fakeWebview()
    provider.resolveWebviewView(first as never)
    provider.resolveWebviewView(second as never)

    const imgSrc = first.webview.html.match(/img-src ([^;"]+)/)?.[1] ?? ''
    expect(imgSrc).not.toContain('https:')
    expect(imgSrc).not.toContain('http:')
    expect(imgSrc).not.toContain('*')

    const nonceOf = (html: string) => html.match(/script-src 'nonce-([A-Za-z0-9]+)'/)?.[1]
    expect(nonceOf(first.webview.html)?.length).toBeGreaterThanOrEqual(32)
    expect(nonceOf(first.webview.html)).not.toBe(nonceOf(second.webview.html))
  })
})


/**
 * Delivery wiring: what `post()` and `syncState()` put on the real `webview.postMessage`.
 *
 * Here rather than in its own file because this file owns the `vscode` mock that
 * `ChatViewProvider` needs. Bun's module mocks are process-wide, so a second file mocking
 * `vscode` with a different shape can break whichever of the two loads first.
 */
describe('ChatViewProvider delivery to the webview', () => {
  function liveView(): {
    view: unknown
    posted: unknown[]
    disposeView: () => void
  } {
    const posted: unknown[] = []
    let onDispose: () => void = () => {}
    const { webview } = fakeWebview()
    const view = {
      webview: {
        ...webview,
        postMessage: (message: unknown) => {
          posted.push(message)
          return Promise.resolve(true)
        },
      },
      onDidDispose: (callback: () => void) => {
        onDispose = callback
      },
    }
    return { view, posted, disposeView: () => onDispose() }
  }

  function provider() {
    return new ChatViewProvider(
      FakeUri.file('/fake/extension/root') as never,
      () => ({ marker: 'state' }) as never,
      {} as never,
    )
  }

  test('streamed deltas arrive merged, and before the init snapshot that follows them', () => {
    const panel = provider()
    const { view, posted } = liveView()
    panel.resolveWebviewView(view as never)

    panel.post({ type: 'appendPartial', id: 'a', kind: 'text', delta: 'Hel' })
    panel.post({ type: 'appendPartial', id: 'a', kind: 'text', delta: 'lo' })
    // Held for the frame: one per-token message each would be the cost being removed.
    expect(posted).toEqual([])

    // `init` replaces the transcript. The deltas it already contains must land before it,
    // or the webview would append them to the fresh snapshot a second time.
    panel.syncState()
    expect(posted).toEqual([
      { type: 'appendPartial', id: 'a', kind: 'text', delta: 'Hello' },
      { type: 'init', state: { marker: 'state' } },
    ])
    panel.dispose()
  })

  test('held deltas are dropped with their view, never delivered to its replacement', async () => {
    const panel = provider()
    const first = liveView()
    panel.resolveWebviewView(first.view as never)

    panel.post({ type: 'appendPartial', id: 'a', kind: 'text', delta: 'held' })
    first.disposeView()
    panel.post({ type: 'appendPartial', id: 'a', kind: 'text', delta: 'after' })
    expect(panel.isOpen).toBe(false)

    // VS Code recreates the view. It starts from `init`; the old view's held deltas must
    // not be flushed into it when the merge timer fires.
    const second = liveView()
    panel.resolveWebviewView(second.view as never)
    // Well past the 33 ms merge window, so an armed timer would have fired by now.
    await new Promise(resolve => setTimeout(resolve, 80))

    expect(first.posted).toEqual([])
    expect(second.posted).toEqual([])
    panel.dispose()
  })
})
