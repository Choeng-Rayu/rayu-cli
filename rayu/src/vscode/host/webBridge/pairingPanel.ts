import * as vscode from 'vscode'
import { spawn } from 'node:child_process'
import { PAIRING_QR_FLAG } from '../../shared/pairingProtocol.js'

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
        if (typeof image !== 'string' || !image.startsWith('data:image/png;base64,')) {
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
  const image = await renderQrInEngine(enginePath, url)
  const panel = vscode.window.createWebviewPanel(
    'rayucodeBridgePairing',
    'Pair Rayucode with Studio',
    vscode.ViewColumn.Active,
    { enableScripts: false },
  )
  panel.webview.html = `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:24px;max-width:620px;margin:auto}
    img{width:280px;height:280px;background:white;padding:8px;border-radius:12px}code{word-break:break-all}
    p{line-height:1.5}</style></head><body>
    <h1>Pair this worker with Rayu Studio</h1>
    <p>Scan the QR code while signed in to Studio, then approve this machine there.</p>
    <img src="${image}" alt="Pairing QR code">
    <p><code>${escapeHtml(url)}</code></p>
    <p>Expires ${escapeHtml(new Date(expiresAt).toLocaleString())}. This grants control of this worker session only; it does not sign the worker into Rayu.</p>
    </body></html>`
}
