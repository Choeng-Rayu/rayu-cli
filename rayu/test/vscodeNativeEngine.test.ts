/**
 * The compiled engine in a platform VSIX behaves like engine.mjs.
 *
 * A platform VSIX runs the same entrypoint compiled into a Bun executable, so the one
 * thing that can differ is the RUNTIME. This drives the real packaged binary through the
 * host's own `ChatSession` and native launch — streaming, a Read, an Edit, a Bash call
 * and a permission round-trip — against a local provider, exactly as
 * vscodeRealEngine.test.ts does for engine.mjs.
 *
 * Runs when the VSIX for this machine has been built:
 *   bun run build:vscode --target linux-x64      (or darwin-arm64, win32-x64, …)
 */
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import { resolveEngineLaunch, withLaunchEnv } from '../src/vscode/host/engine/engineLaunch.js'
import { resolveRipgrep } from '../src/vscode/host/engine/ripgrepLocation.js'
import { sessionCallbacks, until } from './helpers/vscodeSession.js'
import { startLocalProvider } from './helpers/localProvider.js'
import pkg from '../package.json'

const target = `${process.platform}-${process.arch}`
const vsix = resolve(import.meta.dir, `../dist/rayucode-${pkg.version}-${target}.vsix`)

test.if(existsSync(vsix))(`the ${target} compiled engine streams, runs tools and answers permissions`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rayucode-native-engine-'))
  const provider = await startLocalProvider()
  let session: ChatSession | undefined
  try {
    expect(spawnSync('unzip', ['-q', vsix, '-d', dir]).status).toBe(0)
    // The same decision the extension makes at activation.
    const { launch } = resolveEngineLaunch({
      extensionRoot: join(dir, 'extension'),
      platform: process.platform,
      execPath: process.execPath,
    })
    expect(launch.runtime).toBe('native')

    const config = join(dir, 'config')
    mkdirSync(config)
    writeFileSync(join(config, 'providers.json'), JSON.stringify({ activeProvider: 'test', providers: [{ id: 'test', kind: 'openai-compatible', baseURL: provider.url, apiKey: 'fixture-key', defaultModel: 'test-model', fetchedModels: ['test-model'], modelContextWindows: { 'test-model': 32000 } }] }))
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ permissions: { allow: ['Read', 'Bash(true)'] } }))
    writeFileSync(join(dir, 'fixture.txt'), 'before\n')

    const errors: string[] = []
    const deltas: string[] = []
    const permissionTools: string[] = []
    let finished = false
    session = new ChatSession({
      launch,
      cwd: dir,
      env: { RAYU_CONFIG_DIR: config, RAYU_AUTH_CONFIG_DIR: config, USE_RAYU_OAUTH: 'false', RAYU_EXTERNAL_AGENTS: '0' },
    }, sessionCallbacks({
      onError: error => errors.push(error),
      onPartial: (_id, kind, delta) => { if (kind === 'text') deltas.push(delta) },
      onTurnState: running => { if (!running) finished = true },
      // Edit is NOT pre-allowed, so the engine must ask and wait for this answer.
      onPermissionRequest: request => {
        permissionTools.push(String(request.request.tool_name))
        session!.controlClient!.respond(request.requestId, { behavior: 'allow', updatedInput: request.request.input })
      },
    }))
    await session.submitPrompt('Read fixture.txt, change before to after, run true, then summarize.')
    await until(() => finished || errors.length > 0, 60_000)

    expect(errors).toEqual([])
    expect(permissionTools).toContain('Edit')
    expect(readFileSync(join(dir, 'fixture.txt'), 'utf8')).toBe('after\n')
    expect(deltas.join('')).toContain('The check passed.')
    const tools = session.transcript.filter(entry => entry.kind === 'tool')
    expect(tools.find(entry => entry.name === 'Bash')).toMatchObject({ status: 'done' })
  } finally {
    session?.dispose()
    await provider.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    rmSync(dir, { recursive: true, force: true })
  }
}, 90_000)

/**
 * A provider that asks for one Grep, then repeats what the tool returned. Streaming
 * OpenAI chat completions, the same wire format the fixture provider above uses.
 */
function startGrepProvider(pattern: string): { url: string; stop: () => void } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/models')) return Response.json({ data: [{ id: 'test-model' }] })
      if (!url.pathname.endsWith('/chat/completions')) return new Response('', { status: 404 })
      const body = await req.json() as { model: string; stream?: boolean; messages: Array<{ role: string; content: unknown }> }
      // Side requests (titles, token counts) are not streamed. Answering them with SSE
      // makes the engine misjudge the context size and compact in a loop.
      if (!body.stream) {
        return Response.json({ id: 'side', choices: [{ message: { role: 'assistant', content: 'Fixture summary' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
      }
      const result = body.messages.find(m => m.role === 'tool')
      // Usage is reported on the final chunk, as OpenAI does with `include_usage`. Without
      // it the engine has to estimate the context size, and its estimate for this tiny
      // fixture model trips auto-compaction.
      const chunk = (delta: unknown, finish: string | null = null): string =>
        `data: ${JSON.stringify({ id: 'grep', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 100, completion_tokens: 10 } } : {}) })}\n\n`
      const events = result
        ? [chunk({ role: 'assistant', content: `Grep returned: ${JSON.stringify(result.content)}` }), chunk({}, 'stop')]
        : [chunk({ role: 'assistant', content: '' }), chunk({ tool_calls: [{ index: 0, id: 'grep-1', type: 'function', function: { name: 'Grep', arguments: JSON.stringify({ pattern, output_mode: 'files_with_matches' }) } }] }), chunk({}, 'tool_calls')]
      return new Response(`${events.join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

test.if(existsSync(vsix) && process.platform !== 'win32')(
  `the ${target} VSIX searches with its bundled ripgrep when PATH has none`,
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rayucode-native-grep-'))
    const pattern = 'needle-7c1d'
    const provider = startGrepProvider(pattern)
    let session: ChatSession | undefined
    try {
      expect(spawnSync('unzip', ['-q', vsix, '-d', dir]).status).toBe(0)
      const extensionRoot = join(dir, 'extension')
      // A PATH with a shell and nothing else, so no system `rg` can be found.
      const bin = join(dir, 'path-bin')
      mkdirSync(bin)
      for (const tool of ['sh', 'bash']) symlinkSync(Bun.which(tool)!, join(bin, tool))
      expect(Bun.which('rg', { PATH: bin })).toBeNull()

      // The same two decisions the extension makes at activation.
      const ripgrep = resolveRipgrep({ extensionRoot, platform: process.platform, arch: process.arch })
      expect(ripgrep.source).toBe('bundled')
      const launch = withLaunchEnv(
        resolveEngineLaunch({ extensionRoot, platform: process.platform, execPath: process.execPath }).launch,
        { RAYU_RIPGREP_PATH: ripgrep.path! },
      )

      const workspace = join(dir, 'workspace')
      mkdirSync(workspace)
      writeFileSync(join(workspace, 'haystack.txt'), `hay\n${pattern}\nhay\n`)
      const config = join(dir, 'config')
      mkdirSync(config)
      // A context window well above the request's 32k output budget: at 32k the
      // auto-compact threshold is zero, and the engine compacts before every request.
      writeFileSync(join(config, 'providers.json'), JSON.stringify({ activeProvider: 'test', providers: [{ id: 'test', kind: 'openai-compatible', baseURL: provider.url, apiKey: 'fixture-key', defaultModel: 'test-model', fetchedModels: ['test-model'], modelContextWindows: { 'test-model': 200000 } }] }))
      writeFileSync(join(config, 'settings.json'), JSON.stringify({ permissions: { allow: ['Grep'] } }))

      const errors: string[] = []
      const deltas: string[] = []
      let finished = false
      session = new ChatSession({
        launch,
        cwd: workspace,
        env: { PATH: bin, RAYU_CONFIG_DIR: config, RAYU_AUTH_CONFIG_DIR: config, USE_RAYU_OAUTH: 'false', RAYU_EXTERNAL_AGENTS: '0' },
      }, sessionCallbacks({
        onError: error => errors.push(error),
        onPartial: (_id, kind, delta) => { if (kind === 'text') deltas.push(delta) },
        onTurnState: running => { if (!running) finished = true },
      }))
      await session.submitPrompt(`Find files containing ${pattern}.`)
      await until(() => finished || errors.length > 0, 60_000)

      expect(errors).toEqual([])
      const grep = session.transcript.find(entry => entry.kind === 'tool' && entry.name === 'Grep')
      expect(grep).toMatchObject({ status: 'done' })
      expect(deltas.join('')).toContain('haystack.txt')
    } finally {
      session?.dispose()
      provider.stop()
      await new Promise(resolve => setTimeout(resolve, 100))
      rmSync(dir, { recursive: true, force: true })
    }
  },
  90_000,
)
