import { runTests } from '@vscode/test-electron'
import { chromium } from 'playwright-core'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { startLocalProvider } from '../test/helpers/localProvider.js'
import { until } from '../test/helpers/vscodeSession.js'

const root = resolve(new URL('..', import.meta.url).pathname)
const directory = mkdtempSync(join(tmpdir(), 'rayucode-ui-'))
const provider = await startLocalProvider()
const config = join(directory, 'config'), workspace = join(directory, 'workspace')
mkdirSync(config); mkdirSync(workspace)
writeFileSync(join(workspace, 'fixture.txt'), 'before\n')
writeFileSync(join(config, 'providers.json'), JSON.stringify({ activeProvider: 'test', providers: [{ id: 'test', kind: 'openai-compatible', baseURL: provider.url, apiKey: 'fixture-key', defaultModel: 'test-model', fetchedModels: ['test-model', 'test-model-2'] }] }))
writeFileSync(join(config, 'rayu-auth.json'), JSON.stringify({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000, user: { id: 42, email: 'fixture@example.test', displayName: 'Fixture', avatarUrl: null, role: 'user' } }), { mode: 0o600 })
// No auto-approval: the UI must actually answer the Edit permission request.
writeFileSync(join(config, 'settings.json'), JSON.stringify({ permissions: { allow: ['Read', 'Bash(true)'] } }))
const userData = join(directory, 'user-data'); mkdirSync(join(userData, 'User'), { recursive: true })
writeFileSync(join(userData, 'User/settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none' }))
const portServer = createServer(); await new Promise<void>(r => portServer.listen(0, '127.0.0.1', r))
const port = (portServer.address() as AddressInfo).port
await new Promise<void>(r => portServer.close(() => r()))
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
const run = runTests({
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE ?? '/usr/share/code/code',
  extensionDevelopmentPath: join(root, 'dist/vscode-stage'),
  extensionTestsPath: join(root, 'test/vscodeUiRunner.cjs'),
  launchArgs: [workspace, '--disable-extensions', '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userData}`, `--extensions-dir=${join(directory, 'extensions')}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*'],
  extensionTestsEnv: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, RAYU_CONFIG_DIR: config, RAYUCODE_AUTH_CONFIG_DIR: config, USE_RAYU_OAUTH: 'true', RAYU_API_URL: provider.url.replace('/v1', ''), RAYU_GATEWAY_URL: provider.url.replace('/v1', ''), RAYUCODE_UI_CONTROL: directory },
})
// Always observe a launcher failure while the driver waits for readiness.
let launchError: unknown
run.catch(error => { launchError = error })
try {
  // Connect before the extension creates its webview. VS Code hosts webviews in
  // out-of-process targets, and attaching after creation is unreliable on recent
  // Electron builds even while the panel is visibly rendered.
  const connectDeadline = Date.now() + 60_000
  while (!browser && Date.now() < connectDeadline) {
    if (launchError) throw launchError
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  if (!browser) throw new Error('Timed out connecting to VS Code debugging port')
  writeFileSync(join(directory, 'driver-ready'), 'ready')
  await until(() => existsSync(join(directory, 'ready')) || !!launchError, 60_000)
  if (launchError) throw launchError
  const page = browser.contexts()[0]!.pages()[0]!
  page.setDefaultTimeout(30_000)
  // VS Code may expose a webview frame as `vscode-webview://.../fake.html` or as
  // an anonymous out-of-process iframe. Locate our frame by its accessible composer
  // instead of coupling the test to that editor-internal URL.
  async function findRayucodeFrame(timeout = 30_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      for (const candidatePage of browser!.contexts().flatMap(context => context.pages())) {
        for (const candidate of candidatePage.frames()) {
          const count = await candidate
            .getByRole('textbox', { name: 'Message Rayu' })
            .count()
            .catch(() => 0)
          if (count > 0) return candidate
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Timed out waiting for the Rayucode webview')
  }
  let frame = await findRayucodeFrame()
  const input = frame!.getByRole('textbox', { name: 'Message Rayu' })
  await input.waitFor({ timeout: 20_000 })
  await input.fill('Read fixture.txt, change before to after, run true, then summarize.')
  await frame!.getByTitle('Change model', { exact: true }).click()
  const search = frame!.getByRole('textbox', { name: 'Search models', exact: true })
  await search.fill('New Admin Model')
  await frame!.getByRole('option').filter({ hasText: '123,456 tokens' }).waitFor()
  const hosted = await frame!.getByRole('option').innerText()
  if (!hosted.includes('Images: yes') || !hosted.includes('Thinking: yes') || !hosted.includes('Tools: yes')) throw new Error('Hosted capabilities were lost in the panel')
  await frame!.getByRole('option').click()
  await frame!.getByRole('button', { name: /^Effort:/ }).waitFor()
  await frame!.getByTitle('Change model', { exact: true }).click()
  await search.fill('admin-text-only')
  await frame!.getByRole('option').click()
  await frame!.getByRole('button', { name: /^Effort:/ }).waitFor({ state: 'hidden' })
  await frame!.getByTitle('Change model', { exact: true }).click()
  await search.fill('test-model-2')
  await search.press('ArrowDown'); await search.press('Enter')
  if (await input.inputValue() !== 'Read fixture.txt, change before to after, run true, then summarize.') throw new Error('Model selection overwrote the draft')
  await frame!.getByRole('button', { name: 'Send message' }).click()
  // The running state is posted synchronously when the host accepts a prompt. It
  // therefore covers both a still-finishing prewarm and ordinary provider work,
  // rather than leaving the first turn looking frozen.
  await frame!.getByRole('status').getByText(/^Rayu's .+…$/).waitFor()
  await until(() => provider.requests.length > 0, 90_000)
  // Save DOM and screenshots even on failure to make UI regressions reviewable.
  const allow = frame!.getByRole('button', { name: 'Allow once', exact: true })
  await allow.waitFor({ timeout: 45_000 }); await allow.click()
  await frame!.getByText('The check passed.', { exact: false }).first().waitFor({ timeout: 45_000 })

  await input.fill('Ask me which file format to use, then confirm my answer.')
  await frame!.getByRole('button', { name: 'Send message' }).click()
  const question = frame!.getByRole('dialog', { name: "Answer Rayu's questions" })
  await question.waitFor({ timeout: 45_000 })
  await question.getByLabel('Text files (.txt)').check()
  await question.getByRole('button', { name: 'Submit answers' }).click()
  await frame!.getByText("You answered Rayu's questions", { exact: true }).waitFor()
  await frame!.getByText('I received your file-format choice.', { exact: true }).waitFor({ timeout: 45_000 })
  if (await frame!.locator('.rc-tool-name').getByText('AskUserQuestion', { exact: true }).count()) {
    throw new Error('AskUserQuestion exposed raw parameters instead of the question form')
  }
  const output = join(root, 'dist/test-results'); mkdirSync(output, { recursive: true })
  await page.screenshot({ path: join(output, 'rayucode-dark.png') })
  await frame!.getByRole('button', { name: 'Diff', exact: true }).first().click()
  let actionId = 0
  async function native(action: string, extra: object = {}) {
    const id = ++actionId
    writeFileSync(join(directory, 'request.json'), JSON.stringify({ id, action, ...extra }))
    await until(() => existsSync(join(directory, `response-${id}.json`)), 15_000)
    const response = JSON.parse(readFileSync(join(directory, `response-${id}.json`), 'utf8'))
    if (response.error) throw new Error(response.error)
    return response
  }
  const diff = await native('diff')
  if (diff.before !== 'before\n' || diff.after !== 'after\n') throw new Error('Review diff does not match the recorded edit')
  await native('theme', { theme: 'Default Light Modern' })
  await frame!.locator('body.vscode-light').waitFor()
  await page.screenshot({ path: join(output, 'rayucode-light.png') })
  await frame!.getByTitle('Previous sessions', { exact: true }).click()
  await frame!.getByRole('textbox', { name: 'Search previous sessions' }).fill('fixture')
  const history = frame!.getByRole('option').first()
  await history.waitFor(); await history.click(); await history.click()
  await frame!.getByText('The check passed.', { exact: false }).first().waitFor()
  if (provider.requests.filter(r => r.stream).length !== 6) throw new Error('Restoring history resubmitted inference')
  console.log('PASS: real extension host, AskUserQuestion answers, sign-in gate, hosted catalog/capabilities, keyboard model selection/draft, streaming, approval, exact diff, history, dark/light themes')
} catch (error) {
  if (existsSync(join(directory, 'runner.log'))) {
    console.error('RUNNER LOG:\n' + readFileSync(join(directory, 'runner.log'), 'utf8'))
  }
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0]
    if (page) {
      mkdirSync(join(root, 'dist/test-results'), { recursive: true })
      await page.screenshot({ path: join(root, 'dist/test-results/rayucode-failure.png') })
      for (const frame of page.frames()) console.error('FRAME', frame.url(), (await frame.locator('body').innerText().catch(() => '')).slice(-6000))
    }
  }
  throw error
} finally {
  writeFileSync(join(directory, 'done'), 'done')
  await browser?.close()
  await run
  await provider.close()
  rmSync(directory, { recursive: true, force: true })
}
