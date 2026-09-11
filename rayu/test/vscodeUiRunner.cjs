const vscode = require('vscode')
const fs = require('node:fs')
const path = require('node:path')
exports.run = async () => {
  const directory = process.env.RAYUCODE_UI_CONTROL
  const extension = vscode.extensions.getExtension('RayuCode.rayucode')
  if (!extension) throw new Error('Packaged Rayucode extension was not loaded')
  await extension.activate()
  // The driver connects to Chromium before this creates the out-of-process
  // webview. Otherwise recent Electron builds can omit an already-existing
  // webview target from Playwright's frame tree even though it is visible.
  const driverDeadline = Date.now() + 60000
  while (!fs.existsSync(path.join(directory, 'driver-ready'))) {
    if (fs.existsSync(path.join(directory, 'done'))) return
    if (Date.now() > driverDeadline) throw new Error('UI driver did not connect')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  await vscode.commands.executeCommand('workbench.view.extension.rayucode')
  await vscode.commands.executeCommand('rayucode.chat.focus')
  fs.writeFileSync(path.join(directory, 'ready'), 'ready')
  const end = Date.now() + 240000
  let lastRequest = 0
  while (!fs.existsSync(path.join(directory, 'done'))) {
    if (Date.now() > end) throw new Error('UI driver did not finish')
    const file = path.join(directory, 'request.json')
    if (fs.existsSync(file)) {
      const request = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (request.id > lastRequest) {
        lastRequest = request.id
        let result = {}
        try {
          if (request.action === 'theme') await vscode.workspace.getConfiguration('workbench').update('colorTheme', request.theme, vscode.ConfigurationTarget.Global)
          if (request.action === 'diff') {
            // `vscode.diff` resolves after scheduling the editors; give the content
            // provider a moment to materialize both documents before reading them.
            const deadline = Date.now() + 5000
            while (Date.now() < deadline) {
              const before = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'rayucode-pre-edit')
              const after = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath.endsWith('fixture.txt'))
              if (before && after) {
                result = { before: before.getText(), after: after.getText() }
                break
              }
              await new Promise(resolve => setTimeout(resolve, 100))
            }
            if (!result.before && !result.after) result = { error: 'Diff documents were not materialized' }
          }
        } catch (error) { result = { error: String(error) } }
        fs.writeFileSync(path.join(directory, `response-${request.id}.json`), JSON.stringify(result))
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
