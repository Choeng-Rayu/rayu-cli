import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sharedBuildOptions, EXTERNAL } from '../../scripts/bundleConfig.js'
const directory = process.argv[2]!
const firstLogin = process.argv[3] === 'first-login'
const shared = sharedBuildOptions()
const build = await Bun.build({
  ...shared,
  entrypoints: [resolve('src/vscode/host/extension.ts')],
  outdir: directory,
  target: 'node',
  format: 'cjs',
  external: [...EXTERNAL, 'vscode'],
  plugins: [{
    name: 'isolated-host-services',
    setup(builder) {
      builder.onLoad({ filter: /\/vscode\/host\/extension\.ts$/ }, args => {
        let source = readFileSync(args.path, 'utf8')
        source = source.replace('  const idePromise = startIdeServer(version)', '  const idePromise = Promise.resolve(null)')
        if (!firstLogin) {
          source = source.replace('  const registry = new SessionRegistry(', '  ChatSession.prototype.warmup = async () => {}\n  const registry = new SessionRegistry(')
        }
        const marker = '  // A window reload destroys every `SessionPanel`'
        if (!source.includes(marker)) throw new Error('Host fixture marker missing')
        source = source.replace(marker, `  globalThis.__host = {
          registry, surfaces, handlers, scopeFor, stateForEntry, signInToRayucode,
          chatReducer, initialChatState, getProjectDir,
          setAttachTargets: targets => { attachTargets = targets },
        }\n${marker}`)
        return {
          contents: `import { chatReducer, initialChatState } from '../webview/state/reducer.js'\nimport { getProjectDir } from '../../utils/sessionStoragePortable.js'\n${source}`,
          loader: 'ts',
        }
      })
      builder.onLoad({ filter: /\/vscode\/host\/attach\/cliAttachment\.ts$/ }, args => ({
        contents: readFileSync(args.path, 'utf8').replace(
          '  let connection: IpcConnection',
          '  return globalThis.__attach(target, callbacks)\n  let connection: IpcConnection',
        ),
        loader: 'ts',
      }))
      builder.onLoad({ filter: /\/vscode\/host\/auth\/signInGate\.ts$/ }, () => ({
        contents: 'export function checkTurnAllowed() { return { allowed: true } }',
        loader: 'ts',
      }))
      if (firstLogin) {
        builder.onLoad({ filter: /\/vscode\/host\/auth\/vscodeLogin\.ts$/ }, () => ({
          contents: 'export async function signInFromEditor() { return globalThis.__login() }',
          loader: 'ts',
        }))
        builder.onLoad({ filter: /\/vscode\/host\/auth\/authWatcher\.ts$/ }, () => ({
          contents: `export function watchSharedSession(onChange, onProvidersChange) {
            globalThis.__authChanged = onChange
            globalThis.__providersChanged = onProvidersChange
            return { dispose() {} }
          }`,
          loader: 'ts',
        }))
        builder.onLoad({ filter: /\/vscode\/host\/auth\/providerSetup\.ts$/ }, args => ({
          contents: readFileSync(args.path, 'utf8').replace(
            "return runConnectChild(options, { action: 'models', model })",
            'return globalThis.__refreshModels()',
          ),
          loader: 'ts',
        }))
      }
    },
  }, ...(shared.plugins ?? [])],
})
if (!build.success) throw new Error(build.logs.join('\n'))
