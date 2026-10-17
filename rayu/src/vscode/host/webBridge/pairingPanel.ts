import * as vscode from 'vscode'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { PAIRING_QR_FLAG } from '../../shared/pairingProtocol.js'
import { guestPairingStatus, stopGuestPairing } from '../../../webBridge/guestPairing.js'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

/** VS Code-specific QR display; pairing and token handling remain shared with the CLI. */
function renderQrInEngine(enginePath: string, url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [enginePath, PAIRING_QR_FLAG], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    const timeout = setTimeout(() => child.kill(), 10_000)
    child.stdout.on('data', chunk => {
      output += String(chunk)
      if (output.length > 100_000) child.kill()
    })
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', code => {
      clearTimeout(timeout)
      if (code !== 0) return reject(new Error('Could not generate a pairing QR code'))
      try {
        const image = (JSON.parse(output) as { image?: unknown }).image
        if (typeof image !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(image)) {
          throw new Error('Invalid QR image')
        }
        resolve(image)
      } catch (error) {
        reject(error)
      }
    })
    child.stdin.end(JSON.stringify({ url }))
  })
}

export async function showBridgePairingPanel(enginePath: string, url: string, expiresAt: string): Promise<void> {
  const target = new URL(url)
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('Invalid Studio pairing URL')
  }
  let image: string
  try {
    image = await renderQrInEngine(enginePath, url)
  } catch (error) {
    if (guestPairingStatus()?.url === url) stopGuestPairing()
    throw error
  }
  if (guestPairingStatus()?.url !== url) return
  const nonce = randomBytes(16).toString('hex')
  const panel = vscode.window.createWebviewPanel(
    'rayucodeBridgePairing',
    'Pair Rayucode with Studio',
    vscode.ViewColumn.Active,
    { enableScripts: true },
  )
  wirePairingPanel(panel, url, expiresAt)
  panel.webview.html = renderPairingPanelHtml(image, url, expiresAt, nonce)
}

function wirePairingPanel(panel: vscode.WebviewPanel, url: string, expiresAt: string): void {
  const update = () => {
    const pair = guestPairingStatus()
    const samePair = pair?.url === url
    const approved = samePair && pair.status === 'connected'
    const waiting = samePair && pair.status === 'waiting' && Date.parse(expiresAt) > Date.now()
    const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000))
    void panel.webview.postMessage({
      type: 'pairing-status', approved, waiting,
      message: approved ? 'Machine approved. Select it in Studio to start working.'
        : waiting ? `Waiting for approval · QR expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
          : samePair && pair.error ? pair.error : 'Pairing closed or expired. Run /web-bridge pair for a new QR code.',
    })
  }
  const timer = setInterval(update, 1_000)
  timer.unref?.()
  const messages = panel.webview.onDidReceiveMessage((message: unknown) =>
    handlePairingPanelMessage(panel, url, expiresAt, update, message))
  panel.onDidDispose(() => {
    clearInterval(timer)
    messages.dispose()
    const pair = guestPairingStatus()
    if (pair?.url === url && pair.status !== 'connected') stopGuestPairing()
  })
}

function handlePairingPanelMessage(panel: vscode.WebviewPanel, url: string, expiresAt: string, update: () => void, message: unknown): void {
  const type = (message as { type?: unknown } | null)?.type
  if (type === 'ready') return update()
  if (type === 'close') return panel.dispose()
  const pair = guestPairingStatus()
  if (pair?.url !== url) return
  const waiting = pair.status === 'waiting' && Date.parse(expiresAt) > Date.now()
  if (type === 'open' && (waiting || pair.status === 'connected')) {
    const link = new URL(url)
    if (pair.status === 'connected') link.searchParams.delete('pair')
    void Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(link.toString()))).catch(() => {
      void vscode.window.showErrorMessage('Could not open Studio. Copy the pairing link and open it in your browser.')
    })
  } else if (type === 'copy' && waiting) {
    void Promise.resolve(vscode.env.clipboard.writeText(url)).then(() => panel.webview.postMessage({ type: 'copied' })).catch(() => {
      void vscode.window.showErrorMessage('Could not copy the link. Select and copy the pairing URL shown below the QR code.')
    })
  }
}

function renderPairingPanelHtml(image: string, url: string, expiresAt: string, nonce: string): string {
  return `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:24px;max-width:620px;margin:auto}
    img{width:min(280px,100%);height:auto;background:white;padding:8px;border-radius:12px;box-sizing:border-box}code{word-break:break-all}
    p{line-height:1.5}button{font:inherit;padding:8px 14px;border:1px solid var(--vscode-button-border,transparent);border-radius:3px;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
    button:hover{background:var(--vscode-button-hoverBackground)}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}button:disabled{opacity:.5;cursor:default}
    .actions{display:flex;flex-wrap:wrap;gap:8px}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}[hidden]{display:none}</style></head><body>
    <h1>Pair this worker with Rayu Studio</h1>
    <p>Scan the QR code while signed in to Studio, then approve this machine there.</p>
    <p id="status" role="status" aria-live="polite">Waiting for Studio approval…</p>
    <img id="qr" src="${image}" alt="Scan to pair this machine with Studio">
    <div class="actions"><button id="open">Open Studio</button><button id="copy" class="secondary">Copy pairing link</button><button id="close" class="secondary">Cancel pairing</button></div>
    <p><code>${escapeHtml(url)}</code></p>
    <p>Expires ${escapeHtml(new Date(expiresAt).toLocaleString())}. This grants control of this worker session only; it does not sign the worker into Rayu.</p>
    <script nonce="${nonce}">
      const host = acquireVsCodeApi();
      for (const type of ['open','copy','close']) document.getElementById(type).addEventListener('click', () => host.postMessage({type}));
      window.addEventListener('message', ({data}) => {
        if (data.type === 'copied') { document.getElementById('copy').textContent = 'Link copied'; return; }
        if (data.type !== 'pairing-status') return;
        document.getElementById('status').textContent = data.message;
        document.getElementById('qr').hidden = !data.waiting;
        document.getElementById('copy').disabled = !data.waiting;
        document.getElementById('open').disabled = !data.waiting && !data.approved;
        document.getElementById('close').textContent = data.approved ? 'Done' : 'Cancel pairing';
      });
      host.postMessage({type:'ready'});
    </script></body></html>`
}
