const vscode = require('vscode')
const fs = require('node:fs')
const path = require('node:path')
exports.run = async () => {
  const directory = process.env.RAYUCODE_UI_CONTROL
  const extension = vscode.extensions.getExtension('rayu-dev.rayucode')
  if (!extension) throw new Error('Packaged Rayucode extension was not loaded')
  await extension.activate()
  await vscode.commands.executeCommand('workbench.view.extension.rayucode')
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
            const before = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'rayucode-pre-edit')
            const after = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath.endsWith('fixture.txt'))
            result = { before: before?.getText(), after: after?.getText() }
          }
        } catch (error) { result = { error: String(error) } }
        fs.writeFileSync(path.join(directory, `response-${request.id}.json`), JSON.stringify(result))
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
