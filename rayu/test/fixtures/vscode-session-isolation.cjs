const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { randomUUID } = require('node:crypto')
const [bundle, directory, mode] = process.argv.slice(2)
process.env.RAYU_CONFIG_DIR = path.join(directory, 'config')
process.env.RAYUCODE_AUTH_CONFIG_DIR = path.join(directory, 'config')
const disposable = () => ({ dispose() {} })
const emitter = () => {
  const listeners = new Set()
  return {
    event: callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) } },
    fire: value => { for (const listener of listeners) listener(value) },
    dispose: () => listeners.clear(),
  }
}
const fileUri = value => ({ fsPath: value, path: value, scheme: 'file', toString: () => `file://${value}` })
const panels = []
function createPanel() {
  const received = emitter(), changed = emitter(), disposed = emitter()
  const panel = {
    messages: [], active: true, title: 'Session',
    webview: { options: {}, cspSource: 'test:', asWebviewUri: uri => uri,
      postMessage: message => { panel.messages.push(message); return Promise.resolve(true) },
      onDidReceiveMessage: received.event },
    onDidChangeViewState: changed.event, onDidDispose: disposed.event,
    reveal: () => changed.fire({ webviewPanel: panel }), dispose: () => disposed.fire(),
  }
  panels.push(panel)
  return panel
}
/** The sidebar `WebviewView` provider, captured at registration so it can be resolved. */
let sidebarProvider
/** A `WebviewView` for the sidebar, capturing everything the host posts to it. */
function createSidebarView() {
  const received = emitter(), disposed = emitter()
  const view = {
    messages: [],
    webview: { options: {}, cspSource: 'test:', asWebviewUri: uri => uri,
      postMessage: message => { view.messages.push(message); return Promise.resolve(true) },
      onDidReceiveMessage: received.event },
    onDidDispose: disposed.event,
    show: () => {},
  }
  return view
}
let serializer
const vscode = {
  EventEmitter: class { constructor() { Object.assign(this, emitter()) } },
  Uri: { file: fileUri, joinPath: (base, ...parts) => fileUri(path.join(base.fsPath, ...parts)),
    parse: value => ({ ...fileUri(value), toString: () => value }) },
  ViewColumn: { Active: -1 }, FileType: { File: 1, Directory: 2 },
  window: { createWebviewPanel: createPanel,
    registerWebviewViewProvider: (_id, provider) => { sidebarProvider = provider; return disposable() },
    registerWebviewPanelSerializer: (_type, value) => { serializer = value; return disposable() },
    registerUriHandler: disposable, onDidChangeActiveTextEditor: disposable,
    onDidChangeTextEditorSelection: disposable, showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined, showErrorMessage: async () => undefined },
  workspace: { workspaceFolders: [{ uri: fileUri(directory) }], registerTextDocumentContentProvider: disposable },
  commands: { registerCommand: disposable, executeCommand: async () => undefined },
  env: { machineId: 'fixture', clipboard: { readText: async () => '', writeText: async () => {} } },
}
const attachments = []
let holdConnection = false
const pendingConnections = []
globalThis.__attach = async (target, callbacks) => {
  const calls = []
  const handle = {
    pid: target.pid, sessionId: target.sessionId, capabilities: null,
    submitPrompt: async text => { calls.push(['prompt', text]); return 'operation' },
    askSideQuestion: async text => { calls.push(['side', text]); return 'answer' },
    respondPermission: (...args) => calls.push(['permission', ...args]),
    stopTask: async id => calls.push(['stop', id]),
    sendTaskMessage: async (id, text) => calls.push(['task', id, text]),
    detach: () => { calls.push(['detach']); callbacks.onClosed() },
  }
  attachments.push({ handle, callbacks, calls })
  if (holdConnection) {
    holdConnection = false
    return new Promise(resolve => pendingConnections.push(() => resolve(handle)))
  }
  return handle
}
const requireFromRoot = createRequire(path.resolve('package.json'))
const mod = { exports: {} }
vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(bundle, 'utf8')}\n})`)(
  name => name === 'vscode' ? vscode : requireFromRoot(name), mod, mod.exports,
)
const context = { globalStorageUri: fileUri(directory), extensionUri: fileUri(directory),
  extension: { packageJSON: { version: '0.0.0' } }, subscriptions: [] }
mod.exports.activate(context)
const host = globalThis.__host
const scope = entry => host.scopeFor('panel', entry.key)
function open(entry) {
  host.surfaces.openPanel(entry.key)
  return panels.at(-1)
}
function stateFor(panel) {
  return panel.messages.reduce((state, message) =>
    ['init', 'setSurfaceBinding', 'setLiveSessions', 'addMessage'].includes(message.type)
      ? host.chatReducer(state, message) : state, host.initialChatState)
}
function target(pid) {
  return { pid, sessionId: randomUUID(), cwd: directory, startedAt: Date.now(), ipcAddress: 'fixture', ipcToken: 'fixture' }
}
async function run() {
  const fresh = host.registry.active
  const panel = open(fresh)
  const id = randomUUID()
  fresh.session.handleEngineMessage({ type: 'system', subtype: 'init', session_id: id, model: 'fixture' })
  fresh.session.handleEngineMessage({ type: 'assistant', session_id: id, uuid: randomUUID(),
    message: { content: [{ type: 'text', text: 'Saved answer' }] } })
  const saved = stateFor(panel).surfaceBinding
  assert.equal(saved.sessionId, id, 'new engine id must reach persisted panel state')
  const project = host.getProjectDir(directory)
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, `${id}.jsonl`), JSON.stringify({ type: 'assistant', sessionId: id,
    uuid: randomUUID(), cwd: directory, message: { role: 'assistant', content: 'Saved answer' } }) + '\n')
  host.registry.close(fresh.key)
  const revivedPanel = createPanel()
  await serializer.deserializeWebviewPanel(revivedPanel, saved)
  const revived = host.registry.findByEngineSessionId(id)
  assert.ok(revived, 'serializer must resume the saved engine session')
  assert.ok(revived.session.transcript.some(entry => entry.text === 'Saved answer'), 'reload restores transcript')

  const outsideCwd = path.join(directory, 'other-project')
  const outside = host.registry.create({ resumeSessionId: randomUUID(), cwd: outsideCwd })
  assert.equal(host.stateForEntry(outside, 'panel').surfaceBinding.cwd, outsideCwd, 'binding must use its own cwd')

  const owner = host.registry.create()
  owner.session.restoreTranscript([{ kind: 'prompt', text: 'Owner original' }])
  const other = host.registry.create()
  other.session.restoreTranscript([{ kind: 'prompt', text: 'Other original' }])
  const standalone = []
  other.session.submitPrompt = async text => standalone.push(['prompt', text])
  other.session.stopBackgroundTask = async id => standalone.push(['stop', id])
  const firstTarget = target(100)
  host.setAttachTargets([firstTarget])
  await host.handlers.attachToSession(scope(owner), firstTarget.pid)
  const first = attachments.at(-1)
  const ownerPanel = open(owner)
  owner.session.interrupt = async () => first.calls.push(['wrong-local-interrupt'])
  host.handlers.interrupt(scope(owner))
  assert.deepEqual(first.calls, [], 'interrupt must not target the dormant local engine')
  assert.match(ownerPanel.messages.at(-1).message, /attached CLI terminal/)
  first.callbacks.onTaskUnsupported('fixture version skew')
  assert.equal(host.stateForEntry(owner, 'panel').taskInspectionSupported, false)
  assert.equal(host.stateForEntry(other, 'panel').taskInspectionSupported, true, 'capabilities remain session-scoped')
  await host.handlers.submitPrompt(scope(other), 'Other prompt')
  assert.deepEqual(standalone, [['prompt', 'Other prompt']], 'unattached tab uses its own engine')
  assert.deepEqual(first.calls, [], 'unattached tab must not send to attached CLI')
  await host.handlers.stopTask(scope(other), 'other-session', 'task-other')
  assert.deepEqual(standalone.at(-1), ['stop', 'task-other'])
  host.handlers.detachFromSession(scope(other))
  assert.deepEqual(first.calls, [], 'unrelated detach must not touch the owner')
  assert.equal(host.stateForEntry(other, 'panel').attachment.attached, null)
  await host.handlers.submitPrompt(scope(owner), 'Owner prompt')
  assert.deepEqual(first.calls, [['prompt', 'Owner prompt']])
  owner.permissions.present({ requestId: 'local-permission', request: { tool_name: 'Bash', input: { command: 'true' } } })
  first.callbacks.onPermissionRequest({ requestId: 'mirrored-permission', toolName: 'Bash', input: {} })

  const secondTarget = target(200)
  host.setAttachTargets([secondTarget])
  await host.handlers.attachToSession(scope(other), secondTarget.pid)
  const second = attachments.at(-1)
  assert.deepEqual(owner.session.transcript.map(entry => entry.text), ['Owner original'], 'replacement restores previous owner')
  assert.deepEqual(owner.permissions.snapshot().map(request => request.requestId), ['local-permission'], 'detach dismisses only mirrored permissions')
  first.callbacks.onActivity([{ type: 'assistant', message: { role: 'assistant', content: 'late old activity' } }])
  first.callbacks.onClosed()
  assert.equal(host.stateForEntry(other, 'panel').attachment.attached.pid, secondTarget.pid, 'stale closure cannot detach replacement')
  assert.deepEqual(owner.session.transcript.map(entry => entry.text), ['Owner original'], 'stale activity is ignored')
  host.handlers.detachFromSession(scope(other))
  assert.deepEqual(other.session.transcript.map(entry => entry.text), ['Other original'], 'detach restores only its owner')

  // A connection may finish after a detach or session retirement. It must close,
  // rather than reinstall itself or apply late history to the restored conversation.
  holdConnection = true
  host.setAttachTargets([firstTarget])
  const pending = host.handlers.attachToSession(scope(other), firstTarget.pid)
  while (!pendingConnections.length) await new Promise(resolve => setImmediate(resolve))
  const late = attachments.at(-1)
  const localCallsBefore = standalone.length
  await host.handlers.submitPrompt(scope(other), 'While connecting')
  await host.handlers.stopTask(scope(other), 'other-session', 'task-other')
  assert.equal(standalone.length, localCallsBefore, 'pending attachment cannot dispatch a local turn')
  host.handlers.detachFromSession(scope(other))
  pendingConnections.shift()()
  await pending
  assert.deepEqual(late.calls, [['detach']], 'late connection is disposed')
  assert.deepEqual(other.session.transcript.map(entry => entry.text), ['Other original'])

  host.setAttachTargets([secondTarget])
  await host.handlers.attachToSession(scope(other), secondTarget.pid)
  const acknowledging = attachments.at(-1)
  let acknowledge
  acknowledging.handle.submitPrompt = () => new Promise(resolve => { acknowledge = resolve })
  const submitting = host.handlers.submitPrompt(scope(other), 'Late acknowledged prompt')
  host.handlers.detachFromSession(scope(other))
  acknowledge('late-operation')
  await submitting
  assert.deepEqual(other.session.transcript.map(entry => entry.text), ['Other original'], 'late prompt ack cannot contaminate restored transcript')

  host.setAttachTargets([secondTarget])
  await host.handlers.attachToSession(scope(other), secondTarget.pid)
  const closing = attachments.at(-1)
  const keysBeforeClose = host.registry.all.map(entry => entry.key).filter(key => key !== other.key)
  host.registry.close(other.key)
  assert.deepEqual(closing.calls, [['detach']], 'retiring attachment owner disconnects it')
  assert.deepEqual(host.registry.all.map(entry => entry.key), keysBeforeClose, 'retirement does not create an extra session')

  const bound = host.registry.create()
  const boundPanel = open(bound)
  host.registry.create()
  const boundState = stateFor(boundPanel)
  assert.equal(boundState.activeSessionKey, bound.key, 'global active changes must not rebind a panel')
  assert.equal(boundState.surfaceBinding.sessionKey, bound.key)
  const sidebar = host.chatReducer({ ...host.initialChatState, surface: 'sidebar' },
    { type: 'setLiveSessions', sessions: [], activeKey: 'sidebar-target' })
  assert.equal(sidebar.activeSessionKey, 'sidebar-target', 'sidebar still follows global active key')

  // The sidebar must receive a SIDEBAR-flavoured snapshot. It used to be built from the
  // panel snapshot builder, so the sidebar briefly mounted the conversation — a duplicate
  // of the editor tab — and re-laid-out as the flavour flipped back (the "whole UI reload").
  const sidebarView = createSidebarView()
  sidebarProvider.resolveWebviewView(sidebarView)
  sidebarView.messages.length = 0
  const activeEntry = host.registry.active
  const activePanel = open(activeEntry)
  activePanel.messages.length = 0
  host.surfaces.syncSession(activeEntry.key)
  const sidebarInit = sidebarView.messages.filter(message => message.type === 'init').at(-1)
  assert.ok(sidebarInit, 'the sidebar must receive an init for the active session')
  assert.equal(sidebarInit.state.surface, 'sidebar',
    'the sidebar must never receive a panel-flavoured snapshot')
  const panelInit = activePanel.messages.filter(message => message.type === 'init').at(-1)
  assert.ok(panelInit, 'the tab must receive an init for its own session')
  assert.equal(panelInit.state.surface, 'panel', 'a tab must still receive a panel-flavoured snapshot')
  console.log('session isolation checks passed')
}
async function runFirstLogin() {
  const entry = host.registry.active
  const panel = open(entry)
  const starts = path.join(directory, 'starts.log')
  const frames = path.join(directory, 'frames.log')
  const ready = path.join(directory, 'provider-ready')
  fs.writeFileSync(path.join(directory, 'engine.mjs'), `
    import { appendFileSync, existsSync } from 'node:fs'
    import { createInterface } from 'node:readline'
    appendFileSync(${JSON.stringify(starts)}, process.pid + '\\n')
    if (!existsSync(${JSON.stringify(ready)})) {
      console.error('fixture: provider was read before login finished'); process.exit(23)
    }
    createInterface({ input: process.stdin }).on('line', line => {
      const frame = JSON.parse(line)
      appendFileSync(${JSON.stringify(frames)}, line + '\\n')
      if (frame.type !== 'control_request') return
      const response = frame.request.subtype === 'initialize' ? { commands: [], models: [], agents: [] } : {}
      process.stdout.write(JSON.stringify({ type: 'control_response',
        response: { subtype: 'success', request_id: frame.request_id, response } }) + '\\n')
    })
  `)
  let finishLogin, finishRefresh, logins = 0, refreshes = 0
  globalThis.__login = () => { logins++; return new Promise(resolve => { finishLogin = resolve }) }
  globalThis.__refreshModels = () => { refreshes++; return new Promise(resolve => { finishRefresh = resolve }) }
  const tick = () => new Promise(resolve => setTimeout(resolve, 30))
  const until = async predicate => {
    const deadline = Date.now() + 5000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for first-login fixture')
      await tick()
    }
  }

  const login = host.signInToRayucode(entry)
  const repeatedLogin = host.signInToRayucode(entry)
  globalThis.__authChanged()
  globalThis.__providersChanged()
  const prompt = host.handlers.submitPrompt(scope(entry), 'hi')
  await tick()
  assert.equal(logins, 1, 'repeated sign-in must share the same login helper')
  assert.equal(refreshes, 0, 'intermediate auth writes must not refresh providers yet')
  assert.equal(fs.existsSync(starts), false, 'first prompt must wait for the login helper')

  finishLogin({ ok: true, displayName: 'Fixture user' })
  await until(() => refreshes === 1)
  await tick()
  assert.equal(fs.existsSync(starts), false, 'first prompt must also wait for model preparation')
  fs.writeFileSync(ready, 'ready')
  finishRefresh({ ok: true, catalogue: [] })
  await Promise.all([login, repeatedLogin, prompt])
  await until(() => fs.existsSync(frames) && fs.readFileSync(frames, 'utf8').includes('"type":"user"'))
  const received = fs.readFileSync(frames, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(fs.readFileSync(starts, 'utf8').trim().split('\n').length, 1, 'warmup and prompt must share one engine')
  assert.equal(received.filter(frame => frame.request?.subtype === 'initialize').length, 1)
  assert.equal(received.filter(frame => frame.type === 'user').length, 1, 'first prompt must be delivered once')
  assert.equal(entry.session.transcript.filter(item => item.kind === 'notice' && item.severity === 'error').length, 0)
  assert.equal(panel.messages.filter(item => item.type === 'showError').length, 0)

  globalThis.__login = async () => ({ ok: false, error: 'fixture login cancelled' })
  await host.signInToRayucode(entry)
  assert.equal(refreshes, 1, 'failed login must not run model preparation')
  console.log('first login checks passed')
}

(mode === 'first-login' ? runFirstLogin() : run()).catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  for (const subscription of context.subscriptions.reverse()) subscription.dispose()
})
